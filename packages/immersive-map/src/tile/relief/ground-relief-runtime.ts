// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ViewMode } from "../../camera/view-mode.ts";
import type { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { resolvedMaximumZoomLevel } from "../../configuration/tile-settings.ts";
import type { ClosedRange } from "../../math/closed-range.ts";
import type { Mat4 } from "../../math/matrix.ts";
import type { Vec2, Vec3 } from "../../math/vec.ts";
import type { FlatRingBand } from "../visibility/flat-ring-rules.ts";
import { GroundReliefFrame } from "./frame/ground-relief-frame.ts";
import { GroundReliefFrameState } from "./frame/ground-relief-frame-state.ts";
import type { GroundReliefHillshadeAmounts, GroundReliefHillshadeFade } from "./frame/ground-relief-hillshade.ts";
import type { ImmersiveMapTerrainOcclusion } from "../../style/theme.ts";
import { GroundReliefCameraLift } from "./lifts/ground-relief-camera-lift.ts";
import { GroundReliefSurroundings } from "./lifts/ground-relief-surroundings.ts";
import type { ImmersiveMapTerrainSurroundings } from "./lifts/terrain-surroundings.ts";
import { GroundReliefOcclusionKey } from "./store/ground-relief-occlusion.ts";
import { GroundReliefStore, type GroundReliefTextures } from "./store/ground-relief-store.ts";
import type { GroundReliefTerrainSource } from "./store/ground-relief-terrain-source.ts";

/** What the relief reads of a frame before its coverage. */
export interface GroundReliefFrameStart {
  readonly planningZoom: number;
  readonly centerWorldMercator: Vec2;
  /** Seconds since the last frame, `undefined` on the first. */
  readonly deltaTime: number | undefined;
  /** The camera was set outright since the last frame: the rise snaps. */
  readonly cameraJumped: boolean;
  readonly renderMapSize: number;
  readonly cameraEye: Vec3;
  readonly lightDirection: Vec3;
  readonly renderSurfaceMode: ViewMode;
  /** The debug panel's drags over the style and the settings (`DebugOverlayControlState`), none without the panel. */
  readonly debug?: GroundReliefDebugOverrides | undefined;
}

/** What the debug panel drags of the relief over the style and the settings, each left out for theirs. */
export interface GroundReliefDebugOverrides {
  readonly hillshadeFade?: GroundReliefHillshadeFade | undefined;
  readonly hillshadeAmounts?: GroundReliefHillshadeAmounts | undefined;
  readonly occlusion?: ImmersiveMapTerrainOcclusion | undefined;
  /** Draws the occlusion of the sky alone, in grey. */
  readonly occlusionDebugView?: boolean | undefined;
  readonly castsShadows?: boolean | undefined;
}

/** What the relief reads of a frame once its coverage is resolved. */
export interface GroundReliefFrameCoverage {
  readonly renderSurfaceMode: ViewMode;
  readonly tileZoomLevel: number;
  readonly flatRingBands: readonly FlatRingBand[];
  readonly centerWorldMercator: Vec2;
  readonly planningZoom: number;
  readonly deltaTime: number | undefined;
}

/**
 * The ground relief of a map, in the frame's order: the part of the Swift
 * `RenderFrameEngine.collectInput` that sets the relief's state
 * (`GroundReliefFrameState`) once a frame, and the surroundings it reads
 * (`GroundReliefSurroundings`). The map calls `startFrame` before the
 * coverage, which takes `coverageHeights`, then `settleFrame` after it, and
 * every feature of the frame reads `frame`.
 */
export class GroundReliefRuntime {
  readonly store: GroundReliefStore;
  readonly state: GroundReliefFrameState;
  private readonly surroundings = new GroundReliefSurroundings();
  private surroundingsValue: ImmersiveMapTerrainSurroundings | null = null;
  private castsShadows: boolean;
  private surroundingsSettings: ImmersiveMapSettings["tiles"]["groundRelief"]["surroundings"];

  constructor(settings: ImmersiveMapSettings, source: GroundReliefTerrainSource, textures: GroundReliefTextures) {
    const relief = settings.tiles.groundRelief;
    const theme = settings.data.mapStyle.theme;
    this.store = new GroundReliefStore(relief, source, textures, GroundReliefOcclusionKey.ofStyle(theme.terrainOcclusion));
    this.state = new GroundReliefFrameState(this.store, relief, resolvedMaximumZoomLevel(settings.tiles.coverage), theme.hillshade, theme.terrainOcclusion);
    this.castsShadows = relief.castsShadows;
    this.surroundingsSettings = relief.surroundings;
  }

  /**
   * The settings a running map changes in place: the mountains' shadows,
   * the surroundings' reading and the style's shading and occlusion. The
   * rest of the relief is built with it.
   */
  applySettings(settings: ImmersiveMapSettings): void {
    const relief = settings.tiles.groundRelief;
    this.castsShadows = relief.castsShadows;
    this.surroundingsSettings = relief.surroundings;
    const theme = settings.data.mapStyle.theme;
    this.state.setStyle(theme.hillshade, theme.terrainOcclusion);
  }

  /** The relief the frame draws by, settled by `settleFrame`. */
  get frame(): GroundReliefFrame {
    return this.state.frame;
  }

  /** The country around the camera as the last frame read it, `null` off the terrain. */
  get terrainSurroundings(): ImmersiveMapTerrainSurroundings | null {
    return this.surroundingsValue;
  }

  /**
   * The frame's start, before its coverage: the welds written, the rise and
   * the collapse at the planning zoom (which a drag over the terrain never
   * moves), the world scale, the light, the occlusion and the shadows.
   */
  startFrame(input: GroundReliefFrameStart): void {
    const state = this.state;
    state.beginFrame();
    state.setFrame(input.planningZoom, input.centerWorldMercator, input.deltaTime, input.cameraJumped);
    // One rise a metre for every tile this frame, the latitude of the point the camera looks at.
    state.setWorldScale(input.centerWorldMercator, input.renderMapSize);
    const debug = input.debug;
    state.setLight(input.lightDirection, input.cameraEye, debug?.hillshadeFade, debug?.hillshadeAmounts);
    state.setOcclusion(debug?.occlusion, debug?.occlusionDebugView ?? false);
    // The mountains' shadows, as the settings and the debug panel say.
    state.setCastsShadows(this.castsShadows && debug?.castsShadows !== false);
  }

  /**
   * How far the relief falls and rises about the plane this frame, in world
   * units from the last frame's datum, at the strength of a mountain: the
   * coverage reaches the tiles the relief lifts into view. `undefined` off
   * the terrain and off the flat map.
   */
  coverageHeights(renderSurfaceMode: ViewMode): ClosedRange | undefined {
    const relief = this.state.frame;
    if (!relief.isActive || renderSurfaceMode !== "flat") return undefined;
    const range = relief.heightRangeMetres;
    if (range === undefined) return undefined;
    const unitsPerMetre = relief.worldUnitsPerMetre * relief.strength;
    return { lowerBound: (range.lowerBound - relief.datumMetres) * unitsPerMetre, upperBound: (range.upperBound - relief.datumMetres) * unitsPerMetre };
  }

  /**
   * The frame once its coverage is resolved: the rings' terrain, whether the
   * frame is on the terrain and the datum, read off the terrain as the
   * frame now draws it, then the surroundings. Returns the settled frame.
   */
  settleFrame(input: GroundReliefFrameCoverage): GroundReliefFrame {
    const state = this.state;
    const flat = input.renderSurfaceMode === "flat";
    state.setBands(flat ? input.flatRingBands : []);
    if (flat) {
      state.setActive(input.tileZoomLevel >= state.fromTileZoom && state.isVisible(input.planningZoom));
      const datum = GroundReliefCameraLift.datumMetres(state.frame, input.centerWorldMercator, input.tileZoomLevel);
      if (datum !== undefined) state.setDatum(datum);
    } else {
      state.setActive(false);
      state.setDatum(0);
    }
    const frame = state.frame;
    this.surroundingsValue = this.surroundings.update(frame, input.centerWorldMercator, this.surroundingsSettings, input.deltaTime ?? 0);
    return frame;
  }

  /** The view depth the point-locked road widths are stated at on the relief, `undefined` off it. */
  centreGroundDepth(cameraMatrix: Mat4, centerWorldMercator: Vec2, tileZoom: number, renderMapSize: number): number | undefined {
    const frame = this.state.frame;
    if (!frame.isActive) return undefined;
    return GroundReliefCameraLift.centreGroundDepth(frame, cameraMatrix, centerWorldMercator, tileZoom, renderMapSize);
  }

  destroy(): void {
    this.store.destroy();
  }
}
