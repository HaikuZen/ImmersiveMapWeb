// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { GlobeCameraProximity } from "./globe-camera-proximity.ts";
import type { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";
import type { RenderCamera } from "./render-camera.ts";

/**
 * Synchronizes semantic camera state with the render camera: eye and up
 * vectors, matrices, and frustum.
 *
 * The render world is centered on the point the camera looks at (the
 * origin), the map lies in the z = 0 plane (the globe's sphere touches it at
 * the origin), and the eye sits on the arm `1 - 0.5 frac(zoom)` units long,
 * times the globe proximity, tilted by the pitch about x and turned by the
 * bearing about z.
 */
export class RenderCameraPoseResolver {
  private needsUpdate = true;
  private appliedTransition: number | null = null;

  requestUpdate(): void {
    this.needsUpdate = true;
  }

  /**
   * `transition` is the frame's globe-to-plane phase: on the globe the
   * camera moves in by the view centre's surface scale
   * (`GlobeCameraProximity`), and the phase carries that factor through the
   * morph, so a change of phase alone (the debug panel forcing a surface)
   * re-poses the camera too.
   */
  updateIfNeeded(camera: RenderCamera, cameraState: ImmersiveMapCameraState, transition: number): void {
    if (!this.needsUpdate && this.appliedTransition === transition) {
      return;
    }

    const yaw = cameraState.bearing;
    const pitch = cameraState.pitch;

    const zRemains = cameraState.zoom % 1.0;
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(cameraState.centerWorldMercator[1]);
    const proximity = GlobeCameraProximity.distanceFactor(latitude, transition, cameraState.zoom);
    const distance = (1.0 - zRemains * 0.5) * proximity;

    // yawQuat * pitchQuat applied to the camera position (0, 0, distance)
    // and the up (0, 1, 0): the pitch about x first, then the yaw about z.
    const cosPitch = Math.cos(pitch);
    const sinPitch = Math.sin(pitch);
    const cosYaw = Math.cos(yaw);
    const sinYaw = Math.sin(yaw);
    // Pitched position: (0, -distance sin, distance cos).
    const positionY = -distance * sinPitch;
    const positionZ = distance * cosPitch;
    // Pitched up: (0, cos, sin).
    const upY = cosPitch;
    const upZ = sinPitch;

    camera.eye = [-positionY * sinYaw, positionY * cosYaw, positionZ];
    camera.up = [-upY * sinYaw, upY * cosYaw, upZ];

    camera.recalculateMatrix();
    this.needsUpdate = false;
    this.appliedTransition = transition;
  }
}
