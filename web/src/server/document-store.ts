/**
 * JSON documents in object storage — Pagelet's only persistence layer.
 *
 * A document is a JSON file at a key. There is no database instance, so a
 * deployment is a Cloud Run service and a bucket, and it scales to zero.
 *
 * `mutate` is the interesting operation: read a document, change it, write it
 * back, without losing a concurrent writer's change. The two drivers reach that
 * guarantee differently because their substrates differ.
 *
 * GCS has no lock primitive but does have generation numbers, so the `gcs`
 * driver uses `ifGenerationMatch` — compare-and-swap in the storage layer —
 * and retries when it loses a race. The filesystem has no generations, so the
 * `fs` driver takes an in-process mutex around the whole read/apply/write
 * cycle, which cannot starve and leaves nothing behind if the process dies.
 * Running two processes over one directory is out of scope; that is what `gcs`
 * is for.
 */
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { Storage } from "@google-cloud/storage";
import { storageRoot } from "./storage";

/** Opaque per-document version. Compared, never parsed. */
export type DocumentVersion = string;

export type DocumentRead<T> = {
  value: T;
  version: DocumentVersion;
};

/** Thrown when a conditional write loses a race. */
export class DocumentConflictError extends Error {
  constructor(key: string) {
    super(`Document changed during write: ${key}`);
    this.name = "DocumentConflictError";
  }
}

export type DocumentStore = {
  read<T>(key: string): Promise<DocumentRead<T> | null>;
  /**
   * `expectedVersion` is the version from a prior read, or `null` to require
   * that the document does not exist yet. Conflicts throw
   * `DocumentConflictError`.
   */
  write<T>(
    key: string,
    value: T,
    expectedVersion: DocumentVersion | null
  ): Promise<DocumentVersion>;
  /**
   * Read, apply, write as one logical step. `apply` receives `null` when the
   * document does not exist yet, and must be free of side effects: the `gcs`
   * driver can run it more than once.
   */
  mutate<T>(key: string, apply: (current: T | null) => T): Promise<T>;
  list(prefix: string): Promise<string[]>;
  remove(key: string): Promise<void>;
};

let cachedStore: DocumentStore | null = null;

export function getDocumentStore(): DocumentStore {
  if (!cachedStore) {
    cachedStore =
      process.env.PAGELET_STORAGE_BACKEND === "gcs"
        ? createGcsDocumentStore()
        : createFsDocumentStore();
  }

  return cachedStore;
}

/** Test seam: forces the next `getDocumentStore()` to rebuild. */
export function resetDocumentStore(): void {
  cachedStore = null;
}

// ---------------------------------------------------------------------------
// fs driver
// ---------------------------------------------------------------------------

export function createFsDocumentStore(root?: string): DocumentStore {
  const baseDir = () => join(root ?? storageRoot(), "documents");
  const pathFor = (key: string) => join(baseDir(), `${key}.json`);

  // One promise chain per key. Awaiting the previous entry before running the
  // next serialises writers, with no lock file that could outlive the process.
  const chains = new Map<string, Promise<unknown>>();

  function serialise<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(run, run);
    chains.set(
      key,
      next.catch(() => undefined)
    );
    return next;
  }

  async function readRaw<T>(key: string): Promise<DocumentRead<T> | null> {
    try {
      const raw = await readFile(pathFor(key), "utf8");
      return { value: JSON.parse(raw) as T, version: versionOf(raw) };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }

      throw error;
    }
  }

  async function writeRaw<T>(key: string, value: T): Promise<DocumentVersion> {
    const path = pathFor(key);
    const raw = `${JSON.stringify(value, null, 2)}\n`;
    await mkdir(dirname(path), { recursive: true });
    // Write-then-rename, so a crash mid-write cannot leave a truncated
    // document behind for the next reader.
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, raw);
    await rename(temporaryPath, path);
    return versionOf(raw);
  }

  return {
    read: readRaw,

    async write(key, value, expectedVersion) {
      return serialise(key, async () => {
        const current = await readRaw(key);

        if ((current?.version ?? null) !== expectedVersion) {
          throw new DocumentConflictError(key);
        }

        return writeRaw(key, value);
      });
    },

    async mutate<T>(key: string, apply: (current: T | null) => T): Promise<T> {
      // Holding the mutex across read and write is what makes this safe;
      // there is no version to compare and nothing to retry.
      return serialise(key, async () => {
        const current = await readRaw<T>(key);
        const next = apply(current?.value ?? null);
        await writeRaw(key, next);
        return next;
      });
    },

    async list(prefix) {
      const directory = join(baseDir(), prefix);

      try {
        const entries = await readdir(directory, { withFileTypes: true });

        return entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map((entry) => `${prefix}/${entry.name.replace(/\.json$/, "")}`)
          .sort();
      } catch (error) {
        if (isNotFound(error)) {
          return [];
        }

        throw error;
      }
    },

    async remove(key) {
      await serialise(key, () => rm(pathFor(key), { force: true }));
    }
  };
}

// ---------------------------------------------------------------------------
// gcs driver
// ---------------------------------------------------------------------------

const MAX_MUTATE_ATTEMPTS = 25;

function createGcsDocumentStore(): DocumentStore {
  const bucketName = process.env.GCS_BUCKET;

  if (!bucketName) {
    throw new Error("GCS_BUCKET is required when PAGELET_STORAGE_BACKEND=gcs");
  }

  const bucket = new Storage().bucket(bucketName);
  const objectFor = (key: string) => `documents/${key}.json`;

  const store: DocumentStore = {
    async read<T>(key: string) {
      const file = bucket.file(objectFor(key));

      try {
        const [contents] = await file.download();
        const [metadata] = await file.getMetadata();

        return {
          value: JSON.parse(contents.toString("utf8")) as T,
          // The generation changes on every write, which is exactly the
          // precondition semantics `write` needs.
          version: String(metadata.generation)
        };
      } catch (error) {
        if (statusOf(error) === 404) {
          return null;
        }

        throw error;
      }
    },

    async write(key, value, expectedVersion) {
      const file = bucket.file(objectFor(key));

      try {
        await file.save(`${JSON.stringify(value, null, 2)}\n`, {
          contentType: "application/json",
          // Generation 0 means "only if absent", which makes creation safe
          // when two writers race to create the same document.
          preconditionOpts: {
            ifGenerationMatch: expectedVersion ? Number(expectedVersion) : 0
          }
        });

        const [metadata] = await file.getMetadata();
        return String(metadata.generation);
      } catch (error) {
        if (statusOf(error) === 412) {
          throw new DocumentConflictError(key);
        }

        throw error;
      }
    },

    async mutate<T>(key: string, apply: (current: T | null) => T): Promise<T> {
      for (let attempt = 0; attempt < MAX_MUTATE_ATTEMPTS; attempt += 1) {
        const existing = await store.read<T>(key);
        const next = apply(existing?.value ?? null);

        try {
          await store.write(key, next, existing?.version ?? null);
          return next;
        } catch (error) {
          if (!(error instanceof DocumentConflictError)) {
            throw error;
          }

          // Back off with jitter. Without it, everyone who lost the race
          // retries in lockstep and keeps colliding.
          await delay(Math.random() * 25 * (attempt + 1));
        }
      }

      throw new Error(
        `Gave up updating ${key} after ${MAX_MUTATE_ATTEMPTS} conflicting writes`
      );
    },

    async list(prefix) {
      const [files] = await bucket.getFiles({ prefix: `documents/${prefix}/` });

      return files
        .map((file) => file.name)
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice("documents/".length, -".json".length))
        .sort();
    },

    async remove(key) {
      await bucket.file(objectFor(key)).delete({ ignoreNotFound: true });
    }
  };

  return store;
}

// ---------------------------------------------------------------------------

/**
 * Version is a hash of the content, so it identifies the state rather than the
 * number of writes. That makes the usual ABA concern moot: if the content is
 * back to what a writer read, then the state it based its change on is the
 * current state, and letting the write through is correct.
 */
function versionOf(raw: string): DocumentVersion {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function statusOf(error: unknown): number | undefined {
  return (error as { code?: number })?.code;
}
