// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Whether a tile deserves road labels by its visible screen area (the Swift
 * `RoadLabelNearCameraFilter`): the tile quad is clipped in homogeneous
 * coordinates against the near plane and the viewport, and the metrics are
 * taken from what is actually on screen. A near tile whose corners go behind
 * the camera is judged by its large visible part rather than by a degenerate
 * projection of its corners.
 */

type Clip = [number, number, number, number];

/** Below a 150 by 150 point square a tile takes too little of the screen for its road names to read. */
const minimumVisibleAreaPoints = 150 * 150;
/**
 * The least visible area per target-zoom tile equivalent (area over
 * 4^underzoom): a coarse parent of a distant strip may take half the screen,
 * but the world in it is compressed 4^N times.
 */
const minimumVisibleAreaPerNativeTilePoints = 100 * 100;
/** The least area over the long edge squared: a perspective-flattened ribbon is rejected whatever its area. */
const minimumProjectedCompressionRatio = 0.07;

const planes: ((v: Clip) => number)[] = [(v) => v[3] - 1e-4, (v) => v[3] + v[0], (v) => v[3] - v[0], (v) => v[3] + v[1], (v) => v[3] - v[1]];

/** Sutherland-Hodgman in homogeneous coordinates: the near plane first, then the four NDC bounds. */
function clipToViewport(polygon: Clip[]): Clip[] {
  let clipped = polygon;
  for (const plane of planes) {
    if (clipped.length < 3) return [];
    const next: Clip[] = [];
    for (let index = 0; index < clipped.length; index++) {
      const current = clipped[index]!;
      const following = clipped[(index + 1) % clipped.length]!;
      const currentDistance = plane(current);
      const followingDistance = plane(following);
      if (currentDistance >= 0) next.push(current);
      if (currentDistance >= 0 !== followingDistance >= 0) {
        const t = currentDistance / (currentDistance - followingDistance);
        next.push([
          current[0] + (following[0] - current[0]) * t,
          current[1] + (following[1] - current[1]) * t,
          current[2] + (following[2] - current[2]) * t,
          current[3] + (following[3] - current[3]) * t,
        ]);
      }
    }
    clipped = next;
  }
  return clipped;
}

export const RoadLabelNearCameraFilter = {
  /**
   * `clipCorners` are the tile's four corners in clip space, the viewport in
   * device pixels, `underzoomLevels` how many zooms coarser than the frame's
   * tile zoom the tile is.
   */
  shouldKeepTile(clipCorners: readonly Clip[], viewportWidth: number, viewportHeight: number, pixelsPerPoint = 2, underzoomLevels = 0): boolean {
    if (clipCorners.length !== 4 || !Number.isFinite(viewportWidth) || !(viewportWidth > 0) || !Number.isFinite(viewportHeight) || !(viewportHeight > 0)) return false;
    const visible = clipToViewport([...clipCorners]);
    if (visible.length < 3) return false;
    const points = visible.map(([x, y, , w]) => [((x / w) * 0.5 + 0.5) * viewportWidth, ((y / w) * 0.5 + 0.5) * viewportHeight] as const);
    let longestEdge = 0;
    let doubledArea = 0;
    for (let index = 0; index < points.length; index++) {
      const current = points[index]!;
      const next = points[(index + 1) % points.length]!;
      longestEdge = Math.max(longestEdge, Math.hypot(next[0] - current[0], next[1] - current[1]));
      doubledArea += current[0] * next[1] - next[0] * current[1];
    }
    // Float32 epsilon, as the Swift `ulpOfOne`.
    if (!(longestEdge > 1.1920929e-7)) return false;
    // The polygon is in device pixels, so an area stated in points squared scales by the square of the pixels per point.
    const pixelsPerPointSquared = pixelsPerPoint * pixelsPerPoint;
    const visibleArea = Math.abs(doubledArea) * 0.5;
    const contentScale = 2 ** (2 * Math.min(Math.max(underzoomLevels, 0), 10));
    const compressionRatio = visibleArea / (longestEdge * longestEdge);
    return (
      visibleArea >= minimumVisibleAreaPoints * pixelsPerPointSquared &&
      visibleArea / contentScale >= minimumVisibleAreaPerNativeTilePoints * pixelsPerPointSquared &&
      compressionRatio >= minimumProjectedCompressionRatio
    );
  },

  /**
   * The clip corners of a tile laid at `origin` (x, y, size in render units)
   * on the flat map: north-west, north-east, south-east, south-west, as the
   * tile uv runs (0, 0), (1, 0), (1, 1), (0, 1).
   */
  flatTileClipCorners(projectionView: Float64Array, originX: number, originY: number, size: number): Clip[] {
    const m = projectionView;
    const corner = (u: number, v: number): Clip => {
      const x = originX + u * size;
      const y = originY + (1 - v) * size;
      return [m[0]! * x + m[4]! * y + m[12]!, m[1]! * x + m[5]! * y + m[13]!, m[2]! * x + m[6]! * y + m[14]!, m[3]! * x + m[7]! * y + m[15]!];
    };
    return [corner(0, 0), corner(1, 0), corner(1, 1), corner(0, 1)];
  },
} as const;
