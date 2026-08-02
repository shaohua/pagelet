import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export type AdminIo = {
  out(text: string): void;
  err(text: string): void;
  prompt(question: string): Promise<string>;
  promptSecret(question: string): Promise<string>;
  confirm(question: string): Promise<boolean>;
  isInteractive: boolean;
};

export function createAdminIo(): AdminIo {
  return {
    out(text: string): void {
      process.stdout.write(`${text}\n`);
    },
    err(text: string): void {
      process.stderr.write(`${text}\n`);
    },
    prompt: promptLine,
    promptSecret,
    async confirm(question: string): Promise<boolean> {
      const answer = await promptLine(`${question} [y/N] `);
      return /^y(es)?$/i.test(answer);
    },
    isInteractive: Boolean(process.stdin.isTTY)
  };
}

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * readline has no muted mode. Overriding `_writeToOutput` — the classic
 * workaround — silently stopped working with the promises API, which never
 * calls the instance hook, so the secret would echo in cleartext. Giving
 * readline a discarding output stream instead keeps `terminal: true` behavior
 * (raw mode on, kernel echo off, line editing works) while every echo readline
 * produces goes nowhere. Verified under a real pty; do not "simplify" this back
 * to an output hook.
 */
async function promptSecret(question: string): Promise<string> {
  process.stdout.write(question);

  const muted = new Writable({
    write(chunk, encoding, callback): void {
      callback();
    }
  });
  const rl = createInterface({
    input: process.stdin,
    output: muted,
    terminal: process.stdin.isTTY === true
  });

  try {
    const answer = await rl.question("");
    process.stdout.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}
