// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import type { ImmersiveMapCameraAnimationRuntime } from "./immersive-map-camera-animation-runtime.ts";
import type { ImmersiveMapCameraCommand } from "./immersive-map-camera-controller.ts";
import type { ImmersiveMapCameraRuntime } from "./immersive-map-camera-runtime.ts";
import type { ImmersiveMapInteractionRuntime } from "./immersive-map-interaction-runtime.ts";

/**
 * Applies `ImmersiveMapCameraController` commands to the camera runtime,
 * through the narrow surface of applying a position and starting camera
 * animations.
 */
export class ImmersiveMapCameraCommandHandler {
  constructor(
    private readonly cameraRuntime: ImmersiveMapCameraRuntime,
    private readonly cameraAnimationRuntime: ImmersiveMapCameraAnimationRuntime,
    private readonly interactionRuntime: ImmersiveMapInteractionRuntime | null = null,
  ) {}

  /**
   * The position a jump that yields to the user's gestures goes to: the
   * jump's, but the user's value of what a gesture is changing (a pan, a
   * pinch, the wheel, a turn or a tilt, the on-screen controls, and the
   * turn's and the tilt's easing and the globe's pan inertia after them).
   */
  private yieldedPosition(position: ImmersiveMapCameraPosition): ImmersiveMapCameraPosition {
    const current = this.cameraRuntime.currentCameraPosition();
    if (current === null) return position;
    const active = (source: Parameters<ImmersiveMapInteractionRuntime["isActive"]>[0]) => this.interactionRuntime?.isActive(source) ?? false;
    const animation = this.cameraAnimationRuntime;
    const keepsCenter = active("mapPan") || animation.isGlobeCameraPanInertiaActive;
    const keepsZoom = active("mapPinch") || active("scrollZoom") || active("zoomControl");
    // A mouse's tilt drag turns the map too (horizontally), so it holds the bearing as well.
    const keepsBearing = active("mapRotation") || active("mapTilt") || animation.isCameraBearingFollowActive;
    const keepsPitch = active("mapTilt") || active("pitchControl") || animation.isCameraPitchFollowActive;
    return {
      latitudeDegrees: keepsCenter ? current.latitudeDegrees : position.latitudeDegrees,
      longitudeDegrees: keepsCenter ? current.longitudeDegrees : position.longitudeDegrees,
      zoom: keepsZoom ? current.zoom : position.zoom,
      bearing: keepsBearing ? current.bearing : position.bearing,
      pitch: keepsPitch ? current.pitch : position.pitch,
    };
  }

  handle(command: ImmersiveMapCameraCommand): void {
    switch (command.kind) {
      case "jump":
        // The controller's jump goes where it says, every time: also back to
        // the position of the previous jump after a gesture moved the camera
        // away. The dedup against the last declared position
        // (`applyCameraPosition`) belongs to the declared `camera` option
        // alone, which an app may re-declare unchanged and which must not
        // snap the camera back after a gesture. Applied once per frame by an
        // app driving the camera itself, the jump keeps the loop running the
        // way a gesture does, or every frame would stop and start the loop.
        if (command.options.yieldsToGestures) {
          // The app's own motion stops; the gestures' easing and inertia go on.
          this.cameraAnimationRuntime.cancelCameraMovements();
          this.cameraRuntime.setCameraPosition(this.yieldedPosition(command.position));
        } else {
          this.cameraAnimationRuntime.cancelAnimations();
          this.cameraRuntime.setCameraPosition(command.position);
        }
        this.cameraRuntime.noteExternalCameraDrive();
        break;
      case "fly":
        this.cameraAnimationRuntime.startCameraFlight(command.position, command.options, command.completion);
        break;
      case "follow":
        this.cameraAnimationRuntime.startCameraPathFollow(command.path, command.duration, command.curve, command.options, command.completion);
        break;
      case "cancelFollow":
        this.cameraAnimationRuntime.cancelCameraPathFollow();
        break;
      case "cancelFlight":
        this.cameraAnimationRuntime.cancelCameraFlight();
        break;
      case "setAngleTarget":
        this.cameraAnimationRuntime.setCameraAngleTarget(command.bearing, command.pitch);
        break;
    }
  }

  /**
   * The declared position: applied only when it differs from the last
   * declared one, since a repeat must not move a camera the user has since
   * dragged elsewhere.
   */
  applyCameraPosition(cameraPosition: ImmersiveMapCameraPosition | null): void {
    if (!this.cameraRuntime.needsCameraPositionUpdate(cameraPosition)) {
      return;
    }
    this.cameraAnimationRuntime.cancelAnimations();
    this.cameraRuntime.applyCameraPosition(cameraPosition);
  }
}
