// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapProjection } from "../../../geo/immersive-map-projection.ts";
import type { Tile } from "../../tile.ts";
import type { GroundRelief } from "../lifts/ground-relief.ts";
import type { GroundReliefFrame } from "./ground-relief-frame.ts";

/**
 * Mirror of `GroundReliefUniform` in ground-relief.wgsl, a port of the
 * Swift `GroundReliefUniform` (nine `vec4f`, 144 bytes): the tile's corner
 * and side in the terrain texture its grid rises by and the world units a
 * metre of terrain rises by, then the datum, the frame's strength and the
 * metres the shading's terrain texture spans, then the frame's shading of
 * the slopes and its fade, then the tile's corner and side in the terrain
 * texture its slopes are shaded by, and last the frame's darkening by the
 * occlusion of the sky.
 */
export const GroundReliefUniform = {
  byteLength: 144,
  /** The float offsets of the fields, as the WGSL struct lays them. */
  layout: {
    placement: 0,
    frame: 4,
    hillshadeLight: 8,
    hillshadeShadowColor: 12,
    hillshadeHighlightColor: 16,
    hillshadeEye: 20,
    hillshadeFade: 24,
    shading: 28,
    occlusion: 32,
  },

  /** The world units a metre spans at a latitude, by its normalized world mercator y. */
  worldUnitsPerMetre(normalizedWorldY: number, renderMapSize: number): number {
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(normalizedWorldY);
    return Math.fround(ImmersiveMapProjection.worldUnitsPerMeter(latitude, renderMapSize));
  },

  /** The ground metres a terrain texture spans a side, in the frame's metres: the tile's side over its share of the texture. */
  terrainSideMetres(relief: GroundRelief, tile: Tile, worldUnitsPerMetre: number, renderMapSize: number): number {
    const tileSideWorld = renderMapSize / 2 ** tile.z;
    return tileSideWorld / Math.max(worldUnitsPerMetre, Number.MIN_VALUE) / Math.max(relief.scale, Number.MIN_VALUE);
  },

  /**
   * Writes the uniform of one tile's draw at float `offset` of `target`:
   * `relief` the terrain the grid rises by, `shading` the one the slopes are
   * shaded by (the same where the ring's terrain is no finer than the
   * displacement's), with the frame's datum, rise, shading and darkening.
   */
  write(target: Float32Array, offset: number, relief: GroundRelief, shading: GroundRelief, tile: Tile, frame: GroundReliefFrame, renderMapSize: number): void {
    const layout = GroundReliefUniform.layout;
    const unitsPerMetre = frame.worldUnitsPerMetre;
    const o = offset;
    target[o + layout.placement] = relief.originX;
    target[o + layout.placement + 1] = relief.originY;
    target[o + layout.placement + 2] = relief.scale;
    target[o + layout.placement + 3] = unitsPerMetre;
    target[o + layout.frame] = frame.datumMetres;
    target[o + layout.frame + 1] = relief.strength;
    target[o + layout.frame + 2] = GroundReliefUniform.terrainSideMetres(shading, tile, unitsPerMetre, renderMapSize);
    target[o + layout.frame + 3] = 0;
    const hillshade = frame.hillshade;
    target.set(hillshade.light, o + layout.hillshadeLight);
    target.set(hillshade.shadowColor, o + layout.hillshadeShadowColor);
    target.set(hillshade.highlightColor, o + layout.hillshadeHighlightColor);
    target.set(hillshade.eye, o + layout.hillshadeEye);
    target.set(hillshade.fade, o + layout.hillshadeFade);
    target[o + layout.shading] = shading.originX;
    target[o + layout.shading + 1] = shading.originY;
    target[o + layout.shading + 2] = shading.scale;
    target[o + layout.shading + 3] = 0;
    target.set(frame.occlusionUniform, o + layout.occlusion);
  },
} as const;
