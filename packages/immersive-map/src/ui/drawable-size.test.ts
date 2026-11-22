// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { drawableSize } from "./immersive-map.ts";

const entry = (css: [number, number], box: [number, number] | undefined) =>
  ({
    contentRect: { width: css[0], height: css[1] } as DOMRectReadOnly,
    devicePixelContentBoxSize: box ? [{ inlineSize: box[0], blockSize: box[1] }] : [],
  }) as unknown as ResizeObserverEntry;

describe("drawableSize", () => {
  it("takes the device-pixel box where it agrees with the CSS size times the ratio", () => {
    expect(drawableSize(entry([600.5, 400], [1201, 800]), 2)).toEqual([1201, 800]);
  });
  it("ignores a box reported in CSS pixels under an emulated scale", () => {
    expect(drawableSize(entry([1200, 860], [1200, 860]), 2)).toEqual([2400, 1720]);
  });
  it("falls back to the CSS size times the ratio without a box", () => {
    expect(drawableSize(entry([300, 200], undefined), 1.5)).toEqual([450, 300]);
  });
});
