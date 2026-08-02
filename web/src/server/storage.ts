import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function storageRoot(): string {
  if (process.env.PAGELET_STORAGE_DIR) {
    return resolve(process.env.PAGELET_STORAGE_DIR);
  }

  return join(findWorkspaceRoot(process.cwd()), ".pagelet-storage");
}

function findWorkspaceRoot(start: string): string {
  let current = resolve(start);

  while (current !== dirname(current)) {
    if (existsSync(join(current, "package-lock.json"))) {
      return current;
    }

    current = dirname(current);
  }

  return resolve(start);
}
