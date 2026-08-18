# Pagelet

Pagelet publishes an HTML report for browser review, then exports anchored
comments as Markdown a coding agent can apply. Reports are self-hosted and
stored as files locally or in Google Cloud Storage; no database is required.

```sh
npm install -g @howtox/pagelet
pagelet publish report.html
# Share the printed URL for review.
pagelet feedback report.html
```

Publishing the same file creates a new version at the same URL. The CLI keeps
file-to-report bindings in `~/.pagelet/pages.json`. Standalone executables are
available from [GitHub Releases](https://github.com/shaohua/pagelet/releases).

## Local development

Requires Node.js 22+.

```sh
npm ci
npm run dev
```

The app runs at `http://127.0.0.1:3000`, uses development authentication, and
writes data to `.pagelet-storage/`. In another terminal:

```sh
PAGELET_API_URL=http://127.0.0.1:3000 PAGELET_TOKEN=dev-token \
  pagelet publish demo/reports/dashboard-v1.html
PAGELET_API_URL=http://127.0.0.1:3000 PAGELET_TOKEN=dev-token \
  pagelet feedback demo/reports/dashboard-v1.html
```

Run all checks with:

```sh
npm run typecheck && npm run lint && npm test && npm run demo:smoke
```

## Documentation

- [Deployment](DEPLOY.md)
- [End-to-end walkthrough](WALKTHROUGH.md)
- [Security model](SECURITY.md)
- [Agent skill](skills/pagelet/SKILL.md)
- [Contributing](CONTRIBUTING.md)

Pagelet is preview software. It is licensed under the [MIT License](LICENSE).
