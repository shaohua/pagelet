# Security Policy

Pagelet is open-source preview software and is not yet production-hardened.

## Reporting a vulnerability

Do not open a public issue. Use GitHub private vulnerability reporting and
include impact and reproduction steps.

## Current security model

- The viewer Cloud Run service is protected by IAP by default. Setup grants
  access only to configured Google Workspace or Cloud Identity domains.
- Pagelet verifies IAP's signed assertion, expected Cloud Run audience, email
  domain, and hosted-domain claim before serving data.
- The creator Cloud Run service is reachable without Cloud Run invoker IAM so a
  creator CLI needs neither gcloud nor Google OAuth credentials. It exposes no
  viewer/report routes; publish and feedback routes require a Pagelet token.
- CLI approval happens only in the IAP-protected viewer. Device codes use 128
  bits of randomness. Creator tokens are stored hashed in the private bucket,
  are scoped to creator operations, and expire after 30 days.
- One private GCS bucket holds report HTML, assets, comments, and auth records.
  Bucket access is equivalent to full Pagelet data access.
- Published HTML runs in a sandboxed iframe without `allow-same-origin`, under
  a restrictive Content Security Policy. A small injected bridge reports
  selectors, selected text, and geometry to the parent viewer.

## Known preview limitations

- Device-login start and poll must be anonymously reachable on the creator API.
  Device codes are bearer secrets until they expire, so they must not be logged
  or shared. These preview endpoints are not yet rate-limited.
- Any member of an allowed work domain can view, comment, approve a creator
  login, and therefore become a creator. There is no per-user creator allowlist.
- Revoking a user in Google Workspace immediately removes viewer access, but an
  already-issued creator token remains valid until its 30-day expiry unless its
  auth record is removed from the bucket.
- The local development auth path is for development and demos only.
- CSP, sandbox, and external-origin changes require a threat-model review.
