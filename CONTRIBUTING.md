# Contributing

Keep changes focused, follow existing patterns, and add tests for behavior
changes. Update documentation when commands, setup, security assumptions, or
workflows change.

## Development

Requires Node.js 22+.

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run demo:smoke
```

Run the local app with `npm run dev`. It uses development authentication and
file-backed storage by default. `.env.example` lists optional environment
variables; export overrides in the shell that starts the app.

## Pull requests

- Explain the user-visible change.
- Keep unrelated changes out of the pull request.
- Include relevant tests and note what you ran.
- Update affected docs.

## Issues

Include the command or route, expected and actual behavior, reproduction steps,
relevant logs, and your Pagelet, Node.js, npm, and browser versions. Report
security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
