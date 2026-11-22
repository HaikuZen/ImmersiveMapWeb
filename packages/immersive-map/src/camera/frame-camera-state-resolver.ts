// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { CameraSettings } from "../configuration/camera-settings.ts";
import type { CameraPresentationSettings } from "../presentation/camera-presentation-settings.ts";
import type { PresentationSettings } from "../configuration/presentation-settings.ts";
import { type Mat4, mat4Identity } from "../math/matrix.ts";
import { ScreenMatrix } from "../math/screen-matrix.ts";
import type { Vec2, Vec3 } from "../math/vec.ts";
import { PresentationStateResolver } from "../presentation/presentation-state-resolver.ts";
import type { CameraConstraints } from "./camera-constraint-resolver.ts";
import { CameraStateController, type TerrainFollowReport } from "./camera-state-controller.ts";
import type { Frustum } from "./frustum.ts";
import type { ImmersiveMapCameraPosition } from "./immersive-map-camera-position.ts";
import type { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";
import type { CameraTerrainFollow } from "./relief/camera-terrain-follow.ts";
import { RenderCamera } from "./render-camera.ts";
import { RenderCameraPoseResolver } from "./render-camera-pose-resolver.ts";

/** The matrices of a frame's camera. Each is the camera's own array, rewritten by the next frame. */
export interface FrameCameraMatrices {
  /** `projection * view`, the CPU form (far plane `RenderCamera.farPlane`). The GPU draws with `writeGpuCameraUniform` of it. */
  readonly projectionView: Mat4;
  readonly view: Mat4;
  /** The drawable's pixel orthographic matrix (`ScreenMatrix`). */
  readonly screen: Mat4;
}

export const FrameCameraMatrices = {
  identity: Object.freeze({ projectionView: mat4Identity(), view: mat4Identity(), screen: mat4Identity() }) as FrameCameraMatrices,
} as const;

/**
 * The camera of one frame, as `FrameCameraStateResolver.makeFrameState`
 * hands it out. The resolver keeps one of these and rewrites it every frame
 * (the matrices and the frustum are the render camera's own arrays), so
 * nothing is allocated per frame: copy what must outlive the frame.
 */
export interface CameraFrameState {
  /** The drawable's size in device pixels. */
  readonly drawWidth: number;
  readonly drawHeight: number;
  /** `(drawWidth, drawHeight)`. */
  readonly viewport: Vec2;
  readonly cameraMatrices: FrameCameraMatrices;
  /** The eye in render world units (the view centre at the origin). */
  readonly cameraEye: Vec3;
  readonly cameraFrustum: Frustum | null;
  readonly mapCameraState: ImmersiveMapCameraState;
  /** The zoom the map is planned by (`CameraStateController.planningZoom`). */
  readonly planningZoom: number;
}

/** Why `makeFrameState` produced no frame. */
export type FrameCameraSkipReason = "zeroDrawableSize" | "missingScreenMatrix" | "missingCameraState";

interface MutableCameraFrameState {
  drawWidth: number;
  drawHeight: number;
  viewport: Vec2;
  cameraMatrices: { projectionView: Mat4; view: Mat4; screen: Mat4 };
  cameraEye: Vec3;
  cameraFrustum: Frustum | null;
  mapCameraState: ImmersiveMapCameraState;
  planningZoom: number;
}

/**
 * Prepares the camera state for a render frame: syncs the controlling
 * camera with the render camera, applies constraints, and assembles
 * matrices, frustum, eye position, and camera state for the frame pipeline.
 *
 * A frame's camera, from a camera state and a viewport:
 *
 * ```ts
 * const resolver = new FrameCameraStateResolver(settings);
 * resolver.setCameraState(state);
 * const frame = resolver.makeFrameState(canvas.width, canvas.height, presentation.transition);
 * if (frame) writeGpuCameraUniform(staging, 0, frame.cameraMatrices.projectionView, frame.cameraEye);
 * ```
 */
export class FrameCameraStateResolver {
  private readonly camera = new RenderCamera();
  private readonly cameraStateController: CameraStateController;
  private readonly cameraPoseResolver = new RenderCameraPoseResolver();
  private readonly screenMatrix = new ScreenMatrix();
  private readonly presentationSettings: PresentationSettings;
  private lastDrawWidth = 0;
  private lastDrawHeight = 0;
  private jumpCount = 0;
  private skipReason: FrameCameraSkipReason | null = null;
  private frameState: MutableCameraFrameState | null = null;

  constructor(settings: CameraPresentationSettings) {
    this.cameraStateController = new CameraStateController(settings.camera);
    this.presentationSettings = settings.presentation;
    // The renderer's start position, as `RendererSetup.configureCamera`
    // sets it in the Swift engine: Moscow's centre at the clamped zoom.
    this.cameraStateController.setLatLonDeg(55.751244, 37.618423);
    this.requestRenderCameraUpdate();
  }

  /**
   * How many times the camera was set outright (a position or a whole state,
   * by a command, a flight's step or a path's): the animated zoom snaps to
   * such a camera instead of following it (`AnimatedZoom`).
   */
  get cameraJumpCount(): number {
    return this.jumpCount;
  }

  /** Why the last `makeFrameState` returned null, null after a frame was made. */
  get lastSkipReason(): FrameCameraSkipReason | null {
    return this.skipReason;
  }

  /**
   * The frame's camera for a drawable of `drawWidth` by `drawHeight` device
   * pixels, null for an empty drawable (`lastSkipReason` says why).
   * `transition` is the frame's globe-to-plane phase as the presentation
   * resolved it (the forced surface included). Omitted, it resolves the
   * automatic phase from the settings, which is what a caller without a
   * presentation controller gets.
   *
   * The returned object is the same every frame and is rewritten in place.
   */
  makeFrameState(drawWidth: number, drawHeight: number, transition?: number): CameraFrameState | null {
    if (!(drawWidth > 0) || !(drawHeight > 0)) {
      this.skipReason = "zeroDrawableSize";
      return null;
    }

    if (drawWidth !== this.lastDrawWidth || drawHeight !== this.lastDrawHeight) {
      this.camera.recalculateProjection(drawWidth / drawHeight);
      this.lastDrawWidth = drawWidth;
      this.lastDrawHeight = drawHeight;
    }

    this.screenMatrix.update(drawWidth, drawHeight);
    const screen = this.screenMatrix.get();
    if (screen === null) {
      this.skipReason = "missingScreenMatrix";
      return null;
    }

    const cameraState = this.cameraStateController.cameraState;
    const resolvedTransition =
      transition ?? PresentationStateResolver.resolve(cameraState, this.presentationSettings).presentationState.transition;
    this.cameraPoseResolver.updateIfNeeded(this.camera, cameraState, resolvedTransition);
    const projectionView = this.camera.cameraMatrix;
    const view = this.camera.view;
    if (projectionView === null || view === null) {
      this.skipReason = "missingCameraState";
      return null;
    }

    this.skipReason = null;
    let frame = this.frameState;
    if (frame === null) {
      frame = {
        drawWidth,
        drawHeight,
        viewport: [drawWidth, drawHeight],
        cameraMatrices: { projectionView, view, screen },
        cameraEye: this.camera.eye,
        cameraFrustum: this.camera.frustum,
        mapCameraState: cameraState,
        planningZoom: this.cameraStateController.planningZoom,
      };
      this.frameState = frame;
      return frame;
    }
    if (frame.drawWidth !== drawWidth || frame.drawHeight !== drawHeight) {
      frame.drawWidth = drawWidth;
      frame.drawHeight = drawHeight;
      frame.viewport = [drawWidth, drawHeight];
    }
    frame.cameraEye = this.camera.eye;
    frame.cameraFrustum = this.camera.frustum;
    frame.mapCameraState = cameraState;
    frame.planningZoom = this.cameraStateController.planningZoom;
    return frame;
  }

  rotateCameraYaw(delta: number): void {
    this.cameraStateController.rotateYaw(delta);
    this.requestRenderCameraUpdate();
  }

  panCamera(deltaX: number, deltaY: number, transition: number): void {
    this.cameraStateController.pan(deltaX, deltaY, transition);
    this.requestRenderCameraUpdate();
  }

  zoomCameraByScale(scale: number, velocity = 0): void {
    this.cameraStateController.zoomByScale(scale, velocity);
    this.requestRenderCameraUpdate();
  }

  zoomCameraByDelta(delta: number): void {
    this.cameraStateController.zoomByDelta(delta);
    this.requestRenderCameraUpdate();
  }

  setCameraPitch(pitch: number): void {
    this.cameraStateController.setPitch(pitch);
    this.requestRenderCameraUpdate();
  }

  setCameraBearing(bearing: number): void {
    this.cameraStateController.setBearing(bearing);
    this.requestRenderCameraUpdate();
  }

  setCameraPosition(cameraPosition: ImmersiveMapCameraPosition): void {
    this.cameraStateController.setCameraPosition(cameraPosition);
    this.jumpCount += 1;
    this.requestRenderCameraUpdate();
  }

  setCameraState(cameraState: ImmersiveMapCameraState): void {
    this.cameraStateController.setCameraState(cameraState);
    this.jumpCount += 1;
    this.requestRenderCameraUpdate();
  }

  /**
   * Moves only the map center, leaving zoom, bearing and pitch untouched. The
   * zoom anchor compensation must use this instead of `setCameraState`:
   * re-submitting the whole state would re-apply the settings-level pitch
   * floor, which is surface-blind and on the globe can sit above the
   * zoom-eased ceiling the constraints have already enforced.
   */
  setCameraCenterWorldMercator(centerWorldMercator: Vec2): void {
    this.cameraStateController.setCenterWorldMercator(centerWorldMercator);
    this.requestRenderCameraUpdate();
  }

  /**
   * See `CameraStateController.setCenterWorldMercatorOverTerrain`: the zoom
   * anchor compensation on the flat map, where the camera may stand over a
   * terrain.
   */
  setCameraCenterWorldMercatorOverTerrain(centerWorldMercator: Vec2): void {
    this.cameraStateController.setCenterWorldMercatorOverTerrain(centerWorldMercator);
    this.requestRenderCameraUpdate();
  }

  /** The terrain under the camera (`CameraTerrainFollow`), null on a map without a relief. */
  setTerrainFollow(follow: CameraTerrainFollow | null): void {
    this.cameraStateController.terrainFollow = follow;
  }

  /** See `CameraStateController.lastTerrainFollowReport`. */
  get lastTerrainFollowReport(): TerrainFollowReport | null {
    return this.cameraStateController.lastTerrainFollowReport;
  }

  /** See `CameraStateController.endPan`. */
  endPanCamera(): void {
    this.cameraStateController.endPan();
  }

  /** See `CameraStateController.planningZoom`. */
  get planningZoom(): number {
    return this.cameraStateController.planningZoom;
  }

  /** See `CameraStateController.advanceBoundsPull`. */
  advanceBoundsPull(deltaTime: number): boolean {
    const centerBefore = this.cameraStateController.cameraState.centerWorldMercator;
    const isReturning = this.cameraStateController.advanceBoundsPull(deltaTime);
    const centerAfter = this.cameraStateController.cameraState.centerWorldMercator;
    if (centerAfter[0] !== centerBefore[0] || centerAfter[1] !== centerBefore[1]) {
      this.requestRenderCameraUpdate();
    }
    return isReturning;
  }

  currentCameraPosition(): ImmersiveMapCameraPosition {
    const latLon = this.cameraStateController.getLatLonDeg();
    return {
      latitudeDegrees: latLon.latDeg,
      longitudeDegrees: latLon.lonDeg,
      zoom: this.cameraStateController.zoom,
      bearing: this.cameraStateController.yaw,
      pitch: this.cameraStateController.pitch,
    };
  }

  currentCameraState(): ImmersiveMapCameraState {
    return this.cameraStateController.currentCameraState();
  }

  applyCameraSettings(settings: CameraSettings): void {
    this.cameraStateController.apply(settings);
    this.requestRenderCameraUpdate();
  }

  applyConstraints(constraints: CameraConstraints): void {
    this.cameraStateController.clampBearing(constraints.bearing);
    this.cameraStateController.clampPitch(constraints.pitch);
    this.requestRenderCameraUpdate();
  }

  private requestRenderCameraUpdate(): void {
    this.cameraPoseResolver.requestUpdate();
  }
}
