import { describe, expect, it } from "vitest";
import { createApp, type PageletSurface } from "./app";

describe("server surfaces", () => {
  it("keeps viewer and creator routes on their intended surfaces", () => {
    const viewer = routeKeys("viewer");
    const creator = routeKeys("creator");

    expect(viewer).toContain("GET /healthz");
    expect(viewer).toContain("GET /r/:shareId/:versionNumber");
    expect(viewer).toContain("POST /api/cli-login/confirm");
    expect(viewer.some((route) => route.includes("/auth/google"))).toBe(false);
    expect(viewer).not.toContain("POST /api/cli-login/start");
    expect(viewer).not.toContain("GET /api/publish-config");

    expect(creator).toContain("GET /healthz");
    expect(creator).toContain("POST /api/cli-login/start");
    expect(creator).toContain("GET /api/publish-config");
    expect(creator).not.toContain("POST /api/cli-login/confirm");
    expect(creator).not.toContain("GET /r/:shareId/:versionNumber");
    expect(creator).not.toContain("GET /api/pagelets/:shareId");
  });

  it("registers both route sets for local development", () => {
    const routes = routeKeys("all");

    expect(routes).toContain("POST /api/cli-login/start");
    expect(routes).toContain("POST /api/cli-login/confirm");
    expect(routes).toContain("GET /r/:shareId/:versionNumber");
    expect(routes).toContain("GET /api/publish-config");
  });
});

function routeKeys(surface: PageletSurface): string[] {
  return createApp({ surface }).routes.map(
    (route) => `${route.method} ${route.path}`
  );
}
