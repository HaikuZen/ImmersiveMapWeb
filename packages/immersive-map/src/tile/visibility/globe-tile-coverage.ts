// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Frustum } from "../../camera/frustum.ts";
import type { GlobeUniform } from "../../globe/globe-uniform.ts";
import { type GlobeVisibilityInputs, GlobeVisibilityModel } from "../../globe/globe-visibility-model.ts";
import type { Vec3 } from "../../math/vec.ts";
import { type RasterTileSpec, type VisibleTile, visibleTileKey } from "../placement/place-tile.ts";
import { pinnedWorldCoverMaxZoomLevel } from "../store/tile-working-set-store.ts";
import { tileIndex } from "../tile-index.ts";
import type { Tile } from "../tile.ts";
import { type FlatRingBand, FlatRingRules, flatRingBand } from "./flat-ring-rules.ts";
import { FlatTileCoverage } from "./flat-tile-coverage.ts";
import { GlobeRingMath, type GridCell } from "./globe-ring-math.ts";

/** What the walk did, for the diagnostics. `duration` in seconds. */
export interface GlobeCullingMetrics {
  duration: number;
  visitedNodeCount: number;
  frustumRejectCount: number;
  horizonRejectCount: number;
  placedTileCount: number;
  acceptedWholeSubtreeCount: number;
}

function zeroMetrics(): GlobeCullingMetrics {
  return { duration: 0, visitedNodeCount: 0, frustumRejectCount: 0, horizonRejectCount: 0, placedTileCount: 0, acceptedWholeSubtreeCount: 0 };
}

/** What the sphere's coverage resolved. The sets and the map are keyed by `visibleTileKey`. */
export interface GlobeCoverageResolution {
  /** Finest first (`FlatTileCoverage.sorted`). */
  readonly targets: readonly VisibleTile[];
  /** One band per rule, nearest first, as on the plane: its zoom, its last ring and the tiles it placed. */
  readonly bands: readonly FlatRingBand[];
  /**
   * The targets placed by a rule that draws no lines (`FlatRingRule.drawsLines`).
   * A tile two bands ask for takes the nearer band's answer, and the cover
   * past the last rule the last rule's.
   */
  readonly linelessTargets: ReadonlySet<string>;
  /** The targets a rule that draws no labels placed (`FlatRingRule.drawsLabels`), decided as for the lines. */
  readonly unlabelledTargets: ReadonlySet<string>;
  /**
   * The targets a rule that draws its ground from a texture placed
   * (`FlatRingRule.rasterSize`), with how it is baked, decided as for the
   * lines.
   */
  readonly rasterTargets: ReadonlyMap<string, RasterTileSpec>;
  readonly metrics: GlobeCullingMetrics;
}

/**
 * What the globe coverage walk reads, taken off the frame once: the eye in
 * world units (the camera looks at the world origin, the sphere's front
 * point, and the pan turns the sphere under it), the globe it looks at,
 * whose pan and radius place every tile's centre in that world, the ring
 * rules, and the target zoom's tile the camera looks at, which the rings are
 * counted from.
 */
export interface GlobeCoverageInputs {
  readonly eye: Vec3;
  readonly globe: GlobeUniform;
  readonly rules: FlatRingRules;
  readonly lookAtTile: GridCell;
}

/** One rule as the walk reads it: the rings it owns and the zoom it draws them at. */
interface Band {
  readonly firstRing: number;
  readonly lastRing: number;
  readonly zoom: number;
  readonly drawsLines: boolean;
  readonly drawsLabels: boolean;
  readonly rasterSize: number | undefined;
  readonly zoomDrop: number;
  tileCount: number;
}

interface Walk {
  readonly targetZoom: number;
  readonly frustum: Frustum;
  readonly visibility: GlobeVisibilityInputs;
  readonly lookAtTile: GridCell;
  readonly bands: Band[];
  readonly targets: VisibleTile[];
  /** By `tileIndex`. */
  readonly placed: Set<number>;
  readonly lineless: Set<string>;
  readonly unlabelled: Set<string>;
  readonly raster: Map<string, RasterTileSpec>;
  readonly metrics: GlobeCullingMetrics;
}

type GlobeNodeVisibilityEvaluation = "rejectFrustum" | "rejectHorizon" | "descend" | "acceptWholeSubtree";

/**
 * The zoom of the pinned world cover, which the working set keeps resident:
 * the floor of every placement on the sphere and what the ground past the
 * last rule is asked for.
 */
const floorZoom = pinnedWorldCoverMaxZoomLevel;
const transitionLowZoomFallbackLimit = 3;

const rasterSpecs = new Map<number, RasterTileSpec>();
function rasterSpec(size: number): RasterTileSpec {
  let spec = rasterSpecs.get(size);
  if (spec === undefined) {
    spec = Object.freeze({ size });
    rasterSpecs.set(size, spec);
  }
  return spec;
}

function minimumRejectZoom(targetZoom: number, transition: number): number {
  return Math.min(targetZoom, transition > 0 ? 4 : 3);
}

function evaluateVisibility(tile: Tile, targetZoom: number, frustum: Frustum, inputs: GlobeVisibilityInputs): GlobeNodeVisibilityEvaluation {
  const shouldRejectAtZoom = tile.z >= minimumRejectZoom(targetZoom, inputs.transition);
  const needsWholeSubtreeEvaluation = tile.z < targetZoom;
  if (!shouldRejectAtZoom && !needsWholeSubtreeEvaluation) return "descend";
  const bound = GlobeVisibilityModel.tileBound(tile, inputs);
  if (shouldRejectAtZoom && !frustum.isSphereVisible(bound.center, bound.radius)) return "rejectFrustum";
  if (shouldRejectAtZoom && !GlobeVisibilityModel.tileMayPassHorizon(bound, inputs)) return "rejectHorizon";
  if (needsWholeSubtreeEvaluation && frustum.containsSphere(bound.center, bound.radius) && GlobeVisibilityModel.tilePassesHorizonEntirely(bound, inputs)) {
    return "acceptWholeSubtree";
  }
  return "descend";
}

function place(tile: Tile, walk: Walk): void {
  const index = tileIndex(tile.x, tile.y, tile.z);
  if (walk.placed.has(index)) return;
  walk.placed.add(index);
  walk.targets.push({ tile, worldWrap: 0 });
  walk.metrics.placedTileCount += 1;
}

function children(tile: Tile): Tile[] {
  const x = tile.x * 2;
  const y = tile.y * 2;
  const z = tile.z + 1;
  return [
    { x, y, z },
    { x: x + 1, y, z },
    { x, y: y + 1, z },
    { x: x + 1, y: y + 1, z },
  ];
}

/** Through the morph at the coarse zooms every leaf is taken: the visibility tests do not hold there. */
function acceptLeafDescendants(tile: Tile, walk: Walk): void {
  if (tile.z === walk.targetZoom) {
    place(tile, walk);
    return;
  }
  for (const child of children(tile)) acceptLeafDescendants(child, walk);
}

/** `accepted`: the tile lies in a subtree the visibility tests accepted whole, so they are not asked again below it. */
function visit(tile: Tile, acceptedAbove: boolean, walk: Walk): void {
  walk.metrics.visitedNodeCount += 1;
  if (walk.visibility.transition > 0 && walk.targetZoom <= transitionLowZoomFallbackLimit) {
    acceptLeafDescendants(tile, walk);
    return;
  }
  let accepted = acceptedAbove;
  if (!accepted) {
    switch (evaluateVisibility(tile, walk.targetZoom, walk.frustum, walk.visibility)) {
      case "rejectFrustum":
        walk.metrics.frustumRejectCount += 1;
        return;
      case "rejectHorizon":
        walk.metrics.horizonRejectCount += 1;
        return;
      case "acceptWholeSubtree":
        walk.metrics.acceptedWholeSubtreeCount += 1;
        accepted = true;
        break;
      case "descend":
        break;
    }
  }

  // The bands the tile meets: a rule's rings against the rings of the tile's
  // nearest and farthest target tiles. No order of the zooms along the rings
  // is assumed, so any rule list holds.
  const rings = GlobeRingMath.ringRange(tile, walk.targetZoom, walk.lookAtTile);
  const index = tileIndex(tile.x, tile.y, tile.z);
  let placesTile = false;
  let drawsLines = true;
  let drawsLabels = true;
  let rasterSize: number | undefined;
  let finestWanted = floorZoom;
  for (const band of walk.bands) {
    if (!(band.firstRing <= rings.upperBound && band.lastRing >= rings.lowerBound)) continue;
    finestWanted = Math.max(finestWanted, band.zoom);
    if (band.zoom === tile.z && !placesTile) {
      placesTile = true;
      drawsLines = band.drawsLines;
      drawsLabels = band.drawsLabels;
      rasterSize = band.rasterSize;
      if (!walk.placed.has(index)) band.tileCount += 1;
    }
  }
  // Past the last rule the pinned cover paints the ground.
  const lastBand = walk.bands.at(-1);
  if (!placesTile && tile.z === floorZoom && rings.upperBound > (lastBand?.lastRing ?? -1)) {
    placesTile = true;
    drawsLines = lastBand?.drawsLines ?? true;
    drawsLabels = lastBand?.drawsLabels ?? true;
    rasterSize = lastBand?.rasterSize;
  }
  if (placesTile) {
    if (!walk.placed.has(index)) {
      const key = visibleTileKey({ tile, worldWrap: 0 });
      if (!drawsLines) walk.lineless.add(key);
      if (!drawsLabels) walk.unlabelled.add(key);
      if (rasterSize !== undefined) walk.raster.set(key, rasterSpec(rasterSize));
    }
    place(tile, walk);
  }
  if (tile.z < Math.min(finestWanted, walk.targetZoom)) {
    for (const child of children(tile)) visit(child, accepted, walk);
  }
}

/**
 * The sphere's coverage: the plane's ring rules (`FlatRingRules`) read off
 * the sphere's grid. The walk descends from the root with the frustum and
 * horizon rejects, which stand where the plane has its frustum footprint,
 * and at every tile the rings of its nearest and farthest target tiles from
 * the look-at tile (`GlobeRingMath`) say which rules' bands it meets. A tile
 * is placed when a band it meets is drawn at its zoom, and looked into where
 * a band it meets is drawn finer. Overlapping placements are fine, as on the
 * plane: the sphere draws its sources through the same tile-priority
 * stencil.
 *
 * One thing differs from the plane. Beyond the last rule the plane places
 * nothing and leaves the ground to the haze. The sphere has no haze, so
 * ground past the last rule is asked for at the pinned world cover's zoom
 * (`floorZoom`, always resident, nothing to load), and no band goes below
 * that cover either: a coarser stand-in would be a tile the working set
 * already holds.
 */
export const GlobeTileCoverage = {
  floorZoom,

  targets(targetZoom: number, inputs: GlobeCoverageInputs, frustum: Frustum | null | undefined): GlobeCoverageResolution {
    const startTime = performance.now();
    if (targetZoom < 0 || frustum === null || frustum === undefined) {
      return { targets: [], bands: [], linelessTargets: new Set(), unlabelledTargets: new Set(), rasterTargets: new Map(), metrics: zeroMetrics() };
    }
    const bands: Band[] = [];
    for (const rule of FlatRingRules.normalized(inputs.rules).rules) {
      const previous = bands.at(-1);
      bands.push({
        firstRing: previous === undefined ? 0 : previous.lastRing + 1,
        lastRing: rule.distance,
        zoom: Math.min(targetZoom, Math.max(floorZoom, targetZoom - rule.zoomDrop)),
        drawsLines: rule.drawsLines,
        drawsLabels: rule.drawsLabels,
        rasterSize: rule.rasterSize,
        zoomDrop: rule.zoomDrop,
        tileCount: 0,
      });
    }
    const walk: Walk = {
      targetZoom,
      frustum,
      visibility: GlobeVisibilityModel.makeInputs(inputs.globe, inputs.eye),
      lookAtTile: inputs.lookAtTile,
      bands,
      targets: [],
      placed: new Set(),
      lineless: new Set(),
      unlabelled: new Set(),
      raster: new Map(),
      metrics: zeroMetrics(),
    };
    visit({ x: 0, y: 0, z: 0 }, false, walk);
    walk.metrics.duration = (performance.now() - startTime) / 1000;
    return {
      targets: walk.targets.sort(FlatTileCoverage.compare),
      bands: walk.bands.map((band) => flatRingBand(band.zoom, band.lastRing, band.tileCount)),
      linelessTargets: walk.lineless,
      unlabelledTargets: walk.unlabelled,
      rasterTargets: walk.raster,
      metrics: walk.metrics,
    };
  },
} as const;
