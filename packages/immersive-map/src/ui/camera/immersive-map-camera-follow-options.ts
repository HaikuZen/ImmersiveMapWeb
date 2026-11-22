// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Where the camera looks while it follows a path.
 *
 * - `course`: turn to the trajectory, so the direction of travel points up
 *   the screen. Where the settings limit how far the camera may rotate
 *   (`CameraSettings.maximumAbsoluteBearing`, `globeBearingLimit`), the turn
 *   is clamped there rather than fought for.
 * - `unchanged`: keep whatever bearing the camera already has.
 * - `fixed`: hold a fixed bearing, clockwise from north, in radians.
 */
export type ImmersiveMapCameraFollowBearing =
  | { readonly kind: "course" }
  | { readonly kind: "unchanged" }
  | { readonly kind: "fixed"; readonly bearing: number };

export const ImmersiveMapCameraFollowBearing = {
  course: Object.freeze({ kind: "course" }) as ImmersiveMapCameraFollowBearing,
  unchanged: Object.freeze({ kind: "unchanged" }) as ImmersiveMapCameraFollowBearing,
  fixed(bearing: number): ImmersiveMapCameraFollowBearing {
    return Object.freeze({ kind: "fixed", bearing });
  },
} as const;

/** How the camera frames the point it is following along a path. */
export interface ImmersiveMapCameraFollowOptions {
  /** Null keeps the camera's current zoom, so the app can zoom while following without the follow fighting back. */
  readonly zoom: number | null;
  /** Null keeps the camera's current pitch, in radians. */
  readonly pitch: number | null;
  readonly bearing: ImmersiveMapCameraFollowBearing;
  /**
   * Half-life of the exponential catch-up, in seconds: the camera trails the
   * point and closes half the remaining gap every `smoothingHalfLife`. Zero
   * pins the camera exactly on it, which reads as rigid on a curved path.
   */
  readonly smoothingHalfLife: number;
}

export const ImmersiveMapCameraFollowOptions = {
  /** No zoom or pitch of its own, the course up the screen, a 0.35 s catch-up. */
  default: Object.freeze({ zoom: null, pitch: null, bearing: ImmersiveMapCameraFollowBearing.course, smoothingHalfLife: 0.35 }) as ImmersiveMapCameraFollowOptions,

  /** The options given, the rest at their defaults. */
  make(options: Partial<ImmersiveMapCameraFollowOptions> = {}): ImmersiveMapCameraFollowOptions {
    return Object.freeze({ ...ImmersiveMapCameraFollowOptions.default, ...options });
  },
} as const;
