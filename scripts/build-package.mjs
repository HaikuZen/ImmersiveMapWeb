// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Builds the publishable form of @artembobkin/immersive-map into
// packages/immersive-map/dist: plain ES modules with their declarations, the
// layout of src kept file for file, so every `new URL("…", import.meta.url)`
// (the workers, the Wasm modules, the assets in packages/immersive-map/assets)
// still points where it did and the app's bundler picks it up.
//
// - TypeScript compiles with `tsconfig.build.json`, which rewrites the
//   relative `.ts` imports to `.js`.
// - The shaders, imported with Vite's `?raw` in the source, become modules of
//   their own (`x.wgsl.js`, the source text as the default export), so the
//   package asks nothing of the bundler beyond ES modules and `new URL`.
// - The workers' URLs and the declarations' imports move from `.ts` to `.js`.
// - The runtime Wasm modules (not the benchmarks') are copied next to the code.
// - The package's README is the repository's, with its links made absolute
//   (npm shows it away from the repository), and the LICENSE is copied.
//
// Every relative specifier and every `new URL` of the output is checked to
// name a file the package ships. Run `npm run build:wasm` first.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = join(root, "packages/immersive-map");
const src = join(pkg, "src");
const dist = join(pkg, "dist");
const repository = "https://github.com/artembobkin/ImmersiveMapWeb";
const runtimeWasm = ["worker_wasm", "frame_wasm", "layer_wasm", "model_wasm"];

function walk(directory, out = []) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

for (const name of runtimeWasm) {
  if (!existsSync(join(src, "wasm", name, `${name}_bg.wasm`))) throw new Error(`src/wasm/${name} is missing: run \`npm run build:wasm\` first`);
}

rmSync(dist, { recursive: true, force: true });
execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(pkg, "tsconfig.build.json")], { stdio: "inherit" });

// The shaders as modules.
for (const file of walk(src).filter((f) => f.endsWith(".wgsl"))) {
  const out = join(dist, `${relative(src, file)}.js`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `// Generated from ${relative(src, file)} by scripts/build-package.mjs.\nexport default ${JSON.stringify(readFileSync(file, "utf8"))};\n`);
}

// The specifiers.
const rawImport = /(from\s+")([^"]+\.wgsl)\?raw(")/g;
const workerURL = /(new URL\(")(\.{1,2}\/[^"]+)\.ts(",\s*import\.meta\.url\))/g;
const declarationImport = /((?:from\s+|import\()")(\.{1,2}\/[^"]+)\.ts(")/g;
for (const file of walk(dist)) {
  if (file.endsWith(".d.ts")) {
    const text = readFileSync(file, "utf8");
    const next = text.replace(declarationImport, "$1$2.js$3");
    if (next !== text) writeFileSync(file, next);
  } else if (file.endsWith(".js")) {
    const text = readFileSync(file, "utf8");
    const next = text.replace(rawImport, "$1$2.js$3").replace(workerURL, "$1$2.js$3");
    if (next !== text) writeFileSync(file, next);
  }
}

// The Wasm modules.
for (const name of runtimeWasm) {
  const from = join(src, "wasm", name);
  const to = join(dist, "wasm", name);
  mkdirSync(to, { recursive: true });
  for (const file of [`${name}.js`, `${name}.d.ts`, `${name}_bg.wasm`]) cpSync(join(from, file), join(to, file));
}

// Every relative specifier and URL names a shipped file.
const specifier = /(?:from\s+|import\(|export\s+\*\s+from\s+)"(\.{1,2}\/[^"]+)"/g;
const assetURL = /new URL\("(\.{1,2}\/[^"]+)",\s*import\.meta\.url\)/g;
const problems = [];
for (const file of walk(dist).filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))) {
  const text = readFileSync(file, "utf8");
  if (text.includes("?raw")) problems.push(`${relative(pkg, file)}: a ?raw import is left`);
  for (const pattern of [specifier, assetURL]) {
    for (const match of text.matchAll(pattern)) {
      const target = resolve(dirname(file), match[1]);
      const shipped = target.startsWith(dist + "/") || target.startsWith(join(pkg, "assets") + "/");
      if (match[1].endsWith(".ts") && !match[1].endsWith(".d.ts")) problems.push(`${relative(pkg, file)}: ${match[1]} is a .ts specifier`);
      else if (!shipped || !existsSync(target)) problems.push(`${relative(pkg, file)}: ${match[1]} names no shipped file`);
    }
  }
}
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  throw new Error(`${problems.length} broken references in dist`);
}

// The README and the LICENSE.
const readme = readFileSync(join(root, "README.md"), "utf8")
  .replace(/(src="|\]\()(?!https?:|#)([^")]+)/g, (_, lead, path) => `${lead}${path.startsWith("Assets/") ? `${repository}/raw/main/${path}` : `${repository}/blob/main/${path}`}`);
writeFileSync(join(pkg, "README.md"), readme);
cpSync(join(root, "LICENSE"), join(pkg, "LICENSE"));

const files = walk(dist);
const bytes = files.reduce((sum, f) => sum + statSync(f).size, 0);
console.log(`dist: ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`);
