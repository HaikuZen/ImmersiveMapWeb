// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Validates every WGSL shader of the library with naga, each as the pipeline
// compiles it: a file that starts with `// requires: a.wgsl b.wgsl` is
// prepended with those files, in that order, from its own directory. A
// module with the clip-distances markers is checked in both of its variants
// (packages/immersive-map/src/globe/clip-distance-variant.ts, the same rule).
// Run: node scripts/check-shaders.mjs (part of `npm run check`).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "packages/immersive-map/src");
// The naga CLI: the one NAGA names, else cargo's, else the one on PATH.
const cargoNaga = join(process.env.HOME ?? "", ".cargo/bin/naga");
const naga = process.env.NAGA || (existsSync(cargoNaga) ? cargoNaga : "naga");
try {
  execFileSync(naga, ["--version"], { stdio: "pipe" });
} catch {
  console.error(`No naga at ${naga}. Install the version Cargo.lock names: cargo install naga-cli --version "~30.0" --locked`);
  process.exit(1);
}
const scratch = mkdtempSync(join(tmpdir(), "wgsl-"));

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".wgsl") ? [path] : [];
  });
}

let failed = 0;
for (const file of walk(root)) {
  const source = readFileSync(file, "utf8");
  const requires = /^\/\/ requires: (.+)$/m.exec(source)?.[1]?.trim().split(/\s+/) ?? [];
  // A file other shaders include is checked with its includer.
  if (/^\/\/ library$/m.test(source)) continue;
  const full = [...requires.map((r) => readFileSync(join(dirname(file), r), "utf8")), source].join("\n");
  const variants = /\/\/ (no-)?clip-distances\s*$/m.test(full)
    ? [
        ["clip distances", variant(full, true)],
        ["no clip distances", variant(full, false)],
      ]
    : [["", full]];
  for (const [name, code] of variants) {
    const out = join(scratch, "shader.wgsl");
    writeFileSync(out, code);
    const label = `${file.slice(root.length + 1)}${name ? ` (${name})` : ""}`;
    try {
      execFileSync(naga, [out], { stdio: "pipe" });
      console.log(`ok   ${label}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${label}\n${error.stderr?.toString() ?? error}`);
    }
  }
}

/** The lines of the other variant dropped: `clipDistanceVariant` in globe/clip-distance-variant.ts. */
function variant(source, clipDistances) {
  const drop = clipDistances ? "// no-clip-distances" : "// clip-distances";
  return source
    .split("\n")
    .filter((line) => !line.trimEnd().endsWith(drop))
    .join("\n");
}
process.exit(failed ? 1 : 0);
