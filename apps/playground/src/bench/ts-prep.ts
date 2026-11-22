// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The TypeScript twin of crates/tile-prep (with crates/mvt), for benchmark
// B1: the same MVT decode, the same earcut triangulation (mapbox/earcut, of
// which the Rust crate is a port), the same style table and the same output
// layout, written for speed: typed arrays, no object per point.

import earcut from "earcut";

const VERTEX_WORDS = 5;

const rgb = (hex: number) => (((hex >> 16) & 0xff) | (((hex >> 8) & 0xff) << 8) | ((hex & 0xff) << 16) | (0xff << 24)) >>> 0;

const enum Rule {
  Background,
  Earth,
  Landcover,
  Landuse,
  Water,
  WaterLine,
  Building,
  Boundary,
  RoadPath,
  RoadMinor,
  RoadMedium,
  RoadMajor,
  RoadHighway,
  Count,
}

const LANDCOVER: Record<string, number> = {
  forest: rgb(0xcfdfc0),
  grassland: rgb(0xdce6c6),
  scrub: rgb(0xdce6c6),
  farmland: rgb(0xe8e6d2),
  glacier: rgb(0xf6f9fb),
  barren: rgb(0xe8e1d3),
  urban_area: rgb(0xe2ddd6),
};
const LANDUSE: Record<string, number> = {};
for (const k of ["park", "garden", "golf_course", "playground", "nature_reserve", "grass", "meadow", "recreation_ground", "village_green"]) LANDUSE[k] = rgb(0xc9e0bb);
for (const k of ["forest", "wood"]) LANDUSE[k] = rgb(0xbdd6ac);
LANDUSE.cemetery = rgb(0xd3dccb);
LANDUSE.hospital = rgb(0xf0dede);
for (const k of ["school", "university", "college", "kindergarten"]) LANDUSE[k] = rgb(0xeee4d2);
for (const k of ["industrial", "railway"]) LANDUSE[k] = rgb(0xdedadb);
for (const k of ["pedestrian", "dam"]) LANDUSE[k] = rgb(0xebe7e1);
for (const k of ["aerodrome", "runway", "taxiway"]) LANDUSE[k] = rgb(0xdcdbe2);
for (const k of ["beach", "sand"]) LANDUSE[k] = rgb(0xf2ebcf);
LANDUSE.military = rgb(0xe5dcd5);
for (const k of ["zoo", "theme_park"]) LANDUSE[k] = rgb(0xd8e4c8);

const WATER = rgb(0x9ec4e4);

function fillRule(layer: string, kind: string): [Rule, number] | undefined {
  switch (layer) {
    case "earth":
      return [Rule.Earth, rgb(0xe9e5df)];
    case "landcover": {
      const c = LANDCOVER[kind];
      return c === undefined ? undefined : [Rule.Landcover, c];
    }
    case "landuse": {
      const c = LANDUSE[kind];
      return c === undefined ? undefined : [Rule.Landuse, c];
    }
    case "water":
      return [Rule.Water, WATER];
    case "buildings":
      return [Rule.Building, rgb(0xd7d0c6)];
  }
  return undefined;
}

function lineRule(layer: string, kind: string, z: number): [Rule, number, number] | undefined {
  const s = Math.min(1.8, Math.max(0.6, (z - 10) / 4));
  switch (layer) {
    case "water":
    case "physical_line":
      return [Rule.WaterLine, WATER, 1.2 * s];
    case "boundaries":
      return [Rule.Boundary, rgb(0xa8a2b8), 1.0 * s];
    case "roads":
      switch (kind) {
        case "highway":
          return [Rule.RoadHighway, rgb(0xf3c58c), 4.0 * s];
        case "major_road":
          return [Rule.RoadMajor, rgb(0xfbe3ad), 3.2 * s];
        case "medium_road":
          return [Rule.RoadMedium, rgb(0xffffff), 2.4 * s];
        case "minor_road":
          return [Rule.RoadMinor, rgb(0xffffff), 1.6 * s];
        case "path":
        case "other":
          return [Rule.RoadPath, rgb(0xf7f5f2), 0.9 * s];
      }
  }
  return undefined;
}

/** A growable Uint32Array with a Float32Array view of the same bytes. */
class Words {
  u32 = new Uint32Array(1024);
  f32 = new Float32Array(this.u32.buffer);
  length = 0;
  reserve(extra: number): void {
    if (this.length + extra <= this.u32.length) return;
    let size = this.u32.length * 2;
    while (size < this.length + extra) size *= 2;
    const next = new Uint32Array(size);
    next.set(this.u32.subarray(0, this.length));
    this.u32 = next;
    this.f32 = new Float32Array(next.buffer);
  }
}

class Bucket {
  vertices = new Words();
  indices = new Words();
  vertex(x: number, y: number, ex: number, ey: number, color: number): void {
    const v = this.vertices;
    v.reserve(VERTEX_WORDS);
    const i = v.length;
    v.f32[i] = x;
    v.f32[i + 1] = y;
    v.f32[i + 2] = ex;
    v.f32[i + 3] = ey;
    v.u32[i + 4] = color;
    v.length += VERTEX_WORDS;
  }
  get vertexCount(): number {
    return this.vertices.length / VERTEX_WORDS;
  }
}

const decoder = new TextDecoder();

/** A protobuf wire reader over the tile's bytes. */
class Reader {
  pos = 0;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }
  varint(): number {
    const buf = this.buf;
    let b = buf[this.pos++]!;
    let value = b & 0x7f;
    if (b < 0x80) return value;
    b = buf[this.pos++]!;
    value |= (b & 0x7f) << 7;
    if (b < 0x80) return value;
    b = buf[this.pos++]!;
    value |= (b & 0x7f) << 14;
    if (b < 0x80) return value;
    b = buf[this.pos++]!;
    value |= (b & 0x7f) << 21;
    if (b < 0x80) return value >>> 0;
    // Past 28 bits: fall back to multiplication (values above 2^31 are rare in MVT).
    let high = 0;
    let shift = 0;
    do {
      b = buf[this.pos++]!;
      high += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b >= 0x80);
    return (value >>> 0) + high * 2 ** 28;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error("unknown wire type");
  }
  string(): string {
    const length = this.varint();
    const s = decoder.decode(this.buf.subarray(this.pos, this.pos + length));
    this.pos += length;
    return s;
  }
}

interface Layer {
  name: string;
  extent: number;
  keys: string[];
  /** String values only; others are irrelevant to the prototype style. */
  values: (string | undefined)[];
  /** Feature byte ranges: start, end pairs. */
  features: number[];
}

function decodeLayer(buf: Uint8Array, start: number, end: number): Layer {
  const r = new Reader(buf, start, end);
  const layer: Layer = { name: "", extent: 4096, keys: [], values: [], features: [] };
  while (r.pos < end) {
    const key = r.varint();
    const field = key >>> 3;
    const wire = key & 7;
    if (field === 1 && wire === 2) layer.name = r.string();
    else if (field === 2 && wire === 2) {
      const length = r.varint();
      layer.features.push(r.pos, r.pos + length);
      r.pos += length;
    } else if (field === 3 && wire === 2) layer.keys.push(r.string());
    else if (field === 4 && wire === 2) {
      const length = r.varint();
      const valueEnd = r.pos + length;
      let value: string | undefined;
      while (r.pos < valueEnd) {
        const k = r.varint();
        if (k >>> 3 === 1 && (k & 7) === 2) value = r.string();
        else r.skip(k & 7);
      }
      layer.values.push(value);
    } else if (field === 5 && wire === 0) layer.extent = r.varint();
    else r.skip(wire);
  }
  return layer;
}

export interface TsPreparedTile {
  vertices: Uint32Array;
  indices: Uint32Array;
  featureCount: number;
}

/** Scratch buffers reused across features and tiles, like the Rust `Preparer`. */
export class TsPreparer {
  private points = new Int32Array(4096);
  private pointCount = 0;
  private partEnds: number[] = [];
  private ring: number[] = [];
  private holes: number[] = [];
  private buckets: Bucket[] = [];

  prepare(bytes: Uint8Array, z: number): TsPreparedTile {
    this.buckets = Array.from({ length: Rule.Count }, () => new Bucket());
    const background = this.buckets[Rule.Background]!;
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const)
      background.vertex(x, y, 0, 0, WATER);
    background.indices.reserve(6);
    background.indices.u32.set([0, 1, 2, 1, 3, 2], 0);
    background.indices.length = 6;

    let featureCount = 0;
    const r = new Reader(bytes);
    while (r.pos < bytes.length) {
      const key = r.varint();
      if (key >>> 3 === 3 && (key & 7) === 2) {
        const length = r.varint();
        featureCount += this.prepareLayer(decodeLayer(bytes, r.pos, r.pos + length), bytes, z);
        r.pos += length;
      } else r.skip(key & 7);
    }

    let vertexWords = 0;
    let indexCount = 0;
    for (const b of this.buckets) {
      vertexWords += b.vertices.length;
      indexCount += b.indices.length;
    }
    const vertices = new Uint32Array(vertexWords);
    const indices = new Uint32Array(indexCount);
    let vw = 0;
    let ic = 0;
    for (const b of this.buckets) {
      const base = vw / VERTEX_WORDS;
      vertices.set(b.vertices.u32.subarray(0, b.vertices.length), vw);
      vw += b.vertices.length;
      const src = b.indices.u32;
      for (let i = 0; i < b.indices.length; i++) indices[ic++] = src[i]! + base;
    }
    return { vertices, indices, featureCount };
  }

  private prepareLayer(layer: Layer, buf: Uint8Array, z: number): number {
    const scale = 1 / layer.extent;
    let count = 0;
    const kindKey = layer.keys.indexOf("kind");
    const f = layer.features;
    for (let i = 0; i < f.length; i += 2) {
      // Feature: tags, type, geometry.
      const r = new Reader(buf, f[i]!, f[i + 1]!);
      let type = 0;
      let tagsStart = 0;
      let tagsEnd = 0;
      let geomStart = 0;
      let geomEnd = 0;
      while (r.pos < r.end) {
        const key = r.varint();
        const field = key >>> 3;
        const wire = key & 7;
        if (field === 2 && wire === 2) {
          const length = r.varint();
          tagsStart = r.pos;
          tagsEnd = r.pos + length;
          r.pos = tagsEnd;
        } else if (field === 3 && wire === 0) type = r.varint();
        else if (field === 4 && wire === 2) {
          const length = r.varint();
          geomStart = r.pos;
          geomEnd = r.pos + length;
          r.pos = geomEnd;
        } else r.skip(wire);
      }
      if (type !== 2 && type !== 3) continue;
      let kind = "";
      if (kindKey >= 0) {
        const t = new Reader(buf, tagsStart, tagsEnd);
        while (t.pos < tagsEnd) {
          const k = t.varint();
          const v = t.varint();
          if (k === kindKey) {
            kind = layer.values[v] ?? "";
            break;
          }
        }
      }
      if (type === 3) {
        const rule = fillRule(layer.name, kind);
        if (!rule) continue;
        this.decodeGeometry(buf, geomStart, geomEnd, false);
        this.fill(rule[0], rule[1], scale);
        count++;
      } else {
        const rule = lineRule(layer.name, kind, z);
        if (!rule) continue;
        this.decodeGeometry(buf, geomStart, geomEnd, false);
        this.stroke(rule[0], rule[1], rule[2], scale);
        count++;
      }
    }
    return count;
  }

  private decodeGeometry(buf: Uint8Array, start: number, end: number, _isPoint: boolean): void {
    const r = new Reader(buf, start, end);
    this.pointCount = 0;
    this.partEnds.length = 0;
    let x = 0;
    let y = 0;
    while (r.pos < end) {
      const command = r.varint();
      const id = command & 7;
      const count = command >>> 3;
      if (id === 1 || id === 2) {
        if (id === 1 && this.pointCount > 0) this.partEnds.push(this.pointCount);
        if ((this.pointCount + count) * 2 > this.points.length) {
          const next = new Int32Array(Math.max(this.points.length * 2, (this.pointCount + count) * 2));
          next.set(this.points);
          this.points = next;
        }
        for (let i = 0; i < count; i++) {
          const dx = r.varint();
          const dy = r.varint();
          x += (dx >>> 1) ^ -(dx & 1);
          y += (dy >>> 1) ^ -(dy & 1);
          this.points[this.pointCount * 2] = x;
          this.points[this.pointCount * 2 + 1] = y;
          this.pointCount++;
        }
      } else if (id !== 7) throw new Error("unknown geometry command");
    }
    if (this.pointCount > 0) this.partEnds.push(this.pointCount);
  }

  private fill(rule: Rule, color: number, scale: number): void {
    const p = this.points;
    this.ring.length = 0;
    this.holes.length = 0;
    let start = 0;
    for (const end of this.partEnds) {
      const ringStart = start;
      start = end;
      if (end - ringStart < 3) continue;
      let area = 0;
      for (let i = ringStart; i < end; i++) {
        const j = i + 1 === end ? ringStart : i + 1;
        area += p[i * 2]! * p[j * 2 + 1]! - p[j * 2]! * p[i * 2 + 1]!;
      }
      if (area === 0) continue;
      if (area > 0) this.flush(rule, color, scale);
      else if (this.ring.length === 0) continue;
      else this.holes.push(this.ring.length / 2);
      for (let i = ringStart; i < end; i++) this.ring.push(p[i * 2]!, p[i * 2 + 1]!);
    }
    this.flush(rule, color, scale);
  }

  private flush(rule: Rule, color: number, scale: number): void {
    const ring = this.ring;
    if (ring.length < 6) {
      ring.length = 0;
      this.holes.length = 0;
      return;
    }
    const triangles = earcut(ring, this.holes.length > 0 ? this.holes : undefined, 2);
    const bucket = this.buckets[rule]!;
    const base = bucket.vertexCount;
    for (let i = 0; i < ring.length; i += 2) bucket.vertex(ring[i]! * scale, ring[i + 1]! * scale, 0, 0, color);
    const idx = bucket.indices;
    idx.reserve(triangles.length);
    for (let i = 0; i < triangles.length; i++) idx.u32[idx.length + i] = triangles[i]! + base;
    idx.length += triangles.length;
    ring.length = 0;
    this.holes.length = 0;
  }

  private stroke(rule: Rule, color: number, width: number, scale: number): void {
    const half = width * 0.5;
    const bucket = this.buckets[rule]!;
    const p = this.points;
    let start = 0;
    for (const end of this.partEnds) {
      for (let i = start; i + 1 < end; i++) {
        const x0 = p[i * 2]!;
        const y0 = p[i * 2 + 1]!;
        const x1 = p[i * 2 + 2]!;
        const y1 = p[i * 2 + 3]!;
        const dx = x1 - x0;
        const dy = y1 - y0;
        const length = Math.sqrt(dx * dx + dy * dy);
        if (length === 0) continue;
        const nx = (-dy / length) * half;
        const ny = (dx / length) * half;
        const base = bucket.vertexCount;
        bucket.vertex(x0 * scale, y0 * scale, nx, ny, color);
        bucket.vertex(x0 * scale, y0 * scale, -nx, -ny, color);
        bucket.vertex(x1 * scale, y1 * scale, nx, ny, color);
        bucket.vertex(x1 * scale, y1 * scale, -nx, -ny, color);
        const idx = bucket.indices;
        idx.reserve(6);
        const o = idx.length;
        idx.u32[o] = base;
        idx.u32[o + 1] = base + 1;
        idx.u32[o + 2] = base + 2;
        idx.u32[o + 3] = base + 1;
        idx.u32[o + 4] = base + 3;
        idx.u32[o + 5] = base + 2;
        idx.length += 6;
      }
      start = end;
    }
  }
}
