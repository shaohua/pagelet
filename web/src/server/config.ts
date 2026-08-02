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
