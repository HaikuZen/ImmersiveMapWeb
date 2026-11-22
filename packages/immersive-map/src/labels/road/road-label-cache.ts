// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The road labels of the frame's tiles (the Swift `RoadLabelCache` and
 * `RoadLabelTileRecord`): one record per tile in the base labels' winner
 * order, the records' instances (a label at one anchor of its road) packed
 * end to end into one instance set the fades and the collision decisions are
 * index-aligned with. A tile that stays keeps its record, and with it the
 * last placement of its glyphs, so a tile culled from the near set keeps
 * drawing where its names were while they fade out.
 *
 * An instance's key is the FNV-1a 64 of its record's owner, its road's key
 * and its path (Swift hashes the same fields with the process's random
 * seed), so it is stable across sessions.
 */

import type { GroundRelief } from "../../tile/relief/lifts/ground-relief.ts";
import type { VisibleTile } from "../../tile/placement/place-tile.ts";
import type { PreparedLabelTextStyle, RoadLabelAnchor, RoadLabelsMeta } from "../../tile/store/prepared-labels.ts";
import type { GpuLabelVertexSpan } from "../../tile/store/tile-gpu.ts";
import { StableFNV1aHasher } from "../../utils/fnv1a.ts";
import type { LabelSourceTile } from "../base/base-label-cache.ts";
import { type BaseLabelSourceEntry, ownerKeyString, sourcePriorityRank } from "../base/base-label-source-entry.ts";
import { keyHalves } from "../collisions/base-label-rank.ts";
import { type LabelBlockMove, LabelWorkingSetChange } from "../common/label-working-set-change.ts";
import { type RoadLabelGeometry, RoadLabelPlacement } from "./road-label-placer.ts";

/** The style a tile without one of its own draws its road names in (the Swift `RoadLabelCache.fallbackStyle`). */
export const roadLabelFallbackStyle: PreparedLabelTextStyle = Object.freeze<PreparedLabelTextStyle>({
  key: 0,
  fillColor: [0.54, 0.54, 0.52],
  strokeColor: [0.54, 0.54, 0.52],
  haloEm: 0,
  sizePoints: 18,
  weight: "thin",
  uppercased: false,
  emboldenPoints: 0.375,
  letterSpacingEm: 0,
  opacity: 1,
  haloSoftness: 0,
  isPointOfInterest: false,
  sphereFillColor: null,
  sphereStrokeColor: null,
});

/** One tile's road labels in the working set. */
export class RoadLabelTileRecord {
  /** Where the record's instances start in the cache's instance set. */
  instanceStart = 0;
  /** The last placement of the record's glyphs, hidden until the record is first placed. */
  readonly placement = new RoadLabelPlacement();

  constructor(
    readonly ownerKey: VisibleTile,
    readonly resident: LabelSourceTile,
    public sourcePriority: number,
    readonly labelStyle: PreparedLabelTextStyle,
    readonly geometry: RoadLabelGeometry,
    /** The number of roads the record labels. */
    readonly pathCount: number,
    readonly instanceKeys: BigUint64Array,
    readonly instanceKeyHalves: Uint32Array,
    /** Each instance's laid-out size in points, two per instance. */
    readonly instanceLabelSizes: Float32Array,
    readonly instanceAnchorOrdinals: Int32Array,
    /** The tile's road glyph vertices. */
    readonly glyphVertices: GpuLabelVertexSpan,
  ) {
    this.placement.resize(geometry.glyphCount);
  }

  get glyphCount(): number {
    return this.geometry.glyphCount;
  }

  private reliefMetresValue: Float32Array | undefined;
  private reliefMetresKey: string | undefined;

  /**
   * The terrain's metres under each path point on a relief, read once per
   * terrain (its tile, its revision and the record's place in it) and kept,
   * so a frame's lift is one multiply-add per point (the Swift
   * `RoadLabelTileRecord.reliefMetres(for:)`).
   */
  reliefMetres(relief: GroundRelief): Float32Array {
    const key = `${relief.terrain.id}/${relief.terrain.revision}/${relief.originX}/${relief.originY}/${relief.scale}`;
    const points = this.geometry.pathPoints;
    const count = points.length / 2;
    if (key === this.reliefMetresKey && this.reliefMetresValue?.length === count) return this.reliefMetresValue;
    const metres = new Float32Array(count);
    for (let index = 0; index < count; index++) metres[index] = relief.metresAtTileUV(points[index * 2]!, points[index * 2 + 1]!);
    this.reliefMetresValue = metres;
    this.reliefMetresKey = key;
    return metres;
  }

  get instanceCount(): number {
    return this.instanceKeys.length;
  }

  get hasRenderableGlyphs(): boolean {
    return this.glyphCount > 0 && this.glyphVertices.vertexCount > 0;
  }
}

/** A label's path cut at a grid, and where each segment of the path as it came went. */
export interface CutPath {
  /** The points as tile uv, two per point. */
  readonly points: number[];
  /** For each segment of the path as it came, the index of its first segment in `points`. */
  readonly firstSegments: number[];
  /** For each segment of the path as it came, the places along it, 0 to 1, ascending, the grid put points at. */
  readonly cuts: number[][];
}

/** The segment of a cut path an anchor lies on: the one its place along its own segment falls in. */
export function cutPathSegment(path: CutPath, anchor: Pick<RoadLabelAnchor, "segmentIndex" | "t">): number {
  const segment = Math.min(anchor.segmentIndex, path.firstSegments.length - 1);
  if (segment < 0) return 0;
  return path.firstSegments[segment]! + path.cuts[segment]!.reduce((n, t) => (t <= anchor.t ? n + 1 : n), 0);
}

/**
 * Cuts a path in tile uv (two numbers per point) at every crossing of the
 * lines of a grid of `stepUV`, as the parse cut the road's ribbon, so the
 * path has a point wherever the ribbon has a row. A point on a grid line is
 * not doubled.
 */
export function cutAtGrid(path: readonly number[], stepUV: number): CutPath {
  const pointCount = path.length / 2;
  if (pointCount < 2 || !(stepUV > 0)) {
    const segments = Math.max(pointCount - 1, 0);
    return { points: [...path], firstSegments: Array.from({ length: segments }, (_, i) => i), cuts: Array.from({ length: segments }, () => []) };
  }
  // A crossing this close to a segment's end is the end itself.
  const epsilon = 1e-4;
  const points: number[] = [path[0]!, path[1]!];
  const firstSegments: number[] = [];
  const cuts: number[][] = [];
  for (let index = 0; index < pointCount - 1; index++) {
    const sx = path[index * 2]!;
    const sy = path[index * 2 + 1]!;
    const ex = path[index * 2 + 2]!;
    const ey = path[index * 2 + 3]!;
    firstSegments.push(points.length / 2 - 1);
    const along: number[] = [];
    for (const [from, to] of [
      [sx, ex],
      [sy, ey],
    ] as const) {
      if (!(Math.abs(to - from) > 0)) continue;
      const upper = Math.max(from, to);
      let line = Math.floor(Math.min(from, to) / stepUV) + 1;
      while (line * stepUV < upper) {
        const t = (line * stepUV - from) / (to - from);
        if (t > epsilon && t < 1 - epsilon) along.push(t);
        line += 1;
      }
    }
    along.sort((a, b) => a - b);
    const kept: number[] = [];
    for (const t of along) if (kept.length === 0 || t - kept[kept.length - 1]! > epsilon) kept.push(t);
    for (const t of kept) points.push(sx + (ex - sx) * t, sy + (ey - sy) * t);
    points.push(ex, ey);
    cuts.push(kept);
  }
  return { points, firstSegments, cuts };
}

export class RoadLabelCache {
  private recordsByOwner = new Map<string, RoadLabelTileRecord>();
  /** The records in the set's order. */
  orderedRecords: RoadLabelTileRecord[] = [];
  /** The instance set's total. */
  instanceCount = 0;

  /** `reliefSubdivisionStep` is the grid step a tile of a zoom cuts its label paths at, in tile units, `undefined` off the relief. */
  constructor(private readonly reliefSubdivisionStep: (tileZoom: number) => number | undefined = () => undefined) {}

  evict(): void {
    this.recordsByOwner.clear();
    this.orderedRecords = [];
    this.instanceCount = 0;
  }

  /** Brings the set up to `sourceEntries` and returns the change: the surviving records' runs. */
  synchronize(sourceEntries: readonly BaseLabelSourceEntry<LabelSourceTile>[]): LabelWorkingSetChange {
    const next = new Map<string, RoadLabelTileRecord>();
    const ordered: RoadLabelTileRecord[] = [];
    const moves: LabelBlockMove[] = [];
    let start = 0;
    for (const entry of sourceEntries) {
      const key = ownerKeyString(entry.ownerKey);
      const priority = sourcePriorityRank(entry);
      const existing = this.recordsByOwner.get(key);
      let record: RoadLabelTileRecord;
      if (existing !== undefined && existing.resident === entry.resident) {
        record = existing;
        record.sourcePriority = priority;
        if (record.instanceCount > 0) moves.push({ oldStart: record.instanceStart, newStart: start, count: record.instanceCount });
      } else {
        record = this.makeRecord(entry, priority);
      }
      record.instanceStart = start;
      start += record.instanceCount;
      next.set(key, record);
      ordered.push(record);
    }
    // A road instance's key holds its tile, so an instance never outlives
    // its record: the surviving records' runs are all there is to carry.
    this.recordsByOwner = next;
    this.orderedRecords = ordered;
    this.instanceCount = start;
    return new LabelWorkingSetChange(start, moves);
  }

  private makeRecord(entry: BaseLabelSourceEntry<LabelSourceTile>, sourcePriority: number): RoadLabelTileRecord {
    const road: RoadLabelsMeta = entry.resident.gpu.meta.labels.road;
    const style = road.labelStyle ?? roadLabelFallbackStyle;
    const stepTiles = this.reliefSubdivisionStep(entry.resident.tile.z);
    const gridStepUV = stepTiles === undefined ? undefined : stepTiles / 4096;
    const tile = entry.resident.tile;
    const zScale = 2 ** tile.z;

    const instanceKeys: bigint[] = [];
    const instanceSizes: number[] = [];
    const instanceOrdinals: number[] = [];
    const pathPoints: number[] = [];
    const pathRanges: number[] = [];
    const pathInstanceRanges: number[] = [];
    const instanceGlyphRanges: number[] = [];
    const glyphs: number[] = [];
    const glyphInstances: number[] = [];
    const glyphHalfSizes: number[] = [];
    // Every path's points first, then the anchors' own points, so a path's points stay contiguous.
    const anchorPoints: number[] = [];
    const pendingAnchors: [number, number, number][] = [];

    for (const pathRange of road.pathRanges) {
      const labelIndex = pathRange.labelIndex;
      if (labelIndex < 0 || labelIndex >= road.pathLabels.length || labelIndex >= road.glyphBoundRanges.length || labelIndex >= road.sizes.length || labelIndex >= road.anchorRanges.length) continue;
      const pointEnd = pathRange.start + pathRange.count;
      if (pathRange.count <= 1 || pathRange.start < 0 || pointEnd > road.pathInputs.length) continue;
      const local: number[] = [];
      for (let p = pathRange.start; p < pointEnd; p++) local.push(road.pathInputs[p]![0], road.pathInputs[p]![1]);
      let length = 0;
      for (let p = 1; p < pathRange.count; p++) length += Math.hypot((local[p * 2]! - local[p * 2 - 2]!) / zScale, (local[p * 2 + 1]! - local[p * 2 - 1]!) / zScale);
      if (!(length > 0)) continue;
      const boundRange = road.glyphBoundRanges[labelIndex]!;
      const boundEnd = boundRange.start + boundRange.count;
      if (boundRange.count <= 0 || boundRange.start < 0 || boundEnd > road.glyphBounds.length) continue;
      const bounds = road.glyphBounds.slice(boundRange.start, boundEnd);
      const anchorRange = road.anchorRanges[labelIndex]!;
      const anchorEnd = anchorRange.start + anchorRange.count;
      if (anchorRange.count <= 0 || anchorRange.start < 0 || anchorEnd > road.anchors.length) continue;
      const pathIndex = pathRanges.length / 2;
      const entryKey = new StableFNV1aHasher()
        .combine(entry.ownerKey.tile.x)
        .combine(entry.ownerKey.tile.y)
        .combine(entry.ownerKey.tile.z)
        .combine(entry.ownerKey.worldWrap)
        .combine(roadKey(road.pathLabels[labelIndex]!.key))
        .combine(labelIndex)
        .combine(pathRange.start)
        .combine(pathRange.count)
        .finalize();
      const size = road.sizes[labelIndex]!;
      // On the relief, the path cut at the grid as the road is.
      const cut = gridStepUV === undefined ? undefined : cutAtGrid(local, gridStepUV);
      const pathStart = pathPoints.length / 2;
      pathPoints.push(...(cut?.points ?? local));
      pathRanges.push(pathStart, pathPoints.length / 2);
      let labelMinY = Infinity;
      let labelMaxY = -Infinity;
      for (const b of bounds) {
        labelMinY = Math.min(labelMinY, b[2]);
        labelMaxY = Math.max(labelMaxY, b[3]);
      }
      const labelCenterY = (labelMinY + labelMaxY) * 0.5;
      const firstInstance = instanceKeys.length;
      for (let a = anchorRange.start; a < anchorEnd; a++) {
        const anchor = road.anchors[a]!;
        const instanceIndex = instanceKeys.length;
        instanceKeys.push(instanceKey(entryKey, anchor.anchorOrdinal));
        instanceSizes.push(size[0], size[1]);
        instanceOrdinals.push(anchor.anchorOrdinal);
        // The anchor rides the point stream as its own point, so the placer
        // reads the anchor's true projected position.
        const segment = cut === undefined ? anchor.segmentIndex : cutPathSegment(cut, anchor);
        pendingAnchors.push([pathIndex, segment, anchorPoints.length / 2]);
        const s = Math.min(Math.max(anchor.segmentIndex, 0), pathRange.count - 2);
        const t = Math.min(Math.max(anchor.t, 0), 1);
        anchorPoints.push(local[s * 2]! + (local[s * 2 + 2]! - local[s * 2]!) * t, local[s * 2 + 1]! + (local[s * 2 + 3]! - local[s * 2 + 1]!) * t);
        const glyphStart = glyphInstances.length;
        for (const b of bounds) {
          glyphs.push((b[0] + b[1]) * 0.5, labelCenterY, size[0], size[0]);
          glyphInstances.push(instanceIndex);
          glyphHalfSizes.push((b[1] - b[0]) * 0.5, (b[3] - b[2]) * 0.5);
        }
        instanceGlyphRanges.push(glyphStart, glyphInstances.length);
      }
      pathInstanceRanges.push(firstInstance, instanceKeys.length);
    }
    const anchorPointsStart = pathPoints.length / 2;
    pathPoints.push(...anchorPoints);
    const anchors = new Int32Array(pendingAnchors.length * 3);
    pendingAnchors.forEach(([path, segment, offset], i) => {
      anchors[i * 3] = path;
      anchors[i * 3 + 1] = segment;
      anchors[i * 3 + 2] = anchorPointsStart + offset;
    });
    const geometry: RoadLabelGeometry = {
      pathPoints: Float32Array.from(pathPoints),
      pathRanges: Int32Array.from(pathRanges),
      pathInstanceRanges: Int32Array.from(pathInstanceRanges),
      anchors,
      instanceGlyphRanges: Int32Array.from(instanceGlyphRanges),
      glyphs: Float32Array.from(glyphs),
      glyphInstances: Int32Array.from(glyphInstances),
      glyphHalfSizes: Float32Array.from(glyphHalfSizes),
      glyphCount: glyphInstances.length,
    };
    const keys = BigUint64Array.from(instanceKeys);
    const halves = new Uint32Array(keys.length * 2);
    keys.forEach((key, i) => {
      const [hi, lo] = keyHalves(key);
      halves[i * 2] = hi;
      halves[i * 2 + 1] = lo;
    });
    return new RoadLabelTileRecord(
      entry.ownerKey,
      entry.resident,
      sourcePriority,
      style,
      geometry,
      pathRanges.length / 2,
      keys,
      halves,
      Float32Array.from(instanceSizes),
      Int32Array.from(instanceOrdinals),
      entry.resident.gpu.labels.roadGlyphs,
    );
  }
}

/** A road's key as the metadata writes it, a u64 as a decimal string. */
function roadKey(text: string): bigint {
  try {
    return BigInt(text) & 0xffff_ffff_ffff_ffffn;
  } catch {
    return 0n;
  }
}

/** An instance's key: the label's key mixed with its anchor's ordinal (the Swift `makeInstanceKey`). */
function instanceKey(entryKey: bigint, anchorOrdinal: number): bigint {
  return (entryKey ^ ((BigInt(anchorOrdinal) * 1469598103934665603n) & 0xffff_ffff_ffff_ffffn)) & 0xffff_ffff_ffff_ffffn;
}
