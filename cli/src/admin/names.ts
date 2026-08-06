export const DEFAULT_REGION = "us-central1";
export const DEFAULT_SERVICE = "pagelet";

export function creatorServiceName(viewerService: string): string {
  return `${viewerService}-creator`;
}

export const MANAGED_LABEL_KEY = "pagelet-managed";
export const MANAGED_LABEL_VALUE = "true";
export const MANAGED_LABEL = `${MANAGED_LABEL_KEY}=${MANAGED_LABEL_VALUE}`;

/** Service accounts carry no labels, so the description is the ownership marker. */
export const MANAGED_DESCRIPTION = "Managed by pagelet admin";

export const SERVICE_ACCOUNT_ID = "pagelet-run";
export const SERVICE_ACCOUNT_DISPLAY_NAME = "Pagelet Cloud Run service";

export const UPSTREAM_REPO = "pagelet-upstream";
export const UPSTREAM_REGISTRY = "https://ghcr.io";
export const UPSTREAM_IMAGE_PATH = "shaohua/pagelet";

/** Removed from deployments; retained so destroy can clean up old installs. */
export const SESSION_SECRET_NAME = "pagelet-session-secret";
export const GOOGLE_CLIENT_SECRET_NAME = "pagelet-google-client-secret";
export const DEV_TOKEN_SECRET_NAME = "pagelet-dev-token";

export const SECRET_NAMES = [
  SESSION_SECRET_NAME,
  GOOGLE_CLIENT_SECRET_NAME,
  DEV_TOKEN_SECRET_NAME
];

export const GCLOUD_INSTALL_URL = "https://cloud.google.com/sdk/docs/install";

/** IAP access is granted by domain, so shared consumer domains are unsafe. */
export const PUBLIC_EMAIL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com"
];

export function serviceAccountEmail(project: string): string {
  return `${SERVICE_ACCOUNT_ID}@${project}.iam.gserviceaccount.com`;
}

export function defaultBucket(project: string): string {
  return `${project}-pagelet`;
}

/**
 * Cloud Run cannot pull from ghcr.io directly, so setup deploys the pinned
 * upstream image through an Artifact Registry remote repository.
 */
export function upstreamImage(
  region: string,
  project: string,
  version: string
): string {
  return `${region}-docker.pkg.dev/${project}/${UPSTREAM_REPO}/${UPSTREAM_IMAGE_PATH}:${version}`;
}

/** Cloud Run URLs are deterministic, so setup can predict one before deploying. */
export function predictedUrl(
  service: string,
  projectNumber: string,
  region: string
): string {
  return `https://${service}-${projectNumber}.${region}.run.app`;
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function emailDomain(account: string): string | null {
  const domain = account.split("@")[1]?.trim().toLowerCase();
  return domain || null;
}

/**
 * Accepts a bare domain, "@domain", or a full address — people paste all
 * three. Only the domain may survive: an "@" left in the value would later be
 * read as the gcloud `^@^` list delimiter and split the env var apart.
 */
export function normalizeDomain(value: string): string {
  const parts = value.trim().toLowerCase().split("@");
  return parts[parts.length - 1] ?? "";
}

/** Digest-pinned images have no readable version, and that is not an error. */
export function imageTag(image: string): string | null {
  const name = image.slice(image.lastIndexOf("/") + 1);

  if (name.includes("@")) {
    return null;
  }

  const colon = name.lastIndexOf(":");
  return colon < 0 ? null : name.slice(colon + 1) || null;
}

function parseSemver(value: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());

  if (!match) {
    return null;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSemver(value: string): boolean {
  return parseSemver(value) !== null;
}

/** Unparseable versions are treated as not newer: converging is the safe default. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const left = parseSemver(candidate);
  const right = parseSemver(current);

  if (!left || !right) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;

    if (a !== b) {
      return a > b;
    }
  }

  return false;
}
