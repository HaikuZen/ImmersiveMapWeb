// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { CameraFrameState } from "../../camera/frame-camera-state-resolver.ts";
import { type CoverageSettings, resolvedMaximumZoomLevel } from "../../configuration/tile-settings.ts";
import type { ClosedRange } from "../../math/closed-range.ts";
import type { ResolvedPresentationState } from "../../presentation/resolved-presentation-state.ts";
import { FlatRingRules } from "./flat-ring-rules.ts";
import { RingRuleSets } from "./ring-rule-sets.ts";
import { TileCoverageZoomPolicy } from "./tile-coverage-zoom-policy.ts";
import { TileCulling } from "./tile-culling.ts";
import type { TileDiagnostics } from "./tile-diagnostics.ts";
import type { VisibleContentState } from "./visible-content-state.ts";

/** What a frame's coverage is resolved from: the camera, the presentation, the tile settings, the rules and the relief. */
export interface FrameVisibilityInputs {
  readonly cameraFrameState: CameraFrameState;
  readonly resolvedPresentation: ResolvedPresentationState;
  /** `settings.tiles.coverage`. */
  readonly coverage: CoverageSettings;
  /** The debug panel's sets, `RingRuleSets.default` when left out. */
  readonly ruleSets?: RingRuleSets;
  /** How far the relief falls and rises about the plane, in world units, `undefined` off the relief. */
  readonly reliefHeights?: ClosedRange | undefined;
  readonly diagnostics?: TileDiagnostics | undefined;
}

/** Everything the coverage is a function of, as the last frame resolved it. */
interface Fingerprint {
  rasterBandMarginShare: number;
  reliefLow: number | undefined;
  reliefHigh: number | undefined;
  centerX: number;
  centerY: number;
  zoom: number;
  bearing: number;
  pitch: number;
  drawWidth: number;
  drawHeight: number;
  targetZoom: number;
  rules: FlatRingRules;
  flat: boolean;
  panX: number;
  panY: number;
  radius: number;
  transition: number;
}

/**
 * Computes the frame's coverage from the camera snapshot, the presentation
 * state and the tile settings: the target zoom, then the coverage
 * (`TileCulling`). The plane's ring rules are those of the set the frame's
 * zoom falls in. With `reliefHeights` the coverage reaches the tiles the
 * relief lifts into view (the footprint over the relief's slab).
 *
 * The Swift engine's `RenderFrameVisibilityResolver`. The coverage is a pure
 * function of the camera pose, the drawable's size, the presentation and the
 * rules: with all of them as the last frame had them, the last result is
 * handed back, with its `coverageVersion`, which the working set's gate
 * relies on.
 */
export class FrameVisibilityResolver {
  private readonly tileCulling: TileCulling;
  private fingerprint: Fingerprint | undefined;
  private cachedContent: VisibleContentState | undefined;

  constructor(tileCulling: TileCulling = new TileCulling()) {
    this.tileCulling = tileCulling;
  }

  resolve(inputs: FrameVisibilityInputs): VisibleContentState {
    const { cameraFrameState, resolvedPresentation, coverage } = inputs;
    // The planning zoom, not the camera's: over the terrain the camera's
    // zoom follows the ground under the point it looks at, and a coverage
    // planned by it would reshuffle its rings with every slope a drag
    // crosses (`CameraStateController.planningZoom`).
    const zoomPlan = TileCoverageZoomPolicy.resolve(cameraFrameState.planningZoom, resolvedPresentation.renderSurfaceMode, resolvedMaximumZoomLevel(coverage));
    // The frame is drawn by the rules of the set its planning zoom falls in.
    // Not the target zoom: that stops at the tileset's deepest zoom, and a
    // set starting past it would never be reached.
    const rules = RingRuleSets.rulesForZoom(inputs.ruleSets ?? RingRuleSets.default, FrameVisibilityResolver.ruleSetZoom(cameraFrameState.planningZoom));
    if (this.cachedContent !== undefined && this.matchesFingerprint(inputs, zoomPlan.baseZoom, rules)) return this.cachedContent;

    const content = this.tileCulling.resolveVisibleContent({
      cameraState: cameraFrameState.mapCameraState,
      resolvedPresentation,
      targetZoom: zoomPlan.baseZoom,
      cameraMatrix: cameraFrameState.cameraMatrices.projectionView,
      cameraFrustum: cameraFrameState.cameraFrustum,
      cameraEye: cameraFrameState.cameraEye,
      reliefHeights: inputs.reliefHeights,
      rules,
      rasterBandMarginShare: coverage.rasterBandMarginShare,
      diagnostics: inputs.diagnostics,
    });
    this.storeFingerprint(inputs, zoomPlan.baseZoom, rules);
    this.cachedContent = content;
    return content;
  }

  /** The zoom a frame's rule set is chosen by: the camera zoom's whole part, the zoom the panel's sets are named by (`RingRuleSets`). */
  static ruleSetZoom(cameraZoom: number): number {
    if (!Number.isFinite(cameraZoom)) return 0;
    return Math.min(Math.max(0, Math.floor(cameraZoom)), RingRuleSets.zoomRange.upperBound);
  }

  private matchesFingerprint(inputs: FrameVisibilityInputs, targetZoom: number, rules: FlatRingRules): boolean {
    const print = this.fingerprint;
    if (print === undefined) return false;
    const camera = inputs.cameraFrameState.mapCameraState;
    const globe = inputs.resolvedPresentation.globeRenderState.globeUniform;
    return (
      print.rasterBandMarginShare === inputs.coverage.rasterBandMarginShare &&
      print.reliefLow === inputs.reliefHeights?.lowerBound &&
      print.reliefHigh === inputs.reliefHeights?.upperBound &&
      print.centerX === camera.centerWorldMercator[0] &&
      print.centerY === camera.centerWorldMercator[1] &&
      print.zoom === camera.zoom &&
      print.bearing === camera.bearing &&
      print.pitch === camera.pitch &&
      print.drawWidth === inputs.cameraFrameState.drawWidth &&
      print.drawHeight === inputs.cameraFrameState.drawHeight &&
      print.targetZoom === targetZoom &&
      FlatRingRules.equals(print.rules, rules) &&
      print.flat === (inputs.resolvedPresentation.renderSurfaceMode === "flat") &&
      print.panX === globe.panX &&
      print.panY === globe.panY &&
      print.radius === globe.radius &&
      print.transition === globe.transition
    );
  }

  private storeFingerprint(inputs: FrameVisibilityInputs, targetZoom: number, rules: FlatRingRules): void {
    const camera = inputs.cameraFrameState.mapCameraState;
    const globe = inputs.resolvedPresentation.globeRenderState.globeUniform;
    // Stored only when the coverage was resolved anew, which is rare next to the frames that reuse it.
    this.fingerprint = {
      rasterBandMarginShare: inputs.coverage.rasterBandMarginShare,
      reliefLow: inputs.reliefHeights?.lowerBound,
      reliefHigh: inputs.reliefHeights?.upperBound,
      centerX: camera.centerWorldMercator[0],
      centerY: camera.centerWorldMercator[1],
      zoom: camera.zoom,
      bearing: camera.bearing,
      pitch: camera.pitch,
      drawWidth: inputs.cameraFrameState.drawWidth,
      drawHeight: inputs.cameraFrameState.drawHeight,
      targetZoom,
      rules,
      flat: inputs.resolvedPresentation.renderSurfaceMode === "flat",
      panX: globe.panX,
      panY: globe.panY,
      radius: globe.radius,
      transition: globe.transition,
    };
  }
}
