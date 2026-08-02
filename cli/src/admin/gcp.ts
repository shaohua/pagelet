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
