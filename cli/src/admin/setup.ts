import { cliVersion } from "../version.js";
import type { AdminDeps } from "./deps.js";
import {
  describeBucket,
  describeRepository,
  describeService,
  describeServiceAccount,
  isManaged,
  serviceImage
} from "./gcp.js";
import { echoingRunner } from "./gcloud.js";
import { checkBilling, preflight } from "./preflight.js";
import {
  DEFAULT_REGION,
  DEFAULT_SERVICE,
  MANAGED_DESCRIPTION,
  MANAGED_LABEL,
  PUBLIC_EMAIL_DOMAINS,
  SERVICE_ACCOUNT_DISPLAY_NAME,
  SERVICE_ACCOUNT_ID,
  UPSTREAM_REGISTRY,
  UPSTREAM_REPO,
  creatorServiceName,
  defaultBucket,
  emailDomain,
  imageTag,
  isNewerVersion,
  isSemver,
  normalizeDomain,
  predictedUrl,
  serviceAccountEmail,
  trimTrailingSlash,
  upstreamImage
} from "./names.js";

export type PageletSurface = "viewer" | "creator";

export type SetupOptions = {
  project?: string;
  region?: string;
  service?: string;
  bucket?: string;
  allow?: string;
  domain?: string;
  allowedExternalOrigins?: string;
  image?: string;
  source?: string;
  dryRun: boolean;
  yes: boolean;
  verbose: boolean;
};

const REQUIRED_APIS = [
  "run.googleapis.com",
  "storage.googleapis.com",
  "artifactregistry.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "iap.googleapis.com"
];
const DEPLOY_ATTEMPTS = 3;
const PROPAGATION_BACKOFF_MS = 20_000;

export async function runSetup(args: string[], deps: AdminDeps): Promise<number> {
  const options = parseSetupArgs(args);
  const ctx: AdminDeps = options.verbose
    ? { ...deps, gcloud: echoingRunner(deps.gcloud, deps.io) }
    : deps;
  const io = ctx.io;
  const region = options.region ?? DEFAULT_REGION;
  const viewerService = options.service ?? DEFAULT_SERVICE;
  const creatorService = creatorServiceName(viewerService);

  io.out("Preflight");
  const { account, project, projectNumber } = await preflight(ctx, options.project);
  await checkBilling(ctx, project);
  await requireOrganization(ctx, project);

  const serviceAccount = serviceAccountEmail(project);
  const bucket = options.bucket ?? defaultBucket(project);
  const domains = resolveDomains(options.allow, account);

  if (!options.dryRun && !options.yes && !io.isInteractive) {
    throw new Error("This terminal cannot ask for confirmation. Re-run with --yes.");
  }

  io.out("ok    terminal can answer everything this run needs");

  const viewerTarget = { project, region, service: viewerService };
  const creatorTarget = { project, region, service: creatorService };
  const existingViewer = await describeService(ctx.gcloud, viewerTarget);
  const existingCreator = await describeService(ctx.gcloud, creatorTarget);

  checkExistingService(existingViewer, viewerService, project, region, io);
  checkExistingService(existingCreator, creatorService, project, region, io);

  if (!options.source && !options.image && !isSemver(cliVersion())) {
    throw new Error(
      [
        `Cannot read this CLI's own version ("${cliVersion()}"), so there is no image tag to deploy.`,
        "Reinstall the CLI, or pass --image or --source."
      ].join("\n")
    );
  }

  const predictedViewerUrl = options.domain
    ? trimTrailingSlash(options.domain)
    : predictedUrl(viewerService, projectNumber, region);
  const predictedCreatorUrl = predictedUrl(creatorService, projectNumber, region);
  const image = options.source
    ? null
    : options.image ?? upstreamImage(region, project, cliVersion());
  const existing = {
    serviceAccount: await describeServiceAccount(ctx.gcloud, project, serviceAccount),
    bucket: await describeBucket(ctx.gcloud, project, bucket),
    repository: options.source
      ? null
      : await describeRepository(ctx.gcloud, project, region)
  };

  refuseUnmanaged(
    existing.serviceAccount !== null &&
      !existing.serviceAccount.description?.includes(MANAGED_DESCRIPTION),
    `service account ${serviceAccount}`
  );

  io.out("");
  io.out("Configuration");
  io.out(configLine("project", project, "--project", options.project !== undefined));
  io.out(configLine("region", region, "--region", options.region !== undefined));
  io.out(configLine("viewer service", viewerService, "--service", options.service !== undefined));
  io.out(`  ${"creator service".padEnd(18)}${creatorService}  (derived)`);
  io.out(configLine("bucket", `gs://${bucket}`, "--bucket", options.bucket !== undefined));
  io.out(configLine("work domains", domains.join(","), "--allow", options.allow !== undefined));
  io.out(configLine("viewer URL", predictedViewerUrl, "--domain", options.domain !== undefined));
  io.out(`  ${"creator API".padEnd(18)}${predictedCreatorUrl}  (derived)`);
  io.out(`  ${"image".padEnd(18)}${image ?? `built from ${options.source ?? ""}`}`);

  const apis = options.source
    ? [...REQUIRED_APIS, "cloudbuild.googleapis.com"]
    : REQUIRED_APIS;

  io.out("");
  io.out("Plan");
  io.out(planLine("enable", `(idempotent) APIs: ${apis.join(" ")}`));
  if (options.source) {
    io.out(planLine("enable", "Cloud Build source builds"));
  }
  io.out(planLine(existing.serviceAccount ? "exists" : "create", `service account ${serviceAccount}`));
  io.out(planLine(existing.bucket ? "exists" : "create", `bucket gs://${bucket}`));
  if (!options.source) {
    io.out(planLine(existing.repository ? "exists" : "create", `artifact registry repo ${UPSTREAM_REPO}`));
  }
  io.out(planLine(existingViewer ? "update" : "create", `IAP viewer service ${viewerService}`));
  io.out(planLine(existingCreator ? "update" : "create", `creator API service ${creatorService}`));

  if (options.dryRun) {
    io.out("");
    io.out("Dry run: nothing was created or changed.");
    return 0;
  }

  io.out("");
  if (!options.yes && !(await io.confirm("Continue?"))) {
    io.out("Aborted; nothing was created or changed.");
    return 1;
  }

  io.out("");
  io.out("Applying");
  await mutate(ctx, ["services", "enable", ...apis, "--project", project]);
  io.out("ok    APIs enabled");

  if (options.source) {
    await mutate(ctx, [
      "projects",
      "add-iam-policy-binding",
      project,
      "--member",
      `serviceAccount:${projectNumber}-compute@developer.gserviceaccount.com`,
      "--role",
      "roles/cloudbuild.builds.builder"
    ]);
    io.out("ok    Cloud Build can build from uploaded source");
  }

  await ensureRuntimeResources(ctx, {
    project,
    region,
    bucket,
    serviceAccount,
    existing,
    needsRepository: !options.source
  });

  await mutate(ctx, [
    "beta",
    "services",
    "identity",
    "create",
    "--service=iap.googleapis.com",
    `--project=${project}`
  ]);
  io.out("ok    IAP service agent ready");

  io.out(
    options.source
      ? "      building once and deploying both surfaces; Cloud Build takes a few minutes"
      : "      deploying both surfaces; the first revisions can take a minute or two"
  );

  await deploy(
    ctx,
    buildDeployArgs({
      project,
      projectNumber,
      region,
      service: viewerService,
      serviceAccount,
      surface: "viewer",
      viewerUrl: predictedViewerUrl,
      domains,
      bucket,
      image,
      source: options.source,
      allowedExternalOrigins: options.allowedExternalOrigins
    })
  );
  io.out(`ok    IAP viewer service ${viewerService} deployed`);

  let creatorImage = image;
  if (options.source) {
    const builtViewer = await describeService(ctx.gcloud, viewerTarget);
    creatorImage = serviceImage(builtViewer ?? {}) ?? null;
    if (!creatorImage) {
      throw new Error(
        "The viewer source build succeeded, but Cloud Run did not report its image."
      );
    }
    io.out("ok    reusing the viewer build for the creator API");
  }

  await grantIapAccess(ctx, {
    project,
    projectNumber,
    region,
    service: viewerService,
    account,
    domains
  });

  await deploy(
    ctx,
    buildDeployArgs({
      project,
      projectNumber,
      region,
      service: creatorService,
      serviceAccount,
      surface: "creator",
      viewerUrl: predictedViewerUrl,
      domains,
      bucket,
      image: creatorImage,
      allowedExternalOrigins: options.allowedExternalOrigins
    })
  );
  io.out(`ok    creator API service ${creatorService} deployed`);

  const deployedViewer = await describeService(ctx.gcloud, viewerTarget);
  const deployedCreator = await describeService(ctx.gcloud, creatorTarget);
  const viewerUrl = options.domain
    ? predictedViewerUrl
    : trimTrailingSlash(deployedViewer?.status?.url ?? predictedViewerUrl);
  const creatorUrl = trimTrailingSlash(
    deployedCreator?.status?.url ?? predictedCreatorUrl
  );

  if (viewerUrl !== predictedViewerUrl) {
    await updateBaseUrl(ctx, viewerTarget, viewerUrl);
    await updateBaseUrl(ctx, creatorTarget, viewerUrl);
    io.out(`ok    APP_BASE_URL corrected to ${viewerUrl}`);
  }

  io.out("");
  io.out("Verifying");
  await verifyDeployment(ctx, viewerUrl, creatorUrl);

  io.out("");
  if (io.isInteractive) {
    try {
      const session = await ctx.deviceLogin(creatorUrl, io);
      io.out(`Logged in as ${session.email}`);
      io.out(`Saved token to ${session.configPath}`);
    } catch (error) {
      io.err(`Login skipped: ${error instanceof Error ? error.message : String(error)}`);
      io.out(`Log in later with: PAGELET_API_URL=${creatorUrl} pagelet login`);
    }
  } else {
    io.out(`Log in from this machine with: PAGELET_API_URL=${creatorUrl} pagelet login`);
  }

  io.out("");
  io.out("Pagelet is ready.");
  io.out(`  Viewer:  ${viewerUrl}`);
  io.out(`  Creator: ${creatorUrl}`);
  io.out("  Publish: pagelet publish report.html");
  io.out("  Check:   pagelet admin status");
  return 0;
}

export function parseSetupArgs(args: string[]): SetupOptions {
  const options: SetupOptions = { dryRun: false, yes: false, verbose: false };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];

    if (flag === "--project" && value) options.project = value;
    else if (flag === "--region" && value) options.region = value;
    else if (flag === "--service" && value) options.service = value;
    else if (flag === "--bucket" && value) options.bucket = value;
    else if (flag === "--allow" && value) options.allow = value;
    else if (flag === "--domain" && value) options.domain = requireHttpsUrl(value);
    else if (flag === "--allowed-external-origins" && value) options.allowedExternalOrigins = value;
    else if (flag === "--image" && value) options.image = value;
    else if (flag === "--source" && value) options.source = value;
    else if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    } else if (flag === "--yes" || flag === "-y") {
      options.yes = true;
      continue;
    } else if (flag === "--verbose") {
      options.verbose = true;
      continue;
    } else {
      throw new Error(`Unknown or incomplete admin setup option: ${flag ?? ""}`);
    }

    index += 1;
  }

  return options;
}

export type DeployInput = {
  project: string;
  projectNumber: string;
  region: string;
  service: string;
  serviceAccount: string;
  surface: PageletSurface;
  viewerUrl: string;
  domains: readonly string[];
  bucket: string;
  image: string | null;
  source?: string;
  allowedExternalOrigins?: string;
};

export function buildDeployArgs(input: DeployInput): string[] {
  const env = [
    "NODE_ENV=production",
    "PAGELET_DEPLOY_AUTH_MODE=iap",
    `PAGELET_SURFACE=${input.surface}`,
    "PAGELET_STORAGE_BACKEND=gcs",
    `APP_BASE_URL=${input.viewerUrl}`,
    `ALLOWED_EMAIL_DOMAINS=${input.domains.join(",")}`,
    `GCS_BUCKET=${input.bucket}`,
    "PAGELET_DEV_AUTH=0"
  ];

  if (input.surface === "viewer") {
    env.push(
      `PAGELET_IAP_AUDIENCE=/projects/${input.projectNumber}/locations/${input.region}/services/${input.service}`
    );
  }
  if (input.allowedExternalOrigins) {
    env.push(`PAGELET_ALLOWED_EXTERNAL_ORIGINS=${input.allowedExternalOrigins}`);
  }
  for (const entry of env) {
    if (entry.slice(entry.indexOf("=") + 1).includes("@")) {
      throw new Error(
        `Cannot deploy: the value of ${entry.split("=")[0]} contains "@", which gcloud reads as the list delimiter.`
      );
    }
  }

  const args = [
    "run",
    "deploy",
    input.service,
    "--project",
    input.project,
    "--region",
    input.region,
    "--service-account",
    input.serviceAccount,
    input.surface === "viewer" ? "--invoker-iam-check" : "--no-invoker-iam-check",
    input.surface === "viewer" ? "--iap" : "--no-iap",
    "--clear-secrets",
    `--labels=${MANAGED_LABEL}`
  ];

  if (input.surface === "viewer") {
    args.push("--no-allow-unauthenticated");
  }

  if (input.source) args.push("--source", input.source);
  else if (input.image) args.push("--image", input.image);

  args.push("--set-env-vars", `^@^${env.join("@")}`);
  return args;
}

export function resolveDomains(allow: string | undefined, account: string): string[] {
  const accountDomain = emailDomain(account) ?? "";
  const domains = allow === undefined
    ? [accountDomain]
    : [accountDomain, ...allow.split(",").map(normalizeDomain)];
  const normalized = [...new Set(domains.filter(Boolean))];

  if (normalized.length === 0) {
    throw new Error("--allow needs at least one work domain, for example: --allow example.com");
  }
  const publicDomain = normalized.find((domain) => PUBLIC_EMAIL_DOMAINS.includes(domain));
  if (publicDomain) {
    throw new Error(
      [
        `${publicDomain} is a public email domain, not a private work domain.`,
        "Granting the domain would make every account at that provider a creator.",
        "Run gcloud auth login with your organization account."
      ].join("\n")
    );
  }

  return normalized;
}

function checkExistingService(
  service: Awaited<ReturnType<typeof describeService>>,
  name: string,
  project: string,
  region: string,
  io: AdminDeps["io"]
): void {
  if (!service) {
    io.out(`ok    service ${name} is not deployed yet`);
    return;
  }
  if (!isManaged(service.metadata?.labels)) {
    throw new Error(
      [
        `Cloud Run service ${name} exists in ${project}/${region}, but was not created by pagelet admin.`,
        "Deploy under a different name with --service, or remove that service yourself first."
      ].join("\n")
    );
  }
  const deployedTag = imageTag(serviceImage(service) ?? "");
  if (deployedTag && isNewerVersion(deployedTag, cliVersion())) {
    throw new Error(
      [
        `Deployed Pagelet ${deployedTag} is newer than this CLI ${cliVersion()}.`,
        "Update the CLI first: npm i -g @howtox/pagelet@latest"
      ].join("\n")
    );
  }
  io.out(`ok    service ${name} is managed by pagelet admin`);
}

async function ensureRuntimeResources(
  ctx: AdminDeps,
  input: {
    project: string;
    region: string;
    bucket: string;
    serviceAccount: string;
    existing: {
      serviceAccount: Awaited<ReturnType<typeof describeServiceAccount>>;
      bucket: Awaited<ReturnType<typeof describeBucket>>;
      repository: Awaited<ReturnType<typeof describeRepository>>;
    };
    needsRepository: boolean;
  }
): Promise<void> {
  if (!input.existing.serviceAccount) {
    await mutate(ctx, [
      "iam", "service-accounts", "create", SERVICE_ACCOUNT_ID,
      "--project", input.project,
      "--display-name", SERVICE_ACCOUNT_DISPLAY_NAME,
      "--description", MANAGED_DESCRIPTION
    ]);
  }
  ctx.io.out(`ok    service account ${input.serviceAccount} ready`);

  if (!input.existing.bucket) {
    await mutate(ctx, [
      "storage", "buckets", "create", `gs://${input.bucket}`,
      "--project", input.project,
      "--location", input.region,
      "--uniform-bucket-level-access"
    ]);
    await mutate(ctx, [
      "storage", "buckets", "update", `gs://${input.bucket}`,
      "--update-labels", MANAGED_LABEL
    ]);
  }
  await mutate(ctx, [
    "storage", "buckets", "add-iam-policy-binding", `gs://${input.bucket}`,
    "--member", `serviceAccount:${input.serviceAccount}`,
    "--role", "roles/storage.objectAdmin"
  ]);
  ctx.io.out(`ok    bucket gs://${input.bucket} ready`);

  await mutate(ctx, [
    "iam", "service-accounts", "add-iam-policy-binding", input.serviceAccount,
    "--project", input.project,
    "--member", `serviceAccount:${input.serviceAccount}`,
    "--role", "roles/iam.serviceAccountTokenCreator"
  ]);

  if (input.needsRepository && !input.existing.repository) {
    await mutate(ctx, [
      "artifacts", "repositories", "create", UPSTREAM_REPO,
      "--project", input.project,
      "--location", input.region,
      "--repository-format=docker",
      "--mode=remote-repository",
      `--remote-docker-repo=${UPSTREAM_REGISTRY}`,
      `--labels=${MANAGED_LABEL}`
    ]);
  }
  if (input.needsRepository) {
    ctx.io.out(`ok    artifact registry repo ${UPSTREAM_REPO} ready`);
  }
}

async function grantIapAccess(
  ctx: AdminDeps,
  input: {
    project: string;
    projectNumber: string;
    region: string;
    service: string;
    account: string;
    domains: string[];
  }
): Promise<void> {
  await mutate(ctx, [
    "run", "services", "add-iam-policy-binding", input.service,
    "--project", input.project,
    "--region", input.region,
    "--member", `serviceAccount:service-${input.projectNumber}@gcp-sa-iap.iam.gserviceaccount.com`,
    "--role", "roles/run.invoker"
  ]);
  for (const member of [`user:${input.account}`, ...input.domains.map((domain) => `domain:${domain}`)]) {
    await mutate(ctx, [
      "iap", "web", "add-iam-policy-binding",
      "--project", input.project,
      "--region", input.region,
      "--resource-type", "cloud-run",
      "--service", input.service,
      "--member", member,
      "--role", "roles/iap.httpsResourceAccessor"
    ]);
  }
  ctx.io.out(`ok    IAP access granted to ${input.domains.join(", ")}`);
}

async function updateBaseUrl(
  ctx: AdminDeps,
  target: { project: string; region: string; service: string },
  viewerUrl: string
): Promise<void> {
  await mutate(ctx, [
    "run", "services", "update", target.service,
    "--project", target.project,
    "--region", target.region,
    "--update-env-vars", `APP_BASE_URL=${viewerUrl}`
  ]);
}

async function deploy(ctx: AdminDeps, args: string[]): Promise<void> {
  for (let attempt = 1; attempt <= DEPLOY_ATTEMPTS; attempt += 1) {
    const result = await ctx.gcloud(args);
    if (result.code === 0) return;
    if (attempt < DEPLOY_ATTEMPTS && isApiPropagation(result.stderr)) {
      ctx.io.out("warn  newly enabled APIs are still propagating; retrying in 20s");
      await ctx.sleep(PROPAGATION_BACKOFF_MS);
      continue;
    }
    throw new Error(["Deploy failed.", result.stderr.trim() || result.stdout.trim()].join("\n"));
  }
}

async function verifyDeployment(
  ctx: AdminDeps,
  viewerUrl: string,
  creatorUrl: string
): Promise<void> {
  await verifyStatus(ctx, `${viewerUrl}/healthz`, "viewer IAP", (status) =>
    status === 302 || status === 401 || status === 403
  );
  await verifyStatus(ctx, `${creatorUrl}/healthz`, "creator API health", (status) =>
    status >= 200 && status < 300
  );
  await verifyStatus(ctx, `${creatorUrl}/api/publish-config`, "anonymous creator access refused", (status) =>
    status === 401 || status === 403
  );
  await verifyStatus(ctx, `${creatorUrl}/r/not-public/1`, "creator report routes absent", (status) =>
    status === 404
  );
}

async function verifyStatus(
  ctx: AdminDeps,
  url: string,
  label: string,
  accepted: (status: number) => boolean
): Promise<void> {
  try {
    const response = await ctx.fetch(url, { redirect: "manual" });
    ctx.io.out(
      accepted(response.status)
        ? `ok    ${label} (${response.status})`
        : `warn  ${label} answered ${response.status}`
    );
  } catch (error) {
    ctx.io.out(`warn  cannot check ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireHttpsUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`--domain must be an absolute URL, like https://pagelet.example.com (got: ${value})`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`--domain must use https (got: ${value})`);
  }
  return trimTrailingSlash(value);
}

function refuseUnmanaged(unmanaged: boolean, resource: string): void {
  if (unmanaged) {
    throw new Error(
      [
        `${resource} exists, but was not created by pagelet admin.`,
        "Remove or rename it yourself first; setup will not adopt it."
      ].join("\n")
    );
  }
}

async function requireOrganization(ctx: AdminDeps, project: string): Promise<void> {
  const result = await ctx.gcloud([
    "projects",
    "get-ancestors",
    project,
    "--format=json"
  ]);
  let ancestors: Array<{ id?: string; type?: string }> = [];

  if (result.code === 0) {
    try {
      ancestors = JSON.parse(result.stdout) as Array<{ id?: string; type?: string }>;
    } catch {
      ancestors = [];
    }
  }

  const organization = ancestors.find(({ type }) => type === "organization")?.id;
  if (!organization) {
    throw new Error(
      [
        `Project ${project} is not attached to a visible Google Cloud organization.`,
        "Pagelet's automatic IAP setup requires an organization so Google can manage the OAuth configuration.",
        "Use a project owned by your Workspace or Cloud Identity organization."
      ].join("\n")
    );
  }

  ctx.io.out(`ok    organization ${organization}`);
}

function isApiPropagation(stderr: string): boolean {
  return /SERVICE_DISABLED/i.test(stderr) ||
    /has not been used in project/i.test(stderr) ||
    /403[\s\S]*propagat/i.test(stderr);
}

async function mutate(ctx: AdminDeps, args: string[], stdin?: string): Promise<void> {
  const result = await ctx.gcloud(args, stdin);
  if (result.code !== 0) {
    throw new Error(
      [`Command failed: gcloud ${args.join(" ")}`, result.stderr.trim() || result.stdout.trim()].join("\n")
    );
  }
}

function configLine(label: string, value: string, flag: string, explicit: boolean): string {
  return `  ${label.padEnd(18)}${value}  (${explicit ? flag : `${flag}, default`})`;
}

function planLine(action: "create" | "update" | "exists" | "enable", text: string): string {
  const markers = {
    create: "+ create ",
    update: "~ update ",
    exists: "ok exists",
    enable: "enable   "
  };
  return `  ${markers[action]} ${text}`;
}
