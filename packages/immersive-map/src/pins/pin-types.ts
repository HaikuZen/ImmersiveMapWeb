// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The sizes of a map's pins on the screen, worked out once from the pin
 * settings and the shape: a port of the Swift `PinStyle`,
 * `PinCountBadgeStyle` and `PinShapeMetrics` (`PinTypes.swift`,
 * `PinShape.swift`).
 */

import type { Rgba } from "../configuration/color.ts";
import { PinShape } from "../configuration/pin-shape.ts";
import { PinShapeDistanceField } from "./textures/pin-shape-distance-field.ts";

/** The height of the built-in bubble's tail when its resource does not say (`PinShape.bubbleTailHeight`). */
export const defaultBubbleTailHeight = 0.046875;

/**
 * Where a shape stands in its quad, in fractions of the quad, origin bottom
 * left, y up, as the shader reads them.
 */
export interface PinShapeMetrics {
  /** The point of the quad that stands on the pin's coordinate. */
  readonly anchor: readonly [number, number];
  /** The centre of the picture area, also the centre of the circle a pushed pin turns into. */
  readonly bodyCenter: readonly [number, number];
  /** Half the picture area's width and height. */
  readonly bodyHalfSize: readonly [number, number];
  readonly isFrameless: boolean;
  /** The radius of the circle a pushed pin turns into. */
  readonly circleRadius: number;
}

export function pinShapeMetrics(shape: PinShape, bubbleTailHeight = defaultBubbleTailHeight): PinShapeMetrics {
  // A baked shape is drawn inside a margin of its texture, so that its soft
  // edge is not cut by the quad. The built-in bubble's texture has its own,
  // and a bare picture fills the quad.
  const margin = PinShape.isBaked(shape) ? PinShapeDistanceField.margin : 0;
  const scale = 1 - 2 * margin;
  const area = shape.kind === "bubble" ? { ...shape.pictureArea, height: 1 - bubbleTailHeight } : shape.pictureArea;
  const placed = (x: number, y: number): [number, number] => [f32(margin + x * scale), f32(1 - (margin + y * scale))];
  const bodyHalfSize: [number, number] = [f32(area.width * (0.5 * scale)), f32(area.height * (0.5 * scale))];
  return {
    anchor: placed(shape.anchor.x, shape.anchor.y),
    bodyCenter: placed(area.x + area.width * 0.5, area.y + area.height * 0.5),
    bodyHalfSize,
    isFrameless: PinShape.isFrameless(shape),
    circleRadius: Math.min(bodyHalfSize[0], bodyHalfSize[1]),
  };
}

const f32 = Math.fround;

/** What the pin shader reads of the map's style (the Swift `PinStyleGPU`). */
export interface PinStyleGPU {
  readonly sizePx: readonly [number, number];
  readonly anchorUv: readonly [number, number];
  readonly bodyCenterUv: readonly [number, number];
  readonly bodyHalfUv: readonly [number, number];
  readonly circleRadiusUv: number;
  readonly outlineWidthPx: number;
  readonly contentInsetPx: number;
  readonly distanceRangeTexels: number;
  readonly fillColor: Rgba;
  readonly frameless: boolean;
  /** The distance is in the texture's alpha, as the built-in bubble's, not in its red, as a baked one's. */
  readonly distanceInAlpha: boolean;
}

export class PinStyle {
  readonly gpu: PinStyleGPU;

  constructor(options: {
    readonly sizePx: number;
    readonly outlineWidthPx: number;
    readonly contentInset?: number;
    readonly fillColor?: Rgba;
    readonly metrics?: PinShapeMetrics;
    readonly distanceRangeTexels?: number;
    readonly distanceInAlpha?: boolean;
  }) {
    const metrics = options.metrics ?? pinShapeMetrics(PinShape.bubble);
    const sizePx = f32(options.sizePx);
    this.gpu = {
      sizePx: [sizePx, sizePx],
      anchorUv: metrics.anchor,
      bodyCenterUv: metrics.bodyCenter,
      bodyHalfUv: metrics.bodyHalfSize,
      circleRadiusUv: metrics.circleRadius,
      outlineWidthPx: Math.max(options.outlineWidthPx, 0),
      contentInsetPx: f32(Math.max(sizePx * (options.contentInset ?? 0.06), 0)),
      distanceRangeTexels: options.distanceRangeTexels ?? PinShapeDistanceField.distanceRangeTexels,
      fillColor: options.fillColor ?? [1, 1, 1, 1],
      frameless: metrics.isFrameless,
      distanceInAlpha: options.distanceInAlpha ?? false,
    };
  }

  /** The side of the pin's quad. */
  get totalSizePx(): readonly [number, number] {
    return this.gpu.sizePx;
  }

  /** The lower left corner of the quad, from the pin's anchor. */
  get quadOriginPx(): [number, number] {
    return [f32(-this.gpu.anchorUv[0] * this.gpu.sizePx[0]), f32(-this.gpu.anchorUv[1] * this.gpu.sizePx[1])];
  }

  /** The centre of the picture area, and of the circle a pushed pin turns into, from the pin's anchor. */
  get bodyCenterOffsetPx(): [number, number] {
    const g = this.gpu;
    return [f32((g.bodyCenterUv[0] - g.anchorUv[0]) * g.sizePx[0]), f32((g.bodyCenterUv[1] - g.anchorUv[1]) * g.sizePx[1])];
  }

  /** The upper right corner of the picture area, from the pin's anchor. */
  get bodyTopRightPx(): [number, number] {
    const g = this.gpu;
    return [f32((g.bodyCenterUv[0] + g.bodyHalfUv[0] - g.anchorUv[0]) * g.sizePx[0]), f32((g.bodyCenterUv[1] + g.bodyHalfUv[1] - g.anchorUv[1]) * g.sizePx[1])];
  }

  /** Half the longer side of the picture area. */
  get bodyRadiusPx(): number {
    return f32(Math.max(this.gpu.bodyHalfUv[0], this.gpu.bodyHalfUv[1]) * this.gpu.sizePx[0]);
  }

  /** The radius of the circle a pushed pin turns into. */
  get circleRadiusPx(): number {
    return f32(this.gpu.circleRadiusUv * this.gpu.sizePx[0]);
  }
}

/** The round counter of a merged pin: on the top right edge of the body, standing out above it. */
export class PinCountBadgeStyle {
  static readonly sizeRatio = 0.4;
  static readonly minimumSizePx = 46;
  /** The counter's centre in from the body's right edge, as a part of its diameter. */
  static readonly horizontalInsetRatio = 0.18;
  /** The counter's centre down from the body's top, as a part of its diameter. */
  static readonly verticalInsetRatio = 0.15;

  readonly sizePx: readonly [number, number];
  readonly originXPx: number;
  readonly originYPx: number;

  constructor(sizePx: number, pinStyle: PinStyle) {
    const diameter = f32(Math.max(f32(sizePx * PinCountBadgeStyle.sizeRatio), PinCountBadgeStyle.minimumSizePx));
    const [right, top] = pinStyle.bodyTopRightPx;
    const centerX = right - diameter * PinCountBadgeStyle.horizontalInsetRatio;
    const centerY = top - diameter * PinCountBadgeStyle.verticalInsetRatio;
    this.sizePx = [diameter, diameter];
    this.originXPx = f32(centerX - diameter * 0.5);
    this.originYPx = f32(centerY - diameter * 0.5);
  }
}
