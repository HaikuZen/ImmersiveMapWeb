// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type CameraSettings, defaultCameraSettings } from "../configuration/camera-settings.ts";
import { defaultPresentationSettings, type PresentationSettings } from "../configuration/presentation-settings.ts";

/**
 * The two groups of the map's settings (`ImmersiveMapSettings`) that the
 * camera and the presentation read. Structural, so the whole settings value
 * passes where this is asked for.
 */
export interface CameraPresentationSettings {
  readonly camera: CameraSettings;
  readonly presentation: PresentationSettings;
}

/** The two groups of `ImmersiveMapSettings.default`. */
export const defaultCameraPresentationSettings: CameraPresentationSettings = Object.freeze({
  camera: defaultCameraSettings,
  presentation: defaultPresentationSettings,
});
