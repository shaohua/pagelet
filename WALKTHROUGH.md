# Walkthrough: deploy Pagelet and run one review

This walks one deployment from an empty Google Cloud project to a published
report with a comment on it. Reference documentation is in
[DEPLOY.md](DEPLOY.md). Time: about ten minutes, most of it waiting on
Google Cloud.

Prerequisites:

- Node.js 22+.
- The `gcloud` CLI, authenticated: `gcloud auth login`.
- A Google Cloud billing account.

## 1. Create a project

Any existing project with billing works; setup only adds labeled resources.
For a dedicated project:

```sh
gcloud projects create my-pagelet --name="Pagelet"
gcloud billing accounts list
gcloud billing projects link my-pagelet --billing-account=<ACCOUNT_ID>
```

## 2. Install the CLI and preview the plan

```sh
npm install -g @howtox/pagelet
pagelet admin setup --project my-pagelet --dry-run
```

`--dry-run` checks gcloud, billing, and the project, then prints the plan and
changes nothing:

```
Preflight
ok    Google Cloud SDK 576.0.0
ok    account you@example.com
ok    project my-pagelet
ok    project number 123456789012
ok    billing enabled
ok    service pagelet is not deployed yet

Configuration
  project           my-pagelet  (--project)
  region            us-central1  (--region, default)
  reviewer domains  example.com  (--allow, default)
  auth mode         google  (--auth, default)
  base URL          https://pagelet-123456789012.us-central1.run.app  (--domain, default)

Plan
  enable    (idempotent) APIs: run storage secretmanager artifactregistry iam iamcredentials
  + create  service account pagelet-run@my-pagelet.iam.gserviceaccount.com
  + create  bucket gs://my-pagelet-pagelet
  + create  artifact registry repo pagelet-upstream
  + create  secret pagelet-session-secret
  + create  secret pagelet-google-client-secret
  + create  Cloud Run service pagelet
```

Reviewer domains default to your gcloud account's email domain. Pass
`--allow example.com,partner.com` to name them yourself.

## 3. Run setup

```sh
pagelet admin setup --project my-pagelet
```

Setup prints the same plan, asks once for confirmation, creates the
resources, and deploys the released Pagelet image. In the default `google`
auth mode it pauses for the one step it cannot automate — creating the OAuth
client — and prints exactly what to do:

1. Open `https://console.cloud.google.com/auth/clients/create?project=my-pagelet`
   (a new project first asks you to configure the consent screen: set the
   app name and audience, no scopes needed).
2. Application type: **Web application**.
3. Authorized redirect URI: paste the line setup prints, which is your base
   URL plus `/auth/google/callback`.
4. Paste the client ID and secret back into the prompts. The secret goes to
   Secret Manager; it is never shown or stored on disk.

Setup then deploys, verifies the instance (it must answer, and it must
refuse anonymous API access), and finishes by logging your machine in
through the browser. The summary prints your instance URL.

If the deployed URL differs from the one predicted before the deploy, setup
corrects the configuration itself and tells you to update the OAuth
client's redirect URI to the printed value.

## 4. If your organization blocks public services

Pagelet needs to be reachable at the platform edge so reviewers can get to
the sign-in page; report content is protected by app auth behind it. In
organizations that enforce `constraints/iam.allowedPolicyMemberDomains`
(Domain Restricted Sharing), Cloud Run cannot grant that access, and setup
ends with:

```
Deployed, but reviewers cannot reach it: an organization policy
(constraints/iam.allowedPolicyMemberDomains) forbids public Cloud Run services.
Ask an organization admin to exempt this project, or deploy outside the
organization, then re-run: pagelet admin setup
```

An organization admin can add a project-level exception for the constraint
in the console (IAM & Admin → Organization Policies), after which re-running
setup completes the deployment. Personal projects outside an organization
are not affected.

## 5. Publish a report

Setup left your machine logged in, so from any directory:

```sh
pagelet publish report.html
```

```
Published Q2 Revenue Dashboard
Version: 1
URL: https://pagelet-xxxx-uc.a.run.app/p/pl_EAd567qq
```

Relative assets referenced by the HTML (images, CSS) are uploaded with it.
Publishing the same file again creates version 2 of the same report; the
binding lives in `.pagelet.publish.json` next to the file.

## 6. Review and export feedback

Send the `/p/…` URL to reviewers on an allowed email domain. They sign in
with Google, read the report, and comment: **Comment** anchors a note to a
selected element or passage, **Comment on whole report** covers the
document. Each comment carries a kind that names the edit to make —
`replace`, `delete`, `change_request`, `question`, `approve`, `note`.

Then pull everything back as Markdown your agent can act on:

```sh
pagelet feedback pl_EAd567qq
```

```
### 1. [normal] question

Target: whole report

Which quarter does the ARR by Month chart cover? Label the axis.
```

Address the items, publish the same file again, and reviewers see version 2.

## 7. Operate it

```sh
pagelet admin status     # URL, version, auth mode, bucket, health
pagelet admin destroy    # remove the service; reports stay in the bucket
```

Upgrading is `npm install -g @howtox/pagelet@latest` followed by
`pagelet admin setup` again — setup converges an existing deployment and
never rotates working secrets. `destroy --delete-data` also deletes the
bucket and requires typing its name. The service scales to zero; an idle
deployment costs approximately nothing beyond bucket storage.

## Notes for private validation

`--auth dev-preview` deploys without Google sign-in: a generated bearer
token (stored in Secret Manager, printed command to read it) authenticates
the CLI, and **anyone with the URL can read and comment on every report**.
Use it only to validate a deployment privately:

```sh
pagelet admin setup --project my-pagelet --auth dev-preview
gcloud secrets versions access latest --secret=pagelet-dev-token --project my-pagelet
PAGELET_API_URL=<url> PAGELET_TOKEN=<token> pagelet publish report.html
```

Forks can deploy their own code instead of the released image with
`--source <dir>`; setup grants Cloud Build the role it needs on fresh
projects and builds remotely (a few extra minutes).
