import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type PageBinding = {
  shareId: string;
  title: string;
  lastPublishedVersion: number;
};

type PageRegistry = {
  version: 1;
  pages: Record<string, PageBinding>;
};

export function pageRegistryPath(): string {
  return (
    process.env.PAGELET_PAGES ?? join(homedir(), ".pagelet", "pages.json")
  );
}

export async function readPageBinding(
  filePath: string
): Promise<PageBinding | null> {
  const registry = await readPageRegistry();
  return registry.pages[await canonicalFilePath(filePath)] ?? null;
}

export async function writePageBinding(
  filePath: string,
  binding: PageBinding
): Promise<void> {
  const registry = await readPageRegistry();
  registry.pages[await canonicalFilePath(filePath)] = binding;

  const path = pageRegistryPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`, {
    mode: 0o600
  });
}

async function canonicalFilePath(filePath: string): Promise<string> {
  return realpath(resolve(filePath));
}

async function readPageRegistry(): Promise<PageRegistry> {
  const path = pageRegistryPath();

  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;

    if (!isPageRegistry(value)) {
      throw new Error("expected an object with version 1 and a pages map");
    }

    return value;
  } catch (error) {
    if (isMissingFile(error)) {
      return { version: 1, pages: {} };
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read Pagelet page registry at ${path}: ${message}`);
  }
}

function isPageRegistry(value: unknown): value is PageRegistry {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { version?: unknown; pages?: unknown };
  return (
    candidate.version === 1 &&
    !!candidate.pages &&
    typeof candidate.pages === "object" &&
    !Array.isArray(candidate.pages)
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
