# Security Policy

Pagelet is an open-source preview and is not yet production-hardened.

## Supported Versions

Only the current `main` branch receives security fixes during the preview
period.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability.

Use GitHub private vulnerability reporting on this repository ("Report a
vulnerability" under the Security tab). Include a concise description, impact,
and reproduction steps.

## Current Security Model

Pagelet renders user-published HTML inside a sandboxed iframe. The viewer does
not grant `allow-same-origin` to report iframes. Reports are served with a
restrictive Content Security Policy, and inspector-style commenting uses a small
injected iframe bridge for element geometry and anchors.

Production deployments must provide:

- A strong `SESSION_SECRET`.
- Google OAuth client credentials when web login is enabled.
- A private storage bucket. It holds the report HTML, assets, and Pagelet's
  data documents, so bucket access is equivalent to full data access.
- Carefully scoped allowed email domains.

## Known Preview Limitations

- The local development auth path is for development and demos only.
- `pagelet admin setup --auth dev-preview` deploys an instance that anyone with
  the URL can read and comment on. It is for private validation only.
- HTML rendering, CSP, sandboxing, and external asset allowlists need review for
  each deployment's threat model.
