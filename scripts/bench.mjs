// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Runs one browser benchmark page in the system Chrome and saves its result:
//   node scripts/bench.mjs bench-prep [--base http://localhost:5173] [--query passes=30] [--headed]
// The raw JSON goes to docs/benchmarks/raw/<page>-<date>.json, the tables to stdout.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const args = process.argv.slice(2);
const page = args[0];
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = option("base", "http://localhost:5173");
const query = option("query", "");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: !args.includes("--headed"),
  args: ["--enable-gpu", "--enable-unsafe-webgpu"],
});
const tab = await browser.newPage();
tab.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
tab.on("console", (m) => m.type() === "error" && console.log(`[console.error] ${m.text()}`));
await tab.goto(`${base}/${page}.html${query ? `?${query}` : ""}`);
await tab.waitForFunction(() => window.benchDone || window.benchError, null, { timeout: 30 * 60_000 });
const error = await tab.evaluate(() => window.benchError);
if (error) {
  console.error(`benchmark failed: ${error}`);
  process.exit(1);
}
const results = await tab.evaluate(() => window.benchResults);
await browser.close();

for (const { title, columns, rows } of results) {
  console.log(`\n${title}`);
  console.log(`| ${columns.join(" | ")} |\n|${columns.map(() => "---").join("|")}|`);
  for (const row of rows) console.log(`| ${row.map((c) => (typeof c === "number" ? (c >= 100 ? c.toFixed(0) : c >= 10 ? c.toFixed(1) : c.toFixed(3)) : c)).join(" | ")} |`);
}
console.log(`\nenvironment: ${JSON.stringify(results[0]?.environment)}`);
await mkdir(join(root, "docs/benchmarks/raw"), { recursive: true });
const file = join(root, `docs/benchmarks/raw/${page}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.json`);
await writeFile(file, JSON.stringify(results, null, 2));
console.log(`saved ${file}`);
