// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B23 only: the tile grid's frame on the flat map in TypeScript, the logic
// of ImmersiveMapCore's `map_visibility::grid` and `map_frame::tile_grid`
// ported line for line, for the measurement to compare against the Rust the
// map runs (docs/benchmarks/B23-tile-grid.md). Not part of the library.

/** A convex polygon of the plane with its bounds (`CoveragePolygon`). */
export class TsPolygon {
  private readonly minX: number;
  private readonly maxX: number;
  private readonly minY: number;
  private readonly maxY: number;

  constructor(private readonly xy: Float64Array) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < xy.length; i += 2) {
      minX = Math.min(minX, xy[i]!);
      maxX = Math.max(maxX, xy[i]!);
      minY = Math.min(minY, xy[i + 1]!);
      maxY = Math.max(maxY, xy[i + 1]!);
    }
    this.minX = minX;
    this.maxX = maxX;
    this.minY = minY;
    this.maxY = maxY;
  }

  intersects(minX: number, minY: number, maxX: number, maxY: number): boolean {
    const t = 1e-5;
    if (this.maxX < minX - t || this.minX > maxX + t || this.maxY < minY - t || this.minY > maxY + t) return false;
    const slabMin = minY - t;
    const slabMax = maxY + t;
    const xy = this.xy;
    const count = xy.length / 2;
    let lowest = Infinity;
    let highest = -Infinity;
    for (let index = 0; index < count; index++) {
      const sx = xy[index * 2]!;
      const sy = xy[index * 2 + 1]!;
      const next = ((index + 1) % count) * 2;
      const ex = xy[next]!;
      const ey = xy[next + 1]!;
      if (sy >= slabMin && sy <= slabMax) {
        lowest = Math.min(lowest, sx);
        highest = Math.max(highest, sx);
      }
      const dy = ey - sy;
      if (Math.abs(dy) <= 1.1920928955078125e-7) continue;
      for (const y of [slabMin, slabMax]) {
        const u = (y - sy) / dy;
        if (u >= 0 && u <= 1) {
          const x = sx + (ex - sx) * u;
          lowest = Math.min(lowest, x);
          highest = Math.max(highest, x);
        }
      }
    }
    return lowest <= maxX + t && highest >= minX - t;
  }
}

export interface TsGridInput {
  readonly polygon: TsPolygon;
  readonly panX: number;
  readonly panY: number;
  readonly renderMapSize: number;
  readonly centreX: number;
  readonly centreY: number;
  readonly zoom: number;
  readonly limit: number;
}

/** A glyph block of a text: four words a glyph, the tile and the share left zero. */
export interface TsLayout {
  readonly share: number;
  readonly records: Uint32Array;
}

const tileKey = (z: number, x: number, y: number): number => (z * 16_777_216 + x) * 16_777_216 + y;

/** The frame's grid on the flat map: the walk nearest first, the tiles as the GPU takes them and their glyphs. */
export class TsTileGrid {
  // The heap, as parallel arrays.
  private heapDistance = new Float64Array(4096);
  private heapNode = new Int32Array(4096 * 4);
  private heapSize = 0;
  private visible = new Int32Array(4 * 1024);
  instances = new ArrayBuffer(32 * 1024);
  private instanceFloats = new Float32Array(this.instances);
  private instanceWords = new Uint32Array(this.instances);
  glyphs = new Uint32Array(4 * 16 * 1024);
  private glyphFloats = new Float32Array(this.glyphs.buffer);
  tileCount = 0;
  glyphCount = 0;

  constructor(
    private readonly selected: ReadonlySet<number>,
    private readonly layout: (z: number, x: number, y: number) => TsLayout | undefined,
  ) {}

  private push(distance: number, z: number, x: number, y: number, wrap: number): void {
    if (this.heapSize === this.heapDistance.length) {
      const distances = new Float64Array(this.heapSize * 2);
      distances.set(this.heapDistance);
      this.heapDistance = distances;
      const nodes = new Int32Array(this.heapSize * 8);
      nodes.set(this.heapNode);
      this.heapNode = nodes;
    }
    const d = this.heapDistance;
    const n = this.heapNode;
    let index = this.heapSize++;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!(distance < d[parent]!)) break;
      d[index] = d[parent]!;
      n.copyWithin(index * 4, parent * 4, parent * 4 + 4);
      index = parent;
    }
    d[index] = distance;
    n[index * 4] = z;
    n[index * 4 + 1] = x;
    n[index * 4 + 2] = y;
    n[index * 4 + 3] = wrap;
  }

  private pop(out: Int32Array): boolean {
    if (this.heapSize === 0) return false;
    const d = this.heapDistance;
    const n = this.heapNode;
    out[0] = n[0]!;
    out[1] = n[1]!;
    out[2] = n[2]!;
    out[3] = n[3]!;
    const last = --this.heapSize;
    if (last === 0) return true;
    const distance = d[last]!;
    let index = 0;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = -1;
      let best = distance;
      if (left < last && d[left]! < best) {
        smallest = left;
        best = d[left]!;
      }
      if (right < last && d[right]! < best) smallest = right;
      if (smallest < 0) break;
      d[index] = d[smallest]!;
      n.copyWithin(index * 4, smallest * 4, smallest * 4 + 4);
      index = smallest;
    }
    d[index] = distance;
    n.copyWithin(index * 4, last * 4, last * 4 + 4);
    return true;
  }

  private offer(input: TsGridInput, z: number, x: number, y: number, wrap: number): void {
    const count = 2 ** z;
    const size = input.renderMapSize / count;
    const half = input.renderMapSize * 0.5;
    const originX = x * size - half + input.panX * half + wrap * input.renderMapSize;
    const originY = (count - y - 1) * size - half - input.panY * half;
    if (!input.polygon.intersects(originX, originY, originX + size, originY + size)) return;
    const unit = 1 / count;
    const minX = x * unit + wrap;
    const minY = y * unit;
    const dx = Math.max(minX - input.centreX, 0, input.centreX - (minX + unit));
    const dy = Math.max(minY - input.centreY, 0, input.centreY - (minY + unit));
    this.push(dx * dx + dy * dy, z, x, y, wrap);
  }

  resolve(input: TsGridInput, drawsLabels: boolean): void {
    this.heapSize = 0;
    for (const wrap of [-1, 0, 1]) this.offer(input, 0, 0, 0, wrap);
    const node = new Int32Array(4);
    let count = 0;
    let budget = input.limit * 64 + 4096;
    if (this.visible.length < input.limit * 4) this.visible = new Int32Array(input.limit * 4);
    const visible = this.visible;
    while (count < input.limit && budget > 0 && this.pop(node)) {
      budget--;
      if (node[0] === input.zoom) {
        visible.set(node, count * 4);
        count++;
        continue;
      }
      const x = node[1]! * 2;
      const y = node[2]! * 2;
      const z = node[0]! + 1;
      this.offer(input, z, x, y, node[3]!);
      this.offer(input, z, x + 1, y, node[3]!);
      this.offer(input, z, x, y + 1, node[3]!);
      this.offer(input, z, x + 1, y + 1, node[3]!);
    }
    if (this.instances.byteLength < count * 32) {
      this.instances = new ArrayBuffer(count * 64);
      this.instanceFloats = new Float32Array(this.instances);
      this.instanceWords = new Uint32Array(this.instances);
    }
    const f = this.instanceFloats;
    const w = this.instanceWords;
    const half = input.renderMapSize * 0.5;
    // Those not selected first, as the Rust frame orders them.
    let written = 0;
    let glyphWords = 0;
    for (const pass of [false, true]) {
      for (let i = 0; i < count; i++) {
        const z = visible[i * 4]!;
        const x = visible[i * 4 + 1]!;
        const y = visible[i * 4 + 2]!;
        const isSelected = this.selected.has(tileKey(z, x, y));
        if (isSelected !== pass) continue;
        const tiles = 2 ** z;
        const size = input.renderMapSize / tiles;
        const o = written * 8;
        f[o] = x * size - half + input.panX * half + visible[i * 4 + 3]! * input.renderMapSize;
        f[o + 1] = (tiles - y - 1) * size - half - input.panY * half;
        f[o + 2] = size;
        f[o + 3] = (x + 0.5) / tiles;
        f[o + 4] = x / tiles;
        f[o + 5] = y / tiles;
        f[o + 6] = 1 / tiles;
        w[o + 7] = isSelected ? 1 : 0;
        if (drawsLabels) {
          const layout = this.layout(z, x, y);
          if (layout !== undefined) {
            const records = layout.records;
            if (this.glyphs.length < glyphWords + records.length) {
              const grown = new Uint32Array((glyphWords + records.length) * 2);
              grown.set(this.glyphs.subarray(0, glyphWords));
              this.glyphs = grown;
              this.glyphFloats = new Float32Array(grown.buffer);
            }
            this.glyphs.set(records, glyphWords);
            for (let g = glyphWords; g < glyphWords + records.length; g += 4) {
              this.glyphs[g] = this.glyphs[g]! | written;
              this.glyphFloats[g + 3] = layout.share;
            }
            glyphWords += records.length;
          }
        }
        written++;
      }
    }
    this.tileCount = written;
    this.glyphCount = glyphWords / 4;
  }
}
