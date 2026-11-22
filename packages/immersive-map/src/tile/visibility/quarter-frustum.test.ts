// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { mat4Identity } from "../../math/matrix.ts";
import { quartersOutsideDisc, visibleQuarters } from "./quarter-frustum.ts";

// The identity's clip volume is the square from -1 to 1 in x and y.
const identity = mat4Identity();

describe("visibleQuarters", () => {
  test("a tile inside the view keeps every quarter", () => {
    expect(visibleQuarters(identity, -0.5, -0.5, 1, 0, 0b1111, true)).toBe(0b1111);
  });

  test("a tile half off the right edge keeps its western quarters", () => {
    // The tile spans x 0.5 to 2.5: its eastern half (1.5 to 2.5) is past the edge.
    expect(visibleQuarters(identity, 0.5, -0.5, 2, 0, 0b1111, true)).toBe(0b0101);
  });

  test("a tile half off the top keeps its southern quarters", () => {
    expect(visibleQuarters(identity, -0.5, 0.5, 2, 0, 0b1111, true)).toBe(0b1100);
  });

  test("only the quarters the placement draws are tested", () => {
    expect(visibleQuarters(identity, 0.5, -0.5, 2, 0, 0b0010, true)).toBe(0);
  });

  test("a tile kept whole draws all or nothing", () => {
    expect(visibleQuarters(identity, 0.5, -0.5, 2, 0, 0b1111, false)).toBe(0b1111);
    expect(visibleQuarters(identity, 3, 3, 1, 0, 0b1111, false)).toBe(0);
  });

  test("a box behind the camera is out of view", () => {
    const behind = mat4Identity();
    behind[15] = -1;
    expect(visibleQuarters(behind, -0.5, -0.5, 1, 0, 0b1111, true)).toBe(0);
  });
});

describe("quartersOutsideDisc", () => {
  // The tile spans x 0 to 2 and y 0 to 2: quarter 0 (north-west) is x 0 to 1, y 1 to 2.
  test("a disc holding the whole tile leaves nothing", () => {
    expect(quartersOutsideDisc(0, 0, 2, 0b1111, true, 1, 1, 1.5)).toBe(0);
  });

  test("a disc about the south-west corner takes the south-west quarter alone", () => {
    // Quarter 2's farthest corner (1, 1) is at the square root of two: inside 1.5, the other quarters reach 2.24 and more.
    expect(quartersOutsideDisc(0, 0, 2, 0b1111, true, 0, 0, 1.5)).toBe(0b1011);
  });

  test("a quarter only partly inside stays", () => {
    expect(quartersOutsideDisc(0, 0, 2, 0b1111, true, 0, 0, 1.2)).toBe(0b1111);
  });

  test("only the quarters the placement draws are kept", () => {
    expect(quartersOutsideDisc(0, 0, 2, 0b0100, true, 0, 0, 1.5)).toBe(0);
  });

  test("a tile kept whole stays unless the disc holds all of it", () => {
    expect(quartersOutsideDisc(0, 0, 2, 0b1111, false, 0, 0, 1.5)).toBe(0b1111);
    expect(quartersOutsideDisc(0, 0, 2, 0b1111, false, 1, 1, 1.5)).toBe(0);
  });
});
