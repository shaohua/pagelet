# Walkthrough

This takes a billed Google Cloud project to one reviewed report. See
[DEPLOY.md](DEPLOY.md) for prerequisites and every option.

## 1. Deploy

Authenticate `gcloud`, then preview and apply the plan:

```sh
gcloud auth login
npm install -g @howtox/pagelet
pagelet admin setup --project my-pagelet --dry-run
pagelet admin setup --project my-pagelet
```

The project must belong to a Google Workspace or Cloud Identity organization.
Setup creates the IAP-protected viewer, the token-protected creator API, and
shared storage. On an interactive terminal it then opens a browser so you can
approve this machine's creator token.

To allow another organization domain, add `--allow example.com`. Forks can use
`--source <dir>` to build once and deploy the resulting image to both services.

## 2. Publish and review

```sh
pagelet publish report.html
```

Share the printed viewer URL with someone in an allowed domain. Referenced
local styles, scripts, and images are uploaded with the report. Publishing the
same file again creates the next version at the same URL.

After review, export the comments:

```sh
pagelet feedback report.html
```

Apply the feedback, then publish the same file again.

## 3. Add another creator

```sh
npm install -g @howtox/pagelet
PAGELET_API_URL=<creator-url> pagelet login
```

The creator URL is printed by setup and `pagelet admin status`. Approval occurs
on the viewer behind IAP; the saved token expires after 30 days.

## 4. Operate or remove

```sh
pagelet admin status --project my-pagelet
pagelet admin setup --project my-pagelet
pagelet admin destroy --project my-pagelet
```

Destroy keeps report data by default. Add `--delete-data` only when the bucket
and everything in it should also be deleted.
