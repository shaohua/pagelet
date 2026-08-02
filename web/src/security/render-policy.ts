export const reportIframeSandbox = "allow-scripts";

export function reportContentSecurityPolicy(
  allowedExternalOrigins: string[] = []
): string {
  return [
    "default-src 'none'",
    directive("script-src", ["'self'", "'unsafe-inline'", ...allowedExternalOrigins]),
    directive("style-src", ["'self'", "'unsafe-inline'", ...allowedExternalOrigins]),
    directive("img-src", ["'self'", "data:", "blob:", ...allowedExternalOrigins]),
    directive("font-src", ["'self'", "data:", ...allowedExternalOrigins]),
    "connect-src 'none'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'none'"
  ].join("; ");
}

function directive(name: string, values: string[]): string {
  return [name, ...values].join(" ");
}
