// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Keeps the guide's code in step with its examples: every line of every
// `ts` code block in docs/guide/*.md must be found in a line of the files of
// docs/guide/examples/, which `tsc -p docs/guide` typechecks against the
// library's source. A page snippet is an excerpt of an example, so an API
// change that breaks a page breaks the typecheck of its example first, and a
// page edited away from its example fails here.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const guide = resolve(import.meta.dirname, "../docs/guide");
const examples = join(guide, "examples");

const exampleLines = readdirSync(examples)
  .filter((name) => name.endsWith(".ts"))
  .flatMap((name) => readFileSync(join(examples, name), "utf8").split("\n"))
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const failures = [];
for (const page of readdirSync(guide).filter((name) => name.endsWith(".md"))) {
  const text = readFileSync(join(guide, page), "utf8");
  for (const match of text.matchAll(/```ts\n([\s\S]*?)```/g)) {
    for (const raw of match[1].split("\n")) {
      const line = raw.trim();
      if (line.length === 0) continue;
      if (!exampleLines.some((example) => example.includes(line))) failures.push(`${page}: ${line}`);
    }
  }
  for (const link of text.matchAll(/\]\((examples\/[^)]+\.ts)\)/g)) {
    try {
      readFileSync(join(guide, link[1]));
    } catch {
      failures.push(`${page}: links a missing example ${link[1]}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Guide snippets not found in docs/guide/examples:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
