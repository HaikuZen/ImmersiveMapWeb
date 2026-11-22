// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgba } from "./color.ts";
import { deepFreeze, mergeOptions } from "./deep.ts";
import type { Options } from "./deep.ts";
import { PinShape } from "./pin-shape.ts";

/** The side of a pin's picture in the atlas, in pixels. */
export type PinSize = 64 | 128 | 256 | 512 | 1024 | 2048;

/** Every pin size, smallest first. */
export const pinSizes: readonly PinSize[] = Object.freeze([64, 128, 256, 512, 1024, 2048]);

export interface PinSettings {
  /** The side of a pin's picture in the atlas, in pixels. 64 by default. */
  readonly size: PinSize;
  /** 1.7 by default. */
  readonly sizeScale: number;
  /** 0.55 by default. */
  readonly compressedScale: number;
  /** 4096 by default. */
  readonly atlasSizePx: number;
  /** 1 by default. */
  readonly atlasPagesMax: number;
  /**
   * The shape of the frame every pin is drawn in: a built-in one
   * (`PinShape.bubble`, `PinShape.circle`, `PinShape.roundedRectangle(...)`),
   * one of the app's own, from a picture of it (`PinShape.mask(...)`) or from
   * a path (`PinShape.path(...)`), or no frame at all (`PinShape.picture()`).
   * The bubble by default.
   */
  readonly shape: PinShape;
  /** The width of the frame's outline, in pixels. Zero draws no outline. 3 by default. */
  readonly borderWidthPx: number;
  /** The color of the frame's outline. A pin's own `borderColor` takes its place for that pin. Black by default. */
  readonly borderColor: Rgba;
  /**
   * The color of the frame under and around the picture. It shows in the
   * band between the outline and the picture, and through the transparent
   * parts of a picture. White by default.
   */
  readonly fillColor: Rgba;
  /**
   * How far the picture is set in from the frame's edge, as a part of the
   * pin's size. The picture never reaches into the outline. Zero lays the
   * picture right up to the outline. 0.06 by default.
   */
  readonly contentInset: number;
  /**
   * The color of the beam, the cone of light that runs from a pin pushed off
   * its place to the point on the map it belongs to. The beam is densest at
   * the pin and dissolves toward the point, and the alpha sets how dense it
   * is at the pin.
   */
  readonly beamColor: Rgba;
  /** 0 by default. */
  readonly collisionPaddingPx: number;
  /** 5 by default. */
  readonly groupingThreshold: number;
  /** 220 by default. */
  readonly maxOffsetPx: number;
  /** 10 by default. */
  readonly collisionIterations: number;
  /** 0.25 by default. */
  readonly springK: number;
  /** 0.35 by default. */
  readonly smoothing: number;
  /**
   * Whether pins that would overlap push each other apart. A pin pushed off
   * its place stays tied to it by a beam, like a pin on a rubber band, and
   * comes back when there is room. Off, every pin stands exactly on its
   * coordinate and pins may cover each other. On by default. Turn it off for
   * pins whose exact place matters more than being seen whole.
   */
  readonly spreadsApart: boolean;
}

export const defaultPinSettings: PinSettings = deepFreeze({
  size: 64,
  sizeScale: 1.7,
  compressedScale: 0.55,
  atlasSizePx: 4096,
  atlasPagesMax: 1,
  shape: PinShape.bubble,
  borderWidthPx: 3,
  borderColor: [0, 0, 0, 1],
  fillColor: [1, 1, 1, 1],
  contentInset: 0.06,
  beamColor: [0.65, 0.75, 1.0, 1.0],
  collisionPaddingPx: 0,
  groupingThreshold: 5,
  maxOffsetPx: 220,
  collisionIterations: 10,
  springK: 0.25,
  smoothing: 0.35,
  spreadsApart: true,
});

export function pinSettings(options: Options<PinSettings> = {}): PinSettings {
  return deepFreeze(mergeOptions(defaultPinSettings, options));
}
