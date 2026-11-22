// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import type { ClosedRange } from "../math/closed-range.ts";
import { deepFreeze, mergeOptions } from "./deep.ts";
import type { Options } from "./deep.ts";

/**
 * The invisible drag zones in the bottom corners that let one thumb drive
 * the camera: pitch in the bottom leading corner, zoom in the bottom
 * trailing one. Both are on by default, so a map on a phone is driven with
 * one hand out of the box. A zone captures the drags that would otherwise
 * pan the map there, and nothing on screen announces it: turn a zone off
 * (`cameraControlZones({ pitch, zoom })`) where the corner belongs to the
 * app's own controls. Touch input only, ignored for a mouse.
 */
export interface ControlZoneSettings {
  readonly isPitchZoneEnabled: boolean;
  readonly isZoomZoneEnabled: boolean;
}

/** The control zones, both on unless stated. */
export function controlZoneSettings(options: Options<ControlZoneSettings> = {}): ControlZoneSettings {
  return deepFreeze(mergeOptions({ isPitchZoneEnabled: true, isZoomZoneEnabled: true }, options));
}

/**
 * A zoom-dependent rotation window for the globe: at zoom 0 the camera may
 * turn at most `minimumAbsoluteBearing` away from north, and the window
 * opens linearly to the full `maximumAbsoluteBearing` (or the half turn) at
 * `unlockZoom`. Off unless an app sets one.
 */
export interface GlobeBearingLimit {
  readonly minimumAbsoluteBearing: number;
  readonly unlockZoom: number;
}

/** A globe bearing window, `minimum` radians at zoom 0, open at `unlockZoom`. */
export function globeBearingLimit(minimum: number, unlockZoom: number): GlobeBearingLimit {
  return Object.freeze({ minimumAbsoluteBearing: minimum, unlockZoom });
}

/**
 * Keeps a zoomed-out globe upright, north up and seen from straight above,
 * so the planet is never left lying on its side. Across `zoomRange` the
 * bearing and the pitch the camera may rest at close in linearly, from the
 * camera's own limits at the upper bound to north up and the pitch floor at
 * the lower bound and below it.
 *
 * It is a pull, not a wall. A camera outside what its zoom allows is eased
 * back on every frame, during a gesture too, so zooming out of a turned and
 * tilted view straightens the globe on the way, and a rotation past the
 * allowed bearing springs back when the fingers let go. A tilt stops at the
 * allowed pitch. A flight or a path follow owns the camera, and the pull
 * waits for it to finish. The globe only: the flat map is never pulled.
 */
export interface GlobeUprightPull {
  /** The zooms over which the globe is straightened: upright at the lower bound and below it, free from the upper bound on. */
  readonly zoomRange: ClosedRange;
  /** The seconds in which the pull closes half of what is left of the way back. Zero straightens at once. */
  readonly halfLife: number;
}

/** The name the camera's code reads the upright pull by. */
export type GlobeUprightPullSettings = GlobeUprightPull;

/** The upright pull, over zooms 3 to 6 with a 0.2 s half-life unless stated. */
export function globeUprightPull(options: Options<GlobeUprightPull> = {}): GlobeUprightPull {
  return deepFreeze(mergeOptions<GlobeUprightPull>({ zoomRange: { lowerBound: 3, upperBound: 6 }, halfLife: 0.2 }, options));
}

/**
 * What happens at the edge of the area the map center belongs in.
 *
 * - `hard`: the center cannot leave the area. Zooming in far from the
 *   region draws the center toward it as the area closes in.
 * - `elastic`: the center may leave the area, and a pull draws it back on
 *   every frame, during gestures too, so a drag out of the area works
 *   against it and a pinch toward an unreachable point glides to the region
 *   as the zoom grows.
 *
 *   The pull is gentle at the edge and grows with the distance: at `d`
 *   screen points out it closes half the gap every
 *   `pullHalfLife / (1 + d / maximumStretch)^pullProgression` seconds, and
 *   never faster than a sixteenth of `pullHalfLife`. A `pullProgression` of
 *   0 pulls at the same rate at any distance, a larger one keeps the edge
 *   soft and the far field steep. A drag itself is also damped past the
 *   edge, the center stopping about `maximumStretch` points out however far
 *   the finger goes.
 */
export type CameraBoundsEdgeBehavior =
  | { readonly kind: "hard" }
  | {
      readonly kind: "elastic";
      readonly maximumStretch: number;
      readonly pullHalfLife: number;
      readonly pullProgression: number;
    };

/** The edge behaviours. */
export const CameraBoundsEdgeBehavior = Object.freeze({
  /** A wall. */
  hard: Object.freeze({ kind: "hard" }) as CameraBoundsEdgeBehavior,
  /** An elastic band, 200 points of stretch, a 0.35 s half-life and a progression of 2 unless stated. */
  elastic(
    options: {
      readonly maximumStretch?: number | undefined;
      readonly pullHalfLife?: number | undefined;
      readonly pullProgression?: number | undefined;
    } = {},
  ): CameraBoundsEdgeBehavior {
    return Object.freeze({
      kind: "elastic",
      maximumStretch: options.maximumStretch ?? 200,
      pullHalfLife: options.pullHalfLife ?? 0.35,
      pullProgression: options.pullProgression ?? 2,
    });
  },
});

/**
 * How far the pull has closed across its zoom range: a cubic Bezier from
 * (0, 0) to (1, 1) with two control points, as in CSS `cubic-bezier()`. The
 * x axis is the progress through the zoom range, the y axis the share of the
 * way the reachable area has closed in on the region, 0 for the whole world
 * and 1 for the region alone. A y outside 0...1 is clamped.
 */
export interface PullCurve {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** The control points' x values are clamped to 0...1, so the curve stays a function of the zoom. */
function pullCurve(x1: number, y1: number, x2: number, y2: number): PullCurve {
  return Object.freeze({ x1: Math.min(Math.max(x1, 0), 1), y1, x2: Math.min(Math.max(x2, 0), 1), y2 });
}

/** The pull curves. */
export const PullCurve = Object.freeze({
  make: pullCurve,
  /** Closes at a constant rate across the range. */
  linear: pullCurve(0, 0, 1, 1),
  /** Starts gently and closes fastest at the upper bound. */
  easeIn: pullCurve(0.42, 0, 1, 1),
  /** Closes fastest at the lower bound and settles onto the region. */
  easeOut: pullCurve(0, 0, 0.58, 1),
  /** Gentle at both bounds, fastest in the middle. */
  easeInOut: pullCurve(0.42, 0, 0.58, 1),
});

/**
 * A geographic region the camera is held to. Below the pull's zoom range
 * the whole world is open, so a zoomed-out globe turns freely. Across the
 * range the area the map center belongs in closes in on the region,
 * following `pullCurve`, and from its upper bound it is the region itself.
 * `edgeBehavior` says whether the edge of that area is a wall or an elastic
 * band.
 */
export interface CameraBounds {
  /** The south-west corner, in degrees. */
  readonly southWest: GeoCoordinate;
  /** The north-east corner, in degrees. A longitude west of the south-west one spans the antimeridian. */
  readonly northEast: GeoCoordinate;
  /**
   * The zooms over which the camera is drawn into the region: the whole
   * world is open up to the lower bound, and the center is inside the region
   * from the upper bound on. Equal bounds switch from one to the other at
   * that zoom.
   */
  readonly pullZoomRange: ClosedRange;
  /** How the pull runs across `pullZoomRange`. */
  readonly pullCurve: PullCurve;
  /** A wall or an elastic band at the edge of the area, elastic by default. */
  readonly edgeBehavior: CameraBoundsEdgeBehavior;
}

/** The fields of camera bounds: the corners required, the pull over zooms 1 to 2, ease-in-out, elastic, unless stated. */
export interface CameraBoundsOptions {
  readonly southWest: GeoCoordinate;
  readonly northEast: GeoCoordinate;
  readonly pullZoomRange?: ClosedRange | undefined;
  readonly pullCurve?: PullCurve | undefined;
  readonly edgeBehavior?: CameraBoundsEdgeBehavior | undefined;
}

export function cameraBounds(options: CameraBoundsOptions): CameraBounds {
  return deepFreeze({
    southWest: options.southWest,
    northEast: options.northEast,
    pullZoomRange: options.pullZoomRange ?? { lowerBound: 1, upperBound: 2 },
    pullCurve: options.pullCurve ?? PullCurve.easeInOut,
    edgeBehavior: options.edgeBehavior ?? CameraBoundsEdgeBehavior.elastic(),
  });
}

export interface CameraSettings {
  /** The highest pitch the camera can reach, in radians from straight down: 85 degrees by default. */
  readonly maximumPitch: number;
  /**
   * The lowest pitch the camera can reach, in radians from straight down.
   * Zero (the default) allows the top-down view. A floor above the ceiling
   * yields to it.
   */
  readonly minimumPitch: number;
  /**
   * The lowest zoom the camera can reach. Gestures, zoom commands and camera
   * flights are all clamped to it, so raising it keeps the map from ever
   * showing the whole globe.
   */
  readonly minimumZoom: number;
  /**
   * The highest zoom the camera can reach: 20 by default, five levels past
   * the deepest tile (15), close enough to stand among the trees and read
   * the facades. The tiles' detail is blown up there past what it was drawn
   * for. The flattened ground (`GroundFlatteningSettings`, on by default)
   * keeps the near ground whole at any depth. A layered ground's rank depth
   * holds a level past the tiles' zoom, so with the flattening off a street
   * tilt this deep can drop blocks of the near ground: a map that turns the
   * flattening off lowers this with it.
   */
  readonly maximumZoom: number;
  /** The zoom the camera flies to when it focuses a marker. */
  readonly focusedMarkerZoom: number;
  /**
   * How far the camera may rotate away from north, in radians, symmetric
   * around it. Null (the default) leaves rotation unbounded. The cap applies
   * on both surfaces. With a `globeBearingLimit` the globe's window opens
   * with zoom, and the cap becomes the widest that window opens instead of
   * the full half turn.
   */
  readonly maximumAbsoluteBearing: number | null;
  /** The globe's zoom-dependent rotation window, null (the default) for none: the globe then turns as freely as the flat map. */
  readonly globeBearingLimit: GlobeBearingLimit | null;
  /**
   * The pull that keeps a zoomed-out globe upright, on by default. Null
   * turns it off: the globe then keeps any bearing and pitch at every zoom.
   */
  readonly globeUprightPull: GlobeUprightPull | null;
  /** The region the camera is held to, null (the default) for the whole world. */
  readonly bounds: CameraBounds | null;
  /** Extra pitch, in radians, the ceiling gains from `highZoomPitchExtensionStartZoom` to `highZoomPitchExtensionEndZoom`. 0 by default. */
  readonly highZoomPitchExtension: number;
  readonly highZoomPitchExtensionStartZoom: number;
  readonly highZoomPitchExtensionEndZoom: number;
  /** A second extension of the ceiling, in radians, over `extraHighZoomPitchExtensionStartZoom` to `extraHighZoomPitchExtensionEndZoom`. 0 by default. */
  readonly extraHighZoomPitchExtension: number;
  readonly extraHighZoomPitchExtensionStartZoom: number;
  readonly extraHighZoomPitchExtensionEndZoom: number;
  readonly gesturePanTranslationScale: number;
  readonly worldPanSensitivity: number;
  readonly worldPanSpeed: number;
  readonly pinchZoomFactor: number;
  readonly pinchZoomVelocityFactor: number;
  readonly pinchZoomVelocityLimit: number;
  /**
   * How strongly zoom is anchored to the gesture point (cursor, pinch center,
   * double tap): 1 keeps the world point under the cursor put, 0 zooms
   * toward the screen center.
   */
  readonly zoomAnchorFactor: number;
  readonly dragZoomFactor: number;
  readonly dragZoomVelocityFactor: number;
  readonly dragZoomVelocityLimit: number;
  readonly rotationGestureSensitivity: number;
  /**
   * How fast a tilt drag tilts: the multiple of the full pitch range that a
   * drag across the whole view height sweeps. Applies to the two-finger
   * vertical drag on touch input and to the tilt drag (right button, or
   * Alt-drag) with a mouse. 1 makes a full-height drag exactly span the
   * range, the default 2 reaches it in half. Dragging down tilts further and
   * up levels off. A negative value inverts the direction, so -2 tilts on
   * the way up at the same speed.
   */
  readonly tiltGestureSensitivity: number;
  readonly globePanInertiaEnabled: boolean;
  readonly globePanInertiaHalfLife: number;
  readonly globePanInertiaActivationVelocity: number;
  readonly globePanInertiaStopVelocity: number;
  readonly globePanInertiaMaxInitialVelocity: number;
  readonly pitchFollowEnabled: boolean;
  readonly pitchFollowHalfLife: number;
  readonly bearingFollowEnabled: boolean;
  readonly bearingFollowHalfLife: number;
  /**
   * The seconds in which the animated zoom closes half of what is left of
   * its way to the camera's zoom. The camera's zoom is the fact of a frame,
   * and the tiles, the rings and the camera's pose read it as it is. What
   * dresses the frame by the zoom (the styles' zoom fades, the labels'
   * reach) reads the animated one instead, and the relief's collapse a zoom
   * held through a drag and then followed the same way, so a zoom that
   * jumps in one frame, as it does over a relief when the point the camera
   * looks at drops off a ridge onto the plain below, dresses the frame over
   * a few frames rather than at once. A camera set outright snaps it. Zero
   * makes the two one. Raise it for a slower settle, lower it for a quicker
   * one.
   */
  readonly animatedZoomHalfLife: number;
  readonly controlZones: ControlZoneSettings;
}

/**
 * The default camera: tilted nearly to the horizon, 85 degrees from
 * straight down, on both surfaces and at every zoom, so a camera can look
 * along the streets at the skyline.
 */
export const defaultCameraSettings: CameraSettings = deepFreeze({
  maximumPitch: (Math.PI * 17) / 36,
  minimumPitch: 0,
  minimumZoom: 0,
  maximumZoom: 20,
  focusedMarkerZoom: 15.25,
  maximumAbsoluteBearing: null,
  globeBearingLimit: null,
  globeUprightPull: globeUprightPull(),
  bounds: null,
  highZoomPitchExtension: 0,
  highZoomPitchExtensionStartZoom: 15,
  highZoomPitchExtensionEndZoom: 16,
  extraHighZoomPitchExtension: 0,
  extraHighZoomPitchExtensionStartZoom: 18.4,
  extraHighZoomPitchExtensionEndZoom: 20,
  gesturePanTranslationScale: 0.1,
  worldPanSensitivity: 0.05,
  worldPanSpeed: 0.5,
  pinchZoomFactor: 0.4,
  pinchZoomVelocityFactor: 0.2,
  pinchZoomVelocityLimit: 8,
  zoomAnchorFactor: 1,
  dragZoomFactor: 2,
  dragZoomVelocityFactor: 0.35,
  dragZoomVelocityLimit: 5,
  rotationGestureSensitivity: -0.6,
  tiltGestureSensitivity: 2,
  globePanInertiaEnabled: true,
  globePanInertiaHalfLife: 0.28,
  globePanInertiaActivationVelocity: 450,
  globePanInertiaStopVelocity: 60,
  globePanInertiaMaxInitialVelocity: 7000,
  pitchFollowEnabled: true,
  pitchFollowHalfLife: 0.06,
  bearingFollowEnabled: true,
  bearingFollowHalfLife: 0.06,
  animatedZoomHalfLife: 0.15,
  controlZones: controlZoneSettings(),
});

/** Camera settings, every field not stated at the default camera's value. */
export function cameraSettings(options: Options<CameraSettings> = {}): CameraSettings {
  return deepFreeze(mergeOptions(defaultCameraSettings, options));
}

/**
 * Clamps a zoom level to the configured range. Negative minimums are
 * treated as zero (the whole world already fits at zoom 0), and an inverted
 * range collapses to `maximumZoom`.
 */
export function clampZoom(camera: CameraSettings, zoom: number): number {
  const lowerBound = Math.max(camera.minimumZoom, 0);
  if (!(lowerBound <= camera.maximumZoom)) {
    return camera.maximumZoom;
  }
  return Math.min(Math.max(zoom, lowerBound), camera.maximumZoom);
}

function interpolatedPitchExtension(zoom: number, extensionAngle: number, startZoom: number, endZoom: number): number {
  const clampedExtensionAngle = Math.max(extensionAngle, 0);
  if (!(clampedExtensionAngle > 0)) {
    return 0;
  }
  const clampedEndZoom = Math.max(endZoom, startZoom);
  if (!(clampedEndZoom - startZoom > Number.MIN_VALUE)) {
    return zoom >= startZoom ? clampedExtensionAngle : 0;
  }
  const progress = Math.min(Math.max((zoom - startZoom) / (clampedEndZoom - startZoom), 0), 1);
  return clampedExtensionAngle * progress;
}

/** How much the pitch ceiling is raised at a zoom by the two high-zoom extensions. */
export function cameraPitchExtension(camera: CameraSettings, zoom: number): number {
  return (
    interpolatedPitchExtension(
      zoom,
      camera.highZoomPitchExtension,
      camera.highZoomPitchExtensionStartZoom,
      camera.highZoomPitchExtensionEndZoom,
    ) +
    interpolatedPitchExtension(
      zoom,
      camera.extraHighZoomPitchExtension,
      camera.extraHighZoomPitchExtensionStartZoom,
      camera.extraHighZoomPitchExtensionEndZoom,
    )
  );
}

/** The pitch ceiling in force at a zoom. */
export function maximumReachablePitch(camera: CameraSettings, zoom: number): number {
  return Math.max(camera.maximumPitch, 0) + cameraPitchExtension(camera, zoom);
}

/**
 * The pitch floor in force at a zoom: the configured minimum, but never
 * above the ceiling that applies there, so an inverted range collapses to
 * the ceiling instead of deadlocking the camera.
 */
export function minimumReachablePitch(camera: CameraSettings, zoom: number): number {
  return Math.min(Math.max(camera.minimumPitch, 0), maximumReachablePitch(camera, zoom));
}

/** Clamps a pitch to the configured range at a zoom. */
export function clampPitch(camera: CameraSettings, pitch: number, zoom: number): number {
  return Math.min(Math.max(pitch, minimumReachablePitch(camera, zoom)), maximumReachablePitch(camera, zoom));
}
