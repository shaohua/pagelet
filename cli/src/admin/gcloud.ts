import { spawn } from "node:child_process";
import type { AdminIo } from "./io.js";
import { GCLOUD_INSTALL_URL } from "./names.js";

export type GcloudResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type GcloudRunner = (
  args: string[],
  stdin?: string
) => Promise<GcloudResult>;

type GcloudMissingError = Error & { gcloudMissing: true };

export function isGcloudMissingError(error: unknown): error is GcloudMissingError {
  return (
    error instanceof Error &&
    (error as Partial<GcloudMissingError>).gcloudMissing === true
  );
}

function gcloudMissingError(binary: string): GcloudMissingError {
  return Object.assign(
    new Error(
      [
        `gcloud is not installed, or "${binary}" is not on PATH.`,
        `Install the Google Cloud CLI: ${GCLOUD_INSTALL_URL}`
      ].join("\n")
    ),
    { gcloudMissing: true as const }
  );
}

/**
 * Arguments go to spawn as an array and never through a shell: project ids,
 * domains and OAuth values are user input, and a shell would give them meaning.
 */
export function createGcloudRunner(binary = "gcloud"): GcloudRunner {
  return (args, stdin) =>
    new Promise((resolveRun, rejectRun) => {
      const child = spawn(binary, args, {
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        rejectRun(
          error.code === "ENOENT" ? gcloudMissingError(binary) : error
        );
      });
      child.on("close", (code) => {
        resolveRun({ code: code ?? 1, stdout, stderr });
      });

      if (stdin !== undefined) {
        child.stdin?.end(stdin);
      }
    });
}

/**
 * Echoes the command line before running it. Secret values travel on stdin,
 * never in argv, so an echoed line is safe to show.
 */
export function echoingRunner(runner: GcloudRunner, io: AdminIo): GcloudRunner {
  return (args, stdin) => {
    io.out(`+ gcloud ${args.join(" ")}`);
    return runner(args, stdin);
  };
}

/**
 * gcloud refreshes its tokens lazily, so an expired login surfaces as a failure
 * of whatever command happened to run first — not of `auth list`.
 */
export function isReauthenticationError(stderr: string): boolean {
  return (
    /reauthentication (failed|required)/i.test(stderr) ||
    /problem refreshing your current auth tokens/i.test(stderr) ||
    /invalid_grant/i.test(stderr)
  );
}

/**
 * Returns null when the command failed or printed something unparseable, which
 * for a describe call means "this resource is not there".
 */
export async function gcloudJson<T>(
  runner: GcloudRunner,
  args: string[]
): Promise<T | null> {
  const result = await runner([...args, "--format=json"]);

  if (result.code !== 0) {
    return null;
  }

  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    return null;
  }
}
