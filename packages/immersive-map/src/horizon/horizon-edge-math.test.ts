// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `HorizonEdgeMathTests`.

import { describe, expect, test } from "vitest";
import { mat4Invert } from "../math/mat4-invert.ts";
import { Matrix, mat4Multiply } from "../math/matrix.ts";
import type { Vec3 } from "../math/vec.ts";
import { HorizonEdgeMath } from "./horizon-edge-math.ts";

const eye: Vec3 = [0, 0, 1];
const radius = 0.28;

describe("HorizonEdgeMath", () => {
  test("the plane is the zero-curvature limit", () => {
    const edge = HorizonEdgeMath.edge(eye, 0);
    expect(edge.up).toEqual([0, 0, 1]);
    expect(edge.depression).toBe(0);
    expect(edge.limbDistance).toBe(Number.POSITIVE_INFINITY);
    expect(HorizonEdgeMath.angleAboveEdge([0, 0, -1], edge)).toBeCloseTo(-Math.PI / 2, 6);
    expect(HorizonEdgeMath.angleAboveEdge([1, 0, 0], edge)).toBeCloseTo(0, 6);
    expect(HorizonEdgeMath.angleAboveEdge([0, Math.SQRT1_2, Math.SQRT1_2], edge)).toBeCloseTo(Math.PI / 4, 6);
  });

  test("the resting sphere matches the classic limb", () => {
    const edge = HorizonEdgeMath.edge(eye, 1 / radius);
    const centerDistance = 1 + radius;
    expect(edge.up[0]).toBeCloseTo(0, 6);
    expect(edge.up[1]).toBeCloseTo(0, 6);
    expect(edge.up[2]).toBeCloseTo(1, 6);
    expect(edge.depression).toBeCloseTo(Math.acos(radius / centerDistance), 5);
    expect(edge.limbDistance).toBeCloseTo(Math.sqrt(centerDistance * centerDistance - radius * radius), 5);
    const limbAngle = Math.asin(radius / centerDistance);
    expect(Math.abs(HorizonEdgeMath.angleAboveEdge([0, 0, -1], edge) + limbAngle)).toBeLessThan(1e-3);
    const grazing: Vec3 = [Math.sin(limbAngle), 0, -Math.cos(limbAngle)];
    expect(HorizonEdgeMath.angleAboveEdge(grazing, edge)).toBeCloseTo(0, 5);
  });

  test("a pitched eye has its own vertical", () => {
    const pitchedEye: Vec3 = [0, -0.7, 0.7];
    const edge = HorizonEdgeMath.edge(pitchedEye, 1 / radius);
    const d: Vec3 = [0, -0.7, 0.7 + radius];
    const length = Math.hypot(...d);
    for (let i = 0; i < 3; i++) expect(edge.up[i]!).toBeCloseTo(d[i]! / length, 6);
  });

  test("the edge rises monotonically into the plane", () => {
    let previous = HorizonEdgeMath.edge(eye, 1 / radius);
    for (let step = 1; step <= 200; step++) {
      const curvature = (1 / radius) * (1 - step / 200);
      const edge = HorizonEdgeMath.edge(eye, curvature);
      expect(edge.depression).toBeLessThanOrEqual(previous.depression + 1e-6);
      expect(Math.hypot(edge.up[0] - previous.up[0], edge.up[1] - previous.up[1], edge.up[2] - previous.up[2])).toBeLessThan(0.05);
      if (curvature > 0) {
        const sphereRadius = 1 / curvature;
        expect(Math.abs(edge.depression - Math.acos(sphereRadius / (sphereRadius + eye[2])))).toBeLessThan(2e-3);
      }
      previous = edge;
    }
    expect(previous.depression).toBeCloseTo(0, 6);
  });

  test("the edge's reach decides whether the layer draws", () => {
    const projection = Matrix.perspectiveMatrix(new Float64Array(16), Math.PI / 4, 1, 0.01, 200);
    const view = Matrix.lookAt(new Float64Array(16), eye, [0, 0, 0], [0, 1, 0]);
    const inverse = new Float64Array(16);
    mat4Invert(inverse, mat4Multiply(new Float64Array(16), projection, view));
    expect(HorizonEdgeMath.isEdgeWithinReach(HorizonEdgeMath.edge(eye, 1 / radius), 0, inverse, eye)).toBe(true);
    const plane = HorizonEdgeMath.edge(eye, 0);
    expect(HorizonEdgeMath.isEdgeWithinReach(plane, 0.1, inverse, eye)).toBe(false);
    expect(HorizonEdgeMath.isEdgeWithinReach(plane, Math.PI, inverse, eye)).toBe(true);
  });
});
