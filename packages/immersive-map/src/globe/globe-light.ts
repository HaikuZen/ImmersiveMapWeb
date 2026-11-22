// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ViewMode } from "../camera/view-mode.ts";
import type { GlobeLightSettings } from "../configuration/scene-settings.ts";
import { zoomCurveValue } from "../configuration/zoom-curve.ts";
import type { Vec3 } from "../math/vec.ts";

/**
 * The sun on the globe as the shaders read it (`globeLitColor` in
 * globe.wgsl), a port of the Swift `GlobeLightUniform`: the direction toward
 * the sun in world space (`GlobeSunDirection.sunWorldDirection`, the one the
 * atmosphere's halo reads too), the strength at the frame's camera zoom and
 * through the globe's morph into the plane, the night colour and the
 * terminator's softness. On the plane and with the light off the strength is
 * zero and the shaders leave every colour.
 */
export interface GlobeLight {
  /** The unit direction toward the sun, and the strength (0: unlit). */
  readonly lightAndStrength: readonly [number, number, number, number];
  /** The night colour and the terminator's softness. */
  readonly nightColorAndSoftness: readonly [number, number, number, number];
}

export const GlobeLight = {
  disabled: { lightAndStrength: [0, 0, 1, 0], nightColorAndSoftness: [0, 0, 0, 0] } as GlobeLight,

  /**
   * The light fades out over the first stretch of the transition and is
   * gone by here: the terminator is the sphere's, and the unrolling surface
   * is no sphere.
   */
  morphFadeOutEnd: 0.12,

  /** How much of the light is left: 1 on the resting globe, 0 from `morphFadeOutEnd` on and on the plane. */
  morphFade(transition: number, renderSurfaceMode: ViewMode): number {
    if (renderSurfaceMode !== "spherical") return 0;
    const t = Math.min(Math.max(transition / GlobeLight.morphFadeOutEnd, 0), 1);
    return 1 - t * t * (3 - 2 * t);
  },

  /**
   * The light a frame shades the globe with: the sun's direction, the
   * strength's curve read at the camera zoom (the camera's own, with no lag
   * behind it), faded out as the morph into the plane starts.
   */
  resolve(settings: GlobeLightSettings, lightDirection: Vec3, renderSurfaceMode: ViewMode, transition: number, zoom: number): GlobeLight {
    const morphFade = GlobeLight.morphFade(transition, renderSurfaceMode);
    const strength = Math.min(Math.max(zoomCurveValue(settings.strength, zoom), 0), 1) * morphFade;
    const length = Math.hypot(lightDirection[0], lightDirection[1], lightDirection[2]);
    if (!settings.isEnabled || !(strength > 0) || !(length * length > 1e-12)) return GlobeLight.disabled;
    const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
    const [r, g, b] = settings.nightColor;
    return {
      lightAndStrength: [lightDirection[0] / length, lightDirection[1] / length, lightDirection[2] / length, strength],
      nightColorAndSoftness: [clamp01(r), clamp01(g), clamp01(b), Math.min(Math.max(settings.terminatorSoftness, 0.001), 1)],
    };
  },
} as const;
