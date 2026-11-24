// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Frustum } from "../../camera/frustum.ts";
import type { ImmersiveMapCameraState } from "../../camera/immersive-map-camera-state.ts";
import { assertFrameWasm } from "../../frame/frame-wasm.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { ClosedRange } from "../../math/closed-range.ts";
import type { Mat4 } from "../../math/matrix.ts";
import type { Vec2, Vec3 } from "../../math/vec.ts";
import type { ResolvedPresentationState } from "../../presentation/resolved-presentation-state.ts";
import { TileCoverage } from "../../wasm/frame_wasm/frame_wasm.js";
import type { RasterTileSpec, VisibleTile } from "../placement/place-tile.ts";
import { pinnedWorldCoverMaxZoomLevel } from "../store/tile-working-set-store.ts";
import { type FlatRingBand, FlatRingRules, flatRingBand } from "./flat-ring-rules.ts";
import type { TileDiagnostics } from "./tile-diagnostics.ts";
import type { Center, VisibleContentState } from "./visible-content-state.ts";

/** What a frame's coverage is resolved from. */
export interface TileCullingInputs {
  readonly cameraState: ImmersiveMapCameraState;
  readonly resolvedPresentation: ResolvedPresentationState;
  readonly targetZoom: number;
  /** The frame's projection-view matrix, which the flat footprint is cut from. */
  readonly cameraMatrix: Mat4 | null | undefined;
  readonly cameraFrustum: Frustum | null | undefined;
  /** The eye in render world units. */
  readonly cameraEye: Vec3;
  /**
   * How far the ground relief falls and rises about the plane, in world
   * units, `undefined` off the relief: the coverage then reaches the tiles
   * the relief lifts into view (the footprint over the relief's slab).
   */
  readonly reliefHeights?: ClosedRange | undefined;
  /** The ring rules of both surfaces, `FlatRingRules.default` when left out. */
  readonly rules?: FlatRingRules;
  /** `CoverageSettings.rasterBandMarginShare`, 0 when left out. */
  readonly rasterBandMarginShare?: number;
  readonly diagnostics?: TileDiagnostics | undefined;
}

const noKeys: ReadonlySet<string> = new Set<string>();
const noRasters: ReadonlyMap<string, RasterTileSpec> = new Map<string, RasterTileSpec>();

/** Ints per target in the coverage's flat form: z, x, y, the world copy, lines, labels, the raster's size (-1 for none). */
const targetStride = 7;
/** Doubles per band: the zoom, the last ring, the tile count, the terrain's zoom. */
const bandStride = 4;
/** A frame with no camera matrix: it has no inverse, so the coverage places nothing. */
const noMatrix = new Float64Array(16);

const rasterSpecs = new Map<number, RasterTileSpec>();

function rasterSpec(size: number): RasterTileSpec {
  let spec = rasterSpecs.get(size);
  if (spec === undefined) {
    spec = Object.freeze({ size });
    rasterSpecs.set(size, spec);
  }
  return spec;
}

/** The rules as the coverage takes them, six doubles each: zoom drop, distance, lines, labels, raster size (-1 for none), terrain zoom drop. */
function flatRules(rules: FlatRingRules): Float64Array {
  const flat = new Float64Array(rules.rules.length * 6);
  rules.rules.forEach((rule, index) => {
    flat.set([rule.zoomDrop, rule.distance, rule.drawsLines ? 1 : 0, rule.drawsLabels ? 1 : 0, rule.rasterSize ?? -1, rule.terrainZoomDrop], index * 6);
  });
  return flat;
}

/**
 * The frame's coverage: which tiles the frame draws, at which zooms, from the
 * camera pose. The plane's ring rules cut the frustum's footprint into bands,
 * and the sphere's walk reads the same rules off its grid, both counted from
 * the tile the camera looks at.
 *
 * The coverage itself is the `map-visibility` crate of ImmersiveMapCore,
 * shared with the engine's other ports, behind one call a frame
 * (crates/frame-wasm, `TileCoverage`). This class hands it the frame and
 * reads the result back as the objects the rest of the engine takes.
 */
export class TileCulling {
  /**
   * The floor zoom of the flat placements: the pinned world cover's, so no
   * band and no stand-in goes below the tiles that are always resident.
   */
  static readonly flatBackdropZoomLevel = pinnedWorldCoverMaxZoomLevel;

  /** Holds the coverage version, which moves when the targets differ from the last frame's: the working set gates on it. */
  private readonly coverage: TileCoverage;
  /** The rules the coverage was last given: they cross to it when they change, not every frame. */
  private boundRules: FlatRingRules | undefined;

  constructor() {
    assertFrameWasm();
    this.coverage = new TileCoverage();
  }

  resolveVisibleContent(inputs: TileCullingInputs): VisibleContentState {
    const { resolvedPresentation, targetZoom, diagnostics } = inputs;
    const rules = inputs.rules ?? FlatRingRules.default;
    const semanticCenterWorldMercator = inputs.cameraState.centerWorldMercator;
    const center = TileCulling.makeCenter(semanticCenterWorldMercator, targetZoom);
    const coverage = this.coverage;
    if (this.boundRules === undefined || (this.boundRules !== rules && !FlatRingRules.equals(this.boundRules, rules))) coverage.setRules(flatRules(rules));
    this.boundRules = rules;

    let count: number;
    const spherical = resolvedPresentation.renderSurfaceMode === "spherical";
    if (spherical) {
      const frustum = inputs.cameraFrustum;
      if (frustum === null || frustum === undefined) {
        // No frustum, no walk: the plane's entry with no matrix places nothing and keeps the version honest.
        count = coverage.resolveFlat(noMatrix, false, 0, 0, 0, 0, 0, 0, 0, 1, targetZoom, TileCulling.flatBackdropZoomLevel);
      } else {
        const startTime = performance.now();
        const globe = resolvedPresentation.globeRenderState.globeUniform;
        const eye = inputs.cameraEye;
        count = coverage.resolveGlobe(frustum.planes, eye[0], eye[1], eye[2], globe.panX, globe.panY, globe.radius, globe.transition, center.tileX, center.tileY, targetZoom);
        if (diagnostics !== undefined) {
          const metrics = coverage.metrics();
          diagnostics.setMeasurement("globeCullingDurationMs", performance.now() - startTime);
          diagnostics.setCounter("globeCullingVisitedNodes", metrics[0]!);
          diagnostics.setCounter("globeCullingFrustumRejects", metrics[1]!);
          diagnostics.setCounter("globeCullingHorizonRejects", metrics[2]!);
          diagnostics.setCounter("globeCullingPlacedTiles", metrics[3]!);
          diagnostics.setCounter("globeCullingAcceptedWholeSubtrees", metrics[4]!);
        }
      }
    } else {
      // The flat map draws the rules' bands and nothing under them, and the
      // world cover's zoom stays the floor no band and no stand-in goes down
      // to. Beyond the last rule the world tile is the horizon backdrop,
      // placed by the working set under the plan
      // (`TileWorkingSet.horizonBackdrops`). The texture bands cover a
      // footprint pushed out from the camera's ground point, so a turn finds
      // their tiles in.
      const flat = resolvedPresentation.flatRenderState;
      const heights = inputs.reliefHeights;
      count = coverage.resolveFlat(
        inputs.cameraMatrix ?? noMatrix,
        heights !== undefined,
        heights?.lowerBound ?? 0,
        heights?.upperBound ?? 0,
        inputs.cameraEye[0],
        inputs.cameraEye[1],
        inputs.rasterBandMarginShare ?? 0,
        flat.pan[0],
        flat.pan[1],
        flat.renderMapSize,
        targetZoom,
        TileCulling.flatBackdropZoomLevel,
      );
      if (diagnostics !== undefined && inputs.cameraMatrix !== null && inputs.cameraMatrix !== undefined) diagnostics.setCounter("globeCullingVisitedNodes", coverage.metrics()[0]!);
    }

    if (count === 0) {
      return { centerWorldMercator: semanticCenterWorldMercator, center, visibleTiles: [], tileZoomLevel: targetZoom, coverageVersion: coverage.coverageVersion, flatRingBands: TileCulling.bands(coverage), linelessTiles: noKeys, unlabelledTiles: noKeys, rasterTiles: noRasters };
    }
    const targets = coverage.targets();
    const visibleTiles = new Array<VisibleTile>(count);
    let linelessTiles: Set<string> | undefined;
    let unlabelledTiles: Set<string> | undefined;
    let rasterTiles: Map<string, RasterTileSpec> | undefined;
    for (let index = 0; index < count; index++) {
      const o = index * targetStride;
      const z = targets[o]!;
      const x = targets[o + 1]!;
      const y = targets[o + 2]!;
      const worldWrap = targets[o + 3]!;
      visibleTiles[index] = { tile: { x, y, z }, worldWrap };
      const lines = targets[o + 4] !== 0;
      const labels = targets[o + 5] !== 0;
      const rasterSize = targets[o + 6]!;
      if (lines && labels && rasterSize < 0) continue;
      // The key of `visibleTileKey`.
      const key = `${z}/${x}/${y}@${worldWrap}`;
      if (!lines) (linelessTiles ??= new Set()).add(key);
      if (!labels) (unlabelledTiles ??= new Set()).add(key);
      if (rasterSize >= 0) (rasterTiles ??= new Map()).set(key, rasterSpec(rasterSize));
    }
    return {
      centerWorldMercator: semanticCenterWorldMercator,
      center,
      visibleTiles,
      tileZoomLevel: targetZoom,
      coverageVersion: coverage.coverageVersion,
      flatRingBands: TileCulling.bands(coverage),
      linelessTiles: linelessTiles ?? noKeys,
      unlabelledTiles: unlabelledTiles ?? noKeys,
      rasterTiles: rasterTiles ?? noRasters,
    };
  }

  /** The last coverage's bands, nearest first. */
  private static bands(coverage: TileCoverage): FlatRingBand[] {
    const flat = coverage.bands();
    const bands: FlatRingBand[] = [];
    for (let o = 0; o < flat.length; o += bandStride) bands.push(flatRingBand(flat[o]!, flat[o + 1]!, flat[o + 2]!, flat[o + 3]!));
    return bands;
  }

  static makeCenter(centerWorldMercator: Vec2, targetZoom: number): Center {
    const tilesCount = 2 ** targetZoom;
    return {
      tileX: ImmersiveMapProjection.wrapNormalizedWorldX(centerWorldMercator[0]) * tilesCount,
      tileY: ImmersiveMapProjection.clampNormalizedWorldY(centerWorldMercator[1]) * tilesCount,
    };
  }
}
