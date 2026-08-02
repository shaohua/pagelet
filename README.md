# Pagelet

Review agent-generated HTML reports in the browser, and send the feedback
back as a prompt.

Pagelet publishes an HTML report to a shareable URL, lets reviewers pin
comments to selected text or page elements, and exports the feedback as
Markdown that carries the CSS selector and exact quote for each item — so a
coding agent can act on it without reopening the report. Self-hosted, MIT
licensed, no database.

```
npm install -g @howtox/pagelet

pagelet publish report.html      # → https://pagelet.example.com/p/pl_x7Kd2a
                                 #   teammates comment on the rendered page
pagelet feedback pl_x7Kd2a       # → Markdown your agent can act on
```

Standalone binaries that need no Node.js are attached to each
[release](https://github.com/shaohua/pagelet/releases).

## The feedback export

```markdown
### 1. [blocking] replace

Target: `main > section:nth-of-type(2) > p`
Text: "Revenue grew 12% year over year."

This contradicts the summary table; it should be 9%.

### 2. [normal] question

Target: `table#metrics tbody tr:nth-of-type(3)`
Text: "Churn 4.1%"

Where does this figure come from?
```

Item kinds name the edit to make: `replace`, `delete`, `change_request`,
`question` (answer it, don't edit), `approve` (leave it alone), `note`.
The agent reads this digest, never the report HTML, so feedback costs
roughly as many tokens as the comments themselves.

## Use with a coding agent

[skills/pagelet/SKILL.md](skills/pagelet/SKILL.md) is an agent skill. Copy it
into a project's `.claude/skills/pagelet/` to teach Claude Code the loop:
publish the report, hand the URL to the reviewers and stop, then run
`pagelet feedback` later and apply each item by its selector and kind before
publishing the same file again as the next version.

## Status

Preview software. The loop runs end to end and the test suite covers it, but
it has not been hardened by real-world use. Read [SECURITY.md](SECURITY.md)
before pointing it at anything sensitive.

## Quickstart

Node.js 22+.

```sh
npm ci
npm run dev
```

`npm run dev` writes to `.pagelet-storage/` — no database, no bucket, no OAuth
client. Publish the demo report:

```sh
PAGELET_API_URL=http://127.0.0.1:3000 PAGELET_TOKEN=dev-token \
  npx @howtox/pagelet publish demo/reports/dashboard-v1.html
```

Open the printed `/p/:shareId` URL, click **Comment**, select a sentence,
choose what should change, and save. Then:

```sh
PAGELET_API_URL=http://127.0.0.1:3000 PAGELET_TOKEN=dev-token \
  npx @howtox/pagelet feedback <shareId>
```

To check the repository state: `npm run typecheck && npm run lint && npm test
&& npm run demo:smoke`.

## Storage

There is no database. Reports, versions, comments, and CLI login state are
JSON documents stored next to the report files — `.pagelet-storage/` locally,
a GCS bucket when deployed (`PAGELET_STORAGE_BACKEND=gcs`). Concurrent writes
use compare-and-swap on object generations; the design and its accepted
limits are documented in
[web/src/server/document-store.ts](web/src/server/document-store.ts).

## Configuration

Copy `.env.example` to `.env` for local overrides.

- `PAGELET_DEV_AUTH=1` — local-only development auth.
- `PAGELET_DEV_TOKEN` — local CLI bearer token.
- `SESSION_SECRET` — required in production.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth.
- `ALLOWED_EMAIL_DOMAINS` — comma-separated allowed domains.
- `PAGELET_STORAGE_BACKEND=gcs` and `GCS_BUCKET` — store in a bucket.

## Security

Reports are untrusted HTML. They render in sandboxed iframes without
`allow-same-origin`, under a restrictive Content Security Policy. Commenting
uses a bridge script injected into the report iframe that reports element
geometry, selectors, and selected text to the parent viewer over
`postMessage` — the parent never touches the report's DOM. See
[SECURITY.md](SECURITY.md).

## Repository layout

- `web` — web app, API routes, viewer, auth, storage.
- `cli` — the `pagelet` CLI, published as `@howtox/pagelet`.
- `shared` — schemas, types, and the feedback renderer.
- `demo` — demo reports and the end-to-end smoke test.
- [DEPLOY.md](DEPLOY.md) — the Cloud Run deployment doc.
- [WALKTHROUGH.md](WALKTHROUGH.md) — one deployment, end to end.
- `landing` — static landing page.

## License

MIT. See [LICENSE](LICENSE). Contributions welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md).
