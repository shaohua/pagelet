# Deploying Pagelet

Pagelet is a single-organization service. One codebase and one storage bucket
back two Cloud Run services:

| Service | Edge access | Routes |
| --- | --- | --- |
| `pagelet` | IAP; Workspace domain only | Viewer, reports, comments, CLI approval |
| `pagelet-creator` | Reachable at the edge | Token-protected publish and feedback API, plus device-login start/poll |

The creator service contains no report or viewer routes. Its useful API routes
require a scoped Pagelet token. The viewer service never accepts that token as
a way around IAP.

This keeps the roles simple:

- The admin needs `gcloud` to deploy and manage the instance.
- A creator runs `pagelet login` once, approves it in the IAP-protected viewer,
  and then uses the saved Pagelet token. They do not need `gcloud`.
- A viewer signs in through IAP in the browser.
- No one creates or owns a separate Google OAuth client for Pagelet.

## Prerequisites

- A Google Cloud project with billing enabled.
- An administrator with the `gcloud` CLI installed and authenticated.
- A Google Cloud project attached to your Google Workspace or Cloud Identity
  organization. This lets direct Cloud Run IAP use Google-managed OAuth
  configuration; Pagelet intentionally does not fall back to a custom client.
- A private work domain. Public domains such as `gmail.com` are intentionally
  rejected.
- Node.js 22+ to run the CLI.

## Deploy

```sh
npm install -g @howtox/pagelet
pagelet admin setup --project my-pagelet
```

Setup checks the project, prints its plan, and asks before changing anything.
It creates or converges:

- the required Run, Storage, IAM, Artifact Registry, and IAP APIs;
- one `pagelet-run` runtime service account;
- one private `<project>-pagelet` bucket;
- an Artifact Registry remote repository for the released image; and
- the IAP viewer and creator API services, using the same image.

IAP access is granted to the admin and every identity in the configured work
domain. The creator service uses Cloud Run's invoker-IAM-check exemption so it
also works in projects with Domain Restricted Sharing; authorization remains
in the creator API.

Setup finishes by opening the same browser approval flow creators use and saves
a creator token on the admin's machine. Re-running setup is the upgrade path:

```sh
npm install -g @howtox/pagelet@latest
pagelet admin setup --project my-pagelet
```

### Flags

| Flag | Meaning |
| --- | --- |
| `--project` | Google Cloud project; defaults to the gcloud config. |
| `--region` | Cloud Run region; default `us-central1`. |
| `--service` | Viewer service name; creator is derived as `<name>-creator`. |
| `--allow` | Additional in-organization Workspace domains; the admin's domain is always included. |
| `--domain` | Viewer URL after you configure a custom domain. |
| `--bucket` | Bucket name. |
| `--allowed-external-origins` | Extra origins report HTML may load from. |
| `--image` | Deploy a different container image to both services. |
| `--source <dir>` | Build a fork once with Cloud Build and reuse its image for both services. |
| `--dry-run` | Print the plan without changing anything. |
| `--yes` | Skip confirmation. |
| `--verbose` | Echo gcloud commands. |

## Add a creator machine

Copy the creator URL from setup or `pagelet admin status`, then run:

```sh
PAGELET_API_URL=https://pagelet-creator-123456.us-central1.run.app pagelet login
```

The CLI prints and opens an approval URL on the viewer service. IAP signs the
creator in with their Workspace account; approving saves a 30-day Pagelet token
locally. Subsequent `pagelet publish` and `pagelet feedback` commands use that
token without gcloud.

## Inspect and remove

```sh
pagelet admin status
pagelet admin destroy
```

Status checks that the viewer is IAP-protected, anonymous creator operations
are refused, and report routes are absent from the creator service.

Destroy removes both managed services, the runtime service account, and the
registry mirror. It also cleans up legacy Pagelet secrets when present. The
bucket and reports remain unless `--delete-data` is passed; Pagelet never
deletes the Google Cloud project.

## Runtime configuration

Setup configures both services with:

- `PAGELET_SURFACE=viewer` or `creator`;
- `PAGELET_DEPLOY_AUTH_MODE=iap`;
- `APP_BASE_URL`, always pointing to the viewer;
- `ALLOWED_EMAIL_DOMAINS`;
- `PAGELET_STORAGE_BACKEND=gcs` and `GCS_BUCKET`; and
- `PAGELET_IAP_AUDIENCE` on the viewer only.

`PAGELET_DEV_AUTH` and `PAGELET_DEV_TOKEN` are local development conveniences
and are always disabled by admin setup.

Reports are untrusted HTML rendered in sandboxed iframes under a restrictive
Content Security Policy. Read [SECURITY.md](SECURITY.md) before using sensitive
data.
