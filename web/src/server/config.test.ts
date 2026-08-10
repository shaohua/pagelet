import { demoPublishConfig } from "@pagelet/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPublicAppBaseUrl,
  getPublicRequestOrigin,
  parseAllowedEmailDomains,
  parseAllowedExternalOrigins
} from "./config";

const savedAppBaseUrl = process.env.APP_BASE_URL;

afterEach(() => {
  if (savedAppBaseUrl === undefined) {
    delete process.env.APP_BASE_URL;
  } else {
    process.env.APP_BASE_URL = savedAppBaseUrl;
  }
});

describe("server config", () => {
  it("uses demo publish origins when no env override is configured", () => {
    expect(parseAllowedExternalOrigins(undefined)).toEqual(
      demoPublishConfig.allowedExternalOrigins
    );
  });

  it("normalizes comma-separated external origins", () => {
    expect(
      parseAllowedExternalOrigins(
        " https://cdn.example.com/path ,https://fonts.example.com "
      )
    ).toEqual(["https://cdn.example.com", "https://fonts.example.com"]);
  });

  it("normalizes comma-separated allowed email domains", () => {
    expect(parseAllowedEmailDomains(" Example.com,TEAM.example ")).toEqual([
      "example.com",
      "team.example"
    ]);
  });

  it("prefers configured public app base URL over request origin", () => {
    process.env.APP_BASE_URL = "https://pagelet.example.com/app";

    expect(getPublicAppBaseUrl("http://internal.example.test/api/pagelets")).toBe(
      "https://pagelet.example.com"
    );
  });

  /**
   * Cloud Run terminates TLS at the edge, so `request.url` always reads as
   * http. Echoing that back gives the CLI a URL it cannot reach.
   */
  it("rebuilds this service's origin from forwarded proxy headers", () => {
    const request = new Request("http://pagelet-creator.internal/api/cli-login/start", {
      headers: { "x-forwarded-proto": "https" }
    });

    expect(getPublicRequestOrigin(request)).toBe("https://pagelet-creator.internal");
  });

  it("honors a forwarded host and takes the client-facing value first", () => {
    const request = new Request("http://pagelet-creator.internal/api/cli-login/start", {
      headers: {
        "x-forwarded-proto": "https, http",
        "x-forwarded-host": "creator.pagelet.example.com, internal.example.test"
      }
    });

    expect(getPublicRequestOrigin(request)).toBe("https://creator.pagelet.example.com");
  });

  it("falls back to the request origin when no proxy headers are present", () => {
    const request = new Request("http://127.0.0.1:3000/api/cli-login/start");

    expect(getPublicRequestOrigin(request)).toBe("http://127.0.0.1:3000");
  });
});
