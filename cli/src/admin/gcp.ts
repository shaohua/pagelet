import { gcloudJson, type GcloudRunner } from "./gcloud.js";
import {
  MANAGED_LABEL_KEY,
  MANAGED_LABEL_VALUE,
  UPSTREAM_REPO
} from "./names.js";

export type ServiceTarget = {
  project: string;
  region: string;
  service: string;
};

export type RunService = {
  metadata?: { labels?: Record<string, string> };
  spec?: {
    template?: {
      spec?: {
        containers?: Array<{
          image?: string;
          env?: Array<{ name?: string; value?: string }>;
        }>;
      };
    };
  };
  status?: { url?: string };
};

export type LabelledResource = {
  labels?: Record<string, string>;
};

export type ServiceAccountResource = {
  email?: string;
  description?: string;
};

const LOCATION_LABEL = "cloud.googleapis.com/location";

export function isManaged(labels: Record<string, string> | undefined): boolean {
  return labels?.[MANAGED_LABEL_KEY] === MANAGED_LABEL_VALUE;
}

export function serviceImage(service: RunService): string | null {
  return service.spec?.template?.spec?.containers?.[0]?.image ?? null;
}

export function serviceEnv(service: RunService): Record<string, string> {
  const entries = service.spec?.template?.spec?.containers?.[0]?.env ?? [];
  const env: Record<string, string> = {};

  for (const entry of entries) {
    if (entry.name) {
      env[entry.name] = entry.value ?? "";
    }
  }

  return env;
}

export function describeService(
  runner: GcloudRunner,
  target: ServiceTarget
): Promise<RunService | null> {
  return gcloudJson<RunService>(runner, [
    "run",
    "services",
    "describe",
    target.service,
    "--project",
    target.project,
    "--region",
    target.region
  ]);
}

/**
 * Cloud Run carries the region as a Knative label, so one project-wide list
 * finds deployments in regions the caller did not ask about. Destroy uses this
 * to tell "nothing was ever deployed" apart from "you named the wrong region",
 * which otherwise both read as an empty plan.
 */
export async function listManagedServiceRegions(
  runner: GcloudRunner,
  project: string
): Promise<string[]> {
  const services = await gcloudJson<RunService[]>(runner, [
    "run",
    "services",
    "list",
    "--project",
    project
  ]);
  const regions = new Set<string>();

  for (const service of services ?? []) {
    const labels = service.metadata?.labels;
    const region = labels?.[LOCATION_LABEL];

    if (isManaged(labels) && region) {
      regions.add(region);
    }
  }

  return [...regions].sort();
}

export function describeBucket(
  runner: GcloudRunner,
  project: string,
  bucket: string
): Promise<LabelledResource | null> {
  return gcloudJson<LabelledResource>(runner, [
    "storage",
    "buckets",
    "describe",
    `gs://${bucket}`,
    "--project",
    project
  ]);
}

export function describeSecret(
  runner: GcloudRunner,
  project: string,
  name: string
): Promise<LabelledResource | null> {
  return gcloudJson<LabelledResource>(runner, [
    "secrets",
    "describe",
    name,
    "--project",
    project
  ]);
}

export function describeRepository(
  runner: GcloudRunner,
  project: string,
  region: string
): Promise<LabelledResource | null> {
  return gcloudJson<LabelledResource>(runner, [
    "artifacts",
    "repositories",
    "describe",
    UPSTREAM_REPO,
    "--project",
    project,
    "--location",
    region
  ]);
}

export function describeServiceAccount(
  runner: GcloudRunner,
  project: string,
  email: string
): Promise<ServiceAccountResource | null> {
  return gcloudJson<ServiceAccountResource>(runner, [
    "iam",
    "service-accounts",
    "describe",
    email,
    "--project",
    project
  ]);
}
