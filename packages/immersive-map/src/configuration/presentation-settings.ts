// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { deepFreeze, mergeOptions } from "./deep.ts";
import type { Options } from "./deep.ts";

/**
 * The presentation group of the map's settings: where the globe unrolls
 * into the plane and how large the render world is.
 */
export interface PresentationSettings {
  /** The zoom the automatic globe-to-plane transition starts at. 6 by default. */
  readonly automaticTransitionStartZoom: number;
  /** The zoom levels the transition takes, from its start to the finished plane. 1 by default. */
  readonly automaticTransitionSpan: number;
  /**
   * The globe's render radius at zoom 0, in render units. The render world
   * is renormalized per integer zoom: at zoom z the radius is this times
   * `2^floor(z)` and the flat map is `2 pi` radii across. 0.14 by default.
   */
  readonly globeRadiusScale: number;
  /**
   * Whether the map is a globe at low zoom. On (the default), the world is a
   * sphere until the camera zooms into the transition window and unrolls it
   * into the plane. Off, the world is the Mercator plane at every zoom: no
   * sphere, no morph, no stars, the flat map's sky and ground fog from zoom
   * 0 up. Applies live.
   */
  readonly isGlobeEnabled: boolean;
  /**
   * Where in the globe's unroll into the plane, as a fraction `0...1` of the
   * transition window, the globe's air starts giving way to the plane's. Up
   * to here the atmosphere rides the unrolling surface's edge as it does on
   * the resting globe, over space and the stars. From here to
   * `airHandoverEnd` the halo and the limb's glow fade out while the flat
   * map's sky fades in over them, the halo's colour turns into the sky's
   * colour at the horizon, space behind the stars brightens into the map's
   * colour, and the world tile is laid under the far ground as the plane's
   * horizon backdrop. 0.7 by default. Applies live.
   */
  readonly airHandoverStart: number;
  /**
   * Where the handover is complete, as a fraction `0...1` of the transition
   * window, at or past `airHandoverStart`. From here to the end of the
   * window the sphere's path draws exactly the plane's air, so the switch of
   * surfaces at the end changes nothing on screen. 0.9 by default, where the
   * unroll's geometry is a finished plane. Applies live.
   */
  readonly airHandoverEnd: number;
}

/** The presentation of `ImmersiveMapSettings.default`. */
export const defaultPresentationSettings: PresentationSettings = deepFreeze({
  automaticTransitionStartZoom: 6,
  automaticTransitionSpan: 1,
  globeRadiusScale: 0.14,
  isGlobeEnabled: true,
  airHandoverStart: 0.7,
  airHandoverEnd: 0.9,
});

/** Presentation settings, every field not stated at the default's value. */
export function presentationSettings(options: Options<PresentationSettings> = {}): PresentationSettings {
  return deepFreeze(mergeOptions(defaultPresentationSettings, options));
}

/** The name the presentation's code builds the settings by: `presentationSettings`. */
export const makePresentationSettings = presentationSettings;

/**
 * How far the globe's air has given way to the plane's at a point of the
 * transition, `0...1`: 0 up to `airHandoverStart`, a smoothstep to 1 at
 * `airHandoverEnd`, 1 from there on. A window of no width is a step at its
 * start.
 */
export function airHandover(settings: PresentationSettings, transition: number): number {
  const start = Math.min(Math.max(settings.airHandoverStart, 0), 1);
  const end = Math.min(Math.max(settings.airHandoverEnd, start), 1);
  const t = Math.min(Math.max((transition - start) / Math.max(end - start, 1e-6), 0), 1);
  return t * t * (3 - 2 * t);
}
