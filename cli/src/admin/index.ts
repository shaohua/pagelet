import type { CliResult } from "../index.js";
import { resolveAdminDeps, type AdminDepsOverrides } from "./deps.js";
import { runDestroy } from "./destroy.js";
import { runSetup } from "./setup.js";
import { runStatus } from "./status.js";

export function getAdminHelpText(): string {
  return [
    "Pagelet admin: deploy Pagelet into your own Google Cloud project.",
    "",
    "Usage:",
    "  pagelet admin setup --project <id> [options]",
    "  pagelet admin status [--project id] [--region region] [--service name]",
    "  pagelet admin destroy --project <id> [options]",
    "",
    "Setup and destroy always require --project: they create or delete real",
    "infrastructure, so the target is never inherited from gcloud config.",
    "",
    "Setup options:",
    "  --project <id>                    Project id (required)",
    "  --region <region>                 Cloud Run region (default: us-central1)",
    "  --service <name>                  Service name (default: pagelet)",
    "  --bucket <name>                   Bucket name (default: <project>-pagelet)",
    "  --allow <domains>                 Extra in-organization Workspace domains",
    "  --domain <url>                    Viewer URL when you map your own domain",
    "  --allowed-external-origins <csv>  Extra origins reports may load from",
    "  --image <ref>                     Deploy another image",
    "  --source <dir>                    Build and deploy from source",
    "  --dry-run                         Print the plan and stop",
    "  --yes                             Do not ask for confirmation",
    "  --verbose                         Echo each gcloud command",
    "",
    "Destroy options:",
    "  --project <id>                    Project to destroy in (required)",
    "  --region <region>                 Cloud Run region (default: us-central1)",
    "  --service <name>                  Viewer service name (default: pagelet)",
    "  --bucket <name>                   Bucket to delete with --delete-data",
    "  --delete-data                     Also delete the bucket and every report",
    "  --yes                             Do not ask for confirmation"
  ].join("\n");
}

/**
 * Admin subcommands stream their progress through io as it happens, so the
 * CliResult carries the exit code and nothing else.
 */
export async function runAdmin(
  argv: string[],
  overrides: AdminDepsOverrides = {}
): Promise<CliResult> {
  const deps = resolveAdminDeps(overrides);
  const [subcommand, ...rest] = argv;

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    deps.io.out(getAdminHelpText());
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  const commands = {
    setup: runSetup,
    status: runStatus,
    destroy: runDestroy
  };
  const command = commands[subcommand as keyof typeof commands];

  if (!command) {
    deps.io.err(`Unknown admin command: ${subcommand}`);
    deps.io.err(getAdminHelpText());
    return { exitCode: 1, stdout: "", stderr: "" };
  }

  try {
    return {
      exitCode: await command(rest, deps),
      stdout: "",
      stderr: ""
    };
  } catch (error) {
    deps.io.err(error instanceof Error ? error.message : String(error));
    return { exitCode: 1, stdout: "", stderr: "" };
  }
}
