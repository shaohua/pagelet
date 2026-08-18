# Deploying Pagelet

Pagelet deploys two Cloud Run services backed by one private GCS bucket:

| Service | Access | Purpose |
| --- | --- | --- |
| `pagelet` | Google IAP, limited to configured work domains | Viewer, comments, reports, and CLI approval |
| `pagelet-creator` | Public edge; tokens protect publish and feedback | Creator API and CLI login start/poll |

The creator service has no viewer or report routes. CLI login is approved on
the IAP-protected viewer; creators do not need `gcloud` or a Google OAuth
client.

## Prerequisites

- Node.js 22+.
- A billed Google Cloud project attached to a Google Workspace or Cloud
  Identity organization.
- An authenticated `gcloud` CLI account with permission to manage that project.
- A private work domain. Shared domains such as `gmail.com` are rejected.

## Deploy or upgrade

```sh
npm install -g @howtox/pagelet@latest
pagelet admin setup --project my-pagelet
```

Setup shows a plan and asks before changing anything. It enables the required
APIs and converges the bucket, runtime service account, Artifact Registry
remote repository, IAM policy, and both Cloud Run services. Re-run the command
to upgrade.

| Setup flag | Meaning |
| --- | --- |
| `--project <id>` | Google Cloud project; required. |
| `--region <region>` | Cloud Run region; default `us-central1`. |
| `--service <name>` | Viewer name; creator becomes `<name>-creator`. |
| `--bucket <name>` | Bucket; default `<project>-pagelet`. |
| `--allow <domains>` | Additional work domains, comma-separated. |
| `--domain <https-url>` | Viewer URL after custom-domain mapping. |
| `--allowed-external-origins <csv>` | Allowed origins report content may load from. |
| `--image <ref>` | Deploy a different image. |
| `--source <dir>` | Build a fork once with Cloud Build and deploy it to both services. |
| `--dry-run` | Print the plan only. |
| `--yes`, `-y` | Skip confirmation. |
| `--verbose` | Print `gcloud` commands. |

Setup grants IAP access to the active admin and configured domains. On an
interactive terminal it also opens the CLI approval flow and stores a creator
token for the admin.

## Add a creator

Get the creator URL from setup or `pagelet admin status`, then run:

```sh
PAGELET_API_URL=https://pagelet-creator-123456.us-central1.run.app pagelet login
```

Approve the request in the browser. The CLI stores the resulting 30-day token
in `~/.pagelet/config.json`; later publish and feedback commands reuse it.

## Inspect or remove

```sh
pagelet admin status --project my-pagelet
pagelet admin destroy --project my-pagelet
```

`setup` and `destroy` require `--project`; read-only `status` may use the
`gcloud` default. All three accept `--region` and `--service`.

Destroy removes Pagelet-managed services, the runtime service account, the
registry mirror, and managed legacy secrets. It keeps the bucket and reports
unless `--delete-data` is passed, and never deletes the Google Cloud project.
For a non-default bucket, pass `--bucket` if neither service remains to supply
its name.

## Runtime configuration

Setup configures both services with the appropriate `PAGELET_SURFACE`, IAP
mode, allowed domains, viewer URL, and GCS settings. The viewer also receives
its IAP audience. Development authentication is disabled in production.

Reports are untrusted HTML rendered in sandboxed iframes under a restrictive
Content Security Policy. Review [SECURITY.md](SECURITY.md) before publishing
sensitive material.
