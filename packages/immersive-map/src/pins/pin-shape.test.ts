// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `PinShapeTests`, `PinTextureAtlasTests`,
// `PinTextureRasterizerTests` and `LazyPinRenderResourceTests` (the CPU parts).
// The shape's coverage is rasterised by the browser's canvas, which the test
// environment lacks: the baked circle is filled analytically on the same
// grid, so the distance transform and the encoding are what is tested.

import { describe, expect, test } from "vitest";
import { PinShape } from "../configuration/pin-shape.ts";
import type { PinImage } from "./immersive-map-pin.ts";
import { PinCountBadgeStyle, PinStyle, pinShapeMetrics } from "./pin-types.ts";
import { LazyPinRenderResource, pinDrawPassSequence } from "./pins-renderer.ts";
import { PinShapeDistanceField } from "./textures/pin-shape-distance-field.ts";
import { PinCountBadgeAtlas, PinTextureAtlas, pinImageSizeWarning } from "./textures/pin-texture-atlas.ts";

describe("pin shape metrics", () => {
  test("the bubble stands on its tail and the circle on its centre", () => {
    const bubble = pinShapeMetrics(PinShape.bubble);
    expect(bubble.anchor[0]).toBeCloseTo(0.5, 5);
    expect(bubble.anchor[1]).toBeCloseTo(0, 6);
    expect(bubble.bodyCenter[1]).toBeGreaterThan(0.5);
    expect(bubble.bodyHalfSize[0]).toBeCloseTo(0.5, 6);
    expect(bubble.isFrameless).toBe(false);
    const tailed = pinShapeMetrics(PinShape.roundedRectangle(0.2, true));
    expect(tailed.anchor[1]).toBeCloseTo(PinShapeDistanceField.margin, 5);
    const circle = pinShapeMetrics(PinShape.circle);
    expect(circle.anchor[0]).toBeCloseTo(circle.bodyCenter[0], 5);
    expect(circle.anchor[1]).toBeCloseTo(circle.bodyCenter[1], 5);
  });

  test("a picture fills the quad without a margin", () => {
    const metrics = pinShapeMetrics(PinShape.picture({ x: 0, y: 1 }));
    expect(metrics.isFrameless).toBe(true);
    expect(metrics.anchor[0]).toBeCloseTo(0, 6);
    expect(metrics.anchor[1]).toBeCloseTo(0, 6);
    expect(metrics.bodyHalfSize[0]).toBeCloseTo(0.5, 6);
    expect(metrics.circleRadius).toBeCloseTo(0.5, 6);
  });

  test("a path's picture area places the body", () => {
    // SVG path data states no bounds, so the area is given (the Swift engine takes the path's box).
    const shape = PinShape.path("M0.25,0H0.75V0.5H0.25Z", { x: 0.5, y: 1 }, { x: 0.25, y: 0, width: 0.5, height: 0.5 });
    expect(shape.pictureArea).toEqual({ x: 0.25, y: 0, width: 0.5, height: 0.5 });
    expect(shape.anchor).toEqual({ x: 0.5, y: 1 });
    const metrics = pinShapeMetrics(shape);
    expect(metrics.bodyCenter[1]).toBeGreaterThan(0.5);
    expect(metrics.bodyHalfSize[0]).toBeCloseTo(metrics.bodyHalfSize[1], 5);
  });

  test("the anchor moves the quad and the body's offset", () => {
    const centered = new PinStyle({ sizePx: 100, outlineWidthPx: 3, metrics: pinShapeMetrics(PinShape.picture()) });
    expect(centered.quadOriginPx[0]).toBeCloseTo(-50, 4);
    expect(centered.quadOriginPx[1]).toBeCloseTo(-50, 4);
    expect(Math.hypot(...centered.bodyCenterOffsetPx)).toBeCloseTo(0, 4);
    const cornered = new PinStyle({ sizePx: 100, outlineWidthPx: 3, metrics: pinShapeMetrics(PinShape.picture({ x: 0, y: 1 })) });
    expect(cornered.quadOriginPx[0]).toBeCloseTo(0, 4);
    expect(cornered.bodyCenterOffsetPx[0]).toBeCloseTo(50, 4);
    expect(cornered.bodyCenterOffsetPx[1]).toBeCloseTo(50, 4);
  });

  test("the counter sits on the body's top right edge, no smaller than its minimum", () => {
    const style = new PinStyle({ sizePx: 108.8, outlineWidthPx: 3 });
    const badge = new PinCountBadgeStyle(108.8, style);
    expect(badge.sizePx[0]).toBe(PinCountBadgeStyle.minimumSizePx);
    const [right, top] = style.bodyTopRightPx;
    expect(badge.originXPx + badge.sizePx[0] * 0.5).toBeCloseTo(right - badge.sizePx[0] * PinCountBadgeStyle.horizontalInsetRatio, 3);
    expect(badge.originYPx + badge.sizePx[1] * 0.5).toBeCloseTo(top - badge.sizePx[1] * PinCountBadgeStyle.verticalInsetRatio, 3);
  });
});

describe("PinShapeDistanceField", () => {
  test("a square's field is signed and measured from its edge", () => {
    const side = 16;
    const inside = new Uint8Array(side * side);
    for (let y = 4; y < 12; y++) for (let x = 4; x < 12; x++) inside[y * side + x] = 1;
    const distances = PinShapeDistanceField.signedDistances(inside, side);
    expect(distances[8 * side + 4]).toBeCloseTo(-0.5, 4);
    expect(distances[8 * side + 3]).toBeCloseTo(0.5, 4);
    expect(distances[8 * side + 0]).toBeCloseTo(3.5, 4);
    expect(distances[7 * side + 7]).toBeCloseTo(-3.5, 4);
    expect(distances[3 * side + 3]).toBeCloseTo(Math.SQRT2 - 0.5, 4);
  });

  test("a baked circle is inside at its centre and outside in the corner", () => {
    const { fineSide, margin, textureSize } = PinShapeDistanceField;
    // The unit circle laid inside the margin, as the canvas fills it.
    const inside = new Uint8Array(fineSide * fineSide);
    const radius = fineSide * (0.5 - margin);
    for (let y = 0; y < fineSide; y++) {
      for (let x = 0; x < fineSide; x++) {
        if (Math.hypot(x + 0.5 - fineSide / 2, y + 0.5 - fineSide / 2) <= radius) inside[y * fineSide + x] = 1;
      }
    }
    const field = PinShapeDistanceField.encodedField(inside);
    expect(field).toHaveLength(textureSize * textureSize);
    const edge = PinShapeDistanceField.encode(0);
    const center = field[(textureSize / 2) * textureSize + textureSize / 2]!;
    expect(center).toBeGreaterThan(edge);
    expect(field[0]!).toBeLessThan(edge);
    const expected = PinShapeDistanceField.encode(-textureSize * (0.5 - margin));
    // About a radius inside, within a texel and a half (400 of 65535 in the Swift test's units).
    expect(Math.abs(center - expected)).toBeLessThan(400 / 65535);
  });

  test("the encoding puts the edge in the middle and clamps", () => {
    expect(PinShapeDistanceField.encode(0)).toBe(0.5);
    expect(PinShapeDistanceField.encode(1e6)).toBe(0);
    expect(PinShapeDistanceField.encode(-1e6)).toBe(1);
  });

  test("a mask shape's defaults", () => {
    const shape = PinShape.mask("data:image/png;base64,");
    expect(shape.pictureArea).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(shape.anchor).toEqual({ x: 0.5, y: 1 });
  });

  test("a frameless shape bakes one texel and the bubble none", () => {
    expect(PinShapeDistanceField.bake(PinShape.bubble, null)).toBeNull();
    const picture = PinShapeDistanceField.bake(PinShape.picture(), null)!;
    expect(picture.side).toBe(1);
    expect(picture.values[0]).toBe(1);
  });
});

describe("PinTextureAtlas", () => {
  const picture = (name: string): PinImage => ({ name }) as unknown as PinImage;
  const recording = (): { atlas: PinTextureAtlas; uploads: PinImage[] } => {
    const uploads: PinImage[] = [];
    const atlas = new PinTextureAtlas(128, 64, 1, (image) => {
      uploads.push(image);
      return true;
    });
    return { atlas, uploads };
  };

  test("pins sharing a picture share one cell", () => {
    const { atlas, uploads } = recording();
    const image = picture("a");
    atlas.beginFrame(1);
    const first = atlas.uploadImage(image)!;
    const second = atlas.slot(image)!;
    expect(second.uvRect).toEqual(first.uvRect);
    expect(second.pageIndex).toBe(first.pageIndex);
    expect(atlas.uploadImage(image)!.uvRect).toEqual(first.uvRect);
    expect(uploads).toHaveLength(1);
  });

  test("a full atlas takes the cell of a picture this frame did not use", () => {
    const { atlas } = recording();
    expect(atlas.slotCapacity).toBe(4);
    const images = [0, 1, 2, 3, 4].map((index) => picture(String(index)));
    atlas.beginFrame(1);
    for (let index = 0; index < 4; index++) expect(atlas.uploadImage(images[index]!)).not.toBeNull();
    atlas.beginFrame(2);
    for (let index = 1; index < 4; index++) expect(atlas.slot(images[index]!)).not.toBeNull();
    expect(atlas.uploadImage(images[4]!)).not.toBeNull();
    expect(atlas.slot(images[0]!)).toBeNull();
    for (let index = 1; index < 5; index++) expect(atlas.slot(images[index]!)).not.toBeNull();
  });

  test("an atlas full of this frame's pictures refuses an upload", () => {
    const { atlas } = recording();
    const images = [0, 1, 2, 3, 4].map((index) => picture(String(index)));
    atlas.beginFrame(1);
    for (let index = 0; index < 4; index++) {
      expect(atlas.uploadImage(images[index]!)).not.toBeNull();
      atlas.slot(images[index]!);
    }
    expect(atlas.uploadImage(images[4]!)).toBeNull();
    for (let index = 0; index < 4; index++) expect(atlas.slot(images[index]!)).not.toBeNull();
  });

  test("a picture that could not be drawn gives its cell back", () => {
    const atlas = new PinTextureAtlas(64, 64, 1, () => false);
    expect(atlas.uploadImage(picture("broken"))).toBeNull();
    const working = new PinTextureAtlas(64, 64, 1, () => true);
    expect(working.uploadImage(picture("fine"))).not.toBeNull();
  });

  test("the size warning names a mismatch only", () => {
    expect(pinImageSizeWarning(64, 64, 64, 64)).toBeNull();
    expect(pinImageSizeWarning(256, 256, 64, 64)).toContain("256x256");
    expect(pinImageSizeWarning(300, 200, 64, 64)).toContain("300x200");
  });
});

describe("PinCountBadgeAtlas", () => {
  test("a counter is drawn once, and counts above 999 share the overflow's cell", () => {
    const drawn: string[] = [];
    const atlas = new PinCountBadgeAtlas(46, (text) => {
      drawn.push(text);
      return true;
    });
    const two = atlas.slot({ count: 2 })!;
    expect(atlas.slot({ count: 2 })).toBe(two);
    atlas.slot({ count: 1500 });
    atlas.slot({ count: 4000 });
    expect(drawn).toEqual(["2", "999+"]);
    expect(atlas.rows).toBe(50);
    expect(two[0]).toBeCloseTo(46 / atlas.width, 6);
  });
});

describe("LazyPinRenderResource", () => {
  test("the factory runs only on the first read of the value", () => {
    let runs = 0;
    const resource = new LazyPinRenderResource(() => {
      runs += 1;
      return { id: runs };
    });
    expect(resource.isInitialized).toBe(false);
    expect(runs).toBe(0);
    const first = resource.value;
    expect(resource.value).toBe(first);
    expect(runs).toBe(1);
    expect(resource.isInitialized).toBe(true);
  });

  test("reading the existing value does not run the factory", () => {
    let runs = 0;
    const resource = new LazyPinRenderResource(() => (runs += 1));
    expect(resource.existingValue).toBeUndefined();
    expect(runs).toBe(0);
  });

  test("the counters' draw follows the pins' only when a counter shows", () => {
    expect(pinDrawPassSequence(false)).toEqual(["pinBody"]);
    expect(pinDrawPassSequence(true)).toEqual(["pinBody", "countBadge"]);
  });
});
