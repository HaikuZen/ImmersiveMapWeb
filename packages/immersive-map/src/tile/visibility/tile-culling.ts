// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Frustum } from "../../camera/frustum.ts";
import type { ImmersiveMapCameraState } from "../../camera/immersive-map-camera-state.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { ClosedRange } from "../../math/closed-range.ts";
import type { Mat4 } from "../../math/matrix.ts";
import type { Vec2, Vec3 } from "../../math/vec.ts";
import type { ResolvedPresentationState } from "../../presentation/resolved-presentation-state.ts";
import type { RasterTileSpec, VisibleTile } from "../placement/place-tile.ts";
import { pinnedWorldCoverMaxZoomLevel } from "../store/tile-working-set-store.ts";
import { CoveragePolygonBuilder } from "./coverage-polygon.ts";
import { FlatRingRuleCoverage } from "./flat-ring-rule-coverage.ts";
import { type FlatRingBand, FlatRingRules } from "./flat-ring-rules.ts";
import { GlobeRingMath } from "./globe-ring-math.ts";
import { type GlobeCullingMetrics, GlobeTileCoverage } from "./globe-tile-coverage.ts";
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
   * the relief lifts into view (`CoveragePolygonBuilder`).
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

function sameTargets(lhs: readonly VisibleTile[], rhs: readonly VisibleTile[]): boolean {
  if (lhs === rhs) return true;
  if (lhs.length !== rhs.length) return false;
  for (let index = 0; index < lhs.length; index++) {
    const a = lhs[index]!;
    const b = rhs[index]!;
    if (a.worldWrap !== b.worldWrap || a.tile.x !== b.tile.x || a.tile.y !== b.tile.y || a.tile.z !== b.tile.z) return false;
  }
  return true;
}

function sameRasters(lhs: ReadonlyMap<string, RasterTileSpec>, rhs: ReadonlyMap<string, RasterTileSpec>): boolean {
  if (lhs === rhs) return true;
  if (lhs.size !== rhs.size) return false;
  for (const [key, spec] of lhs) {
    if (rhs.get(key)?.size !== spec.size) return false;
  }
  return true;
}

/**
 * The frame's coverage: which tiles the frame draws, at which zooms, from the
 * camera pose. The plane's ring rules (`FlatRingRuleCoverage`) or the
 * sphere's walk (`GlobeTileCoverage`) over the same rules, both counted from
 * the tile the camera looks at.
 */
export class TileCulling {
  /**
   * The floor zoom of the flat placements: the pinned world cover's, so no
   * band and no stand-in goes below the tiles that are always resident.
   */
  static readonly flatBackdropZoomLevel = pinnedWorldCoverMaxZoomLevel;

  /** Moves when the targets differ from the last frame's, not when the walk merely ran again: the working set gates on it. */
  private coverageVersion = 0;
  private previousVisibleTiles: readonly VisibleTile[] = [];
  private previousRasterTiles: ReadonlyMap<string, RasterTileSpec> = noRasters;

  resolveVisibleContent(inputs: TileCullingInputs): VisibleContentState {
    const { resolvedPresentation, targetZoom, diagnostics } = inputs;
    const rules = inputs.rules ?? FlatRingRules.default;
    const rasterBandMarginShare = inputs.rasterBandMarginShare ?? 0;
    const semanticCenterWorldMercator = inputs.cameraState.centerWorldMercator;
    const center = TileCulling.makeCenter(semanticCenterWorldMercator, targetZoom);
    let visibleTiles: readonly VisibleTile[];
    let flatRingBands: readonly FlatRingBand[] = [];
    let linelessTiles: ReadonlySet<string> = noKeys;
    let unlabelledTiles: ReadonlySet<string> = noKeys;
    let rasterTiles: ReadonlyMap<string, RasterTileSpec> = noRasters;

    if (resolvedPresentation.renderSurfaceMode === "spherical") {
      const resolution = GlobeTileCoverage.targets(
        targetZoom,
        {
          eye: inputs.cameraEye,
          globe: resolvedPresentation.globeRenderState.globeUniform,
          rules,
          lookAtTile: GlobeRingMath.lookAtTile(center, targetZoom),
        },
        inputs.cameraFrustum,
      );
      visibleTiles = resolution.targets;
      flatRingBands = resolution.bands;
      linelessTiles = resolution.linelessTargets;
      unlabelledTiles = resolution.unlabelledTargets;
      rasterTiles = resolution.rasterTargets;
      TileCulling.recordGlobeMetrics(resolution.metrics, diagnostics);
    } else {
      const flatRenderState = resolvedPresentation.flatRenderState;
      const polygon = CoveragePolygonBuilder.make(inputs.cameraMatrix, inputs.reliefHeights);
      if (polygon !== undefined) {
        // The flat map draws the rules' bands and nothing under them, and
        // the world cover's zoom stays the floor no band and no stand-in goes
        // down to. Beyond the last rule the world tile is the horizon
        // backdrop, placed by the working set under the plan
        // (`TileWorkingSet.horizonBackdrops`). The texture bands cover a
        // footprint pushed out from the camera's ground point, so a turn
        // finds their tiles in.
        const rasterPolygon = rasterBandMarginShare > 0 ? polygon.inflated(inputs.cameraEye[0], inputs.cameraEye[1], 1 + rasterBandMarginShare) : undefined;
        const resolution = FlatRingRuleCoverage.resolve(flatRenderState, targetZoom, TileCulling.flatBackdropZoomLevel, rules, polygon, rasterPolygon);
        visibleTiles = resolution.targets;
        flatRingBands = resolution.bands;
        linelessTiles = resolution.linelessTargets;
        unlabelledTiles = resolution.unlabelledTargets;
        rasterTiles = resolution.rasterTargets;
        diagnostics?.setCounter("globeCullingVisitedNodes", resolution.visitedNodeCount);
      } else {
        visibleTiles = [];
      }
    }

    // Which targets are rasters, and at what size, is part of the coverage:
    // a change of it is a new coverage even over the same targets.
    if (!sameTargets(visibleTiles, this.previousVisibleTiles) || !sameRasters(rasterTiles, this.previousRasterTiles)) {
      this.coverageVersion += 1;
      this.previousVisibleTiles = visibleTiles;
      this.previousRasterTiles = rasterTiles;
    }
    return {
      centerWorldMercator: semanticCenterWorldMercator,
      center,
      visibleTiles,
      tileZoomLevel: targetZoom,
      coverageVersion: this.coverageVersion,
      flatRingBands,
      linelessTiles,
      unlabelledTiles,
      rasterTiles,
    };
  }

  static makeCenter(centerWorldMercator: Vec2, targetZoom: number): Center {
    const tilesCount = 2 ** targetZoom;
    return {
      tileX: ImmersiveMapProjection.wrapNormalizedWorldX(centerWorldMercator[0]) * tilesCount,
      tileY: ImmersiveMapProjection.clampNormalizedWorldY(centerWorldMercator[1]) * tilesCount,
    };
  }

  private static recordGlobeMetrics(metrics: GlobeCullingMetrics, diagnostics: TileDiagnostics | undefined): void {
    if (diagnostics === undefined) return;
    diagnostics.setMeasurement("globeCullingDurationMs", metrics.duration * 1000.0);
    diagnostics.setCounter("globeCullingVisitedNodes", metrics.visitedNodeCount);
    diagnostics.setCounter("globeCullingFrustumRejects", metrics.frustumRejectCount);
    diagnostics.setCounter("globeCullingHorizonRejects", metrics.horizonRejectCount);
    diagnostics.setCounter("globeCullingPlacedTiles", metrics.placedTileCount);
    diagnostics.setCounter("globeCullingAcceptedWholeSubtrees", metrics.acceptedWholeSubtreeCount);
  }
}
