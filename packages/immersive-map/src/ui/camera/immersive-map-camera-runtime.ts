// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { CameraConstraints } from "../../camera/camera-constraint-resolver.ts";
import { FrameCameraStateResolver } from "../../camera/frame-camera-state-resolver.ts";
import type { GlobeUprightWindow } from "../../camera/globe-upright-pull.ts";
import type { ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import { ImmersiveMapCameraState } from "../../camera/immersive-map-camera-state.ts";
import { ZoomAnchorMath } from "../../camera/zoom-anchor-math.ts";
import { clampZoom } from "../../configuration/camera-settings.ts";
import type { Vec2 } from "../../math/vec.ts";
import type { CameraPresentationSettings } from "../../presentation/camera-presentation-settings.ts";
import { MapPresentationStateController } from "../../presentation/map-presentation-state-controller.ts";
import type { CameraRenderRequests } from "../render-loop-pacing.ts";
import type { ImmersiveMapCameraCommand, ImmersiveMapCameraController } from "./immersive-map-camera-controller.ts";
import { type ImmersiveMapCameraSnapshot, ImmersiveMapCameraSnapshotResolver } from "./immersive-map-camera-snapshot.ts";

/**
 * The on-screen controls the camera keeps in step (Swift
 * `ImmersiveMapControlsRuntime`): the pitch zone's value and the
 * attribution's zoom-dependent credits. Both optional, a map without them
 * passes nothing.
 */
export interface CameraControlsSink {
  syncPitch?(cameraPosition: ImmersiveMapCameraPosition | null, minimumPitch: number, maximumPitch: number): void;
  syncAttribution?(zoom: number | null): void;
}

export interface ImmersiveMapCameraRuntimeOptions {
  readonly settings: CameraPresentationSettings;
  /** Where the camera opens, null for the renderer's own start. */
  readonly initialCameraPosition?: ImmersiveMapCameraPosition | null;
  readonly render: CameraRenderRequests;
  readonly controls?: CameraControlsSink;
  /** The map's size in CSS pixels (width, height), what the zoom anchor reads. */
  readonly viewportSize: () => Vec2;
}

/**
 * Owns the mutable camera state of one map. Wraps `FrameCameraStateResolver`,
 * applies camera changes under the constraints of the surface, stores the
 * settings, notifies the attached controller and requests frames.
 */
export class ImmersiveMapCameraRuntime {
  private readonly initialCameraPosition: ImmersiveMapCameraPosition | null;
  readonly presentationStateResolver: MapPresentationStateController;
  private readonly render: CameraRenderRequests;
  private readonly controls: CameraControlsSink;
  private readonly viewportSize: () => Vec2;
  private controller: ImmersiveMapCameraController | null = null;
  private renderCameraValue: FrameCameraStateResolver | null = null;
  private settings: CameraPresentationSettings;
  private appliedCameraPosition: ImmersiveMapCameraPosition | null = null;
  private cameraNotificationGeneration = 0;

  constructor(options: ImmersiveMapCameraRuntimeOptions) {
    this.settings = options.settings;
    this.initialCameraPosition = options.initialCameraPosition ?? null;
    this.presentationStateResolver = new MapPresentationStateController(options.settings);
    this.render = options.render;
    this.controls = options.controls ?? {};
    this.viewportSize = options.viewportSize;
  }

  get currentSettings(): CameraPresentationSettings {
    return this.settings;
  }

  /** The frame camera, null until `makeRenderCamera`. */
  get renderCamera(): FrameCameraStateResolver | null {
    return this.renderCameraValue;
  }

  isAttachedController(cameraController: ImmersiveMapCameraController | null): boolean {
    return this.controller === cameraController;
  }

  /**
   * Forgets the last declared camera position when the map parks for reuse:
   * a new screen declaring the same position as the previous one expects the
   * camera to actually move there.
   */
  clearAppliedCameraPositionForReuse(): void {
    this.appliedCameraPosition = null;
  }

  updateSettings(settings: CameraPresentationSettings, notifiesCameraPositionChanged = true): void {
    this.settings = settings;
    this.presentationStateResolver.applySettings(settings);
    this.renderCameraValue?.applyCameraSettings(settings.camera);
    this.applyCurrentCameraConstraints();
    if (notifiesCameraPositionChanged) {
      this.notifyCameraPositionChanged();
    }
  }

  attachController(newController: ImmersiveMapCameraController | null, handle: (command: ImmersiveMapCameraCommand) => void): void {
    if (this.controller === newController) {
      return;
    }
    this.controller?.detachRuntime(this);
    this.controller = newController;
    newController?.attachRuntime(this, handle);
    newController?.updateCurrentCameraPosition(this.currentCameraPosition());
    this.notifyCameraPositionChanged();
  }

  detachController(): void {
    this.controller?.detachRuntime(this);
    this.controller = null;
  }

  /** Builds the frame camera, at `cameraPosition` when given. */
  makeRenderCamera(settings: CameraPresentationSettings, cameraPosition: ImmersiveMapCameraPosition | null): FrameCameraStateResolver {
    this.settings = settings;
    const renderCamera = new FrameCameraStateResolver(settings);
    this.renderCameraValue = renderCamera;
    if (cameraPosition !== null) {
      renderCamera.setCameraPosition(cameraPosition);
      this.appliedCameraPosition = cameraPosition;
    }
    this.applyCurrentCameraConstraints();
    this.syncPitchControlValue(cameraPosition);
    this.notifyCameraPositionChanged();
    return renderCamera;
  }

  clearRenderCamera(): void {
    this.renderCameraValue = null;
  }

  cameraPositionForRendererRecreation(): ImmersiveMapCameraPosition | null {
    return this.currentCameraPosition();
  }

  currentCameraPosition(): ImmersiveMapCameraPosition | null {
    return this.renderCameraValue?.currentCameraPosition() ?? this.appliedCameraPosition ?? this.initialCameraPosition;
  }

  currentCameraState(): ImmersiveMapCameraState | null {
    return this.renderCameraValue?.currentCameraState() ?? null;
  }

  get currentPitch(): number | null {
    return this.renderCameraValue?.currentCameraState().pitch ?? null;
  }

  get currentBearing(): number | null {
    return this.renderCameraValue?.currentCameraState().bearing ?? null;
  }

  currentMaximumAbsoluteBearing(): number {
    const cameraState = this.currentCameraState();
    if (cameraState === null) {
      return Math.min(Math.max(this.settings.camera.maximumAbsoluteBearing ?? Math.PI, 0), Math.PI);
    }
    return this.currentCameraConstraints(cameraState).bearing.maximumAbsoluteBearing ?? Math.PI;
  }

  currentCameraSnapshot(overridePosition: ImmersiveMapCameraPosition | null = null): ImmersiveMapCameraSnapshot | null {
    const renderCamera = this.renderCameraValue;
    if (renderCamera === null) {
      return null;
    }
    const cameraState = renderCamera.currentCameraState();
    const position = overridePosition ?? renderCamera.currentCameraPosition();
    return ImmersiveMapCameraSnapshotResolver.resolve(
      position,
      this.currentCameraConstraints(cameraState),
      this.presentationStateResolver.isSphericalSurfaceActive(cameraState),
      renderCamera.planningZoom,
    );
  }

  currentMaximumPitch(): number {
    const cameraState = this.currentCameraState();
    if (cameraState === null) {
      return this.settings.camera.maximumPitch;
    }
    return this.currentCameraConstraints(cameraState).pitch.maximumPitch;
  }

  currentMinimumPitch(): number {
    const cameraState = this.currentCameraState();
    if (cameraState === null) {
      return Math.min(Math.max(this.settings.camera.minimumPitch, 0), Math.max(this.settings.camera.maximumPitch, 0));
    }
    return this.currentCameraConstraints(cameraState).pitch.clampedMinimumPitch;
  }

  /** The window the globe's upright pull holds the camera to right now, null where it holds nothing. */
  currentGlobeUprightWindow(): GlobeUprightWindow | null {
    const cameraState = this.currentCameraState();
    return cameraState === null ? null : this.presentationStateResolver.globeUprightWindow(cameraState);
  }

  isSphericalRenderSurfaceActive(): boolean {
    const cameraState = this.currentCameraState();
    return cameraState === null ? false : this.presentationStateResolver.isSphericalSurfaceActive(cameraState);
  }

  /** The current globe-to-plane transition, 1 before the frame camera exists. */
  currentTransition(): number {
    const cameraState = this.currentCameraState();
    return cameraState === null ? 1 : this.presentationStateResolver.resolve(cameraState).presentationState.transition;
  }

  needsCameraPositionUpdate(cameraPosition: ImmersiveMapCameraPosition | null): boolean {
    return !positionsEqual(this.appliedCameraPosition, cameraPosition);
  }

  /** A camera position arrived from outside through the controller's `jump`: keeps the render loop awake across a series of such sets. */
  noteExternalCameraDrive(): void {
    this.render.noteExternalCameraDrive();
  }

  /** The declared position (the map's `camera` option): applied only when it differs from the last declared one. */
  applyCameraPosition(cameraPosition: ImmersiveMapCameraPosition | null): void {
    if (positionsEqual(this.appliedCameraPosition, cameraPosition)) {
      return;
    }
    this.appliedCameraPosition = cameraPosition;
    if (cameraPosition === null) {
      return;
    }
    this.renderCameraValue?.setCameraPosition(cameraPosition);
    this.applyCurrentCameraConstraints();
    this.syncPitchControlValue(cameraPosition);
    this.notifyCameraPositionChanged();
    this.render.requestFrame();
  }

  setCameraPosition(cameraPosition: ImmersiveMapCameraPosition, requestRenderFrame = true): void {
    this.appliedCameraPosition = cameraPosition;
    this.renderCameraValue?.setCameraPosition(cameraPosition);
    this.applyCurrentCameraConstraints();
    this.syncPitchControlValue(cameraPosition);
    this.notifyCameraPositionChanged();
    if (requestRenderFrame) {
      this.render.requestFrame();
    }
  }

  setCameraState(cameraState: ImmersiveMapCameraState): void {
    this.renderCameraValue?.setCameraState(cameraState);
    this.applyCurrentCameraConstraints();
    this.syncPitchControlValue();
    this.notifyCameraPositionChanged();
    this.render.requestFrame();
  }

  /** The debug panel's surface switch. */
  switchRenderMode(): void {
    const cameraState = this.currentCameraState();
    if (cameraState === null) {
      return;
    }
    this.presentationStateResolver.switchRenderSurfaceMode(cameraState);
    this.applyCurrentCameraConstraints();
    this.syncPitchControlValue();
    this.notifyCameraPositionChanged();
    this.render.requestFrame();
  }

  rotateCameraYaw(delta: number): void {
    this.renderCameraValue?.rotateCameraYaw(delta);
    this.applyCurrentCameraConstraints();
    this.notifyCameraPositionChanged();
    this.render.requestFrame();
  }

  /** A pan by a gesture delta, already scaled by `gesturePanTranslationScale`. */
  panCamera(deltaX: number, deltaY: number): void {
    const renderCamera = this.renderCameraValue;
    if (renderCamera === null) {
      return;
    }
    const transition = this.presentationStateResolver.resolve(renderCamera.currentCameraState()).presentationState.transition;
    renderCamera.panCamera(deltaX, deltaY, transition);
    this.notifyCameraPositionChanged();
    this.render.requestFrame();
  }

  /** The drag ended, however it ended: the next one is its own (`CameraStateController.endPan`). */
  endPan(): void {
    this.renderCameraValue?.endPanCamera();
  }

  /** A pinch by `scale` at `velocity` (scale per second), anchored at `anchorPoint` (CSS pixels, top-left origin) when given. */
  zoomCameraByScale(scale: number, velocity: number, anchorPoint: Vec2 | null = null): void {
    const stateBefore = this.currentCameraState();
    this.renderCameraValue?.zoomCameraByScale(scale, velocity);
    this.applyCurrentCameraConstraints();
    this.applyZoomAnchorCompensation(stateBefore, anchorPoint);
    this.notifyCameraPositionChanged();
    this.syncPitchControlValue();
    this.render.requestFrame();
  }

  /** A zoom by `delta` levels, anchored at `anchorPoint` when given. */
  zoomCameraByDelta(delta: number, anchorPoint: Vec2 | null = null): void {
    const stateBefore = this.currentCameraState();
    this.renderCameraValue?.zoomCameraByDelta(delta);
    this.applyCurrentCameraConstraints();
    this.applyZoomAnchorCompensation(stateBefore, anchorPoint);
    this.notifyCameraPositionChanged();
    this.syncPitchControlValue();
    this.render.requestFrame();
  }

  /**
   * Target position for an animated anchored zoom (double tap or click): the
   * zoom changes by `zoomDelta`, the center shifts so that the world point
   * under `anchorPoint` stays put (subject to `zoomAnchorFactor`).
   */
  anchoredZoomTargetPosition(zoomDelta: number, anchorPoint: Vec2): ImmersiveMapCameraPosition | null {
    const stateBefore = this.currentCameraState();
    if (stateBefore === null) {
      return null;
    }
    const zoomed: ImmersiveMapCameraState = { ...stateBefore, zoom: clampZoom(this.settings.camera, stateBefore.zoom + zoomDelta) };
    const stateAfter: ImmersiveMapCameraState = { ...zoomed, centerWorldMercator: this.anchorCompensatedCenter(stateBefore, zoomed, anchorPoint) };
    return ImmersiveMapCameraState.cameraPosition(stateAfter);
  }

  /**
   * Shifts the map center after an already-applied zoom so that the world
   * point under `anchorPoint` stays under it (by the `zoomAnchorFactor`
   * fraction). On the flat map the shift is a move over the terrain, where
   * there is one (`CameraStateController.setCenterWorldMercatorOverTerrain`):
   * the eye keeps the altitude the zoom gave it, whatever ground the point
   * slides over.
   */
  private applyZoomAnchorCompensation(stateBefore: ImmersiveMapCameraState | null, anchorPoint: Vec2 | null): void {
    const renderCamera = this.renderCameraValue;
    if (stateBefore === null || anchorPoint === null || renderCamera === null) {
      return;
    }
    const stateAfter = renderCamera.currentCameraState();
    const center = this.anchorCompensatedCenter(stateBefore, stateAfter, anchorPoint);
    if (center[0] === stateAfter.centerWorldMercator[0] && center[1] === stateAfter.centerWorldMercator[1]) {
      return;
    }
    const onThePlane = this.presentationStateResolver.resolve(stateAfter).presentationState.transition >= 1;
    if (onThePlane) {
      renderCamera.setCameraCenterWorldMercatorOverTerrain(center);
    } else {
      renderCamera.setCameraCenterWorldMercator(center);
    }
  }

  private anchorCompensatedCenter(stateBefore: ImmersiveMapCameraState, stateAfter: ImmersiveMapCameraState, anchorPoint: Vec2): Vec2 {
    return ZoomAnchorMath.compensatedCenterWorldMercator({
      anchorPoint,
      viewportSize: this.viewportSize(),
      centerWorldMercator: stateBefore.centerWorldMercator,
      zoomBefore: stateBefore.zoom,
      zoomAfter: stateAfter.zoom,
      bearing: stateBefore.bearing,
      transitionBefore: this.presentationStateResolver.resolve(stateBefore).presentationState.transition,
      transitionAfter: this.presentationStateResolver.resolve(stateAfter).presentationState.transition,
      globeRadiusScale: this.settings.presentation.globeRadiusScale,
      anchorFactor: this.settings.camera.zoomAnchorFactor,
    });
  }

  /** Advances the elastic bounds' pull by one frame, notifying and redrawing when the center moved. Returns whether it is still pulling. */
  advanceBoundsPull(deltaTime: number): boolean {
    const renderCamera = this.renderCameraValue;
    if (renderCamera === null) {
      return false;
    }
    const before = renderCamera.currentCameraState().centerWorldMercator;
    const isReturning = renderCamera.advanceBoundsPull(deltaTime);
    const after = renderCamera.currentCameraState().centerWorldMercator;
    if (after[0] !== before[0] || after[1] !== before[1]) {
      this.notifyCameraPositionChanged();
      this.render.requestFrame();
    }
    return isReturning;
  }

  setCameraPitch(pitch: number): void {
    this.renderCameraValue?.setCameraPitch(pitch);
    this.applyCurrentCameraConstraints();
    this.notifyCameraPositionChanged();
    this.render.requestFrame();
  }

  setCameraBearing(bearing: number): void {
    this.renderCameraValue?.setCameraBearing(bearing);
    this.applyCurrentCameraConstraints();
    this.notifyCameraPositionChanged();
    this.render.requestFrame();
  }

  notifyCameraPositionChanged(explicitPosition: ImmersiveMapCameraPosition | null = null): void {
    const position = explicitPosition ?? this.currentCameraPosition();
    if (position === null) {
      return;
    }
    this.controls.syncAttribution?.(position.zoom);
    const snapshot = this.currentCameraSnapshot(position);
    this.cameraNotificationGeneration += 1;
    const notificationGeneration = this.cameraNotificationGeneration;

    if (snapshot !== null) {
      this.controller?.updateCurrentCameraSnapshot(snapshot);
    }
    this.controller?.notifyCameraPositionChanged(position);

    // A callback that moved the camera again has already notified the newer
    // snapshot: this one is stale.
    if (notificationGeneration !== this.cameraNotificationGeneration || snapshot === null) {
      return;
    }
    this.controller?.notifyCameraSnapshotChanged(snapshot);
  }

  notifyMapBackgroundTap(): void {
    this.controller?.notifyMapBackgroundTap();
  }

  notifyUserInteractionBegan(): void {
    this.controller?.notifyUserInteractionBegan();
  }

  syncPitchControlValue(fallbackCameraPosition: ImmersiveMapCameraPosition | null = null): void {
    const position =
      this.renderCameraValue?.currentCameraPosition() ?? fallbackCameraPosition ?? this.appliedCameraPosition ?? this.initialCameraPosition;
    this.controls.syncPitch?.(position, this.currentMinimumPitch(), this.currentMaximumPitch());
    this.controls.syncAttribution?.(position?.zoom ?? null);
  }

  private applyCurrentCameraConstraints(): void {
    const renderCamera = this.renderCameraValue;
    if (renderCamera === null) {
      return;
    }
    renderCamera.applyConstraints(this.currentCameraConstraints(renderCamera.currentCameraState()));
  }

  private currentCameraConstraints(cameraState: ImmersiveMapCameraState): CameraConstraints {
    return this.presentationStateResolver.cameraConstraints(cameraState);
  }
}

function positionsEqual(a: ImmersiveMapCameraPosition | null, b: ImmersiveMapCameraPosition | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    a.latitudeDegrees === b.latitudeDegrees &&
    a.longitudeDegrees === b.longitudeDegrees &&
    a.zoom === b.zoom &&
    a.bearing === b.bearing &&
    a.pitch === b.pitch
  );
}
