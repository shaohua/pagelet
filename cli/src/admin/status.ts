import { readCliConfig } from "../config.js";
import type { AdminDeps } from "./deps.js";
import { describeService, serviceEnv, serviceImage } from "./gcp.js";
import { DEFAULT_REGION, DEFAULT_SERVICE, imageTag, trimTrailingSlash } from "./names.js";
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
  const service = options.service ?? DEFAULT_SERVICE;
  const { project } = await preflight(deps, options.project);
  const deployed = await describeService(deps.gcloud, { project, region, service });

  if (!deployed) {
    io.err(`Service ${service} is not deployed in ${project}/${region}.`);
    io.err("Deploy it with: pagelet admin setup");
    return 1;
  }

  const env = serviceEnv(deployed);
  const url = trimTrailingSlash(deployed.status?.url ?? "");
  const authMode = env.PAGELET_DEPLOY_AUTH_MODE ?? "unknown";

  io.out("");
  io.out(statusLine("URL", url || "unknown"));
  io.out(statusLine("Version", imageTag(serviceImage(deployed) ?? "") ?? "unknown"));
  io.out(statusLine("Auth mode", authMode));
  io.out(statusLine("Reviewer domains", env.ALLOWED_EMAIL_DOMAINS || "none"));
  io.out(statusLine("Bucket", env.GCS_BUCKET ? `gs://${env.GCS_BUCKET}` : "unknown"));

  if (!url) {
    io.err("Cloud Run reported no URL for this service; skipping the live checks.");
    return 0;
  }

  try {
    const response = await deps.fetch(url);
    io.out(statusLine("Health", `${response.status}`));
  } catch (error) {
    io.out(
      statusLine(
        "Health",
        `unreachable (${error instanceof Error ? error.message : String(error)})`
      )
    );
  }

  let worldReadable = false;

  try {
    const response = await deps.fetch(`${url}/api/publish-config`);
    const refused = response.status === 401 || response.status === 403;
    worldReadable = response.status >= 200 && response.status < 300;
    io.out(
      statusLine(
        "Anonymous read",
        refused ? `${response.status} (refused)` : `${response.status} (not refused)`
      )
    );
  } catch (error) {
    io.out(
      statusLine(
        "Anonymous read",
        `unknown (${error instanceof Error ? error.message : String(error)})`
      )
    );
  }

  const config = await readCliConfig();
  const loggedIn =
    Boolean(config?.token) && trimTrailingSlash(config?.apiBaseUrl ?? "") === url;
  io.out(
    statusLine(
      "This machine",
      loggedIn ? "logged in" : `not logged in (PAGELET_API_URL=${url} pagelet login)`
    )
  );

  if (worldReadable) {
    io.err("");
    io.err("WARNING: anyone with the URL can read and comment on every report here.");
    io.err(
      authMode === "dev-preview"
        ? "That is what dev-preview auth does. Move to --auth google before real review."
        : "The instance answers the API without a token; check its auth configuration."
    );
  }

  return 0;
}

export function parseStatusArgs(args: string[]): StatusOptions {
  const options: StatusOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];

    if (flag === "--project" && value) {
      options.project = value;
      index += 1;
      continue;
    }

    if (flag === "--region" && value) {
      options.region = value;
      index += 1;
      continue;
    }

    if (flag === "--service" && value) {
      options.service = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown or incomplete admin status option: ${flag ?? ""}`);
  }

  return options;
}

function statusLine(label: string, value: string): string {
  return `${`${label}:`.padEnd(18)}${value}`;
}
