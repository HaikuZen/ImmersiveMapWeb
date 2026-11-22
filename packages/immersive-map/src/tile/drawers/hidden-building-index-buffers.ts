// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The index buffers the map's buildings draw from while models stand in
 * for some of them, a port of the Swift `HiddenBuildingIndexBuffers`.
 *
 * A tile's buildings are one run of indices in its arena, one building
 * after another, drawn in one call (one a run of quarters). A model takes
 * buildings out of the middle of it, and the arena itself cannot change:
 * the building comes back when its model goes, and the frames in flight
 * still read it. So a tile with hidden buildings gets a working buffer of
 * its own, a copy of its indices without the hidden buildings' ranges
 * (`TileBuildingRange`), and draws that, in one call again. The vertices
 * are shared, only indices are copied, and only for the tiles that hold a
 * hidden building.
 *
 * WebGPU reads no buffer back on the CPU, and the arena's indices live only
 * on the GPU, so the copy is a compute pass (`BuildingIndexCopier`, encoded
 * before the frame's passes) reading the arena as storage and writing the
 * working buffer, 16-bit indices two to a word. Swift copies on the CPU
 * from the shared buffer. A drawn index needs no alignment in WebGPU (the
 * draw takes a first index), so the quarters of a working buffer follow
 * one another without the padding Swift puts between them.
 *
 * A working buffer is built in the frame the hidden buildings change and
 * kept for as long as its tile lives. With nothing hidden (the models are
 * gone, or not shown yet) the tile draws its own indices, and the working
 * buffer waits: the same buildings hidden again cost nothing. The world
 * pass and the shadow casters draw the same tiles and share the buffers.
 */

import type { ReplacedBuildings } from "../../render/core/scene-model-frame-state.ts";
import { quarterCount } from "../tile-quarters.ts";
import { buildingIndexRuns, type TileBuildingRanges } from "../tile-building-range.ts";

/** What a tile's buildings draw from this frame. */
export type HiddenBuildingIndices =
  /** The tile's own indices, whole: it holds no hidden building. */
  | { readonly kind: "whole" }
  /** The working buffer, from its start, and where each quarter starts in it, the count last (empty for a tile kept whole). */
  | { readonly kind: "working"; readonly buffer: GPUBuffer; readonly indexCount: number; readonly quarterStarts: readonly number[] }
  /** Nothing: every building of the tile is hidden. */
  | { readonly kind: "none" };

/** How a working buffer lays out the runs it keeps: each quarter's after another (`quarterStarts` the tile's own), or one segment for a tile kept whole. */
export interface WorkingLayout {
  /** The runs of each quarter, as [start, end) in the tile's own indices. */
  readonly segments: readonly (readonly [number, number])[][];
  /** Where each quarter starts in the working buffer, the count last: empty for a tile kept whole. */
  readonly quarterStarts: readonly number[];
  readonly indexCount: number;
}

export function workingLayout(runs: readonly (readonly [number, number])[], quarterStarts: readonly number[]): WorkingLayout {
  if (quarterStarts.length !== quarterCount + 1) {
    const indexCount = runs.reduce((sum, [start, end]) => sum + end - start, 0);
    return { segments: [runs.map(([s, e]) => [s, e] as const)], quarterStarts: [], indexCount };
  }
  const segments: (readonly [number, number])[][] = [];
  const starts: number[] = [];
  let indexCount = 0;
  for (let quarter = 0; quarter < quarterCount; quarter++) {
    const low = quarterStarts[quarter]!;
    const high = quarterStarts[quarter + 1]!;
    const segment: (readonly [number, number])[] = [];
    for (const [start, end] of runs) {
      const s = Math.max(start, low);
      const e = Math.min(end, high);
      if (e > s) segment.push([s, e]);
    }
    starts.push(indexCount);
    segments.push(segment);
    indexCount += segment.reduce((sum, [s, e]) => sum + e - s, 0);
  }
  starts.push(indexCount);
  return { segments, quarterStarts: starts, indexCount };
}

/**
 * The copy a layout asks for, one [destination start, source start, count]
 * triple a run, in indices: the working buffer's indices `destination`
 * onwards are the tile's from `source`, one after another.
 */
export function copyRuns(layout: WorkingLayout): Uint32Array {
  const flat = layout.segments.flat();
  const triples = new Uint32Array(flat.length * 4);
  let destination = 0;
  flat.forEach(([start, end], i) => {
    triples[i * 4] = destination;
    triples[i * 4 + 1] = start;
    triples[i * 4 + 2] = end - start;
    destination += end - start;
  });
  return triples;
}

/** The tile whose buildings an entry answers for: its ranges, its index count and quarter starts, its zoom. */
export interface HiddenBuildingTile {
  readonly zoom: number;
  readonly ranges: TileBuildingRanges;
  readonly indexCount: number;
  readonly quarterIndexStarts: readonly number[];
}

/** Makes the working buffer of a layout: `undefined` when it could not be made, and the tile's buildings then draw nothing. */
export type WorkingBufferFactory<Owner> = (owner: Owner, layout: WorkingLayout) => GPUBuffer | undefined;

interface Entry {
  /** The hidden set the entry was last checked against. */
  generation: number;
  /** The runs the working buffer holds, `undefined` for a tile that draws whole. */
  runs: [number, number][] | undefined;
  indices: HiddenBuildingIndices;
}

const whole: HiddenBuildingIndices = { kind: "whole" };
const none: HiddenBuildingIndices = { kind: "none" };

export class HiddenBuildingIndexBuffers<Owner extends object> {
  /** The fewest entries worth a sweep for the ones of released tiles. */
  static readonly minimumSweepEntryCount = 64;
  private sweepEntryCount = HiddenBuildingIndexBuffers.minimumSweepEntryCount;
  private replaced: ReplacedBuildings | undefined;
  private isHidingNothing = true;
  /** The ids left out of the map tiles of each zoom asked for, worked out once per change. */
  private hiddenIDsByZoom = new Map<number, ReadonlySet<number>>();
  /** Moves on when the hidden buildings change: an entry of an older generation is checked again before it answers. */
  private generation = 0;
  private readonly entries = new Map<Owner, Entry>();

  constructor(
    private readonly makeWorkingBuffer: WorkingBufferFactory<Owner>,
    /** Whether an owner's tile still lives: the sweep drops the entries (and destroys the buffers) of the ones that do not. */
    private readonly isLive: (owner: Owner) => boolean,
  ) {}

  /**
   * Takes the buildings the frame leaves out. Called once a frame before
   * the tiles ask: the comparison is the only work a frame with the same
   * buildings hidden does here. With nothing hidden the last buildings are
   * kept, and the working buffers with them, for the models' return.
   */
  update(replaced: ReplacedBuildings): void {
    this.isHidingNothing = replaced.isEmpty;
    if (this.isHidingNothing || (this.replaced !== undefined && replaced.equals(this.replaced))) return;
    this.replaced = replaced;
    this.hiddenIDsByZoom.clear();
    this.generation++;
  }

  /** What `owner`'s tile draws its buildings from, the buildings of the last `update` left out. A tile takes the hidden ids of its own zoom. */
  indices(owner: Owner, tile: HiddenBuildingTile): HiddenBuildingIndices {
    if (this.isHidingNothing || this.replaced === undefined) return whole;
    const entry = this.entries.get(owner);
    if (entry !== undefined && entry.generation === this.generation) return entry.indices;
    let hiddenIDs = this.hiddenIDsByZoom.get(tile.zoom);
    if (hiddenIDs === undefined) {
      hiddenIDs = this.replaced.ids(tile.zoom);
      this.hiddenIDsByZoom.set(tile.zoom, hiddenIDs);
    }
    const runs = buildingIndexRuns(tile.ranges, tile.indexCount, hiddenIDs);
    if (entry !== undefined && sameRuns(entry.runs, runs)) {
      // Another set of hidden buildings that takes the same ones out of
      // this tile: its working buffer stands.
      entry.generation = this.generation;
      return entry.indices;
    }
    if (entry?.indices.kind === "working") entry.indices.buffer.destroy();
    const indices = this.makeIndices(owner, tile, runs);
    this.entries.set(owner, { generation: this.generation, runs, indices });
    this.sweepIfNeeded();
    return indices;
  }

  /** Destroys every working buffer. */
  destroy(): void {
    for (const entry of this.entries.values()) if (entry.indices.kind === "working") entry.indices.buffer.destroy();
    this.entries.clear();
  }

  private makeIndices(owner: Owner, tile: HiddenBuildingTile, runs: [number, number][] | undefined): HiddenBuildingIndices {
    if (runs === undefined) return whole;
    const layout = workingLayout(runs, tile.quarterIndexStarts);
    if (layout.indexCount === 0) return none;
    const buffer = this.makeWorkingBuffer(owner, layout);
    if (buffer === undefined) return none;
    return { kind: "working", buffer, indexCount: layout.indexCount, quarterStarts: layout.quarterStarts };
  }

  /** Drops the entries of released tiles, and their working buffers with them, once the entries have doubled since the last sweep. */
  private sweepIfNeeded(): void {
    if (this.entries.size <= this.sweepEntryCount) return;
    for (const [owner, entry] of this.entries) {
      if (this.isLive(owner)) continue;
      if (entry.indices.kind === "working") entry.indices.buffer.destroy();
      this.entries.delete(owner);
    }
    this.sweepEntryCount = Math.max(HiddenBuildingIndexBuffers.minimumSweepEntryCount, this.entries.size * 2);
  }
}

function sameRuns(a: readonly [number, number][] | undefined, b: readonly [number, number][] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((run, i) => run[0] === b[i]![0] && run[1] === b[i]![1]);
}
