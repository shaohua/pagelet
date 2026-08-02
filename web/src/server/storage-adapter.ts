import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Storage } from "@google-cloud/storage";
import type { DraftUploadFile, DraftUploadUrl } from "@pagelet/shared";
import { storageRoot } from "./storage";

export type StoredUploadTarget = {
  originalPath: string;
  gcsObject: string;
  contentType: string;
  uploadedAt: string | null;
};

export type CreateDraftUploadTargetsInput = {
  orgId: string;
  pageletId: string;
  versionId: string;
  files: DraftUploadFile[];
};

export type CreateDraftUploadUrlsInput = {
  appBaseUrl: string;
  draftId: string;
  expiresAt: string;
  targets: StoredUploadTarget[];
};

export type StoredObject = {
  bytes: Buffer;
  contentType: string;
};

export type StoredObjectMetadata = {
  sizeBytes: number;
  sha256: string;
};

export type StorageAdapter = {
  createDraftUploadTargets(
    input: CreateDraftUploadTargetsInput
  ): StoredUploadTarget[];
  createDraftUploadUrls(
    input: CreateDraftUploadUrlsInput
  ): Promise<DraftUploadUrl[]>;
  putObject(gcsObject: string, bytes: Buffer, contentType: string): Promise<void>;
  getObject(gcsObject: string, contentType: string): Promise<StoredObject>;
  getObjectMetadata(gcsObject: string): Promise<StoredObjectMetadata>;
};

export function getStorageAdapter(): StorageAdapter {
  if (process.env.PAGELET_STORAGE_BACKEND === "gcs") {
    return createGcsStorageAdapter();
  }

  return localStorageAdapter;
}

const localStorageAdapter: StorageAdapter = {
  createDraftUploadTargets({ orgId, pageletId, versionId, files }) {
    return files.map((file) => ({
      originalPath: file.originalPath,
      gcsObject: objectNameForFile({
        orgId,
        pageletId,
        versionId,
        file
      }),
      contentType: file.contentType,
      uploadedAt: null
    }));
  },

  async createDraftUploadUrls(input) {
    return proxyDraftUploadUrls(input);
  },

  async putObject(gcsObject, bytes) {
    const path = localObjectPath(gcsObject);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  },

  async getObject(gcsObject, contentType) {
    return {
      bytes: await readFile(localObjectPath(gcsObject)),
      contentType
    };
  },

  async getObjectMetadata(gcsObject) {
    const bytes = await readFile(localObjectPath(gcsObject));

    return {
      sizeBytes: bytes.byteLength,
      sha256: sha256Hex(bytes)
    };
  }
};

function createGcsStorageAdapter(): StorageAdapter {
  const bucketName = process.env.GCS_BUCKET;

  if (!bucketName) {
    throw new Error("GCS_BUCKET is required when PAGELET_STORAGE_BACKEND=gcs");
  }

  const bucket = new Storage().bucket(bucketName);

  return {
    createDraftUploadTargets: localStorageAdapter.createDraftUploadTargets,

    async createDraftUploadUrls(input) {
      if (process.env.PAGELET_GCS_UPLOAD_MODE !== "signed-url") {
        return proxyDraftUploadUrls(input);
      }

      const { expiresAt, targets } = input;

      return Promise.all(
        targets.map(async (target) => {
          const [uploadUrl] = await bucket.file(target.gcsObject).getSignedUrl({
            version: "v4",
            action: "write",
            expires: Date.parse(expiresAt),
            contentType: target.contentType
          });

          return {
            originalPath: target.originalPath,
            gcsObject: target.gcsObject,
            uploadUrl,
            expiresAt
          };
        })
      );
    },

    async putObject(gcsObject, bytes, contentType) {
      await bucket.file(gcsObject).save(bytes, {
        contentType,
        resumable: false
      });
    },

    async getObject(gcsObject, contentType) {
      const [bytes] = await bucket.file(gcsObject).download();

      return {
        bytes,
        contentType
      };
    },

    async getObjectMetadata(gcsObject) {
      const [bytes] = await bucket.file(gcsObject).download();

      return {
        sizeBytes: bytes.byteLength,
        sha256: sha256Hex(bytes)
      };
    }
  };
}

function proxyDraftUploadUrls({
  appBaseUrl,
  draftId,
  expiresAt,
  targets
}: CreateDraftUploadUrlsInput): DraftUploadUrl[] {
  return targets.map((target, index) => ({
    originalPath: target.originalPath,
    gcsObject: target.gcsObject,
    uploadUrl: `${appBaseUrl}/api/uploads/${draftId}/${index}`,
    expiresAt
  }));
}

function objectNameForFile({
  orgId,
  pageletId,
  versionId,
  file
}: {
  orgId: string;
  pageletId: string;
  versionId: string;
  file: DraftUploadFile;
}): string {
  const filename =
    file.role === "html"
      ? "report.html"
      : file.rewrittenPath ?? file.originalPath;
  const normalizedFilename = normalizeObjectName(filename);

  return `orgs/${orgId}/pagelets/${pageletId}/versions/${versionId}/${normalizedFilename}`;
}

function localObjectPath(gcsObject: string): string {
  return join(storageRoot(), "objects", ...normalizeObjectName(gcsObject).split("/"));
}

function normalizeObjectName(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean);

  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Response("Invalid storage object path", { status: 400 });
  }

  return parts.join("/");
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
