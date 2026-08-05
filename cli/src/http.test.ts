import { afterEach, describe, expect, it } from "vitest";
import { authHeaders } from "./http.js";

const originalPageletToken = process.env.PAGELET_TOKEN;
const originalCloudRunToken = process.env.PAGELET_CLOUD_RUN_TOKEN;

afterEach(() => {
  restoreEnv("PAGELET_TOKEN", originalPageletToken);
  restoreEnv("PAGELET_CLOUD_RUN_TOKEN", originalCloudRunToken);
});

describe("authHeaders", () => {
  it("sends Cloud Run auth without replacing the Pagelet bearer token", async () => {
    process.env.PAGELET_TOKEN = "pagelet-token";
    process.env.PAGELET_CLOUD_RUN_TOKEN = "cloud-run-token";

    await expect(authHeaders()).resolves.toEqual({
      "X-Pagelet-Token": "pagelet-token",
      "X-Serverless-Authorization": "Bearer cloud-run-token"
    });
  });

  it("ignores a blank Cloud Run token", async () => {
    process.env.PAGELET_TOKEN = "pagelet-token";
    process.env.PAGELET_CLOUD_RUN_TOKEN = "   ";

    await expect(authHeaders()).resolves.toEqual({
      Authorization: "Bearer pagelet-token"
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
