import type { AdminDeps } from "./deps.js";
import {
  describeBucket,
  describeRepository,
  describeSecret,
  describeService,
  describeServiceAccount,
  isManaged,
  serviceEnv
} from "./gcp.js";
import {
  DEFAULT_REGION,
  DEFAULT_SERVICE,
  MANAGED_DESCRIPTION,
  SECRET_NAMES,
  UPSTREAM_REPO,
  defaultBucket,
  serviceAccountEmail
} from "./names.js";
import { preflight } from "./preflight.js";

export type DestroyOptions = {
  project?: string;
  region?: string;
  service?: string;
  bucket?: string;
  deleteData: boolean;
  yes: boolean;
};

type Deletion = {
  label: string;
  args: string[];
};

export async function runDestroy(args: string[], deps: AdminDeps): Promise<number> {
  const options = parseDestroyArgs(args);
  const io = deps.io;
  const region = options.region ?? DEFAULT_REGION;
  const service = options.service ?? DEFAULT_SERVICE;
  const { project } = await preflight(deps, options.project);
  const serviceAccount = serviceAccountEmail(project);

  const deletions: Deletion[] = [];
  const skips: string[] = [];

  const deployed = await describeService(deps.gcloud, { project, region, service });

  if (deployed && isManaged(deployed.metadata?.labels)) {
    deletions.push({
      label: `Cloud Run service ${service}`,
      args: [
        "run",
        "services",
        "delete",
        service,
        "--project",
        project,
        "--region",
        region,
        "--quiet"
      ]
    });
  } else if (deployed) {
    skips.push(`Cloud Run service ${service}: not managed by pagelet admin`);
  }

  for (const name of SECRET_NAMES) {
    const secret = await describeSecret(deps.gcloud, project, name);

    if (!secret) {
      continue;
    }

    if (isManaged(secret.labels)) {
      deletions.push({
        label: `secret ${name}`,
        args: ["secrets", "delete", name, "--project", project, "--quiet"]
      });
    } else {
      skips.push(`secret ${name}: not managed by pagelet admin`);
    }
  }

  const repository = await describeRepository(deps.gcloud, project, region);

  if (repository && isManaged(repository.labels)) {
    deletions.push({
      label: `artifact registry repo ${UPSTREAM_REPO}`,
      args: [
        "artifacts",
        "repositories",
        "delete",
        UPSTREAM_REPO,
        "--project",
        project,
        "--location",
        region,
        "--quiet"
      ]
    });
  } else if (repository) {
    skips.push(`artifact registry repo ${UPSTREAM_REPO}: not managed by pagelet admin`);
  }

  const account = await describeServiceAccount(deps.gcloud, project, serviceAccount);

  if (account?.description?.includes(MANAGED_DESCRIPTION)) {
    deletions.push({
      label: `service account ${serviceAccount}`,
      args: [
        "iam",
        "service-accounts",
        "delete",
        serviceAccount,
        "--project",
        project,
        "--quiet"
      ]
    });
  } else if (account) {
    skips.push(`service account ${serviceAccount}: not managed by pagelet admin`);
  }

  // Once the service is gone its GCS_BUCKET env is too, so a non-default
  // bucket can only be reached again through the flag.
  const bucket =
    options.bucket ??
    (deployed
      ? serviceEnv(deployed).GCS_BUCKET || defaultBucket(project)
      : defaultBucket(project));
  const bucketResource = await describeBucket(deps.gcloud, project, bucket);
  const bucketManaged = Boolean(bucketResource && isManaged(bucketResource.labels));
  const deletingBucket = options.deleteData && bucketManaged;

  if (bucketResource && !bucketManaged) {
    skips.push(`bucket gs://${bucket}: not managed by pagelet admin`);
  }

  io.out("");
  io.out("Plan");

  for (const deletion of deletions) {
    io.out(`  delete  ${deletion.label}`);
  }

  if (deletingBucket) {
    io.out(`  delete  bucket gs://${bucket} and every report in it`);
  } else if (bucketManaged) {
    io.out(
      `  keep    bucket gs://${bucket} (your reports and comments; pass --delete-data to delete it)`
    );
  }

  for (const skip of skips) {
    io.out(`  skipped ${skip}`);
  }

  if (deletions.length === 0 && !deletingBucket) {
    io.out("");
    io.out("Nothing to delete.");
    return 0;
  }

  io.out("");

  if (!options.yes && !io.isInteractive) {
    throw new Error("This terminal cannot ask for confirmation. Re-run with --yes.");
  }

  if (!options.yes && !(await io.confirm("Delete these resources?"))) {
    io.out("Aborted; nothing was deleted.");
    return 1;
  }

  // The guard above already rejected a non-interactive run without --yes, so
  // reaching this prompt implies a terminal that can answer it.
  if (deletingBucket && !options.yes) {
    const typed = await io.prompt(
      `Type the bucket name to confirm data deletion (${bucket}): `
    );

    if (typed !== bucket) {
      io.err("Bucket name did not match; nothing was deleted.");
      return 1;
    }
  }

  io.out("");
  let failed = false;

  for (const deletion of deletions) {
    if (!(await remove(deps, deletion))) {
      failed = true;
    }
  }

  if (deletingBucket) {
    // `storage rm --recursive` removes the objects and the bucket in one pass.
    const removed = await remove(deps, {
      label: `bucket gs://${bucket}`,
      args: ["storage", "rm", "--recursive", `gs://${bucket}`]
    });
    failed = failed || !removed;
  }

  io.out("");

  if (deletingBucket) {
    io.out(`Deleted gs://${bucket} and everything it held.`);
  } else if (bucketManaged) {
    io.out(`Your reports and comments are still in gs://${bucket}.`);
    io.out("Re-run pagelet admin setup to bring the service back.");
  }

  io.out("The Google Cloud project itself was not touched.");

  return failed ? 1 : 0;
}

export function parseDestroyArgs(args: string[]): DestroyOptions {
  const options: DestroyOptions = { deleteData: false, yes: false };

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

    if (flag === "--delete-data") {
      options.deleteData = true;
      continue;
    }

    if (flag === "--yes" || flag === "-y") {
      options.yes = true;
      continue;
    }

    throw new Error(`Unknown or incomplete admin destroy option: ${flag ?? ""}`);
  }

  return options;
}

/** A resource that is already gone is the outcome we wanted, not a failure. */
async function remove(deps: AdminDeps, deletion: Deletion): Promise<boolean> {
  const result = await deps.gcloud(deletion.args);

  if (result.code === 0) {
    deps.io.out(`ok    deleted ${deletion.label}`);
    return true;
  }

  if (/not found|does not exist/i.test(result.stderr)) {
    deps.io.out(`ok    ${deletion.label} was already gone`);
    return true;
  }

  deps.io.err(`fail  could not delete ${deletion.label}`);
  deps.io.err(result.stderr.trim());
  return false;
}
