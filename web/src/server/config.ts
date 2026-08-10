import { demoOrganization, demoPublishConfig } from "@pagelet/shared";

export function getAllowedExternalOrigins(): string[] {
  return parseAllowedExternalOrigins(process.env.PAGELET_ALLOWED_EXTERNAL_ORIGINS);
}

export function parseAllowedExternalOrigins(raw: string | undefined): string[] {
  if (raw === undefined) {
    return demoPublishConfig.allowedExternalOrigins;
  }

  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => new URL(origin).origin);
}

export function getAllowedEmailDomains(): string[] {
  return parseAllowedEmailDomains(process.env.ALLOWED_EMAIL_DOMAINS);
}

export function parseAllowedEmailDomains(raw: string | undefined): string[] {
  if (raw === undefined) {
    return demoOrganization.allowedDomains;
  }

  return raw
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
}

export function getPublicAppBaseUrl(requestUrl: string): string {
  const configuredBaseUrl = process.env.APP_BASE_URL?.trim();

  if (configuredBaseUrl) {
    return new URL(configuredBaseUrl).origin;
  }

  return new URL(requestUrl).origin;
}

/**
 * The origin a client outside the load balancer must call to reach *this*
 * service. Cloud Run terminates TLS at the edge and forwards plain HTTP, so
 * `request.url` reads as `http://` on every request. Handing that origin back
 * to a client produces a URL it cannot use, so trust the proxy's forwarded
 * headers over the scheme we observe on the socket.
 */
export function getPublicRequestOrigin(request: Request): string {
  const url = new URL(request.url);
  const forwardedHost = firstForwardedValue(request, "x-forwarded-host");
  const forwardedProto = firstForwardedValue(request, "x-forwarded-proto");

  if (forwardedHost) {
    url.host = forwardedHost;
  }

  if (forwardedProto) {
    url.protocol = `${forwardedProto}:`;
  }

  return url.origin;
}

/** Proxies append rather than replace, so the client-facing value is first. */
function firstForwardedValue(request: Request, header: string): string | undefined {
  const raw = request.headers.get(header);
  return raw?.split(",")[0]?.trim() || undefined;
}
