import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CliConfig = {
  apiBaseUrl: string;
  token: string;
};

export function cliConfigPath(): string {
  return process.env.PAGELET_CONFIG ?? join(homedir(), ".pagelet", "config.json");
}

export async function readCliConfig(): Promise<CliConfig | null> {
  try {
    return JSON.parse(await readFile(cliConfigPath(), "utf8")) as CliConfig;
  } catch {
    return null;
  }
}

export async function writeCliConfig(config: CliConfig): Promise<void> {
  const path = cliConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600
  });
}
