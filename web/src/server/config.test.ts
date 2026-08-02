import { demoPublishConfig } from "@pagelet/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  getPublicAppBaseUrl,
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
});
