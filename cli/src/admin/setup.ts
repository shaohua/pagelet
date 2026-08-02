import { randomBytes } from "node:crypto";
import { cliVersion } from "../version.js";
import type { AdminDeps } from "./deps.js";
import {
  describeBucket,
  describeRepository,
  describeSecret,
  describeService,
  describeServiceAccount,
  isManaged,
  serviceEnv,
  serviceImage
} from "./gcp.js";
import { echoingRunner, gcloudJson } from "./gcloud.js";
import { checkBilling, preflight } from "./preflight.js";
import {
  DEFAULT_REGION,
  DEFAULT_SERVICE,
  DEV_TOKEN_SECRET_NAME,
  GOOGLE_CLIENT_SECRET_NAME,
  MANAGED_DESCRIPTION,
  MANAGED_LABEL,
  PUBLIC_EMAIL_DOMAINS,
  SERVICE_ACCOUNT_DISPLAY_NAME,
  SERVICE_ACCOUNT_ID,
  SESSION_SECRET_NAME,
  UPSTREAM_REGISTRY,
  UPSTREAM_REPO,
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

export type AuthMode = "google" | "dev-preview";

export type SetupOptions = {
  project?: string;
  region?: string;
  service?: string;
  bucket?: string;
  allow?: string;
  auth?: AuthMode;
  domain?: string;
  googleClientId?: string;
  googleClientSecret?: string;
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
  "secretmanager.googleapis.com",
  "artifactregistry.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com"
];

const DEPLOY_ATTEMPTS = 3;
const PROPAGATION_BACKOFF_MS = 20_000;

export async function runSetup(args: string[], deps: AdminDeps): Promise<number> {
  const options = parseSetupArgs(args);
  const ctx: AdminDeps = options.verbose
    ? { ...deps, gcloud: echoingRunner(deps.gcloud, deps.io) }
    : deps;
  const io = ctx.io;
  const authMode: AuthMode = options.auth ?? "google";
  const region = options.region ?? DEFAULT_REGION;
  const service = options.service ?? DEFAULT_SERVICE;

  io.out("Preflight");
  const { account, project, projectNumber } = await preflight(ctx, options.project);
  await checkBilling(ctx, project);

  const serviceAccount = serviceAccountEmail(project);
  const bucket = options.bucket ?? defaultBucket(project);
  const domains = resolveDomains(options.allow, account);

  if (!options.dryRun && !options.yes && !io.isInteractive) {
    throw new Error(
      "This terminal cannot ask for confirmation. Re-run with --yes."
    );
  }

  io.out("ok    terminal can answer everything this run needs");

  const target = { project, region, service };
  const existingService = await describeService(ctx.gcloud, target);

  if (existingService) {
    if (!isManaged(existingService.metadata?.labels)) {
      throw new Error(
        [
          `Cloud Run service ${service} exists in ${project}/${region}, but was not created by pagelet admin.`,
          "Deploy under a different name with --service, or remove that service yourself first."
        ].join("\n")
      );
    }

    const deployedTag = imageTag(serviceImage(existingService) ?? "");

    if (deployedTag && isNewerVersion(deployedTag, cliVersion())) {
      throw new Error(
        [
          `Deployed Pagelet ${deployedTag} is newer than this CLI ${cliVersion()}.`,
          "Update the CLI first: npm i -g @howtox/pagelet@latest"
        ].join("\n")
      );
    }

    io.out(`ok    service ${service} is managed by pagelet admin`);
  } else {
    io.out(`ok    service ${service} is not deployed yet`);
  }

  if (!options.source && !options.image && !isSemver(cliVersion())) {
    throw new Error(
      [
        `Cannot read this CLI's own version ("${cliVersion()}"), so there is no image tag to deploy.`,
        "Reinstall the CLI, or pass --image or --source."
      ].join("\n")
    );
  }

  const baseUrl = options.domain
    ? trimTrailingSlash(options.domain)
    : predictedUrl(service, projectNumber, region);
  const image = options.source
    ? null
    : options.image ?? upstreamImage(region, project, cliVersion());
  const authSecretName =
    authMode === "google" ? GOOGLE_CLIENT_SECRET_NAME : DEV_TOKEN_SECRET_NAME;

  const existing = {
    serviceAccount: await describeServiceAccount(ctx.gcloud, project, serviceAccount),
    bucket: await describeBucket(ctx.gcloud, project, bucket),
    repository: await describeRepository(ctx.gcloud, project, region),
    sessionSecret: await describeSecret(ctx.gcloud, project, SESSION_SECRET_NAME),
    authSecret: await describeSecret(ctx.gcloud, project, authSecretName)
  };

  refuseUnmanaged(
    existing.serviceAccount !== null &&
      !existing.serviceAccount.description?.includes(MANAGED_DESCRIPTION),
    `service account ${serviceAccount}`
  );
  refuseUnmanaged(
    existing.sessionSecret !== null && !isManaged(existing.sessionSecret.labels),
    `secret ${SESSION_SECRET_NAME}`
  );
  refuseUnmanaged(
    existing.authSecret !== null && !isManaged(existing.authSecret.labels),
    `secret ${authSecretName}`
  );

  // What OAuth material this run still lacks, given flags, the deployed
  // service, and the stored secret. A converging re-run usually needs nothing.
  const deployedClientId = existingService
    ? serviceEnv(existingService).GOOGLE_CLIENT_ID
    : undefined;
  const needsOAuthPrompt =
    authMode === "google" &&
    (!(options.googleClientId ?? deployedClientId) ||
      (!options.googleClientSecret && existing.authSecret === null));

  if (needsOAuthPrompt && !options.dryRun && !io.isInteractive) {
    throw new Error(
      [
        "Google auth needs an OAuth client, and this terminal cannot prompt for one.",
        "Re-run with --google-client-id <id> --google-client-secret <secret>,",
        "or run setup from an interactive terminal."
      ].join("\n")
    );
  }

  io.out("");
  io.out("Configuration");
  io.out(configLine("project", project, "--project", options.project !== undefined));
  io.out(configLine("region", region, "--region", options.region !== undefined));
  io.out(configLine("service", service, "--service", options.service !== undefined));
  io.out(configLine("bucket", `gs://${bucket}`, "--bucket", options.bucket !== undefined));
  io.out(
    configLine("reviewer domains", domains.join(","), "--allow", options.allow !== undefined)
  );
  io.out(configLine("auth mode", authMode, "--auth", options.auth !== undefined));
  io.out(configLine("base URL", baseUrl, "--domain", options.domain !== undefined));
  io.out(`  ${"image".padEnd(18)}${image ?? `built from ${options.source ?? ""}`}`);

  // Deploying from source builds the image with Cloud Build first.
  const apis = options.source
    ? [...REQUIRED_APIS, "cloudbuild.googleapis.com"]
    : REQUIRED_APIS;

  io.out("");
  io.out("Plan");
  io.out(planLine("enable", `(idempotent) APIs: ${apis.join(" ")}`));

  if (options.source) {
    io.out(
      planLine(
        "enable",
        "Cloud Build source builds (grants roles/cloudbuild.builds.builder to the default compute service account)"
      )
    );
  }
  io.out(
    planLine(existing.serviceAccount ? "exists" : "create", `service account ${serviceAccount}`)
  );
  io.out(planLine(existing.bucket ? "exists" : "create", `bucket gs://${bucket}`));
  io.out(
    planLine(existing.repository ? "exists" : "create", `artifact registry repo ${UPSTREAM_REPO}`)
  );
  io.out(
    planLine(existing.sessionSecret ? "exists" : "create", `secret ${SESSION_SECRET_NAME}`)
  );
  io.out(planLine(existing.authSecret ? "exists" : "create", `secret ${authSecretName}`));
  io.out(planLine(existingService ? "update" : "create", `Cloud Run service ${service}`));

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

  // On fresh projects the default compute service account, which Cloud Build
  // runs as, cannot read the uploaded source; the deploy fails without this.
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

  if (existing.serviceAccount) {
    io.out(`ok    service account ${serviceAccount} already exists`);
  } else {
    await mutate(ctx, [
      "iam",
      "service-accounts",
      "create",
      SERVICE_ACCOUNT_ID,
      "--project",
      project,
      "--display-name",
      SERVICE_ACCOUNT_DISPLAY_NAME,
      "--description",
      MANAGED_DESCRIPTION
    ]);
    io.out(`ok    service account ${serviceAccount} created`);
  }

  if (existing.bucket) {
    io.out(`ok    bucket gs://${bucket} already exists`);
  } else {
    await mutate(ctx, [
      "storage",
      "buckets",
      "create",
      `gs://${bucket}`,
      "--project",
      project,
      "--location",
      region,
      "--uniform-bucket-level-access"
    ]);
    await mutate(ctx, [
      "storage",
      "buckets",
      "update",
      `gs://${bucket}`,
      "--update-labels",
      MANAGED_LABEL
    ]);
    io.out(`ok    bucket gs://${bucket} created`);
  }

  await mutate(ctx, [
    "storage",
    "buckets",
    "add-iam-policy-binding",
    `gs://${bucket}`,
    "--member",
    `serviceAccount:${serviceAccount}`,
    "--role",
    "roles/storage.objectAdmin"
  ]);
  io.out("ok    bucket writable by the service account");

  // Signed download URLs are minted by the service account signing for itself.
  await mutate(ctx, [
    "iam",
    "service-accounts",
    "add-iam-policy-binding",
    serviceAccount,
    "--project",
    project,
    "--member",
    `serviceAccount:${serviceAccount}`,
    "--role",
    "roles/iam.serviceAccountTokenCreator"
  ]);
  io.out("ok    service account can sign download URLs");

  if (existing.repository) {
    io.out(`ok    artifact registry repo ${UPSTREAM_REPO} already exists`);
  } else {
    await mutate(ctx, [
      "artifacts",
      "repositories",
      "create",
      UPSTREAM_REPO,
      "--project",
      project,
      "--location",
      region,
      "--repository-format=docker",
      "--mode=remote-repository",
      `--remote-docker-repo=${UPSTREAM_REGISTRY}`,
      `--labels=${MANAGED_LABEL}`
    ]);
    io.out(`ok    artifact registry repo ${UPSTREAM_REPO} created`);
  }

  if (existing.sessionSecret) {
    io.out(`ok    secret ${SESSION_SECRET_NAME} kept (rotating it logs everyone out)`);
  } else {
    await createSecret(ctx, project, SESSION_SECRET_NAME, randomSecret());
    io.out(`ok    secret ${SESSION_SECRET_NAME} created`);
  }

  await grantSecretAccess(ctx, project, SESSION_SECRET_NAME, serviceAccount);

  let googleClientId: string | undefined;

  if (authMode === "google") {
    googleClientId = await configureGoogleOAuth(ctx, {
      project,
      baseUrl,
      serviceAccount,
      // A second run reuses the client id already deployed, so converging an
      // existing instance asks for nothing.
      clientId: options.googleClientId ?? deployedClientId,
      clientSecret: options.googleClientSecret,
      secretExists: existing.authSecret !== null
    });
  } else {
    if (!(await confirmDevPreview(ctx, options.yes))) {
      io.out("Aborted. Remove what was created with: pagelet admin destroy");
      return 1;
    }

    if (existing.authSecret) {
      io.out(`ok    secret ${DEV_TOKEN_SECRET_NAME} kept`);
    } else {
      await createSecret(ctx, project, DEV_TOKEN_SECRET_NAME, randomSecret());
      io.out(`ok    secret ${DEV_TOKEN_SECRET_NAME} created`);
    }

    await grantSecretAccess(ctx, project, DEV_TOKEN_SECRET_NAME, serviceAccount);
    io.out(
      `      read it with: gcloud secrets versions access latest --secret=${DEV_TOKEN_SECRET_NAME} --project ${project}`
    );
  }

  io.out(
    options.source
      ? "      building and deploying from source; Cloud Build takes a few minutes"
      : "      deploying; the first revision can take a minute or two"
  );
  await deploy(
    ctx,
    buildDeployArgs({
      project,
      region,
      service,
      serviceAccount,
      authMode,
      baseUrl,
      domains,
      bucket,
      image,
      source: options.source,
      googleClientId,
      allowedExternalOrigins: options.allowedExternalOrigins
    })
  );
  io.out(`ok    ${service} deployed`);

  const deployed = await describeService(ctx.gcloud, target);
  const actualUrl = deployed?.status?.url;
  let liveUrl = baseUrl;

  if (actualUrl && actualUrl !== baseUrl && !options.domain) {
    await mutate(ctx, [
      "run",
      "services",
      "update",
      service,
      "--project",
      project,
      "--region",
      region,
      "--update-env-vars",
      `APP_BASE_URL=${actualUrl}`
    ]);
    liveUrl = actualUrl;
    io.out(`ok    APP_BASE_URL corrected to ${actualUrl}`);

    if (authMode === "google") {
      io.out("");
      io.out("IMPORTANT: the service URL is not the one predicted before deploying.");
      io.out(
        `Change the authorized redirect URI of your OAuth client to: ${actualUrl}/auth/google/callback`
      );
    }
  }

  const publiclyReachable = await ensurePublicInvoker(ctx, target);

  io.out("");
  io.out("Verifying");
  await verifyDeployment(ctx, liveUrl, authMode);

  if (!publiclyReachable) {
    io.err("");
    io.err("Deployed, but reviewers cannot reach it: an organization policy");
    io.err("(constraints/iam.allowedPolicyMemberDomains) forbids public Cloud Run services.");
    io.err("Ask an organization admin to exempt this project, or deploy outside the");
    io.err("organization, then re-run: pagelet admin setup");
    return 1;
  }

  io.out("");

  if (io.isInteractive) {
    try {
      const session = await ctx.deviceLogin(liveUrl, io);
      io.out(`Logged in as ${session.email}`);
      io.out(`Saved token to ${session.configPath}`);
    } catch (error) {
      io.err(
        `Login skipped: ${error instanceof Error ? error.message : String(error)}`
      );
      io.out(`Log in later with: PAGELET_API_URL=${liveUrl} pagelet login`);
    }
  } else {
    io.out(`Log in from this machine with: PAGELET_API_URL=${liveUrl} pagelet login`);
  }

  io.out("");
  io.out("Pagelet is ready.");
  io.out(`  URL:     ${liveUrl}`);
  io.out("  Publish: pagelet publish report.html");
  io.out("  Check:   pagelet admin status");

  if (authMode === "dev-preview") {
    io.out("");
    io.out(
      "WARNING: dev-preview auth means anyone with the URL can read and comment on every report."
    );
  }

  return 0;
}

export function parseSetupArgs(args: string[]): SetupOptions {
  const options: SetupOptions = { dryRun: false, yes: false, verbose: false };

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

    if (flag === "--bucket" && value) {
      options.bucket = value;
      index += 1;
      continue;
    }

    if (flag === "--allow" && value) {
      options.allow = value;
      index += 1;
      continue;
    }

    if (flag === "--auth" && value) {
      if (value !== "google" && value !== "dev-preview") {
        throw new Error(
          `Unknown auth mode: ${value}. Use --auth google or --auth dev-preview.`
        );
      }

      options.auth = value;
      index += 1;
      continue;
    }

    if (flag === "--domain" && value) {
      options.domain = requireHttpsUrl(value);
      index += 1;
      continue;
    }

    if (flag === "--google-client-id" && value) {
      options.googleClientId = value;
      index += 1;
      continue;
    }

    if (flag === "--google-client-secret" && value) {
      options.googleClientSecret = value;
      index += 1;
      continue;
    }

    if (flag === "--allowed-external-origins" && value) {
      options.allowedExternalOrigins = value;
      index += 1;
      continue;
    }

    if (flag === "--image" && value) {
      options.image = value;
      index += 1;
      continue;
    }

    if (flag === "--source" && value) {
      options.source = value;
      index += 1;
      continue;
    }

    if (flag === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (flag === "--yes" || flag === "-y") {
      options.yes = true;
      continue;
    }

    if (flag === "--verbose") {
      options.verbose = true;
      continue;
    }

    throw new Error(`Unknown or incomplete admin setup option: ${flag ?? ""}`);
  }

  return options;
}

/**
 * The value becomes APP_BASE_URL, the OAuth redirect URI, and the login
 * target, so a bare hostname would fail three quiet ways later. OAuth also
 * rules out plain http outside localhost.
 */
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

  return value;
}

/**
 * Reviewer access is by email domain. Defaulting to a public provider domain
 * would admit every account at that provider, so that case has to be explicit.
 */
export function resolveDomains(
  allow: string | undefined,
  account: string
): string[] {
  if (allow !== undefined) {
    const domains = allow
      .split(",")
      .map(normalizeDomain)
      .filter((domain) => domain.length > 0);

    if (domains.length === 0) {
      throw new Error("--allow needs at least one domain, for example: --allow example.com");
    }

    return domains;
  }

  const domain = emailDomain(account);

  if (!domain) {
    throw new Error(
      `Cannot read a domain from the gcloud account ${account}; pass --allow <domains>.`
    );
  }

  if (PUBLIC_EMAIL_DOMAINS.includes(domain)) {
    throw new Error(
      [
        `Your gcloud account ${account} uses a public email domain (${domain}).`,
        "Allowing it would let anyone with such an address read your reports.",
        "Name the reviewer domains yourself, for example: --allow example.com"
      ].join("\n")
    );
  }

  return [domain];
}

export type DeployInput = {
  project: string;
  region: string;
  service: string;
  serviceAccount: string;
  authMode: AuthMode;
  baseUrl: string;
  domains: string[];
  bucket: string;
  image: string | null;
  source?: string;
  googleClientId?: string;
  allowedExternalOrigins?: string;
};

/** Sharing a fixed resource name with something else's resource is a takeover. */
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

/**
 * Env and secret lists use gcloud's `^@^` delimiter form so that commas inside
 * a value (reviewer domains, external origins) stay part of that value. The
 * delimiter itself must therefore never appear in a value.
 */
export function buildDeployArgs(input: DeployInput): string[] {
  const devPreview = input.authMode === "dev-preview";
  // The dev token authenticates as the demo user (reviewer@example.com), so a
  // dev-preview deploy without its domain cannot publish or review anything.
  const domains =
    devPreview && !input.domains.includes("example.com")
      ? [...input.domains, "example.com"]
      : input.domains;
  const env = [
    "NODE_ENV=production",
    `PAGELET_DEPLOY_AUTH_MODE=${input.authMode}`,
    "PAGELET_STORAGE_BACKEND=gcs",
    `APP_BASE_URL=${input.baseUrl}`,
    `ALLOWED_EMAIL_DOMAINS=${domains.join(",")}`,
    `GCS_BUCKET=${input.bucket}`,
    `PAGELET_DEV_AUTH=${devPreview ? "1" : "0"}`
  ];

  if (input.allowedExternalOrigins) {
    env.push(`PAGELET_ALLOWED_EXTERNAL_ORIGINS=${input.allowedExternalOrigins}`);
  }

  if (!devPreview && input.googleClientId) {
    env.push(`GOOGLE_CLIENT_ID=${input.googleClientId}`);
  }

  for (const entry of env) {
    const value = entry.slice(entry.indexOf("=") + 1);

    if (value.includes("@")) {
      throw new Error(
        `Cannot deploy: the value of ${entry.split("=")[0]} contains "@", which gcloud reads as the list delimiter.`
      );
    }
  }

  const secrets = [
    `SESSION_SECRET=${SESSION_SECRET_NAME}:latest`,
    devPreview
      ? `PAGELET_DEV_TOKEN=${DEV_TOKEN_SECRET_NAME}:latest`
      : `GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET_NAME}:latest`
  ];
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
    "--allow-unauthenticated",
    `--labels=${MANAGED_LABEL}`
  ];

  if (input.source) {
    args.push("--source", input.source);
  } else if (input.image) {
    args.push("--image", input.image);
  }

  args.push(
    "--set-env-vars",
    `^@^${env.join("@")}`,
    "--set-secrets",
    `^@^${secrets.join("@")}`
  );

  return args;
}

async function deploy(ctx: AdminDeps, args: string[]): Promise<void> {
  for (let attempt = 1; attempt <= DEPLOY_ATTEMPTS; attempt += 1) {
    const result = await ctx.gcloud(args);

    if (result.code === 0) {
      return;
    }

    if (blocksPublicAccess(result.stderr)) {
      throw new Error(
        [
          "Deploy failed: an organization policy forbids public Cloud Run services.",
          "constraints/iam.allowedPolicyMemberDomains blocks granting access to allUsers,",
          "which Pagelet needs so reviewers can reach the sign-in page.",
          "Ask an organization admin to exempt this project, or deploy outside the organization.",
          result.stderr.trim()
        ].join("\n")
      );
    }

    if (attempt < DEPLOY_ATTEMPTS && isApiPropagation(result.stderr)) {
      ctx.io.out("warn  newly enabled APIs are still propagating; retrying in 20s");
      await ctx.sleep(PROPAGATION_BACKOFF_MS);
      continue;
    }

    throw new Error(
      ["Deploy failed.", result.stderr.trim() || result.stdout.trim()].join("\n")
    );
  }
}

/**
 * `--allow-unauthenticated` fails soft: when an organization policy forbids
 * allUsers, gcloud deploys anyway, warns on stderr, and leaves the service
 * answering 403 to everyone. The IAM policy is the only honest signal.
 */
async function ensurePublicInvoker(
  ctx: AdminDeps,
  target: { project: string; region: string; service: string }
): Promise<boolean> {
  const policy = await gcloudJson<{
    bindings?: Array<{ role?: string; members?: string[] }>;
  }>(ctx.gcloud, [
    "run",
    "services",
    "get-iam-policy",
    target.service,
    "--project",
    target.project,
    "--region",
    target.region
  ]);
  const isPublic = Boolean(
    policy?.bindings?.some(
      (binding) =>
        binding.role === "roles/run.invoker" &&
        binding.members?.includes("allUsers")
    )
  );

  if (isPublic) {
    ctx.io.out("ok    reviewers can reach the service (public at the platform edge)");
    return true;
  }

  const bound = await ctx.gcloud([
    "run",
    "services",
    "add-iam-policy-binding",
    target.service,
    "--project",
    target.project,
    "--region",
    target.region,
    "--member",
    "allUsers",
    "--role",
    "roles/run.invoker"
  ]);

  if (bound.code === 0) {
    ctx.io.out("ok    reviewers can reach the service (public at the platform edge)");
    return true;
  }

  return false;
}

function isApiPropagation(stderr: string): boolean {
  return (
    /SERVICE_DISABLED/i.test(stderr) ||
    /has not been used in project/i.test(stderr) ||
    /403[\s\S]*propagat/i.test(stderr)
  );
}

function blocksPublicAccess(stderr: string): boolean {
  return (
    /constraints\/iam\.allowedPolicyMemberDomains/i.test(stderr) ||
    /do not belong to a permitted customer/i.test(stderr) ||
    /FAILED_PRECONDITION[\s\S]*allUsers/i.test(stderr)
  );
}

async function configureGoogleOAuth(
  ctx: AdminDeps,
  input: {
    project: string;
    baseUrl: string;
    serviceAccount: string;
    clientId?: string;
    clientSecret?: string;
    secretExists: boolean;
  }
): Promise<string> {
  const io = ctx.io;
  let clientId = input.clientId ?? "";
  let clientSecret = input.clientSecret ?? "";

  if (!clientId || (!clientSecret && !input.secretExists)) {
    io.out("");
    io.out("Google OAuth client");
    io.out(
      `  1. Open: https://console.cloud.google.com/auth/clients/create?project=${input.project}`
    );
    io.out('  2. Application type: "Web application"');
    io.out(`  3. Authorized redirect URI: ${input.baseUrl}/auth/google/callback`);
    io.out("");

    if (!clientId) {
      clientId = await io.prompt("Client ID: ");
    }

    if (!clientSecret) {
      if (input.secretExists) {
        io.out("Leave the secret empty to keep the one already stored.");
      }

      clientSecret = await io.promptSecret("Client secret: ");
    }
  }

  if (!clientId) {
    throw new Error("A Google OAuth client ID is required for --auth google.");
  }

  if (!clientSecret) {
    if (!input.secretExists) {
      throw new Error("A Google OAuth client secret is required the first time.");
    }

    io.out(`ok    secret ${GOOGLE_CLIENT_SECRET_NAME} kept`);
  } else if (input.secretExists) {
    await mutate(
      ctx,
      [
        "secrets",
        "versions",
        "add",
        GOOGLE_CLIENT_SECRET_NAME,
        "--project",
        input.project,
        "--data-file=-"
      ],
      clientSecret
    );
    io.out(`ok    secret ${GOOGLE_CLIENT_SECRET_NAME} updated`);
  } else {
    await createSecret(ctx, input.project, GOOGLE_CLIENT_SECRET_NAME, clientSecret);
    io.out(`ok    secret ${GOOGLE_CLIENT_SECRET_NAME} created`);
  }

  await grantSecretAccess(
    ctx,
    input.project,
    GOOGLE_CLIENT_SECRET_NAME,
    input.serviceAccount
  );

  return clientId;
}

async function confirmDevPreview(ctx: AdminDeps, yes: boolean): Promise<boolean> {
  ctx.io.out("");
  ctx.io.out(
    "WARNING: dev-preview auth means anyone with the URL can read and comment on every report."
  );
  ctx.io.out("Use it for private validation only, never for real review.");

  return yes ? true : ctx.io.confirm("Continue with dev-preview auth?");
}

async function verifyDeployment(
  ctx: AdminDeps,
  baseUrl: string,
  authMode: AuthMode
): Promise<void> {
  const io = ctx.io;

  try {
    const response = await ctx.fetch(baseUrl);

    if (response.status === 403) {
      io.out(
        "warn  the platform refused the request (403); an organization policy may block public services"
      );
    } else {
      io.out(
        response.status < 500
          ? `ok    service answers (${response.status})`
          : `warn  service answered ${response.status}`
      );
    }
  } catch (error) {
    io.out(
      `warn  cannot reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  try {
    const response = await ctx.fetch(`${baseUrl}/api/publish-config`);

    if (response.status === 401 || response.status === 403) {
      io.out("ok    anonymous API access refused");
    } else if (response.status >= 200 && response.status < 300) {
      if (authMode === "google") {
        io.err("");
        io.err(
          `WARNING: /api/publish-config answered ${response.status} without a token.`
        );
        io.err("This instance looks world-readable. Check it before publishing anything.");
      } else {
        io.out(
          `warn  anonymous API access answered ${response.status}; expected in dev-preview mode`
        );
      }
    } else {
      io.out(
        `warn  anonymous access check answered ${response.status}; try pagelet admin status later`
      );
    }
  } catch (error) {
    io.out(
      `warn  cannot check anonymous access: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (authMode !== "google") {
    return;
  }

  try {
    const response = await ctx.fetch(`${baseUrl}/auth/google`, {
      redirect: "manual"
    });
    const location = response.headers.get("location") ?? "";

    io.out(
      response.status >= 300 &&
        response.status < 400 &&
        location.includes("accounts.google.com")
        ? "ok    sign-in redirects to accounts.google.com"
        : `warn  sign-in did not redirect to Google (${response.status})`
    );
  } catch (error) {
    io.out(
      `warn  cannot check sign-in: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function createSecret(
  ctx: AdminDeps,
  project: string,
  name: string,
  value: string
): Promise<void> {
  return mutate(
    ctx,
    [
      "secrets",
      "create",
      name,
      "--project",
      project,
      "--replication-policy",
      "automatic",
      "--data-file=-",
      `--labels=${MANAGED_LABEL}`
    ],
    value
  );
}

async function grantSecretAccess(
  ctx: AdminDeps,
  project: string,
  name: string,
  serviceAccount: string
): Promise<void> {
  await mutate(ctx, [
    "secrets",
    "add-iam-policy-binding",
    name,
    "--project",
    project,
    "--member",
    `serviceAccount:${serviceAccount}`,
    "--role",
    "roles/secretmanager.secretAccessor"
  ]);
}

/** Secret values travel on stdin, so an echoed command line stays safe to print. */
async function mutate(
  ctx: AdminDeps,
  args: string[],
  stdin?: string
): Promise<void> {
  const result = await ctx.gcloud(args, stdin);

  if (result.code !== 0) {
    throw new Error(
      [
        `Command failed: gcloud ${args.join(" ")}`,
        result.stderr.trim() || result.stdout.trim()
      ].join("\n")
    );
  }
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function configLine(
  label: string,
  value: string,
  flag: string,
  explicit: boolean
): string {
  return `  ${label.padEnd(18)}${value}  (${explicit ? flag : `${flag}, default`})`;
}

function planLine(
  action: "create" | "update" | "exists" | "enable",
  text: string
): string {
  const markers = {
    create: "+ create ",
    update: "~ update ",
    exists: "ok exists",
    enable: "enable   "
  };

  return `  ${markers[action]} ${text}`;
}
