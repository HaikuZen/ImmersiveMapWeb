// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { Vec2, Vec3 } from "../../math/vec.ts";

/**
 * What the frame needs to know about each label of a working set besides its
 * geometry, as columns index-aligned with the set (the Swift
 * `BaseLabelPresentationInput`): the camera zooms it shows at, whether it is
 * local detail, and whether it is another tile's copy of a feature the set
 * keeps (it never reserves space and never shows).
 */
export interface BaseLabelPresentation {
  /** The camera zoom the label shows from, 0 for always. */
  readonly minCameraZoom: Float32Array;
  /** The camera zoom it goes away at, Infinity for never. */
  readonly maxCameraZoom: Float32Array;
  readonly isLocal: Uint8Array;
  readonly isCopy: Uint8Array;
}

/** Whether the camera's zoom is one a label shows at: from its minimum up to, not including, its maximum. */
export function showsAtZoom(presentation: BaseLabelPresentation, index: number, cameraZoom: number): boolean {
  return presentation.minCameraZoom[index]! <= cameraZoom && cameraZoom < presentation.maxCameraZoom[index]!;
}

/** How far the local detail may be, for `localSuppression`. */
export interface LocalDetailReach {
  /** The camera in the render world the anchors are placed in. */
  readonly eye: Vec3;
  /** Render-world units per metre at the look-at point, `undefined` where the distance is not measured (the globe). */
  readonly unitsPerMeter: number | undefined;
  readonly maximumDistanceMeters: number;
}

/**
 * The per-label rules between the projection, the collision solve and the
 * fades (the Swift `BaseLabelVisibilityResolver`), written as in-place passes
 * over the columns so a frame allocates nothing. Spans are start and end
 * pairs (`LabelActiveSpans`): only their labels are decided, the rest are
 * cleared.
 */
export const BaseLabelVisibilityResolver = {
  activeAlphaThreshold: 0.0001,

  /**
   * Whether a label reserves collision space this frame: it must have a
   * drawable screen point and be either in view (in front of the horizon) or
   * still fading out of view (so neighbours do not jump mid-fade). A label
   * outside its camera zooms, or local detail out of reach, reserves nothing
   * while it is fully invisible, otherwise a hidden POI would displace
   * visible ones.
   */
  reservesSpaceOne(screenVisible: boolean, horizonVisible: boolean, localSuppressed: boolean, currentAlpha: number, minCameraZoom: number, maxCameraZoom: number, cameraZoom: number): boolean {
    if (!screenVisible) return false;
    const threshold = BaseLabelVisibilityResolver.activeAlphaThreshold;
    const active = horizonVisible || currentAlpha > threshold;
    const outsideZooms = minCameraZoom > cameraZoom || cameraZoom >= maxCameraZoom;
    const suppressed = (outsideZooms || localSuppressed) && currentAlpha <= threshold;
    return active && !suppressed;
  },

  /** `reservesSpaceOne` for the spans of the set, into `reserves`. A copy reserves nothing. */
  reservesSpace(
    presentation: BaseLabelPresentation,
    screenVisible: Uint8Array,
    horizonVisible: Uint8Array,
    localSuppressed: Uint8Array,
    currentAlphas: Float32Array,
    cameraZoom: number,
    spans: ArrayLike<number>,
    reserves: Uint8Array,
  ): void {
    reserves.fill(0);
    const count = reserves.length;
    const limit = Math.min(count, screenVisible.length, horizonVisible.length, currentAlphas.length);
    const localCount = localSuppressed.length;
    for (let s = 0; s + 1 < spans.length; s += 2) {
      const end = Math.min(spans[s + 1]!, limit);
      for (let index = spans[s]!; index < end; index++) {
        const reserves1 =
          presentation.isCopy[index] === 0 &&
          BaseLabelVisibilityResolver.reservesSpaceOne(
            screenVisible[index] !== 0,
            horizonVisible[index] !== 0,
            index < localCount && localSuppressed[index] !== 0,
            currentAlphas[index]!,
            presentation.minCameraZoom[index]!,
            presentation.maxCameraZoom[index]!,
            cameraZoom,
          );
        reserves[index] = reserves1 ? 1 : 0;
      }
    }
  },

  /**
   * Whether a label wants to be shown: accepted by the collision solve
   * (which never offers a copy a place), in front of the horizon, not local
   * detail out of reach, and within its camera zooms. A missing entry counts
   * as hidden.
   */
  targetVisibility(
    presentation: BaseLabelPresentation,
    collisionVisible: Uint8Array,
    horizonVisible: Uint8Array,
    localSuppressed: Uint8Array,
    cameraZoom: number,
    spans: ArrayLike<number>,
    target: Uint8Array,
  ): void {
    target.fill(0);
    const count = target.length;
    for (let s = 0; s + 1 < spans.length; s += 2) {
      const end = Math.min(spans[s + 1]!, count);
      for (let index = spans[s]!; index < end; index++) {
        const accepted = index < collisionVisible.length && collisionVisible[index] !== 0;
        const inView = index < horizonVisible.length && horizonVisible[index] !== 0;
        const outsideLookAt = index < localSuppressed.length && localSuppressed[index] !== 0;
        target[index] = accepted && inView && !outsideLookAt && showsAtZoom(presentation, index, cameraZoom) ? 1 : 0;
      }
    }
  },

  /**
   * Which labels are local detail out of reach, written in place: a local
   * label whose tile lies outside the three by three tiles around the one
   * holding the look-at point (`centerWorldMercator`, normalized Mercator),
   * counted in that tile's own grid, or whose anchor (`anchors`, xyz in the
   * render world) is farther from the camera than `reach` allows. A tile
   * coarser than the look-at tile holds the point over its whole area, so a
   * stand-in shows its detail near the camera until the exact tiles arrive.
   * `tiles` holds each label's tile as z, x, y. Returns whether any label
   * changed.
   */
  localSuppression(
    presentation: BaseLabelPresentation,
    tiles: Int32Array,
    anchors: Float32Array,
    centerWorldMercator: Vec2,
    reach: LocalDetailReach,
    spans: ArrayLike<number>,
    suppressed: Uint8Array,
  ): boolean {
    const count = suppressed.length;
    const maximumDistance = reach.unitsPerMeter === undefined ? undefined : reach.unitsPerMeter * Math.max(0, reach.maximumDistanceMeters);
    const [ex, ey, ez] = reach.eye;
    const pointCount = tiles.length / 3;
    const anchorCount = anchors.length / 3;
    let changed = false;
    // The labels of a tile are a run: the tile's answer is found once for the run.
    let lastZ = -1;
    let lastX = -1;
    let lastY = -1;
    let lastOutside = false;
    for (let s = 0; s + 1 < spans.length; s += 2) {
      const end = Math.min(spans[s + 1]!, count);
      for (let index = spans[s]!; index < end; index++) {
        let outOfReach = false;
        if (presentation.isLocal[index] !== 0 && index < pointCount) {
          const z = tiles[index * 3]!;
          const x = tiles[index * 3 + 1]!;
          const y = tiles[index * 3 + 2]!;
          if (z !== lastZ || x !== lastX || y !== lastY) {
            lastZ = z;
            lastX = x;
            lastY = y;
            lastOutside = !BaseLabelVisibilityResolver.isWithinLookAtBlock(z, x, y, centerWorldMercator);
          }
          outOfReach = lastOutside;
          if (!outOfReach && maximumDistance !== undefined && index < anchorCount) {
            const dx = anchors[index * 3]! - ex;
            const dy = anchors[index * 3 + 1]! - ey;
            const dz = anchors[index * 3 + 2]! - ez;
            outOfReach = Math.sqrt(dx * dx + dy * dy + dz * dz) > maximumDistance;
          }
        }
        const value = outOfReach ? 1 : 0;
        if (suppressed[index] !== value) {
          suppressed[index] = value;
          changed = true;
        }
      }
    }
    return changed;
  },

  /**
   * Whether the tile lies in the three by three tiles of its zoom around the
   * one holding a point of the normalized Mercator world (x wrapped across
   * the antimeridian, y clamped to the tile grid).
   */
  isWithinLookAtBlock(z: number, x: number, y: number, mercator: Vec2): boolean {
    const tilesCount = 2 ** z;
    const lookAtX = Math.floor(ImmersiveMapProjection.wrapNormalizedWorldX(mercator[0]) * tilesCount);
    const lookAtY = Math.floor(ImmersiveMapProjection.clampNormalizedWorldY(mercator[1]) * tilesCount);
    const dx = Math.abs(x - lookAtX);
    const dy = Math.abs(y - lookAtY);
    return Math.min(dx, tilesCount - dx) <= 1 && dy <= 1;
  },
} as const;
