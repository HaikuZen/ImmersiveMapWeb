// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Builds the POI sprite atlas the label shaders sample, the port of the Swift
// PoiSpriteAtlas: a 640x640 texture of 5x5 cells of 128 texels, one per
// PoiSpriteIcon in declared order, row by row from the top left. Each icon is
// drawn white with its coverage in alpha on a transparent background. Browsers
// have no SF Symbols, so each sprite is rasterized from the closest Maki icon
// (CC0 1.0, Mapbox) in headless system Chrome.
//   packages/immersive-map/assets/poi_sprites.webp   lossless WebP, straight alpha
//   packages/immersive-map/assets/poi_sprites.json   the layout and the icon used per cell
// The Maki SVGs are downloaded once into fixtures/maki/<tag>/ (git-ignored).
// Usage: node scripts/build-poi-atlas.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Maki v8.0.1, pinned by commit so the download can never change under us.
const MAKI_TAG = "v8.0.1";
const MAKI_COMMIT = "9fa4d9df8ba25ce84190ecfb237a14d807e7dfbc";
const MAKI_BASE = `https://raw.githubusercontent.com/mapbox/maki/${MAKI_COMMIT}/icons`;

// PoiSpriteIcon::ALL in declared order, with the Swift SF Symbol each sprite
// was drawn from and the Maki icon that stands in for it. The marker has no
// symbol: its cell stays empty.
const ICONS = [
  { icon: "restaurant", symbol: "fork.knife", maki: "restaurant" },
  { icon: "cafe", symbol: "cup.and.saucer.fill", maki: "cafe" },
  { icon: "bar", symbol: "wineglass.fill", maki: "bar" },
  { icon: "park", symbol: "tree.fill", maki: "park" },
  { icon: "museum", symbol: "building.columns.fill", maki: "museum" },
  { icon: "hospital", symbol: "cross.case.fill", maki: "hospital" },
  { icon: "school", symbol: "graduationcap.fill", maki: "college" },
  { icon: "airport", symbol: "airplane", maki: "airport" },
  { icon: "stadium", symbol: "sportscourt.fill", maki: "stadium" },
  { icon: "hotel", symbol: "bed.double.fill", maki: "lodging" },
  { icon: "shopping", symbol: "bag.fill", maki: "shop" },
  { icon: "gasStation", symbol: "fuelpump.fill", maki: "fuel" },
  { icon: "pharmacy", symbol: "pills.fill", maki: "pharmacy" },
  { icon: "viewpoint", symbol: "binoculars.fill", maki: "viewpoint" },
  { icon: "train", symbol: "tram.fill", maki: "rail-light" },
  { icon: "transit", symbol: "bus.fill", maki: "bus" },
  { icon: "parking", symbol: "parkingsign", maki: "parking" },
  { icon: "bank", symbol: "banknote.fill", maki: "bank" },
  { icon: "theatre", symbol: "theatermasks.fill", maki: "theatre" },
  { icon: "toilets", symbol: "toilet.fill", maki: "toilet" },
  { icon: "civic", symbol: "building.2.fill", maki: "town-hall" },
  { icon: "worship", symbol: "hands.and.sparkles.fill", maki: "place-of-worship" },
  { icon: "marker", symbol: null, maki: null },
];

// PoiSpriteAtlasDescriptor.default and PoiSpriteAtlasLayout.
const CELL_SIZE = 128;
const CELL_PADDING = 16;
const MINIMUM_COLUMNS = 4;
const ICON_INSET = 0.16;
const CELLS_PER_SIDE = Math.max(MINIMUM_COLUMNS, Math.ceil(Math.sqrt(ICONS.length)));
const PIXEL_SIZE = CELLS_PER_SIDE * CELL_SIZE;

const makiDir = join(root, "fixtures/maki", MAKI_TAG);
const assets = join(root, "packages/immersive-map/assets");
mkdirSync(makiDir, { recursive: true });

// Downloads a Maki SVG unless it is already there, then reads it back as text
// and checks it is an SVG document. Nothing from that directory is executed.
async function makiSvg(name) {
  const path = join(makiDir, `${name}.svg`);
  if (!existsSync(path)) {
    const response = await fetch(`${MAKI_BASE}/${name}.svg`);
    if (!response.ok) throw new Error(`Maki ${name}.svg: HTTP ${response.status}`);
    writeFileSync(path, await response.text());
  }
  const text = readFileSync(path, "utf8");
  if (!/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/.test(text) || !/<\/svg>\s*$/.test(text)) {
    throw new Error(`${path} is not an SVG document`);
  }
  if (/<script|<foreignObject|\son\w+\s*=/i.test(text)) throw new Error(`${path} carries active content`);
  return text;
}

// Forces every shape white: a fill on the root and a style that overrides any
// fill a path sets itself.
function whiteSvg(text) {
  return text.replace(/<svg\b([^>]*)>/, (_, attrs) => `<svg${attrs.replace(/\sfill="[^"]*"/, "")} fill="#fff"><style>*{fill:#fff !important}</style>`);
}

// The icon rect of a cell: the cell inset by the padding, then by 16% of its
// side on each side, as PoiSpriteAtlasRenderer.drawIcon does.
function iconRect(index) {
  const x = (index % CELLS_PER_SIDE) * CELL_SIZE + CELL_PADDING;
  const y = Math.floor(index / CELLS_PER_SIDE) * CELL_SIZE + CELL_PADDING;
  const side = CELL_SIZE - 2 * CELL_PADDING;
  const inset = side * ICON_INSET;
  return { x: x + inset, y: y + inset, width: side - 2 * inset, height: side - 2 * inset };
}

const sprites = [];
for (const [index, entry] of ICONS.entries()) {
  if (!entry.maki) continue;
  const svg = whiteSvg(await makiSvg(entry.maki));
  sprites.push({ index, url: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`, rect: iconRect(index) });
}

const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
const pixels = await page.evaluate(
  async ({ sprites, size }) => {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.clearRect(0, 0, size, size);
    context.imageSmoothingQuality = "high";
    for (const sprite of sprites) {
      const image = new Image();
      image.src = sprite.url;
      await image.decode();
      const width = image.naturalWidth || 1;
      const height = image.naturalHeight || 1;
      // Aspect fit, centred, as the Swift aspectFitRect.
      const scale = Math.min(sprite.rect.width / width, sprite.rect.height / height);
      const w = width * scale;
      const h = height * scale;
      context.drawImage(image, sprite.rect.x + (sprite.rect.width - w) / 2, sprite.rect.y + (sprite.rect.height - h) / 2, w, h);
    }
    return Array.from(context.getImageData(0, 0, size, size).data);
  },
  { sprites, size: PIXEL_SIZE },
);
await browser.close();

// White everywhere with the coverage in alpha: straight alpha, and no dark
// fringe when linear filtering blends a transparent texel in.
const rgba = Buffer.from(pixels);
for (let i = 0; i < rgba.length; i += 4) {
  rgba[i] = 255;
  rgba[i + 1] = 255;
  rgba[i + 2] = 255;
}

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

// An unfiltered RGBA PNG: only an intermediate for cwebp, so size is moot.
function encodePNG(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const work = mkdtempSync(join(tmpdir(), "poi-atlas-"));
try {
  const png = join(work, "poi_sprites.png");
  writeFileSync(png, encodePNG(rgba, PIXEL_SIZE, PIXEL_SIZE));
  execFileSync("cwebp", ["-quiet", "-lossless", "-exact", "-z", "9", png, "-o", join(assets, "poi_sprites.webp")]);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const layout = {
  source: { set: "maki", tag: MAKI_TAG, commit: MAKI_COMMIT, license: "CC0-1.0" },
  pixelSize: PIXEL_SIZE,
  cellSize: CELL_SIZE,
  cellPadding: CELL_PADDING,
  cellsPerSide: CELLS_PER_SIDE,
  iconInset: ICON_INSET,
  icons: ICONS.map((entry, index) => ({ icon: entry.icon, index, maki: entry.maki })),
};
writeFileSync(join(assets, "poi_sprites.json"), `${JSON.stringify(layout, null, 2)}\n`);
console.log(`poi_sprites.webp: ${PIXEL_SIZE}x${PIXEL_SIZE}, ${statSync(join(assets, "poi_sprites.webp")).size} bytes, ${sprites.length} sprites`);
