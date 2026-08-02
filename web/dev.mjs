/**
 * The dev runner: the node server on 3001, Vite on 3000 proxying the app
 * routes to it. Open http://127.0.0.1:3000.
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
const children = [
  start("tsx", ["watch", "src/server/main.ts"], { PORT: "3001" }),
  start("vite", ["dev", "--host", "127.0.0.1"], {})
];
let stopping = false;

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: appDir,
    env: { ...process.env, ...env },
    stdio: "inherit"
  });

  child.on("error", (error) => {
    console.error(`Could not start ${command}: ${error.message}`);
    stop(1);
  });
  child.on("exit", (code) => stop(code ?? 1));
  return child;
}

function stop(code) {
  if (stopping) {
    return;
  }

  stopping = true;

  for (const child of children) {
    child.kill("SIGTERM");
  }

  process.exit(code);
}
