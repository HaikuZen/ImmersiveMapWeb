// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { clipDistanceVariant } from "./clip-distance-variant.ts";
import { globeModuleSource } from "./globe-shader-source.ts";
import sphereSource from "../tile/shaders/tile-sphere.wgsl?raw";

describe("clipDistanceVariant", () => {
  const source = ["enable clip_distances; // clip-distances", "a", "out.cut[0] = c; // clip-distances", "if (c < 0.0) { discard; } // no-clip-distances", "b"].join("\n");

  test("with the feature: the clip distance, no discard", () => {
    expect(clipDistanceVariant(source, true)).toBe(["enable clip_distances; // clip-distances", "a", "out.cut[0] = c; // clip-distances", "b"].join("\n"));
  });

  test("without it: the discard by the same clearance, no clip distance", () => {
    expect(clipDistanceVariant(source, false)).toBe(["a", "if (c < 0.0) { discard; } // no-clip-distances", "b"].join("\n"));
  });

  test("a globe module starts with the directive where the feature is", () => {
    expect(globeModuleSource(true, [], sphereSource).trimStart().split("\n").find((line) => !line.startsWith("//") && line.trim() !== "")).toBe("enable clip_distances; // clip-distances");
    expect(globeModuleSource(false, [], sphereSource)).not.toContain("clip_distances");
  });
});
