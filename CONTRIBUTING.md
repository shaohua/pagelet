# Contributing

Thanks for helping improve Pagelet.

Pagelet is currently an open-source preview. The most useful contributions are
small, well-tested changes that keep the publish, review, feedback, and
republish loop working.

## Development

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run demo:smoke
```

For local web development:

```sh
npm run dev
```

The app uses local file-backed storage by default. Copy `.env.example` to
`.env` only when you need to override defaults.

## Pull Requests

- Keep changes focused.
- Prefer existing patterns over new abstractions.
- Include tests for behavior changes.
- Run `npm run typecheck`, `npm run lint`, and the relevant tests before opening a PR.
- Update README or docs when setup, security assumptions, or user workflows
  change.

## Reporting Issues

Please include:

- What you were trying to do.
- The command or route you used.
- Expected behavior.
- Actual behavior, including logs or screenshots when helpful.
- Your Node.js and npm versions.
