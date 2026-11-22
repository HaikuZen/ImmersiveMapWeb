// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgb } from "../../configuration/color.ts";

const hueStep = 0.618034;
const hueOffset = 0.12;

/**
 * The colour of a tile zoom in the debug overlays (the Swift
 * `DebugTileZoomPalette`). The tile outlines and the tile labels on the map
 * and the card titles in the debug panel share it, so a zoom reads the same
 * everywhere, and where two zooms overlap, a near ring's tiles over a far
 * ring's or a stand-in in the slot it fills, the overlap shows as two
 * colours. Neighbouring zooms take hues far apart, a golden-ratio step round
 * the wheel, so z6 and z7 never look alike. Bright and saturated, for the
 * black stroke on a dark map.
 */
export const DebugTileZoomPalette = {
  color(zoom: number): Rgb {
    const hue = (Math.max(0, zoom) * hueStep + hueOffset) % 1;
    return DebugTileZoomPalette.rgb(hue, 0.85, 1);
  },

  /** HSV to RGB, every component in 0...1. */
  rgb(hue: number, saturation: number, value: number): Rgb {
    const sector = hue * 6;
    const index = Math.floor(sector) % 6;
    const fraction = sector - Math.floor(sector);
    const low = value * (1 - saturation);
    const falling = value * (1 - saturation * fraction);
    const rising = value * (1 - saturation * (1 - fraction));
    switch (index) {
      case 0:
        return [value, rising, low];
      case 1:
        return [falling, value, low];
      case 2:
        return [low, value, rising];
      case 3:
        return [low, falling, value];
      case 4:
        return [rising, low, value];
      default:
        return [value, low, falling];
    }
  },
} as const;
