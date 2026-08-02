import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const requiredFiles = [
  "reports/dashboard-v1.html",
  "reports/dashboard-v2.html",
  "reports/pagelet-journal.md",
  "reports/styles/report.css",
  "reports/scripts/report.js",
  "reports/images/chart.svg",
  "reports/images/bg.svg"
];

for (const file of requiredFiles) {
  await access(resolve(root, file));
}

const v1 = await readFile(resolve(root, "reports/dashboard-v1.html"), "utf8");
const v2 = await readFile(resolve(root, "reports/dashboard-v2.html"), "utf8");
const journal = await readFile(
  resolve(root, "reports/pagelet-journal.md"),
  "utf8"
);

if (!v1.includes("<title>Q2 Revenue Dashboard</title>")) {
  throw new Error("dashboard-v1.html is missing the expected title");
}

if (!v2.includes("Regional Breakdown")) {
  throw new Error("dashboard-v2.html is missing the review-driven revision");
}

if (!journal.includes("## Goal")) {
  throw new Error("pagelet-journal.md is missing known journal headings");
}

console.log("Demo fixtures validated");
