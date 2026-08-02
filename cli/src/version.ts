import { readFileSync } from "node:fs";

/**
 * Compiled binaries have no package.json next to them, so their build injects
 * the version as a constant (bun build --define PAGELET_VERSION='"x.y.z"').
 * Everywhere else the identifier stays undefined and the file read wins.
 */
declare const PAGELET_VERSION: string | undefined;

/**
 * Version comes from package.json, which sits one directory above this file in
 * both layouts: src/ and dist/ in the workspace, and dist/ in the published
 * tarball. One place to bump.
 */
export function cliVersion(): string {
  if (typeof PAGELET_VERSION === "string") {
    return PAGELET_VERSION;
  }

  try {
    const raw = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { version?: string };
    return raw.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
