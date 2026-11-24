// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Lays a tile's road glyphs along their roads on screen, on the CPU, in the
 * frame that draws them (the Swift `RoadLabelPlacer`): the same numbers go
 * to the collision solve and to the road text vertex shader, so the boxes
 * tested are the glyphs drawn.
 *
 * A record's paths are projected once (one tile, one origin), then each
 * path's arc length is accumulated once and every label instance on it is
 * placed from that: the anchor's distance along the path from the anchor's
 * own projected point, the reading direction from the label's own span of
 * the path (a stitched road that hooks back has a chord pointing the wrong
 * way), then each glyph at its offset from the anchor, extrapolated straight
 * past a path end where the label overhangs it. A glyph is drawn when placed
 * and the path is long enough for the label. A path with any point behind
 * the camera draws nothing.
 *
 * The placement itself is the `map-frame` crate of ImmersiveMapCore, shared
 * with the engine's other ports (crates/frame-wasm, `RoadLabelPlacer`). A
 * record's geometry crosses to it once and stays there, so a frame's call
 * carries the camera alone, and the placement is copied back into the
 * record's arrays.
 */

import { assertFrameWasm, frameWasmMemory } from "../../frame/frame-wasm.ts";
import { RoadLabelPlacer as WasmRoadLabelPlacer, projectRoadLabelPoints } from "../../wasm/frame_wasm/frame_wasm.js";

/**
 * One tile record's roads and labels, fixed when the record is made. Ranges
 * are start and end pairs, end exclusive.
 */
export interface RoadLabelGeometry {
  /** Every path's points as tile uv (two per point), path after path, then each anchor's own point. */
  readonly pathPoints: Float32Array;
  /** Each path's points in `pathPoints`. */
  readonly pathRanges: Int32Array;
  /** Each path's label instances, contiguous. */
  readonly pathInstanceRanges: Int32Array;
  /** Per instance: its path, the segment it sits on, the index of its own point in `pathPoints`. */
  readonly anchors: Int32Array;
  /** Each instance's glyphs, contiguous. */
  readonly instanceGlyphRanges: Int32Array;
  /** Per glyph: its centre along the label, the label's vertical centre, the label's width, the least path length it needs, in points. */
  readonly glyphs: Float32Array;
  /** Per glyph, its instance in the record. */
  readonly glyphInstances: Int32Array;
  /** Per glyph, the collision box half size in points before rotation. */
  readonly glyphHalfSizes: Float32Array;
  readonly glyphCount: number;
}

export const RoadGlyphLayout = {
  floats: 4,
  center: 0,
  labelCenterY: 1,
  labelWidth: 2,
  minLength: 3,
} as const;

/** Where a record's glyphs go this frame, index-aligned with its glyphs. */
export class RoadLabelPlacement {
  /** Per glyph: x, y in device pixels (origin bottom left), the angle, 1 when drawn. */
  placements = new Float32Array(0);
  /** Glyphs placed past a path end: drawn but never offered to the solve. */
  extrapolated = new Uint8Array(0);
  /** The rotated collision box half sizes, two per glyph. */
  boxHalfSizes = new Float32Array(0);

  resize(glyphCount: number): void {
    if (this.extrapolated.length !== glyphCount) {
      this.placements = new Float32Array(glyphCount * 4);
      this.extrapolated = new Uint8Array(glyphCount);
      this.boxHalfSizes = new Float32Array(glyphCount * 2);
    }
  }

  hideAll(): void {
    this.placements.fill(0);
    this.extrapolated.fill(0);
  }
}

/** The projected paths, reused between records and frames. */
export class RoadLabelPlacerScratch {
  screenPoints = new Float64Array(0);
  visible = new Uint8Array(0);
}

/**
 * The lift of a tile's path points on the ground relief (the Swift
 * `RoadLabelPlacer.PointLifts`): the terrain's metres under each point, read
 * once per terrain and kept on the tile's record, and the frame's datum and
 * scale (the world units a metre rises by times the relief's strength).
 */
export interface RoadLabelPointLifts {
  readonly metres: Float32Array;
  readonly datumMetres: number;
  readonly unitsPerMetre: number;
}

/** A record's geometry as the placer holds it: its handle there, and the lifts it was last given. */
interface RegisteredGeometry {
  readonly handle: number;
  lifts: Float32Array | undefined;
}

let wasmPlacer: WasmRoadLabelPlacer | undefined;
const registered = new WeakMap<RoadLabelGeometry, RegisteredGeometry>();
/** A geometry no record holds any more gives its handle back. */
const released = new FinalizationRegistry<number>((handle) => wasmPlacer?.unregister(handle));
const noLifts = new Float32Array(0);

function placer(): WasmRoadLabelPlacer {
  if (wasmPlacer === undefined) {
    assertFrameWasm();
    wasmPlacer = new WasmRoadLabelPlacer();
  }
  return wasmPlacer;
}

/** The geometry's registration with the placer, made the first time it is placed. */
function registration(geometry: RoadLabelGeometry): RegisteredGeometry {
  let entry = registered.get(geometry);
  if (entry === undefined) {
    const handle = placer().register(geometry.pathPoints, geometry.pathRanges, geometry.pathInstanceRanges, geometry.anchors, geometry.instanceGlyphRanges, geometry.glyphs, geometry.glyphHalfSizes, geometry.glyphCount);
    entry = { handle, lifts: undefined };
    registered.set(geometry, entry);
    released.register(geometry, handle);
  }
  return entry;
}

/** Copies a record's placement out of the placer's memory into the record's own arrays. */
function readPlacement(handle: number, glyphCount: number, output: RoadLabelPlacement): void {
  output.resize(glyphCount);
  if (glyphCount === 0) return;
  const wasm = placer();
  const buffer = frameWasmMemory().buffer;
  output.placements.set(new Float32Array(buffer, wasm.placementsPtr(handle), glyphCount * 4));
  output.extrapolated.set(new Uint8Array(buffer, wasm.extrapolatedPtr(handle), glyphCount));
  output.boxHalfSizes.set(new Float32Array(buffer, wasm.boxHalfSizesPtr(handle), glyphCount * 2));
}

export const RoadLabelPlacer = {
  /**
   * Projects the record's path points onto the flat map and places its
   * glyphs. `origin` is the record's tile on the map (x, y, size in render
   * units). A point deeper than `maximumDepth` (clip w) is out of reach, and
   * a glyph on it is not placed. `lifts` raises each point by the ground
   * relief under it: the road's names ride the relief with it.
   */
  place(
    geometry: RoadLabelGeometry,
    origin: readonly [number, number, number],
    projectionView: Float64Array,
    viewportWidth: number,
    viewportHeight: number,
    pixelsPerPoint: number,
    maximumDepth: number,
    output: RoadLabelPlacement,
    lifts?: RoadLabelPointLifts,
  ): void {
    if (geometry.glyphCount === 0) {
      output.resize(0);
      return;
    }
    const entry = registration(geometry);
    const wasm = placer();
    // The metres are kept on the tile's record and read once per terrain: they cross when they are another array.
    const metres = lifts?.metres;
    if (metres !== undefined && metres !== entry.lifts) {
      wasm.setLifts(entry.handle, metres);
      entry.lifts = metres;
    }
    wasm.place(entry.handle, projectionView, origin[0], origin[1], origin[2], viewportWidth, viewportHeight, pixelsPerPoint, maximumDepth, metres !== undefined, lifts?.datumMetres ?? 0, lifts?.unitsPerMetre ?? 0);
    readPlacement(entry.handle, geometry.glyphCount, output);
  },

  /**
   * The flat projection of a tile's points, device pixels with the origin at
   * the bottom left, into `scratch`. The frame projects inside `place`: this
   * is the projection on its own, for a caller that wants the points.
   */
  project(
    pathPoints: Float32Array,
    origin: readonly [number, number, number],
    m: Float64Array,
    viewportWidth: number,
    viewportHeight: number,
    maximumDepth: number,
    scratch: RoadLabelPlacerScratch,
    lifts?: RoadLabelPointLifts,
  ): void {
    assertFrameWasm();
    const count = pathPoints.length / 2;
    if (scratch.visible.length < count) {
      scratch.screenPoints = new Float64Array(count * 2);
      scratch.visible = new Uint8Array(count);
    }
    const projected = projectRoadLabelPoints(pathPoints, origin[0], origin[1], origin[2], m, viewportWidth, viewportHeight, maximumDepth, lifts?.metres ?? noLifts, lifts?.datumMetres ?? 0, lifts?.unitsPerMetre ?? 0);
    for (let index = 0; index < count; index++) {
      scratch.screenPoints[index * 2] = projected[index * 3]!;
      scratch.screenPoints[index * 2 + 1] = projected[index * 3 + 1]!;
      scratch.visible[index] = projected[index * 3 + 2]!;
    }
  },

  /**
   * Places the record's glyphs from its projected path points. With the
   * viewport given, an instance whose anchor lies farther outside it than
   * half its label and a margin is left hidden unplaced: none of its glyphs
   * can reach the screen, so the solve would keep none of it either, and
   * the frame skips its glyphs' trigonometry.
   */
  placeProjected(geometry: RoadLabelGeometry, points: Float64Array, visible: Uint8Array, pixelsPerPoint: number, output: RoadLabelPlacement, viewportWidth = Infinity, viewportHeight = Infinity): void {
    if (geometry.glyphCount === 0) {
      output.resize(0);
      return;
    }
    const entry = registration(geometry);
    placer().placeProjected(entry.handle, points, visible, pixelsPerPoint, viewportWidth, viewportHeight);
    readPlacement(entry.handle, geometry.glyphCount, output);
  },

  /**
   * Appends the glyph boxes of one instance from the record's placement, for
   * the collision solve, onto `boxes`. Returns false when the instance gets
   * no decision: a hidden glyph (path behind the camera or shorter than the
   * label), a glyph placed past a path end, or a turn between adjacent
   * glyphs beyond `maxGlyphTurnRadians`. Then nothing is appended.
   */
  appendInstanceBoxes(glyphStart: number, glyphEnd: number, output: RoadLabelPlacement, maxGlyphTurnRadians: number, boxes: RoadBoxBuffer): boolean {
    if (glyphEnd <= glyphStart || glyphStart < 0 || glyphEnd > output.extrapolated.length) return false;
    const boxStart = boxes.count;
    let previousAngle: number | undefined;
    for (let glyph = glyphStart; glyph < glyphEnd; glyph++) {
      const angle = output.placements[glyph * 4 + 2]!;
      if (output.placements[glyph * 4 + 3] === 0 || output.extrapolated[glyph] !== 0) {
        boxes.count = boxStart;
        return false;
      }
      if (previousAngle !== undefined && Math.abs(RoadLabelPlacer.normalizedAngleDelta(previousAngle, angle)) > maxGlyphTurnRadians) {
        boxes.count = boxStart;
        return false;
      }
      previousAngle = angle;
      boxes.push(output.placements[glyph * 4]!, output.placements[glyph * 4 + 1]!, output.boxHalfSizes[glyph * 2]!, output.boxHalfSizes[glyph * 2 + 1]!);
    }
    return true;
  },

  normalizedAngleDelta(lhs: number, rhs: number): number {
    let delta = rhs - lhs;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    return delta;
  },
} as const;

/** The road glyph boxes offered to one solve: centres and half sizes, two floats each, grown as needed. */
export class RoadBoxBuffer {
  count = 0;
  centers = new Float32Array(512);
  halfSizes = new Float32Array(512);

  push(cx: number, cy: number, hx: number, hy: number): void {
    if (this.centers.length < (this.count + 1) * 2) {
      const centers = new Float32Array(this.centers.length * 2);
      centers.set(this.centers);
      this.centers = centers;
      const halves = new Float32Array(this.halfSizes.length * 2);
      halves.set(this.halfSizes);
      this.halfSizes = halves;
    }
    this.centers[this.count * 2] = cx;
    this.centers[this.count * 2 + 1] = cy;
    this.halfSizes[this.count * 2] = hx;
    this.halfSizes[this.count * 2 + 1] = hy;
    this.count++;
  }
}
