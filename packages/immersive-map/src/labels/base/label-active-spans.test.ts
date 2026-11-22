// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `LabelActiveSpansTests`: the labels a frame works on,
// the head of each tile's run its zoom shows, and the labels behind it still
// fading out.

import { describe, expect, test } from "vitest";
import { LabelActiveSpans } from "./label-active-spans.ts";

/** Two tiles of labels ordered by their zoom: 0, 14, 16, 17 and 15, 18. */
const minZooms = Float32Array.from([0, 14, 16, 17, 15, 18]);
const runs = [0, 4, 4, 6];

function resolve(spans: LabelActiveSpans, zoom: number, alphas: number[]): void {
  spans.resolve(minZooms, Float32Array.from(alphas), zoom);
}

function fade(spans: LabelActiveSpans, alphas: number[], targets: boolean[]): void {
  spans.updateLitEnds(Float32Array.from(alphas), Uint8Array.from(targets.map(Number)));
}

const dark = [0, 0, 0, 0, 0, 0];

describe("LabelActiveSpans", () => {
  test("each run is worked on up to the labels its zoom shows", () => {
    const spans = new LabelActiveSpans();
    spans.rebind(runs);
    resolve(spans, 16, dark);
    expect(spans.spans).toEqual([0, 3, 4, 5]);
    expect(spans.spanCount).toBe(2);
    expect(spans.count).toBe(4);
  });

  test("a run with nothing at the zoom is left out", () => {
    const spans = new LabelActiveSpans();
    spans.rebind(runs);
    resolve(spans, 14.5, dark);
    expect(spans.spans).toEqual([0, 2]);
  });

  test("a rebind covers every non-empty run until the first resolve", () => {
    const spans = new LabelActiveSpans();
    spans.rebind([0, 4, 4, 4, 4, 6]);
    expect(spans.spans).toEqual([0, 4, 4, 6]);
    spans.reset();
    expect(spans.spanCount).toBe(0);
  });

  // Zooming out, the labels past the new zoom are worked on while they fade
  // out, and left once they are dark.
  test("a label past the zoom is worked on until it has faded out", () => {
    const spans = new LabelActiveSpans();
    spans.rebind(runs);
    resolve(spans, 17, dark);
    expect(spans.spans).toEqual([0, 4, 4, 5]);
    fade(spans, [1, 1, 1, 1, 1, 0], [true, true, true, true, true, false]);

    resolve(spans, 15, [1, 1, 1, 1, 1, 0]);
    expect(spans.spans, "the labels of 16 and 17 still fade out").toEqual([0, 4, 4, 5]);

    fade(spans, [1, 1, 0.5, 0, 1, 0], [true, true, false, false, true, false]);
    resolve(spans, 15, [1, 1, 0.5, 0, 1, 0]);
    expect(spans.spans, "the label of 17 is dark: left out").toEqual([0, 3, 4, 5]);

    fade(spans, [1, 1, 0, 0, 1, 0], [true, true, false, false, true, false]);
    resolve(spans, 15, [1, 1, 0, 0, 1, 0]);
    expect(spans.spans).toEqual([0, 2, 4, 5]);
  });

  // A run that survived a change of the set carries its fades: the first
  // resolve finds its lit labels past the zoom in the alphas.
  test("a rebind finds the lit labels the runs carried", () => {
    const spans = new LabelActiveSpans();
    spans.rebind(runs);
    resolve(spans, 14, [1, 1, 0, 0.4, 0, 0]);
    expect(spans.spans, "the label of 17 still lit, the label of 16 before it with it").toEqual([0, 4]);

    resolve(spans, 14, [1, 1, 0, 0.4, 0, 0]);
    expect(spans.spans, "found once, kept until the fades say otherwise").toEqual([0, 4]);
  });
});
