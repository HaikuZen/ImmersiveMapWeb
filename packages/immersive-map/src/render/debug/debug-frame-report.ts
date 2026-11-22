// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { TerrainFollowReport } from "../../camera/camera-state-controller.ts";
import type { ImmersiveMapCameraState } from "../../camera/immersive-map-camera-state.ts";
import type { ViewMode } from "../../camera/view-mode.ts";
import type { GeoScreenProjectionFrameConstants } from "../../geo/geo-screen-projection-math.ts";
import type { Mat4 } from "../../math/matrix.ts";
import type { Vec2, Vec3 } from "../../math/vec.ts";
import type { FlatRenderState } from "../../presentation/resolved-presentation-state.ts";
import type { PlaceTile, ResidentTile, VisibleTile } from "../../tile/placement/place-tile.ts";
import type { GroundReliefFrame } from "../../tile/relief/frame/ground-relief-frame.ts";
import type { ImmersiveMapTerrainSurroundings } from "../../tile/relief/lifts/terrain-surroundings.ts";
import type { FlatRingBand } from "../../tile/visibility/flat-ring-rules.ts";

/**
 * The frame's times, as `ImmersiveMap.drawFrame` measures them.
 */
export interface DebugFrameTimings {
  /** Seconds since the previous frame (`drawFrame`'s `deltaTime`), `undefined` for the first frame. */
  readonly frameDeltaSeconds: number | undefined;
  /** The frame's main-thread time (`FrameEvent.cpuMilliseconds`). */
  readonly cpuMilliseconds: number;
  /** The world pass's GPU time of the last frame measured (`FrameEngine.gpuMilliseconds`), `undefined` without `timestamp-query`. */
  readonly gpuMilliseconds: number | undefined;
  /** The draw records the frame encoded (`drawParameters.recordCount`). */
  readonly drawCount: number;
}

/** The frame's tile counters, the working set's (`TilePlacementState`). */
export interface DebugFrameTileCounts {
  /** `visibleTilesCount`: the coverage's targets. */
  readonly visible: number;
  /** `readyTilesCount`: the targets resident. */
  readonly ready: number;
  /** `requestedTilesCount`: the demanded tiles not resident yet. */
  readonly requested: number;
  /** `renderedTilesCount`: the placements drawn. */
  readonly rendered: number;
}

/** What the frame still waits for besides map tiles. */
export interface DebugFramePendingCounts {
  /** The terrain tiles the relief asked for and has not got yet (`pendingTerrainTileCount`), 0 without a relief. */
  readonly terrainTiles: number;
  /** The app layers whose meshes are not ready yet (`layerRuntime.subsystem.pendingCount`). */
  readonly layerMeshes: number;
  /** The 3D models still on their way (`models.pendingCount`). */
  readonly sceneModelMeshes: number;
}

/**
 * One label's collision box on screen (the Swift `BaseLabelDebugBox`), in
 * drawable pixels with the origin at the bottom left and y up, the space
 * `GeoScreenProjectionMath` projects into.
 */
export interface DebugLabelBox {
  readonly center: Vec2;
  readonly halfSize: Vec2;
  /** Shown this frame, as opposed to hidden by collision, the label horizon or a fade. */
  readonly isVisible: boolean;
}

/** The frame's label boxes (the Swift `BaseLabelDebugBoxesState`): the base labels' and the road labels' glyph boxes. */
export interface DebugLabelBoxes {
  readonly boxes: readonly DebugLabelBox[];
  readonly roadBoxes: readonly DebugLabelBox[];
}

/** The frame's label counters, for the diagnostics' Labels section. */
export interface DebugLabelCounts {
  /** Base labels placed this frame. */
  readonly base: number;
  /** Road label glyphs drawn. */
  readonly roadGlyphs: number;
  /** Road label instances drawn. */
  readonly roadInstances: number;
}

/**
 * What the map hands the debug entry (`@immersive-map/web/debug`) after
 * each drawn frame: everything the debug overlay draws over the map and the
 * HUD snapshot's text reads. Filled at the end of `ImmersiveMap.drawFrame`
 * and read synchronously, before the next frame: several fields are the
 * frame's own arrays (the camera's matrices, the placements), which the next
 * frame rewrites.
 */
export interface DebugFrameReport {
  /** `ImmersiveMap.frameNumber` after the frame. */
  readonly frameIndex: number;
  /** The drawable's size in device pixels (`canvas.width`, `canvas.height`): the overlay canvas has the same pixel size. */
  readonly drawWidth: number;
  readonly drawHeight: number;
  /** Device pixels per CSS pixel the frame was drawn at (`pixelsPerPoint`). */
  readonly pixelsPerPoint: number;

  /** `cameraFrame.mapCameraState`: the camera's centre, zoom, bearing and pitch. */
  readonly mapCameraState: ImmersiveMapCameraState;
  /** `cameraFrame.planningZoom`. */
  readonly planningZoom: number;
  /** The animated zoom the frame drew at (`animatedZoom` of `drawFrame`). */
  readonly animatedZoom: number;
  /** `cameraFrame.cameraEye`, render world units. */
  readonly cameraEye: Vec3;
  /** `cameraFrame.cameraMatrices.projectionView`, the CPU form. */
  readonly projectionView: Mat4;

  /** `presentation.renderSurfaceMode`. */
  readonly renderSurfaceMode: ViewMode;
  /** `presentation.presentationState.transition`, 0 the globe and 1 the plane. */
  readonly transition: number;
  /** `presentation.flatRenderState`. */
  readonly flatRenderState: FlatRenderState;
  /**
   * The frame's projection: `new GeoScreenProjectionFrameConstants(width,
   * height, { matrix: projectionView, eye: cameraEye }, presentation)`.
   * Every tile point of the overlay is projected through it.
   */
  readonly projection: GeoScreenProjectionFrameConstants;

  /** `visibleContent.tileZoomLevel`. */
  readonly tileZoomLevel: number;
  /** `visibleContent.flatRingBands`, nearest first. */
  readonly flatRingBands: readonly FlatRingBand[];
  /** `placement.placeTilesContext.tilePlacements`: the planner's placements, then the horizon backdrops. */
  readonly placements: readonly PlaceTile<ResidentTile>[];

  /** The frame's settled relief (`reliefFrame` of `drawFrame`), `undefined` without a relief runtime. */
  readonly reliefFrame: GroundReliefFrame | undefined;
  /** `relief.terrainSurroundings`, `undefined` off the terrain or without a relief. */
  readonly terrainSurroundings: ImmersiveMapTerrainSurroundings | undefined;
  /** The camera's last settle over the terrain (`FrameCameraStateResolver.lastTerrainFollowReport`), `undefined` for none. */
  readonly terrainFollowReport: TerrainFollowReport | undefined;

  readonly timings: DebugFrameTimings;
  readonly tiles: DebugFrameTileCounts;
  readonly pending: DebugFramePendingCounts;

  /**
   * The tile slots the road labels were laid out in this frame (the Swift
   * `RoadLabelState.activeRoadLabelTiles`), for the road label tiles
   * overlay. Optional: filled from the label prepare.
   */
  readonly activeRoadLabelTiles?: readonly VisibleTile[] | undefined;
  /** The frame's label collision boxes, for the label bounds overlay. Optional: filled from the label prepare. */
  readonly labelBoxes?: DebugLabelBoxes | undefined;
  /** The frame's label counters, for the diagnostics. Optional: filled from the label prepare. */
  readonly labelCounts?: DebugLabelCounts | undefined;
}
