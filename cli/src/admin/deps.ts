import { pollUntilComplete, startCliLogin } from "../cli-login.js";
import { cliConfigPath, writeCliConfig } from "../config.js";
import { sleep } from "../wait.js";
import { createGcloudRunner, type GcloudRunner } from "./gcloud.js";
import { createAdminIo, type AdminIo } from "./io.js";

export type FetchFn = typeof fetch;

export type DeviceLogin = (
  apiBaseUrl: string,
  io: AdminIo
) => Promise<{ email: string; configPath: string }>;

export type AdminDeps = {
  gcloud: GcloudRunner;
  io: AdminIo;
  fetch: FetchFn;
  deviceLogin: DeviceLogin;
  sleep: (ms: number) => Promise<void>;
};

export type AdminDepsOverrides = Partial<AdminDeps>;

export function resolveAdminDeps(overrides: AdminDepsOverrides = {}): AdminDeps {
  return {
    gcloud: overrides.gcloud ?? createGcloudRunner(),
    io: overrides.io ?? createAdminIo(),
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    deviceLogin: overrides.deviceLogin ?? deviceLogin,
    sleep: overrides.sleep ?? sleep
  };
}

/** The same device-code flow as `pagelet login`, pointed at the new instance. */
async function deviceLogin(
  apiBaseUrl: string,
  io: AdminIo
): Promise<{ email: string; configPath: string }> {
  const started = await startCliLogin(apiBaseUrl, { label: "pagelet admin setup" });
  io.out(`Open: ${started.verificationUrl}`);
  io.out(`Code: ${started.userCode}`);

  const completed = await pollUntilComplete(apiBaseUrl, started);

  if (completed.status !== "complete") {
    throw new Error("CLI login expired before approval");
  }

  await writeCliConfig({ apiBaseUrl, token: completed.token });

  return { email: completed.user.email, configPath: cliConfigPath() };
}
