// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Downloads the fixed set of real tiles the tests and benchmarks run on into
// fixtures/ (git-ignored), so neither ever touches the network. Run once:
//   node scripts/fetch-fixtures.mjs
// The map tiles are stored as the archive serves them (gzip), the terrain
// tiles as Mapterhorn serves them (WebP), the model tiles inflated (the
// bytes the model tile decoder reads). fixtures/manifest.json lists all.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import init, { Archive, LocateKind } from "../packages/immersive-map/src/wasm/worker_wasm/worker_wasm.js";
import initModels, { Archive as ModelArchive } from "../packages/immersive-map/src/wasm/model_wasm/model_wasm.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARCHIVE = "https://tiles.immersivemap.dev/20260922.pmtiles";
const TERRAIN = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
// The published model archive: PMTiles v3, gzip tiles and directories, zoom 14 only.
const MODELS = "https://tiles.immersivemap.dev/models.pmtiles";
const out = join(root, "fixtures");

function tileAt(lon, lat, z) {
  const n = 2 ** z;
  const phi = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}

function block(name, lon, lat, zooms, radius = 1) {
  const tiles = [];
  for (const z of zooms) {
    const [cx, cy] = tileAt(lon, lat, z);
    const n = 2 ** z;
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && y >= 0 && x < n && y < n) tiles.push({ set: name, z, x, y });
      }
  }
  return tiles;
}

const mapTiles = [
  ...block("moscow", 37.6175, 55.752, [14, 15]),
  ...block("manhattan", -74.011, 40.715, [14, 15]),
  ...block("zermatt", 7.653, 45.977, [10, 11, 12, 13]),
  ...block("rome", 12.488, 41.891, [15], 0),
  ...block("paris-region", 2.33, 48.823, [10], 1),
  ...[0, 1, 2].flatMap((z) => {
    const n = 2 ** z, t = [];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) t.push({ set: "globe", z, x, y });
    return t;
  }),
  ...block("globe", 18.1, 48.1, [3, 4, 5]),
  ...block("ocean", -140, 0, [8], 0),
];
const terrainTiles = [...block("zermatt-terrain", 7.653, 45.977, [10, 11, 12], 1)];
// Model tiles of the archive's 16: small Moscow (about 1.4 MB inflated), one
// with two texture layers (about 2.5 MB), a small neighbour, and the Kremlin
// (about 44 MB), the heaviest geometry.
const modelTiles = [
  { set: "moscow-models", z: 14, x: 9904, y: 5120 },
  { set: "moscow-models", z: 14, x: 9916, y: 5126 },
  { set: "moscow-models", z: 14, x: 9917, y: 5126 },
  { set: "kremlin-models", z: 14, x: 9904, y: 5121 },
];

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

// curl rather than fetch: curl honours the system's proxy settings, Node's fetch does not.
const run = promisify(execFile);
async function download(url, rangeHeader) {
  const args = ["-sfL", "--retry", "3", ...(rangeHeader ? ["-r", rangeHeader] : []), url];
  const { stdout } = await run("curl", args, { encoding: "buffer", maxBuffer: 1 << 30 });
  return new Uint8Array(stdout);
}

async function range(offset, length, url = ARCHIVE) {
  const bytes = await download(url, `${offset}-${offset + length - 1}`);
  if (bytes.length !== length) throw new Error(`expected ${length} bytes, got ${bytes.length}`);
  return bytes;
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

await init({ module_or_path: await readFile(join(root, "packages/immersive-map/src/wasm/worker_wasm/worker_wasm_bg.wasm")) });
await mkdir(join(out, "tiles"), { recursive: true });
await mkdir(join(out, "terrain"), { recursive: true });
await mkdir(join(out, "models"), { recursive: true });

const head = await range(0, 16384);
const archive = new Archive(head.subarray(0, 127));
archive.setRoot(await gunzip(head.subarray(archive.rootOffset, archive.rootOffset + archive.rootLength)));

const manifest = { archive: ARCHIVE, terrain: TERRAIN, models: MODELS, fetched: new Date().toISOString(), tiles: [], terrainTiles: [], modelTiles: [] };
for (const tile of mapTiles) {
  const file = `tiles/${tile.z}-${tile.x}-${tile.y}.mvt.gz`;
  if (!(await exists(join(out, file)))) {
    let located = archive.locate(tile.z, tile.x, tile.y);
    while (located.kind === LocateKind.NeedLeaf) {
      const { offset, length } = located;
      archive.addLeaf(offset, await gunzip(await range(offset, length)));
      located = archive.locate(tile.z, tile.x, tile.y);
    }
    if (located.kind === LocateKind.Missing) {
      console.log(`missing ${file}`);
      continue;
    }
    await writeFile(join(out, file), await range(located.offset, located.length));
  }
  manifest.tiles.push({ ...tile, file });
}
for (const tile of terrainTiles) {
  const file = `terrain/${tile.z}-${tile.x}-${tile.y}.webp`;
  if (!(await exists(join(out, file)))) {
    const url = TERRAIN.replace("{z}", tile.z).replace("{x}", tile.x).replace("{y}", tile.y);
    let bytes;
    try { bytes = await download(url); } catch { console.log(`terrain failed ${url}`); continue; }
    await writeFile(join(out, file), bytes);
  }
  manifest.terrainTiles.push({ ...tile, file });
}
// The model archive's directories are walked by the model worker's own Wasm.
await initModels({ module_or_path: await readFile(join(root, "packages/immersive-map/src/wasm/model_wasm/model_wasm_bg.wasm")) });
let models;
for (const tile of modelTiles) {
  const file = `models/${tile.z}-${tile.x}-${tile.y}.immt`;
  if (!(await exists(join(out, file)))) {
    if (!models) {
      const modelHead = await range(0, 16384, MODELS);
      models = new ModelArchive(modelHead.subarray(0, 127));
      models.setRoot(await gunzip(modelHead.subarray(models.rootOffset, models.rootOffset + models.rootLength)));
    }
    let located = models.locate(tile.z, tile.x, tile.y);
    while (located.kind === LocateKind.NeedLeaf) {
      const { offset, length } = located;
      models.addLeaf(offset, await gunzip(await range(offset, length, MODELS)));
      located = models.locate(tile.z, tile.x, tile.y);
    }
    if (located.kind === LocateKind.Missing) {
      console.log(`missing ${file}`);
      continue;
    }
    // Tile compression 2 is gzip, 1 none.
    const stored = await range(located.offset, located.length, MODELS);
    await writeFile(join(out, file), models.tileCompression === 2 ? await gunzip(stored) : stored);
  }
  manifest.modelTiles.push({ ...tile, file });
}
await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`${manifest.tiles.length} map tiles, ${manifest.terrainTiles.length} terrain tiles, ${manifest.modelTiles.length} model tiles in fixtures/`);
