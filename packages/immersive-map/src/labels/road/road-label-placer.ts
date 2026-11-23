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
 */

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

/** How far past half its label a road name's glyph box can reach from the anchor, in points: a glyph's own half height and more. */
const OFFSCREEN_MARGIN_POINTS = 48;

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
  cumulative = new Float64Array(0);
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

export const RoadLabelPlacer = {
  /**
   * Projects the record's path points onto the flat map and places its
   * glyphs. `origin` is the record's tile on the map (x, y, size in render
   * units). A point deeper than `maximumDepth` (clip w) is out of reach, and
   * a glyph on it is not placed.
   */
  place(
    geometry: RoadLabelGeometry,
    origin: readonly [number, number, number],
    projectionView: Float64Array,
    viewportWidth: number,
    viewportHeight: number,
    pixelsPerPoint: number,
    maximumDepth: number,
    scratch: RoadLabelPlacerScratch,
    output: RoadLabelPlacement,
    lifts?: RoadLabelPointLifts,
  ): void {
    RoadLabelPlacer.project(geometry.pathPoints, origin, projectionView, viewportWidth, viewportHeight, maximumDepth, scratch, lifts);
    RoadLabelPlacer.placeProjected(geometry, scratch.screenPoints, scratch.visible, pixelsPerPoint, scratch, output, viewportWidth, viewportHeight);
  },

  /**
   * The flat projection of a tile's points, device pixels with the origin at
   * the bottom left. `lifts` raises each point by the ground relief under it:
   * the road's names ride the relief with it.
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
    const count = pathPoints.length / 2;
    if (scratch.visible.length < count) {
      scratch.screenPoints = new Float64Array(count * 2);
      scratch.visible = new Uint8Array(count);
    }
    const [ox, oy, size] = origin;
    const halfWidth = viewportWidth * 0.5;
    const halfHeight = viewportHeight * 0.5;
    const screen = scratch.screenPoints;
    const visible = scratch.visible;
    // The lift as two scalars over the kept metres: nothing read per point but the metres themselves.
    const liftMetres = lifts !== undefined && lifts.metres.length === count ? lifts.metres : undefined;
    const datumMetres = lifts?.datumMetres ?? 0;
    const liftScale = lifts?.unitsPerMetre ?? 0;
    for (let index = 0; index < count; index++) {
      // v grows from the north edge, the flat render world is y up.
      const x = ox + pathPoints[index * 2]! * size;
      const y = oy + (1 - pathPoints[index * 2 + 1]!) * size;
      const z = liftMetres === undefined ? 0 : (liftMetres[index]! - datumMetres) * liftScale;
      const cw = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
      if (cw > 0) {
        screen[index * 2] = ((m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / cw + 1) * halfWidth;
        screen[index * 2 + 1] = ((m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / cw + 1) * halfHeight;
        visible[index] = cw <= maximumDepth ? 1 : 0;
      } else {
        screen[index * 2] = 0;
        screen[index * 2 + 1] = 0;
        visible[index] = 0;
      }
    }
  },

  /**
   * Places the record's glyphs from its projected path points. With the
   * viewport given, an instance whose anchor lies farther outside it than
   * half its label and a margin is left hidden unplaced: none of its glyphs
   * can reach the screen, so the solve would keep none of it either, and
   * the frame skips its glyphs' trigonometry.
   */
  placeProjected(
    geometry: RoadLabelGeometry,
    points: Float64Array,
    visible: Uint8Array,
    pixelsPerPoint: number,
    scratch: RoadLabelPlacerScratch,
    output: RoadLabelPlacement,
    viewportWidth = Infinity,
    viewportHeight = Infinity,
  ): void {
    output.resize(geometry.glyphCount);
    const pathCount = geometry.pathRanges.length / 2;
    let longestPath = 0;
    for (let p = 0; p < pathCount; p++) longestPath = Math.max(longestPath, geometry.pathRanges[p * 2 + 1]! - geometry.pathRanges[p * 2]!);
    if (scratch.cumulative.length < longestPath) scratch.cumulative = new Float64Array(longestPath);
    if (geometry.glyphCount === 0 || points.length < geometry.pathPoints.length) {
      output.hideAll();
      return;
    }
    const cumulative = scratch.cumulative;
    const placements = output.placements;
    const extrapolated = output.extrapolated;
    const boxes = output.boxHalfSizes;
    const glyphs = geometry.glyphs;
    const G = RoadGlyphLayout;
    const pointAlong = (start: number, count: number, distance: number, out: number[]): void => {
      const segment = segmentAt(cumulative, count, distance);
      if (segment < 0) {
        const last = (start + count - 1) * 2;
        out[0] = points[last]!;
        out[1] = points[last + 1]!;
        return;
      }
      const segmentLength = cumulative[segment + 1]! - cumulative[segment]!;
      const t = segmentLength > 0 ? Math.min(Math.max((distance - cumulative[segment]!) / segmentLength, 0), 1) : 0;
      const a = (start + segment) * 2;
      out[0] = points[a]! + (points[a + 2]! - points[a]!) * t;
      out[1] = points[a + 1]! + (points[a + 3]! - points[a + 1]!) * t;
    };
    const ahead = [0, 0];
    const behind = [0, 0];
    for (let path = 0; path < pathCount; path++) {
      const start = geometry.pathRanges[path * 2]!;
      const count = geometry.pathRanges[path * 2 + 1]! - start;
      // The path's arc length, and whether all of it is in front of the camera.
      let pathVisible = count >= 2;
      if (pathVisible) {
        cumulative[0] = 0;
        pathVisible = visible[start] !== 0;
        for (let offset = 1; offset < count; offset++) {
          if (visible[start + offset] === 0) pathVisible = false;
          const a = (start + offset) * 2;
          // A square root and not Math.hypot, which guards against an overflow
          // screen pixels cannot reach and costs a third of the placement.
          const stepX = points[a]! - points[a - 2]!;
          const stepY = points[a + 1]! - points[a - 1]!;
          cumulative[offset] = cumulative[offset - 1]! + Math.sqrt(stepX * stepX + stepY * stepY);
        }
      }
      const totalLength = count >= 2 ? cumulative[count - 1]! : 0;
      const instanceStart = geometry.pathInstanceRanges[path * 2]!;
      const instanceEnd = geometry.pathInstanceRanges[path * 2 + 1]!;
      for (let instance = instanceStart; instance < instanceEnd; instance++) {
        const pointIndex = geometry.anchors[instance * 3 + 2]!;
        const glyphStart = geometry.instanceGlyphRanges[instance * 2]!;
        const glyphEnd = geometry.instanceGlyphRanges[instance * 2 + 1]!;
        const reach = (glyphs[glyphStart * G.floats + G.labelWidth]! * 0.5 + OFFSCREEN_MARGIN_POINTS) * pixelsPerPoint;
        const anchorX = points[pointIndex * 2]!;
        const anchorY = points[pointIndex * 2 + 1]!;
        const offscreen = anchorX < -reach || anchorY < -reach || anchorX > viewportWidth + reach || anchorY > viewportHeight + reach;
        if (!pathVisible || pointIndex < 0 || pointIndex * 2 >= points.length || visible[pointIndex] === 0 || glyphEnd <= glyphStart || offscreen) {
          for (let glyph = glyphStart; glyph < glyphEnd; glyph++) {
            placements[glyph * 4] = placements[glyph * 4 + 1] = placements[glyph * 4 + 2] = placements[glyph * 4 + 3] = 0;
            extrapolated[glyph] = 0;
          }
          continue;
        }
        // The anchor's distance along the path: its own projected point
        // dropped onto its segment. Lerping the world t along the projected
        // segment is not the projection of the anchor under a tilted camera.
        const segment = Math.min(Math.max(geometry.anchors[instance * 3 + 1]!, 0), count - 2);
        const s0 = (start + segment) * 2;
        const segmentX = points[s0 + 2]! - points[s0]!;
        const segmentY = points[s0 + 3]! - points[s0 + 1]!;
        const segmentLength = cumulative[segment + 1]! - cumulative[segment]!;
        let along = 0;
        if (segmentLength > 0) {
          const ax = points[pointIndex * 2]! - points[s0]!;
          const ay = points[pointIndex * 2 + 1]! - points[s0 + 1]!;
          along = Math.min(Math.max((ax * segmentX + ay * segmentY) / segmentLength, 0), segmentLength);
        }
        const anchorDistance = cumulative[segment]! + along;
        // Which way the text reads: the label's own span of the path, half a
        // label either side of the anchor, runs left on screen or right.
        const labelWidth = glyphs[glyphStart * G.floats + G.labelWidth]!;
        const halfSpan = labelWidth * 0.5 * pixelsPerPoint;
        pointAlong(start, count, Math.min(Math.max(anchorDistance + halfSpan, 0), totalLength), ahead);
        pointAlong(start, count, Math.min(Math.max(anchorDistance - halfSpan, 0), totalLength), behind);
        let spanX = ahead[0]! - behind[0]!;
        const spanY = ahead[1]! - behind[1]!;
        if (spanX * spanX + spanY * spanY <= 0) spanX = segmentX;
        const reverse = spanX < 0;
        const canDraw = totalLength >= glyphs[glyphStart * G.floats + G.minLength]! * pixelsPerPoint;

        let cachedSegment = -1;
        let cachedAngle = 0;
        let boxAngle = Number.NaN;
        let boxSin = 0;
        let boxCos = 1;
        for (let glyph = glyphStart; glyph < glyphEnd; glyph++) {
          // Glyph metrics are in layout points, the arc length they are placed along in device pixels.
          let glyphOffset = (glyphs[glyph * G.floats + G.center]! - labelWidth * 0.5) * pixelsPerPoint;
          if (reverse) glyphOffset = -glyphOffset;
          const targetDistance = anchorDistance + glyphOffset;
          let placed = false;
          let overhangs = false;
          let px = 0;
          let py = 0;
          let angle = 0;
          if (targetDistance <= 0) {
            const a = start * 2;
            const dx = points[a + 2]! - points[a]!;
            const dy = points[a + 3]! - points[a + 1]!;
            const length = Math.sqrt(dx * dx + dy * dy);
            if (length > 0) {
              px = points[a]! + (dx / length) * targetDistance;
              py = points[a + 1]! + (dy / length) * targetDistance;
              angle = Math.atan2(dy, dx);
              placed = overhangs = true;
            }
          } else if (targetDistance >= totalLength) {
            const a = (start + count - 1) * 2;
            const dx = points[a]! - points[a - 2]!;
            const dy = points[a + 1]! - points[a - 1]!;
            const length = Math.sqrt(dx * dx + dy * dy);
            if (length > 0) {
              px = points[a]! + (dx / length) * (targetDistance - totalLength);
              py = points[a + 1]! + (dy / length) * (targetDistance - totalLength);
              angle = Math.atan2(dy, dx);
              placed = overhangs = true;
            }
          } else {
            // 0 < targetDistance < totalLength: the segment found has a length.
            const seg = segmentAt(cumulative, count, targetDistance);
            if (seg >= 0) {
              const length = cumulative[seg + 1]! - cumulative[seg]!;
              const t = (targetDistance - cumulative[seg]!) / length;
              const a = (start + seg) * 2;
              const dx = points[a + 2]! - points[a]!;
              const dy = points[a + 3]! - points[a + 1]!;
              px = points[a]! + dx * t;
              py = points[a + 1]! + dy * t;
              // The glyphs of one segment share its direction.
              if (seg !== cachedSegment) {
                cachedSegment = seg;
                cachedAngle = Math.atan2(dy, dx);
              }
              angle = cachedAngle;
              placed = true;
            }
          }
          if (placed && reverse) angle += Math.PI;
          const isVisible = placed && canDraw;
          placements[glyph * 4] = px;
          placements[glyph * 4 + 1] = py;
          placements[glyph * 4 + 2] = angle;
          placements[glyph * 4 + 3] = isVisible ? 1 : 0;
          extrapolated[glyph] = overhangs ? 1 : 0;
          if (isVisible) {
            const hx = geometry.glyphHalfSizes[glyph * 2]! * pixelsPerPoint;
            const hy = geometry.glyphHalfSizes[glyph * 2 + 1]! * pixelsPerPoint;
            if (angle !== boxAngle) {
              boxAngle = angle;
              boxSin = Math.abs(Math.sin(angle));
              boxCos = Math.abs(Math.cos(angle));
            }
            const s = boxSin;
            const c = boxCos;
            boxes[glyph * 2] = c * hx + s * hy;
            boxes[glyph * 2 + 1] = s * hx + c * hy;
          } else {
            boxes[glyph * 2] = 0;
            boxes[glyph * 2 + 1] = 0;
          }
        }
      }
    }
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

/**
 * The first segment of a path (`count` points, arc lengths in `cumulative`)
 * whose end lies at `distance` or past it, -1 past the path's end: the
 * segment the Swift placer's linear walk stops at, found by bisection. A
 * zero-length segment is never the first such one for a distance above 0.
 */
function segmentAt(cumulative: Float64Array, count: number, distance: number): number {
  let low = 1;
  let high = count - 1;
  if (count < 2 || cumulative[high]! < distance) return -1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (cumulative[middle]! >= distance) high = middle;
    else low = middle + 1;
  }
  return low - 1;
}

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
