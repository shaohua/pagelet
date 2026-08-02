import type { AdminDeps } from "./deps.js";
import { gcloudJson, isReauthenticationError } from "./gcloud.js";
import { GCLOUD_INSTALL_URL } from "./names.js";

export type PreflightContext = {
  account: string;
  project: string;
  projectNumber: string;
};

type AuthAccount = { account?: string; status?: string };
type GcloudConfig = { core?: { project?: string } };
type ProjectResource = { projectNumber?: string; lifecycleState?: string };
type BillingInfo = { billingEnabled?: boolean };

/**
 * gcloud, an active account, and a readable project: what every command needs.
 * The describe doubles as the token check — without it, an expired login would
 * make every later describe read as "resource is not there".
 */
export async function preflight(
  deps: AdminDeps,
  projectFlag: string | undefined
): Promise<PreflightContext> {
  await requireGcloud(deps);
  const account = await requireActiveAccount(deps);
  const project = await resolveProject(deps, projectFlag);
  const projectNumber = await requireProjectAccess(deps, project);

  return { account, project, projectNumber };
}

async function requireGcloud(deps: AdminDeps): Promise<void> {
  const result = await deps.gcloud(["--version"]);

  if (result.code !== 0) {
    throw new Error(
      [
        "gcloud is installed but `gcloud --version` failed.",
        result.stderr.trim() || "No error output.",
        `Reinstall the Google Cloud CLI: ${GCLOUD_INSTALL_URL}`
      ].join("\n")
    );
  }

  const version = result.stdout.split("\n")[0]?.trim();
  deps.io.out(`ok    ${version || "gcloud installed"}`);
}

async function requireActiveAccount(deps: AdminDeps): Promise<string> {
  const accounts = await gcloudJson<AuthAccount[]>(deps.gcloud, [
    "auth",
    "list",
    "--filter=status:ACTIVE"
  ]);
  const account = accounts?.[0]?.account;

  if (!account) {
    throw new Error(
      ["No active gcloud account.", "Run: gcloud auth login"].join("\n")
    );
  }

  deps.io.out(`ok    account ${account}`);
  return account;
}

async function resolveProject(
  deps: AdminDeps,
  projectFlag: string | undefined
): Promise<string> {
  if (projectFlag) {
    deps.io.out(`ok    project ${projectFlag}`);
    return projectFlag;
  }

  const config = await gcloudJson<GcloudConfig>(deps.gcloud, ["config", "list"]);
  const project = config?.core?.project;

  if (!project) {
    throw new Error(
      [
        "No Google Cloud project selected.",
        "Pass --project <id>, or run: gcloud config set project <id>"
      ].join("\n")
    );
  }

  deps.io.out(`ok    project ${project} (gcloud config)`);
  return project;
}

async function requireProjectAccess(
  deps: AdminDeps,
  project: string
): Promise<string> {
  const result = await deps.gcloud([
    "projects",
    "describe",
    project,
    "--format=json"
  ]);

  if (result.code !== 0 && isReauthenticationError(result.stderr)) {
    throw new Error(
      ["Your gcloud login has expired.", "Run: gcloud auth login"].join("\n")
    );
  }

  const described = parseProject(result.code === 0 ? result.stdout : "");

  if (!described) {
    throw new Error(
      [
        `Cannot read project ${project}.`,
        "Check the project id, and that your account has access to it.",
        result.stderr.trim()
      ]
        .filter((line) => line.length > 0)
        .join("\n")
    );
  }

  if (described.lifecycleState && described.lifecycleState !== "ACTIVE") {
    throw new Error(
      `Project ${project} is ${described.lifecycleState}, not ACTIVE.`
    );
  }

  if (!described.projectNumber) {
    throw new Error(
      `Project ${project} has no project number; cannot predict the service URL.`
    );
  }

  deps.io.out(`ok    project number ${described.projectNumber}`);
  return described.projectNumber;
}

function parseProject(stdout: string): ProjectResource | null {
  try {
    return JSON.parse(stdout) as ProjectResource;
  } catch {
    return null;
  }
}

/**
 * Older gcloud releases and read-only roles cannot answer this, which says
 * nothing about the project. Only a definite "no billing" stops setup.
 */
export async function checkBilling(
  deps: AdminDeps,
  project: string
): Promise<void> {
  const info = await gcloudJson<BillingInfo>(deps.gcloud, [
    "billing",
    "projects",
    "describe",
    project
  ]);

  if (!info) {
    deps.io.out("warn  cannot read billing status; continuing");
    return;
  }

  if (info.billingEnabled === false) {
    throw new Error(
      [
        `Billing is not enabled for ${project}, and Cloud Run needs it.`,
        `Enable billing: https://console.cloud.google.com/billing/linkedaccount?project=${project}`
      ].join("\n")
    );
  }

  deps.io.out("ok    billing enabled");
}
