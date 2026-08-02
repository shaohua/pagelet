# Deploying Pagelet

Pagelet is a single-tenant service: one organization runs one instance with
its own object storage, auth configuration, and allowed email domains.

There is no database. Reports, versions, comments, and CLI login state are
JSON documents in the same bucket that holds the report files, so a deployment
is one Cloud Run service and one bucket, it scales to zero, and there is
nothing to pause between sessions — the bucket is billed for what it holds.

Deployment is driven by the `pagelet admin` commands in the CLI. For a
guided first deployment, see [WALKTHROUGH.md](WALKTHROUGH.md).

## Prerequisites

- A Google Cloud project with billing enabled.
- The `gcloud` CLI, installed and authenticated (`gcloud auth login`).
- Node.js 22+ to run the CLI.

## Deploy

```sh
npm install -g @howtox/pagelet
pagelet admin setup
```

`setup` checks gcloud, your credentials, the project, and billing, prints a
plan of the resources it will create, and asks for confirmation before it
changes anything.

The plan covers:

- Enabled APIs: `run`, `storage`, `secretmanager`, `artifactregistry`, `iam`,
  `iamcredentials`.
- A `pagelet-run` service account.
- A `<project>-pagelet` bucket.
- An Artifact Registry remote repository, `pagelet-upstream`, mirroring
  `ghcr.io`. Cloud Run pulls the published
  `ghcr.io/shaohua/pagelet:<version>` image through it.
- Secret Manager secrets: an auto-generated `SESSION_SECRET`, plus
  `GOOGLE_CLIENT_SECRET` or `PAGELET_DEV_TOKEN` depending on the auth mode.
- The Cloud Run service, labeled `pagelet-managed=true`.

In `google` auth mode there is one manual step. Setup prints the exact
redirect URI (`<base-url>/auth/google/callback`), you create a Web application
OAuth client in the Google Cloud console with that URI, and setup prompts for
the client ID and secret before the single deploy.

`setup` is idempotent. Re-running it converges the deployment to the current
flags, so upgrading is:

```sh
npm install -g @howtox/pagelet@latest
pagelet admin setup
```

### Flags

| Flag | Meaning |
| --- | --- |
| `--project` | Google Cloud project. Default: your gcloud config. |
| `--region` | Cloud Run region. Default: `us-central1`. |
| `--allow` | Comma-separated reviewer email domains. Default: the domain of your gcloud account. Required explicitly for public-provider accounts such as `gmail.com`. |
| `--auth` | `google` or `dev-preview`. Default: `google`. |
| `--domain` | Custom base URL for the service. |
| `--bucket` | Bucket name. |
| `--service` | Cloud Run service name. |
| `--google-client-id`, `--google-client-secret` | Supply OAuth credentials and skip the interactive prompt. |
| `--allowed-external-origins` | Origins reports may load assets from. |
| `--source <dir>` | Deploy from a source checkout through Cloud Build instead of the published image. For forks. |
| `--dry-run` | Print the plan and exit without changing anything. |
| `--yes` | Skip the confirmation prompt. |
| `--verbose` | Print the gcloud commands as they run. |

`--auth dev-preview` deploys an instance where anyone with the URL can read
and comment on every report. Use it for private validation only.

## Inspect

```sh
pagelet admin status
```

Reports the service URL, the deployed version, the auth mode, the bucket, and
service health.

## Remove

```sh
pagelet admin destroy
```

Removes the managed resources: the Cloud Run service, the service account, the
secrets, and the registry mirror. It only touches resources labeled
`pagelet-managed=true`, and it never deletes the Google Cloud project.

The bucket and its data are kept unless you pass `--delete-data`, which
requires typing the bucket name to confirm (`--yes` skips both
confirmations). If the service is already gone and the deployment used a
non-default bucket name, name it with `--bucket`.

## Runtime configuration

`pagelet admin setup` sets these on the Cloud Run service. They are also the
environment variables to set if you deploy the container yourself.

- `SESSION_SECRET`: strong random session secret.
- `APP_BASE_URL`: public origin of the deployed app.
- `ALLOWED_EMAIL_DOMAINS`: comma-separated list of allowed email domains.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: required for Google OAuth.
- `GCS_BUCKET`: bucket holding report HTML, assets, and data documents.
- `PAGELET_STORAGE_BACKEND=gcs`: store in the bucket rather than on local
  disk. Without it, Pagelet writes to `.pagelet-storage/`, which is what
  `npm run dev` uses and what a single-node deployment with a persistent disk
  can use.

`PAGELET_DEV_AUTH=1` and `PAGELET_DEV_TOKEN` are development conveniences.
Do not use preview auth for a public or production deployment.

## Smoke test

Check the deployed publish and review path:

```sh
PAGELET_DEPLOYED_URL="$APP_BASE_URL" PAGELET_TOKEN="$PAGELET_DEV_TOKEN" npm run smoke:deployed
```

## Security

Reports are untrusted HTML, rendered in sandboxed iframes under a restrictive
Content Security Policy. Review `web/src/security/render-policy.ts`
before changing allowed external origins or sandbox settings, and read
[SECURITY.md](SECURITY.md) before deploying with sensitive data.
