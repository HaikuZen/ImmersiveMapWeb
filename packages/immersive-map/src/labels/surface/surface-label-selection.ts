// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { SurfaceLabelPlacement, SurfaceLabelRecord } from "../../tile/store/prepared-labels.ts";

/** Whether a surface label shows at a camera zoom: from its minimum up to, not including, its maximum (null for no bound). */
export function surfaceLabelVisibleAtZoom(placement: SurfaceLabelPlacement, zoom: number): boolean {
  return zoom >= (placement.minimumZoom ?? -Infinity) && zoom < (placement.maximumZoom ?? Infinity);
}

export interface SurfaceLabelSource {
  readonly labels: readonly SurfaceLabelRecord[];
  readonly tileZoom: number;
  readonly worldWrap: number;
}

export interface SurfaceLabelSelectionItem {
  readonly sourceIndex: number;
  readonly labelIndex: number;
  readonly key: string;
}

/**
 * Which copy of each label painted on the map draws this frame (the Swift
 * `SurfaceLabelSelection`). A surface label reaches past the edge of the
 * tile that carries it, and the same name rides every tile zoom from the one
 * it first ships at, so the ground's rule (every source draws, the finest
 * owns each pixel) would cut the text at tile edges and stack copies of it.
 * Instead one copy of a key draws, from the finest source that carries it,
 * whole and over every tile it crosses. The flat map's wrap copies of the
 * world are separate worlds, each drawing its own copy.
 */
export const SurfaceLabelSelection = {
  /**
   * The copies to draw, finest source first: a key already taken by a finer
   * source of the same world is skipped, as is a label outside its zooms at
   * `cameraZoom`.
   */
  select(sources: readonly SurfaceLabelSource[], cameraZoom: number): SurfaceLabelSelectionItem[] {
    const order = sources.map((_, index) => index).sort((lhs, rhs) => sources[rhs]!.tileZoom - sources[lhs]!.tileZoom || lhs - rhs);
    const taken = new Set<string>();
    const items: SurfaceLabelSelectionItem[] = [];
    for (const sourceIndex of order) {
      const source = sources[sourceIndex]!;
      source.labels.forEach((label, labelIndex) => {
        if (!surfaceLabelVisibleAtZoom(label.placement, cameraZoom)) return;
        const worldKey = `${label.key}@${source.worldWrap}`;
        if (taken.has(worldKey)) return;
        taken.add(worldKey);
        items.push({ sourceIndex, labelIndex, key: label.key });
      });
    }
    return items;
  },
} as const;

/**
 * How large a label painted on the map is on screen (the Swift
 * `SurfaceLabelScale`). At the camera zoom equal to a tile's own, the render
 * camera (vertical field of view pi/4, at distance 1) shows the tile's world
 * size over the viewport's height, so a tile spans the same share of the
 * height in any window. The text keeps to that scale: its point size at the
 * reference zoom, twice that one zoom deeper. The vertex stage never lets it
 * draw smaller than its point size where the ground itself is small on
 * screen (surface-label.wgsl).
 */
export const SurfaceLabelScale = {
  /** Screen points one tile spans at the camera zoom equal to its own. */
  tileScreenPoints(viewportHeightPoints: number, tileWorldSize: number): number {
    return (viewportHeightPoints * tileWorldSize) / (2 * Math.tan(Math.PI / 8));
  },

  /** Tile units per point of a label drawn from a tile of `tileZoom` that spans its point size at `referenceZoom`. */
  tileUnitsPerPoint(tileZoom: number, referenceZoom: number, tileScreenPoints: number): number {
    const points = tileScreenPoints * 2 ** (referenceZoom - tileZoom);
    if (!(points > 0) || !Number.isFinite(points)) return 0;
    return 4096 / points;
  },
} as const;

/**
 * Where the labels painted on the map sit in the ground's far-plane depth
 * band (the Swift `SurfaceLabelDepth`): nearer than the ground's layers and
 * every road rank, so the text lies over them, and still farther than the
 * buildings and the models, which hide it.
 */
export const SurfaceLabelDepth = {
  /** `GlobeSurfaceDepthRank.surfaceLabelsRank` times the layer step under the far plane. */
  depth: 1 - 1220 * 3.2e-6,
} as const;
