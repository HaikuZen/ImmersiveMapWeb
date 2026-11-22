// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgba } from "../../../configuration/color.ts";
import { type ImmersiveMapZoomCurve, zoomCurveValue } from "../../../configuration/zoom-curve.ts";
import type { Vec3, Vec4 } from "../../../math/vec.ts";
import type { ImmersiveMapHillshade } from "../../../style/theme.ts";

/** How much the slopes are shaded, the three amounts of a style the debug panel drags live: each 0 to 1. */
export interface GroundReliefHillshadeAmounts {
  readonly intensity: number;
  readonly shadow: number;
  readonly highlight: number;
}

/** Where the shading fades, the two curves of a style the debug panel drags live: metres from the eye by the camera zoom. */
export interface GroundReliefHillshadeFade {
  readonly startMeters: ImmersiveMapZoomCurve;
  readonly endMeters: ImmersiveMapZoomCurve;
}

/**
 * The shading of the ground's slopes this frame (`ImmersiveMapHillshade`),
 * a port of the Swift `GroundReliefHillshade`: the scene's light, the share
 * of the style's intensity the relief's rise leaves, the style's colours,
 * and how it fades with the distance from the eye, as the fills' fragment
 * stages read them (`GroundReliefUniform`, `groundReliefHillshade` in
 * ground-relief.wgsl). Resolved once a frame, so every draw on the relief
 * shades by the same light.
 */
export interface GroundReliefHillshade {
  /** The direction toward the light in the flat basis (+x east, +y north, +z up), unit length, and the amount of shading: zero draws none. */
  readonly light: Vec4;
  readonly shadowColor: Rgba;
  readonly highlightColor: Rgba;
  /** The eye in the world, where the fade is measured from. */
  readonly eye: Vec4;
  /** The world distance from the eye the fade starts at, and one over the world distance it takes to fade out. */
  readonly fade: Vec4;
}

const clampUnit = (value: number) => Math.min(Math.max(value, 0), 1);

export const GroundReliefHillshade = {
  none: Object.freeze<GroundReliefHillshade>({
    light: [0, 0, 1, 0],
    shadowColor: [0, 0, 0, 0],
    highlightColor: [0, 0, 0, 0],
    eye: [0, 0, 0, 0],
    fade: [0, 0, 0, 0],
  }),

  /** The lowest light the slopes are shaded by, the sine of its elevation: about half a degree over the horizon. */
  minimumLightZ: 0.01,

  /** The amounts, each clamped to 0 to 1. */
  amounts(intensity: number, shadow: number, highlight: number): GroundReliefHillshadeAmounts {
    return { intensity: clampUnit(intensity), shadow: clampUnit(shadow), highlight: clampUnit(highlight) };
  },

  /** The amounts a style shades by. */
  amountsOfStyle(style: ImmersiveMapHillshade): GroundReliefHillshadeAmounts {
    return GroundReliefHillshade.amounts(style.intensity, style.shadowColor[3], style.highlightColor[3]);
  },

  /**
   * The shading of a style under a light (`SceneLightSettings.direction`,
   * toward the light) with the relief risen by `risenShare`, 0 to 1, seen
   * from `cameraEye`, the world's origin being the point it looks at, at
   * the camera `zoom` the fade's curves are read at and `unitsPerMetre`
   * world units a metre. `fade` replaces the style's fade and `amounts` its
   * amounts. A light at or under the horizon shades nothing.
   */
  resolve(input: {
    readonly style: ImmersiveMapHillshade;
    readonly lightDirection: Vec3;
    readonly risenShare: number;
    readonly cameraEye: Vec3;
    readonly zoom: number;
    readonly unitsPerMetre: number;
    readonly fade?: GroundReliefHillshadeFade | undefined;
    readonly amounts?: GroundReliefHillshadeAmounts | undefined;
  }): GroundReliefHillshade {
    const [lx, ly, lz] = input.lightDirection;
    const lengthSquared = lx * lx + ly * ly + lz * lz;
    if (!(lengthSquared > 1e-12)) return GroundReliefHillshade.none;
    let { intensity, shadowColor, highlightColor } = input.style;
    if (input.amounts !== undefined) {
      intensity = input.amounts.intensity;
      shadowColor = [shadowColor[0], shadowColor[1], shadowColor[2], input.amounts.shadow];
      highlightColor = [highlightColor[0], highlightColor[1], highlightColor[2], input.amounts.highlight];
    }
    const startCurve = input.fade?.startMeters ?? input.style.fadeStartMeters;
    const endCurve = input.fade?.endMeters ?? input.style.fadeEndMeters;
    const length = Math.sqrt(lengthSquared);
    const light: [number, number, number] = [Math.fround(lx / length), Math.fround(ly / length), Math.fround(lz / length)];
    const amount = Math.max(0, intensity) * clampUnit(input.risenShare);
    const unitsPerMetre = input.unitsPerMetre;
    if (!(light[2] > GroundReliefHillshade.minimumLightZ) || !(amount > 0) || !light.every(Number.isFinite) || !Number.isFinite(unitsPerMetre) || !(unitsPerMetre > 0)) {
      return GroundReliefHillshade.none;
    }
    // The fade in metres at this zoom, geometric between the stops as a
    // length on the ground runs, then in the world.
    const startMetres = Math.max(0, zoomCurveValue(startCurve, input.zoom, "geometric"));
    const endMetres = Math.max(startMetres, zoomCurveValue(endCurve, input.zoom, "geometric"));
    const startWorld = startMetres * unitsPerMetre;
    const spanWorld = Math.max((endMetres - startMetres) * unitsPerMetre, Math.max(startWorld, unitsPerMetre) * 1e-3);
    const [ex, ey, ez] = input.cameraEye;
    return {
      light: [light[0], light[1], light[2], amount],
      shadowColor,
      highlightColor,
      eye: [ex, ey, ez, 0],
      fade: [startWorld, 1 / spanWorld, 0, 0],
    };
  },
} as const;
