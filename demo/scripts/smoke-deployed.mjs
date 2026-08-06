import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const creatorUrl = process.env.PAGELET_CREATOR_URL ?? process.env.PAGELET_API_URL;
const viewerUrl = process.env.PAGELET_VIEWER_URL;
const token = process.env.PAGELET_TOKEN;

if (!creatorUrl) {
  throw new Error("Set PAGELET_CREATOR_URL to the creator service URL");
}
if (!token) {
  throw new Error("Set PAGELET_TOKEN to a creator token");
}

const creator = new URL(creatorUrl);
const reportDir = await mkdtemp(resolve(tmpdir(), "pagelet-deployed-reports-"));
const cliPath = resolve(root, "cli/dist/index.js");

await execFileAsync("npm", ["run", "build", "-w", "cli"], { cwd: root });
await cp(resolve(root, "demo/reports"), reportDir, { recursive: true });
await rm(resolve(reportDir, ".pagelet.publish.json"), { force: true });

try {
  await expectStatus(new URL("/health", creator), 200);
  await expectStatus(new URL("/api/publish-config", creator), 401);
  await expectStatus(new URL("/r/not-public/1", creator), 404);

  const config = await fetchJson(new URL("/api/publish-config", creator));
  if (!Number.isInteger(config.maxUploadBytes)) {
    throw new Error("Publish config did not include maxUploadBytes");
  }

  const v1 = await runCli(["publish", resolve(reportDir, "dashboard-v1.html")]);
  assertIncludes(v1.stdout, "Version: 1", "first publish version");
  const shareId = parseShareId(parsePublishedUrl(v1.stdout));

  const feedback = await runCli(["feedback", shareId]);
  assertIncludes(feedback.stdout, "# Pagelet Feedback", "feedback heading");

  const v2 = await runCli([
    "publish",
    resolve(reportDir, "dashboard-v2.html"),
    "--message",
    "Deployed creator smoke test"
  ]);
  assertIncludes(v2.stdout, "Version: 2", "second publish version");

  if (viewerUrl) {
    const response = await fetch(new URL("/health", viewerUrl), {
      redirect: "manual"
    });
    if (![302, 401, 403].includes(response.status)) {
      throw new Error(`Viewer is not IAP-protected: health returned ${response.status}`);
    }
  }

  console.log("Deployed creator boundary smoke passed");
} finally {
  await rm(reportDir, { force: true, recursive: true });
}

function runCli(args) {
  return execFileAsync("node", [cliPath, ...args], {
    cwd: root,
    env: {
      ...process.env,
      PAGELET_API_URL: creator.origin,
      PAGELET_TOKEN: token
    }
  });
}

async function expectStatus(url, expected) {
  const response = await fetch(url, { redirect: "manual" });
  if (response.status !== expected) {
    throw new Error(`${url} returned ${response.status}; expected ${expected}`);
  }
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status}\n${text}`);
  }
  return JSON.parse(text);
}

function parsePublishedUrl(stdout) {
  const line = stdout.split("\n").find((item) => item.startsWith("URL: "));
  if (!line) throw new Error(`Publish output did not contain a URL:\n${stdout}`);
  return new URL(line.slice("URL: ".length));
}

function parseShareId(url) {
  const match = /^\/p\/([^/]+)$/.exec(url.pathname);
  if (!match?.[1]) throw new Error(`Could not read share id from ${url}`);
  return match[1];
}

function assertIncludes(actual, expected, label) {
  if (!actual.includes(expected)) {
    throw new Error(`${label} did not include ${expected}:\n${actual}`);
  }
}
