// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgb } from "../../configuration/color.ts";
import { clampTo, swiftRounded } from "./debug-overlay-geometry.ts";

/**
 * The settings' colours as a colour input shows and hands them back. The
 * settings state their colours in sRGB, 0 to 1 a channel, and a colour
 * input (`<input type="color">`) in `#rrggbb`, so the two convert directly.
 * A colour picked by hand comes back to a 255th of a channel.
 */
export const DebugOverlayColor = {
  /** The colour as `#rrggbb`, each channel held to 0...1 first. */
  hex(rgb: Rgb): string {
    const channel = (value: number) =>
      swiftRounded(clampTo(Number.isFinite(value) ? value : 0, 0, 1) * 255)
        .toString(16)
        .padStart(2, "0");
    return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
  },

  /** The colour of `#rrggbb` (or `rrggbb`), `undefined` for anything else. */
  rgb(hex: string): Rgb | undefined {
    const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (match === null) return undefined;
    const channel = (text: string | undefined) => parseInt(text ?? "0", 16) / 255;
    return [channel(match[1]), channel(match[2]), channel(match[3])];
  },
} as const;
