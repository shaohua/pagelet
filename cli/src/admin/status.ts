import { readCliConfig } from "../config.js";
import type { AdminDeps } from "./deps.js";
import { describeService, serviceEnv, serviceImage } from "./gcp.js";
import {
  DEFAULT_REGION,
  DEFAULT_SERVICE,
  creatorServiceName,
  imageTag,
  trimTrailingSlash
} from "./names.js";
import { preflight } from "./preflight.js";

export type StatusOptions = {
  project?: string;
  region?: string;
  service?: string;
};

export async function runStatus(args: string[], deps: AdminDeps): Promise<number> {
  const options = parseStatusArgs(args);
  const io = deps.io;
  const region = options.region ?? DEFAULT_REGION;
  const viewerService = options.service ?? DEFAULT_SERVICE;
  const creatorService = creatorServiceName(viewerService);
  const { project } = await preflight(deps, options.project);
  const [viewer, creator] = await Promise.all([
    describeService(deps.gcloud, { project, region, service: viewerService }),
    describeService(deps.gcloud, { project, region, service: creatorService })
  ]);

  if (!viewer && !creator) {
    io.err(`Pagelet is not deployed in ${project}/${region}.`);
    io.err("Deploy it with: pagelet admin setup");
    return 1;
  }

  if (!viewer) io.err(`Viewer service ${viewerService} is missing.`);
  if (!creator) io.err(`Creator service ${creatorService} is missing.`);

  const primary = viewer ?? creator;
  if (!primary) return 1;
  const env = serviceEnv(primary);
  const viewerUrl = trimTrailingSlash(viewer?.status?.url ?? "");
  const creatorUrl = trimTrailingSlash(creator?.status?.url ?? "");

  io.out("");
  io.out(statusLine("Viewer", viewerUrl || "missing"));
  io.out(statusLine("Creator API", creatorUrl || "missing"));
  io.out(statusLine("Version", imageTag(serviceImage(primary) ?? "") ?? "unknown"));
  if (viewer && creator) {
    io.out(
      statusLine(
        "Same image",
        serviceImage(viewer) === serviceImage(creator)
          ? "yes"
          : "no (WARNING: services have drifted)"
      )
    );
  }
  io.out(statusLine("Auth", "IAP viewer + Pagelet creator tokens"));
  io.out(statusLine("Work domains", env.ALLOWED_EMAIL_DOMAINS || "none"));
  io.out(statusLine("Bucket", env.GCS_BUCKET ? `gs://${env.GCS_BUCKET}` : "unknown"));

  if (viewerUrl) {
    await reportCheck(deps, `${viewerUrl}/healthz`, "Viewer IAP", (status) =>
      status === 302 || status === 401 || status === 403
        ? `${status} (protected)`
        : `${status} (WARNING: not protected)`
    );
  }

  if (creatorUrl) {
    await reportCheck(deps, `${creatorUrl}/healthz`, "Creator health", (status) =>
      status >= 200 && status < 300 ? `${status} (healthy)` : `${status} (unhealthy)`
    );
    await reportCheck(
      deps,
      `${creatorUrl}/api/publish-config`,
      "Anonymous create",
      (status) =>
        status === 401 || status === 403
          ? `${status} (refused)`
          : `${status} (WARNING: not refused)`
    );
    await reportCheck(deps, `${creatorUrl}/r/not-public/1`, "Creator reports", (status) =>
      status === 404 ? "404 (absent)" : `${status} (WARNING: exposed)`
    );
  }

  const config = await readCliConfig();
  const loggedIn =
    Boolean(config?.token) &&
    Boolean(creatorUrl) &&
    trimTrailingSlash(config?.apiBaseUrl ?? "") === creatorUrl;
  io.out(
    statusLine(
      "This machine",
      loggedIn
        ? "logged in"
        : creatorUrl
          ? `not logged in (PAGELET_API_URL=${creatorUrl} pagelet login)`
          : "creator service missing"
    )
  );

  return 0;
}

export function parseStatusArgs(args: string[]): StatusOptions {
  const options: StatusOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];

    if (flag === "--project" && value) options.project = value;
    else if (flag === "--region" && value) options.region = value;
    else if (flag === "--service" && value) options.service = value;
    else throw new Error(`Unknown or incomplete admin status option: ${flag ?? ""}`);
    index += 1;
  }

  return options;
}

async function reportCheck(
  deps: AdminDeps,
  url: string,
  label: string,
  describe: (status: number) => string
): Promise<void> {
  try {
    const response = await deps.fetch(url, { redirect: "manual" });
    deps.io.out(statusLine(label, describe(response.status)));
  } catch (error) {
    deps.io.out(
      statusLine(label, `unreachable (${error instanceof Error ? error.message : String(error)})`)
    );
  }
}

function statusLine(label: string, value: string): string {
  return `${`${label}:`.padEnd(18)}${value}`;
}
