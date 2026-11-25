// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Writes the Swift engine's MTSDF text atlases (raw BGRA) in every delivery
// format it was delivered in once, into fixtures/atlas/:
//   <name>.rgba        raw RGBA, row major, top row first
//   <name>.rgba.gz     the same, gzip -9 (inflated in the browser by DecompressionStream)
//   <name>.png         lossless PNG, per-row adaptive filters, zlib 9
//   <name>.webp        lossless WebP (cwebp -lossless -exact -z 9)
// Usage: node scripts/encode-atlases.mjs [path to the Swift Text/Resources]

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The Swift engine's text resources, by default in a checkout of it next to this repository.
const source = process.argv[2] ?? join(root, "../ImmersiveMap/Sources/ImmersiveMap/Text/Resources");
const out = join(root, "fixtures/atlas");
mkdirSync(out, { recursive: true });

const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (bytes) => {
  let c = -1;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

function encodePNG(rgba, width, height) {
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  const line = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    let best = 0;
    let bestScore = Infinity;
    let bestLine = Buffer.from(row);
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0;
        const b = prev[i];
        const c = i >= 4 ? prev[i - 4] : 0;
        let predictor = 0;
        if (f === 1) predictor = a;
        else if (f === 2) predictor = b;
        else if (f === 3) predictor = (a + b) >> 1;
        else if (f === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (row[i] - predictor) & 0xff;
        line[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
        bestLine = Buffer.from(line);
      }
    }
    filtered[y * (stride + 1)] = best;
    bestLine.copy(filtered, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(filtered, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

for (const name of ["atlas", "atlas_thin"]) {
  const meta = JSON.parse(readFileSync(join(source, `${name}.json`), "utf8"));
  const { width, height } = meta.atlas;
  const bgra = readFileSync(join(source, `${name}.bgra`));
  const rgba = Buffer.alloc(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2];
    rgba[i + 1] = bgra[i + 1];
    rgba[i + 2] = bgra[i];
    rgba[i + 3] = bgra[i + 3];
  }
  writeFileSync(join(out, `${name}.rgba`), rgba);
  writeFileSync(join(out, `${name}.rgba.gz`), gzipSync(rgba, { level: 9 }));
  writeFileSync(join(out, `${name}.png`), encodePNG(rgba, width, height));
  execFileSync("cwebp", ["-quiet", "-lossless", "-exact", "-z", "9", join(out, `${name}.png`), "-o", join(out, `${name}.webp`)]);
  writeFileSync(join(out, `${name}.json`), JSON.stringify(meta));
  const size = (f) => readFileSync(join(out, f)).length;
  const brotli = execFileSync("brotli", ["-c", "-q", "11", join(out, `${name}.rgba`)], { maxBuffer: 1 << 26 }).length;
  console.log(`${name}: raw ${size(`${name}.rgba`)}, raw+brotli ${brotli}, gzip ${size(`${name}.rgba.gz`)}, png ${size(`${name}.png`)}, webp ${size(`${name}.webp`)}`);
}
