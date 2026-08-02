import { describe, expect, it } from "vitest";
import {
  reportContentSecurityPolicy,
  reportIframeSandbox
} from "./render-policy";

describe("report render policy", () => {
  it("allows bundled same-origin assets while blocking runtime network access", () => {
    const csp = reportContentSecurityPolicy();

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("font-src 'self' data:");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'none'");
  });

  it("adds allow-listed external origins only to static asset directives", () => {
    const csp = reportContentSecurityPolicy(["https://cdn.example.com"]);

    expect(csp).toContain(
      "script-src 'self' 'unsafe-inline' https://cdn.example.com"
    );
    expect(csp).toContain(
      "style-src 'self' 'unsafe-inline' https://cdn.example.com"
    );
    expect(csp).toContain("img-src 'self' data: blob: https://cdn.example.com");
    expect(csp).toContain("font-src 'self' data: https://cdn.example.com");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("connect-src 'none' https://cdn.example.com");
  });

  it("keeps report iframes script-capable but cross-origin isolated", () => {
    expect(reportIframeSandbox).toBe("allow-scripts");
    expect(reportIframeSandbox).not.toContain("allow-same-origin");
  });
});
