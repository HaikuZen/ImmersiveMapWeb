// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `DebugOverlayZoomCurveEditingTests`
// (DebugOverlayShadowGroupTests.swift), with the graph's pointer handling.

import { describe, expect, test } from "vitest";
import { closedRange } from "../../math/closed-range.ts";
import { zoomCurve } from "../../configuration/zoom-curve.ts";
import { DebugOverlayZoomCurveAxes as Axes, DebugOverlayZoomCurveEditing as Editing, DebugOverlayZoomCurveGraph as Graph } from "./debug-overlay-zoom-curve-editing.ts";

const rect = { x: 0, y: 0, width: 220, height: 100 };
const axes = Axes.of(closedRange(0, 22), closedRange(0, 1));

describe("DebugOverlayZoomCurveAxes", () => {
  /** Zoom runs left to right, the value bottom to top, and a point maps back onto the half zoom grid and the hundredths. */
  test("the axes round-trip on the grid", () => {
    expect(Axes.x(axes, 11, rect)).toBe(110);
    expect(Axes.y(axes, 0, rect)).toBe(100);
    expect(Axes.y(axes, 1, rect)).toBe(0);
    expect(Axes.zoom(axes, 112, rect)).toBe(11);
    expect(Axes.zoom(axes, 116, rect)).toBe(11.5);
    expect(Axes.zoom(axes, -40, rect)).toBe(0);
    expect(Axes.value(axes, 25.3, rect)).toBeCloseTo(0.75, 9);
    expect(Axes.value(axes, 400, rect)).toBe(0);
  });

  test("a logarithmic axis spaces the decades evenly and keeps two digits", () => {
    const log = Axes.of(closedRange(0, 22), closedRange(0.01, 1), { isLogarithmic: true });
    expect(Axes.y(log, 0.1, rect)).toBeCloseTo(50, 6);
    expect(Axes.value(log, 50, rect)).toBeCloseTo(0.1, 9);
    const metres = Axes.of(closedRange(0, 22), closedRange(10, 2_000_000), { isLogarithmic: true });
    const value = Axes.value(metres, 42, rect);
    expect(Number(value.toPrecision(2))).toBeCloseTo(value, 6);
  });
});

describe("DebugOverlayZoomCurveEditing", () => {
  const curve = zoomCurve({ 11: 0.5, 13: 1 });

  test("a stop is found near the pointer", () => {
    expect(Editing.stopIndex({ x: 112, y: 52 }, curve, axes, rect, 8)).toBe(0);
    expect(Editing.stopIndex({ x: 60, y: 50 }, curve, axes, rect, 8)).toBeUndefined();
  });

  /** A click adds a stop, or sets the value of the stop already at that zoom. */
  test("setting a stop adds or replaces", () => {
    const added = Editing.settingStop(curve, 12, 0.2);
    expect(added.curve).toEqual(zoomCurve({ 11: 0.5, 12: 0.2, 13: 1 }));
    expect(added.index).toBe(1);
    expect(Editing.settingStop(curve, 13, 0.3).curve).toEqual(zoomCurve({ 11: 0.5, 13: 0.3 }));
  });

  /** A dragged stop moves, its index following it. Dropped onto another stop's zoom it keeps its own zoom and takes only the value. */
  test("moving a stop never swallows a neighbour", () => {
    const moved = Editing.movingStop(curve, 0, 14, 0.4);
    expect(moved.curve).toEqual(zoomCurve({ 13: 1, 14: 0.4 }));
    expect(moved.index).toBe(1);
    expect(Editing.movingStop(curve, 0, 13, 0.4).curve).toEqual(zoomCurve({ 11: 0.4, 13: 1 }));
  });

  test("the last stop stays", () => {
    expect(Editing.removingStop(curve, 0)).toEqual(zoomCurve({ 13: 1 }));
    expect(Editing.removingStop(zoomCurve({ 13: 1 }), 0)).toBeUndefined();
  });
});

describe("DebugOverlayZoomCurveGraph", () => {
  const curve = zoomCurve({ 11: 0.5, 13: 1 });

  test("the plot leaves room for the labels", () => {
    expect(Graph.plotRect({ x: 0, y: 0, width: 258, height: 120 })).toEqual({ x: 30, y: 6, width: 220, height: 100 });
    expect(Graph.gridZooms(axes)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  });

  test("a press on a stop holds it, a double press removes it, a press elsewhere adds one", () => {
    expect(Graph.pressed(curve, axes, rect, { x: 112, y: 52 }, 1)).toEqual({ curve, draggedStop: 0 });
    expect(Graph.pressed(curve, axes, rect, { x: 112, y: 52 }, 2)).toEqual({ curve: zoomCurve({ 13: 1 }), draggedStop: undefined });
    const added = Graph.pressed(curve, axes, rect, { x: 60, y: 80 }, 1);
    expect(added.curve).toEqual(zoomCurve({ 6: 0.2, 11: 0.5, 13: 1 }));
    expect(added.draggedStop).toBe(0);
    expect(Graph.pressed(curve, axes, rect, { x: 60, y: 80 }, 1, false)).toEqual({ curve, draggedStop: undefined });
  });

  test("a drag moves the held stop, and a secondary press removes the stop under it", () => {
    expect(Graph.dragged(curve, axes, rect, { x: 160, y: 60 }, 0)).toEqual({ curve: zoomCurve({ 13: 1, 16: 0.4 }), draggedStop: 1 });
    expect(Graph.dragged(curve, axes, rect, { x: 160, y: 60 }, undefined)).toEqual({ curve, draggedStop: undefined });
    expect(Graph.secondaryPressed(curve, axes, rect, { x: 130, y: 0 })).toEqual(zoomCurve({ 11: 0.5 }));
    expect(Graph.secondaryPressed(curve, axes, rect, { x: 60, y: 0 })).toBe(curve);
  });

  test("a stop's label names its zoom and value", () => {
    expect(Graph.stopLabel({ zoom: 12, value: 0.25 }, Graph.defaultValueText)).toBe("z12: 0.25");
    expect(Graph.stopLabel({ zoom: 16.5, value: 0.03 }, Graph.defaultValueText)).toBe("z16.5: 0.03");
    expect(Graph.curvePoints(curve, axes, rect)).toHaveLength(221);
    const marker = Graph.cameraMarker(curve, axes, rect, 12);
    expect(marker.x).toBeCloseTo(120, 9);
    expect(marker.y).toBeCloseTo(25, 9);
  });
});
