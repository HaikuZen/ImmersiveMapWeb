// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgba } from "../configuration/color.ts";
import { airHandover, type PresentationSettings } from "../configuration/presentation-settings.ts";
import type { SpaceSettings } from "../configuration/scene-settings.ts";

/**
 * The world pass's clear colour, a port of the Swift `RenderFrameClearColor`:
 * space for as long as the surface is the sphere, most of the unroll
 * included, so the starfield stays through the morph, and the style's map
 * colour from the surface switch on, where it is what shows under a tile
 * that has not arrived. Over the air handover (`airHandoverStart` to
 * `airHandoverEnd`) space brightens into the map's colour at the pace the
 * flat map's sky fades in.
 *
 * Transparent space clears to a fully transparent pixel and reaches the map
 * colour through premultiplied values: the canvas is composited as
 * premultiplied alpha, so a colour at zero alpha would tint the page.
 */
export function frameClearColor(transition: number, presentation: PresentationSettings, space: SpaceSettings, mapColor: Rgba): GPUColorDict {
  const mix = airHandover(presentation, transition);
  const spaceColor: Rgba = space.isTransparent ? [0, 0, 0, 0] : space.clearColor;
  const target: Rgba = space.isTransparent ? [mapColor[0] * mapColor[3], mapColor[1] * mapColor[3], mapColor[2] * mapColor[3], mapColor[3]] : mapColor;
  const at = (i: number): number => spaceColor[i]! + (target[i]! - spaceColor[i]!) * mix;
  return { r: at(0), g: at(1), b: at(2), a: at(3) };
}
