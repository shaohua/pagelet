# Security Policy

Pagelet is preview software and is not production-hardened.

## Report a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting and
include the impact and reproduction steps.

## Security model

- The viewer is protected by Google IAP and limited to configured Workspace or
  Cloud Identity domains. Pagelet verifies the signed assertion, Cloud Run
  audience, email domain, and hosted-domain claim.
- The creator service is reachable without Cloud Run invoker IAM, but exposes
  no viewer/report routes. Publish and feedback operations require a scoped
  Pagelet token.
- CLI approval occurs on the IAP-protected viewer. Login codes contain 128 bits
  of randomness and expire after 10 minutes. Creator tokens are stored hashed
  in the private bucket and expire after 30 days.
- One private GCS bucket contains reports, assets, comments, and authentication
  records. Bucket access is equivalent to full Pagelet data access.
- Report HTML runs in an iframe sandboxed with only `allow-scripts`. Its Content
  Security Policy blocks network connections and allows content only from
  Pagelet plus configured external origins. The parent receives selectors,
  selected text, and geometry through `postMessage`.

## Preview limitations

- CLI login start/poll endpoints are anonymous and are not rate-limited. Treat
  login codes as short-lived bearer secrets.
- Every member of an allowed domain can view, comment, and approve CLI login;
  there is no per-user creator allowlist.
- Removing Workspace access blocks viewer access immediately, but an issued
  creator token remains valid until expiry unless its record is removed from
  the bucket.
- Development authentication is only for local use.
- Changes to iframe sandboxing, CSP, or external origins require threat review.
