# Walkthrough: deploy Pagelet and run one review

This takes an empty Google Cloud project to one published report. Reference
details are in [DEPLOY.md](DEPLOY.md).

## 1. Prepare the project

Use an existing billed project, or create one:

```sh
gcloud auth login
gcloud projects create my-pagelet --name="Pagelet"
gcloud billing accounts list
gcloud billing projects link my-pagelet --billing-account=<ACCOUNT_ID>
```

The active account should belong to the Workspace domain that will use
Pagelet. Setup rejects public email domains such as `gmail.com`.

## 2. Preview and deploy

```sh
npm install -g @howtox/pagelet
pagelet admin setup --project my-pagelet --dry-run
pagelet admin setup --project my-pagelet
```

The plan creates one bucket, one runtime identity, and two services from the
same image:

- `pagelet`, the IAP-protected viewer;
- `pagelet-creator`, the token-protected CLI API.

There is no OAuth consent-screen or client-credential step. Setup configures
IAP for the active admin and their work domain, verifies both surfaces, then
opens a viewer page where the admin approves a creator token for this machine.

To allow more than one work domain, deploy with for example
`--allow example.com,subsidiary.example`.

## 3. Publish

Setup leaves the admin machine logged in:

```sh
pagelet publish report.html
```

Relative images and CSS are uploaded with the HTML. Publishing the same file
again creates the next version; `.pagelet.publish.json` beside the file keeps
the binding.

## 4. Review and export feedback

Send the printed viewer URL to a teammate in the allowed domain. IAP asks them
to sign in, then they can read and comment on the report.

Pull the comments back into the creator workflow:

```sh
pagelet feedback <shareId>
```

Address the feedback and publish the same file to create version 2.

## 5. Add another creator

Creators install only Pagelet, not gcloud:

```sh
npm install -g @howtox/pagelet
PAGELET_API_URL=<creator-url-from-admin-status> pagelet login
```

They approve the request in their browser behind IAP. The resulting local
token works for publish and feedback for 30 days.

## 6. Operate it

```sh
pagelet admin status
pagelet admin setup     # converge or upgrade both services
pagelet admin destroy   # remove services; keep report data
```

Use `pagelet admin destroy --delete-data` only when the bucket and every report
should also be deleted.

Forks can use `--source <dir>`; setup builds once with Cloud Build and deploys
the resulting image to both services.
