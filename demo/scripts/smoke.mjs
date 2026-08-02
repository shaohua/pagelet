import { execFile, spawn } from "node:child_process";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workspaceRoot = resolve(root, "..");
const port = 3210;
const apiUrl = `http://127.0.0.1:${port}`;
const storageDir = await mkdtemp(resolve(tmpdir(), "pagelet-storage-"));
const reportDir = await mkdtemp(resolve(tmpdir(), "pagelet-reports-"));
const serverLog = [];

await execFileAsync("npm", ["run", "build", "-w", "cli"], { cwd: workspaceRoot });
await execFileAsync("npm", ["run", "build", "-w", "shared"], { cwd: workspaceRoot });
await execFileAsync("npm", ["run", "build", "-w", "web"], { cwd: workspaceRoot });

const cliPath = resolve(root, "../cli/dist/index.js");

// Invoke the CLI through a symlink, the way npm's node_modules/.bin does.
// Running dist/index.js directly cannot catch a broken entry guard: the
// published 0.1.0 passed every direct invocation and then exited silently
// under npx, because argv[1] was the symlink and the guard compared paths
// without resolving it.
{
  const binDir = await mkdtemp(resolve(tmpdir(), "pagelet-bin-"));
  const binLink = resolve(binDir, "pagelet");
  await symlink(cliPath, binLink);
  const viaSymlink = await execFileAsync(process.execPath, [binLink, "--version"]);

  if (!/^\d+\.\d+\.\d+\n$/.test(viaSymlink.stdout)) {
    throw new Error(
      `CLI invoked via bin symlink printed ${JSON.stringify(viaSymlink.stdout)} instead of a version`
    );
  }

  await rm(binDir, { force: true, recursive: true });
}

await cp(resolve(root, "reports"), reportDir, { recursive: true });
await rm(resolve(reportDir, ".pagelet.publish.json"), { force: true });

const server = spawn(
  process.execPath,
  [resolve(workspaceRoot, "web/dist/server/main.js")],
  {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      PAGELET_STORAGE_DIR: storageDir,
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
);

server.stdout.on("data", (chunk) => serverLog.push(chunk.toString()));
server.stderr.on("data", (chunk) => serverLog.push(chunk.toString()));

try {
  await waitForServer(`${apiUrl}/`);

  const v1 = await runCli([
    "publish",
    resolve(reportDir, "dashboard-v1.html")
  ]);
  assertIncludes(v1.stdout, "Version: 1", "first publish version");
  const urlMatch = /^URL: (.+)$/m.exec(v1.stdout);

  if (!urlMatch?.[1]) {
    throw new Error(`Could not find published URL in CLI output:\n${v1.stdout}`);
  }

  const pageletUrl = urlMatch[1];
  const shareId = pageletUrl.split("/").pop();

  if (!shareId) {
    throw new Error(`Could not parse share id from ${pageletUrl}`);
  }

  // The viewer is a client-rendered page, so the share URL serves the app
  // shell. What it renders is covered by the checks against the API below.
  const viewerHtml = await fetchText(pageletUrl);
  assertIncludes(viewerHtml, `<div id="root">`, "viewer app shell");

  const renderedV1 = await fetchText(`${apiUrl}/r/${shareId}/latest`);
  assertIncludes(renderedV1, "ARR by Month", "v1 rendered report");
  assertIncludes(renderedV1, "<base", "rendered base tag");
  const assetMatch = /src="(assets\/[^"]+chart\.svg)"/.exec(renderedV1);

  if (!assetMatch?.[1]) {
    throw new Error("Rendered report did not include rewritten chart asset");
  }

  const chartAsset = await fetchText(`${apiUrl}/r/${shareId}/1/${assetMatch[1]}`);
  assertIncludes(chartAsset, "<svg", "served chart asset");

  const metadata = await fetchJson(`${apiUrl}/api/pagelets/${shareId}`);
  const createdThread = await fetchJson(
    `${apiUrl}/api/pagelets/${shareId}/comments`,
    {
      method: "POST",
      body: JSON.stringify({
        versionId: metadata.currentVersion.id,
        kind: "question",
        priority: "normal",
        bodyMarkdown: "Can we break this out by region?",
        anchor: {
          xPct: 42,
          yPct: 32,
          documentWidth: 960,
          documentHeight: 720,
          viewportWidth: 1280,
          viewportHeight: 800,
          scrollX: 0,
          scrollY: 0,
          textFingerprint: "ARR by Month"
        }
      })
    }
  );
  const comments = await fetchJson(
    `${apiUrl}/api/pagelets/${shareId}/comments?version=1`
  );
  assertIncludes(
    JSON.stringify(comments),
    "Can we break this out by region?",
    "comment list"
  );
  await fetchJson(
    `${apiUrl}/api/comment-threads/${createdThread.thread.id}/replies`,
    {
      method: "POST",
      body: JSON.stringify({
        bodyMarkdown: "Yes, please split it into Americas, EMEA, and APAC."
      })
    }
  );
  const commentsWithReply = await fetchJson(
    `${apiUrl}/api/pagelets/${shareId}/comments?version=1`
  );
  assertIncludes(
    JSON.stringify(commentsWithReply),
    "Americas, EMEA, and APAC",
    "comment reply list"
  );
  const feedback = await runCli(["feedback", shareId]);
  assertIncludes(feedback.stdout, "# Pagelet Feedback", "feedback heading");
  assertIncludes(
    feedback.stdout,
    "Can we break this out by region?",
    "feedback comment"
  );
  assertIncludes(feedback.stdout, "Americas, EMEA, and APAC", "feedback reply");

  const resolvedThread = await fetchJson(
    `${apiUrl}/api/comment-threads/${createdThread.thread.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({ status: "resolved" })
    }
  );

  if (resolvedThread.thread.status !== "resolved") {
    throw new Error("Thread did not resolve");
  }

  const v2 = await runCli([
    "publish",
    resolve(reportDir, "dashboard-v2.html"),
    "--message",
    "Address review comments"
  ]);
  assertIncludes(v2.stdout, "Version: 2", "second publish version");

  const renderedLatest = await fetchText(`${apiUrl}/r/${shareId}/latest`);
  assertIncludes(renderedLatest, "Regional Breakdown", "v2 rendered report");

  const renderedHistorical = await fetchText(`${apiUrl}/r/${shareId}/1`);
  assertIncludes(renderedHistorical, "ARR by Month", "historical v1 report");

  console.log("Demo smoke passed");
} finally {
  server.kill("SIGTERM");
  await rm(storageDir, { force: true, recursive: true });
  await rm(reportDir, { force: true, recursive: true });
}

async function runCli(args) {
  return execFileAsync("node", [cliPath, ...args], {
    env: {
      ...process.env,
      PAGELET_API_URL: apiUrl,
      PAGELET_TOKEN: "dev-token"
    }
  });
}

async function waitForServer(url) {
  const started = Date.now();

  while (Date.now() - started < 15000) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }

  throw new Error(`Server did not start. Logs:\n${serverLog.join("")}`);
}

async function fetchText(url) {
  const response = await fetch(url);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status}\n${text}`);
  }

  return text;
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status}\n${text}`);
  }

  return JSON.parse(text);
}

function assertIncludes(value, expected, label) {
  if (!value.includes(expected)) {
    throw new Error(`${label} did not include ${expected}`);
  }
}
