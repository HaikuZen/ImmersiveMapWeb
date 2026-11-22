// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ClosedRange } from "../../math/closed-range.ts";
import { zoomCurve, zoomCurveStops, zoomCurveValue } from "../../configuration/zoom-curve.ts";
import type { ImmersiveMapZoomCurve, ZoomCurveInterpolation, ZoomCurveStop } from "../../configuration/zoom-curve.ts";
import type { DebugOverlayPoint, DebugOverlayRect } from "./debug-overlay-geometry.ts";
import { clampTo, formatFixed, formatG, rectMaxX, rectMaxY, swiftRounded } from "./debug-overlay-geometry.ts";

/**
 * The axes of the panel's zoom curve graph (the Swift
 * `DebugOverlayZoomCurveAxes`): the zoom across, the value up.
 *
 * A stop's zoom lies on a half zoom grid and its value is rounded to a
 * hundredth, so a curve tuned by hand reads cleanly when it is copied into
 * code. Two stops never share a zoom: a curve does not jump.
 */
export interface DebugOverlayZoomCurveAxes {
  /** The zooms across the graph. */
  readonly zoomRange: ClosedRange;
  /** The values up the graph. */
  readonly valueRange: ClosedRange;
  /**
   * A value axis in decades rather than in equal steps, for a value that
   * matters by its ratio (a height from a film to a wall). The range's lower
   * bound must then be above zero.
   */
  readonly isLogarithmic: boolean;
  /** How the curve runs between its stops, as the setting it edits reads it, so the graph draws the curve the map follows. */
  readonly interpolation: ZoomCurveInterpolation;
}

function fraction(value: number, range: ClosedRange): number {
  const span = range.upperBound - range.lowerBound;
  if (!(span > 0)) return 0;
  return clampTo((value - range.lowerBound) / span, 0, 1);
}

function valueFraction(axes: DebugOverlayZoomCurveAxes, value: number): number {
  if (!axes.isLogarithmic) return fraction(value, axes.valueRange);
  const low = Math.log10(axes.valueRange.lowerBound);
  const high = Math.log10(axes.valueRange.upperBound);
  return clampTo((Math.log10(Math.max(value, axes.valueRange.lowerBound)) - low) / (high - low), 0, 1);
}

export const DebugOverlayZoomCurveAxes = {
  /** The zoom grid a stop is placed on. */
  zoomStep: 0.5,
  /** The rounding of a stop's value on an axis of equal steps. A logarithmic axis keeps two significant digits instead: 1200 m, 0.45 per kilometre. */
  valueStep: 0.01,

  /** Axes of the given ranges, linear and smooth unless the options say otherwise. */
  of(
    zoomRange: ClosedRange,
    valueRange: ClosedRange,
    options: { readonly isLogarithmic?: boolean; readonly interpolation?: ZoomCurveInterpolation } = {},
  ): DebugOverlayZoomCurveAxes {
    return Object.freeze({
      zoomRange,
      valueRange,
      isLogarithmic: options.isLogarithmic ?? false,
      interpolation: options.interpolation ?? "smooth",
    });
  },

  /** Where a zoom lies across a rectangle, left to right. */
  x(axes: DebugOverlayZoomCurveAxes, zoom: number, rect: DebugOverlayRect): number {
    return rect.x + rect.width * fraction(zoom, axes.zoomRange);
  },

  /** Where a value lies up a rectangle whose y grows downward. */
  y(axes: DebugOverlayZoomCurveAxes, value: number, rect: DebugOverlayRect): number {
    return rectMaxY(rect) - rect.height * valueFraction(axes, value);
  },

  /** The zoom at a point across a rectangle, on the grid, inside the range. */
  zoom(axes: DebugOverlayZoomCurveAxes, x: number, rect: DebugOverlayRect): number {
    const share = rect.width > 0 ? (x - rect.x) / rect.width : 0;
    const zoom = axes.zoomRange.lowerBound + share * (axes.zoomRange.upperBound - axes.zoomRange.lowerBound);
    const step = DebugOverlayZoomCurveAxes.zoomStep;
    const snapped = swiftRounded(zoom / step) * step;
    return clampTo(snapped, axes.zoomRange.lowerBound, axes.zoomRange.upperBound);
  },

  /** The value at a point up a rectangle, rounded, inside the range. */
  value(axes: DebugOverlayZoomCurveAxes, y: number, rect: DebugOverlayRect): number {
    const share = rect.height > 0 ? (rectMaxY(rect) - y) / rect.height : 0;
    const clamped = clampTo(share, 0, 1);
    const range = axes.valueRange;
    let value: number;
    if (axes.isLogarithmic) {
      const low = Math.log10(range.lowerBound);
      const high = Math.log10(range.upperBound);
      value = Math.pow(10, low + clamped * (high - low));
    } else {
      value = range.lowerBound + clamped * (range.upperBound - range.lowerBound);
    }
    let rounded: number;
    if (axes.isLogarithmic && value > 0) {
      const magnitude = Math.pow(10, Math.floor(Math.log10(value)) - 1);
      rounded = swiftRounded(value / magnitude) * magnitude;
    } else {
      const step = DebugOverlayZoomCurveAxes.valueStep;
      rounded = swiftRounded(value / step) * step;
    }
    return clampTo(rounded, range.lowerBound, range.upperBound);
  },

  /** The curve's value at a zoom, read as the axes read it. */
  curveValue(axes: DebugOverlayZoomCurveAxes, curve: ImmersiveMapZoomCurve, zoom: number): number {
    return zoomCurveValue(curve, zoom, axes.interpolation);
  },
} as const;

/** A curve after an edit, and the index of the stop the edit placed or moved. */
export interface DebugOverlayZoomCurveEdit {
  readonly curve: ImmersiveMapZoomCurve;
  readonly index: number;
}

/** A curve after a pointer went down or moved on the graph, and the stop the drag now holds, `undefined` for none. */
export interface DebugOverlayZoomCurveDrag {
  readonly curve: ImmersiveMapZoomCurve;
  readonly draggedStop: number | undefined;
}

function curveOf(stops: readonly ZoomCurveStop[]): ImmersiveMapZoomCurve {
  const record: Record<number, number> = {};
  for (const stop of stops) record[stop.zoom] = stop.value;
  return zoomCurve(record);
}

function indexOfZoom(curve: ImmersiveMapZoomCurve, zoom: number): number {
  return zoomCurveStops(curve).findIndex((stop) => stop.zoom === zoom);
}

/** The edits a pointer makes to a curve on the graph (the Swift `DebugOverlayZoomCurveEditing`). */
export const DebugOverlayZoomCurveEditing = {
  /** The stop under a point, if one lies within `radius` of it: the nearest, so two close stops are still told apart. */
  stopIndex(
    point: DebugOverlayPoint,
    curve: ImmersiveMapZoomCurve,
    axes: DebugOverlayZoomCurveAxes,
    rect: DebugOverlayRect,
    radius: number,
  ): number | undefined {
    let nearest: number | undefined;
    let nearestDistance = Infinity;
    zoomCurveStops(curve).forEach((stop, index) => {
      const dx = DebugOverlayZoomCurveAxes.x(axes, stop.zoom, rect) - point.x;
      const dy = DebugOverlayZoomCurveAxes.y(axes, stop.value, rect) - point.y;
      const distance = Math.hypot(dx, dy);
      if (distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    });
    return nearest !== undefined && nearestDistance <= radius ? nearest : undefined;
  },

  /** The curve with a stop at a zoom: the stop there takes the value, or a new one is added. The index is the stop's in the new curve. */
  settingStop(curve: ImmersiveMapZoomCurve, zoom: number, value: number): DebugOverlayZoomCurveEdit {
    const others = zoomCurveStops(curve).filter((stop) => stop.zoom !== zoom);
    const edited = curveOf([...others, { zoom, value }]);
    return { curve: edited, index: Math.max(indexOfZoom(edited, zoom), 0) };
  },

  /**
   * The curve with one stop moved. A stop dragged onto another's zoom keeps
   * its own zoom and takes only the value, so the drag never swallows a
   * neighbour. The index is the moved stop's in the new curve.
   */
  movingStop(curve: ImmersiveMapZoomCurve, index: number, zoom: number, value: number): DebugOverlayZoomCurveEdit {
    const stops = zoomCurveStops(curve);
    const own = stops[index];
    if (own === undefined) {
      return { curve, index };
    }
    const taken = stops.some((stop, other) => other !== index && stop.zoom === zoom);
    const newZoom = taken ? own.zoom : zoom;
    const moved = stops.map((stop, other) => (other === index ? { zoom: newZoom, value } : stop));
    const edited = curveOf(moved);
    const newIndex = indexOfZoom(edited, newZoom);
    return { curve: edited, index: newIndex < 0 ? index : newIndex };
  },

  /** The curve without one stop, or `undefined` for the last stop: a curve keeps at least one. */
  removingStop(curve: ImmersiveMapZoomCurve, index: number): ImmersiveMapZoomCurve | undefined {
    const stops = zoomCurveStops(curve);
    if (stops.length <= 1 || index < 0 || index >= stops.length) {
      return undefined;
    }
    return curveOf(stops.filter((_, other) => other !== index));
  },
} as const;

/**
 * The graph a zoom curve is edited on (the platform-neutral part of the
 * Swift `DebugOverlayZoomCurveView`): where its plot lies in the view, what
 * it draws and labels, and what a pointer does on it. A press on a stop
 * holds it for a drag and a double press removes it, a press elsewhere puts
 * a stop there and holds it, a drag moves the held stop, and a secondary
 * press on a stop removes it. Every change goes out at once, so the map
 * follows the drag.
 */
export const DebugOverlayZoomCurveGraph = {
  /** Room under the plot for the zoom labels. */
  bottomInset: 14,
  /** Room left of the plot for the value labels. */
  leftInset: 30,
  topInset: 6,
  rightInset: 8,
  stopRadius: 4,
  /** A hovered or dragged stop is drawn this much larger. */
  activeStopGrowth: 1.5,
  /** How near a pointer must come to a stop to take it. */
  hitRadius: 8,
  /** A zoom label every this many zoom levels. */
  zoomLabelStep: 2,
  /** How faint the graph is drawn while its setting is off. */
  disabledAlpha: 0.4,

  /** The plot inside a view of `bounds`. */
  plotRect(bounds: DebugOverlayRect): DebugOverlayRect {
    const graph = DebugOverlayZoomCurveGraph;
    return {
      x: bounds.x + graph.leftInset,
      y: bounds.y + graph.topInset,
      width: Math.max(0, bounds.width - graph.leftInset - graph.rightInset),
      height: Math.max(0, bounds.height - graph.topInset - graph.bottomInset),
    };
  },

  /** How a value is printed when the graph is given no text of its own: `%g`. */
  defaultValueText(value: number): string {
    return formatG(value);
  },

  /** The zooms the vertical grid lines and their labels stand at: every `zoomLabelStep` across the axes' range. */
  gridZooms(axes: DebugOverlayZoomCurveAxes): number[] {
    const step = DebugOverlayZoomCurveGraph.zoomLabelStep;
    const zooms: number[] = [];
    for (let zoom = Math.ceil(axes.zoomRange.lowerBound / step) * step; zoom <= axes.zoomRange.upperBound; zoom += step) {
      zooms.push(zoom);
    }
    return zooms;
  },

  /** A grid zoom's label: the whole zoom. */
  gridZoomLabel(zoom: number): string {
    return formatFixed(zoom, 0);
  },

  /** The curve as a polyline across the plot, one point per pixel, as the map reads it between the stops. */
  curvePoints(curve: ImmersiveMapZoomCurve, axes: DebugOverlayZoomCurveAxes, plot: DebugOverlayRect): DebugOverlayPoint[] {
    if (!(plot.width > 1)) return [];
    const points: DebugOverlayPoint[] = [];
    const span = axes.zoomRange.upperBound - axes.zoomRange.lowerBound;
    for (let x = plot.x; x <= rectMaxX(plot); x += 1) {
      const zoom = axes.zoomRange.lowerBound + ((x - plot.x) / plot.width) * span;
      points.push({ x, y: DebugOverlayZoomCurveAxes.y(axes, zoomCurveValue(curve, zoom, axes.interpolation), plot) });
    }
    return points;
  },

  /** The camera's zoom on the plot: the dashed line's x, and the curve's point on it. */
  cameraMarker(curve: ImmersiveMapZoomCurve, axes: DebugOverlayZoomCurveAxes, plot: DebugOverlayRect, cameraZoom: number): DebugOverlayPoint {
    const value = zoomCurveValue(curve, cameraZoom, axes.interpolation);
    return { x: DebugOverlayZoomCurveAxes.x(axes, cameraZoom, plot), y: DebugOverlayZoomCurveAxes.y(axes, value, plot) };
  },

  /** Every stop's centre on the plot, in the curve's order. */
  stopPoints(curve: ImmersiveMapZoomCurve, axes: DebugOverlayZoomCurveAxes, plot: DebugOverlayRect): DebugOverlayPoint[] {
    return zoomCurveStops(curve).map((stop) => ({
      x: DebugOverlayZoomCurveAxes.x(axes, stop.zoom, plot),
      y: DebugOverlayZoomCurveAxes.y(axes, stop.value, plot),
    }));
  },

  /** The label of a hovered or dragged stop: its zoom, whole or to a tenth, and its value as the graph prints it. */
  stopLabel(stop: ZoomCurveStop, valueText: (value: number) => string): string {
    const zoom = stop.zoom === swiftRounded(stop.zoom) ? formatFixed(stop.zoom, 0) : formatFixed(stop.zoom, 1);
    return `z${zoom}: ${valueText(stop.value)}`;
  },

  /** The stop label's top left corner, 8 pixels right of the stop and above it, kept inside the plot. */
  stopLabelOrigin(stopCentre: DebugOverlayPoint, labelWidth: number, labelHeight: number, plot: DebugOverlayRect): DebugOverlayPoint {
    return {
      x: Math.min(stopCentre.x + 8, rectMaxX(plot) - labelWidth),
      y: Math.max(stopCentre.y - labelHeight - 4, plot.y),
    };
  },

  /**
   * A primary press at `point` of the plot: on a stop it holds the stop for
   * a drag, or removes it on a double press (`clickCount` 2 or more), and
   * elsewhere it puts a stop there and holds it. A disabled graph changes
   * nothing.
   */
  pressed(
    curve: ImmersiveMapZoomCurve,
    axes: DebugOverlayZoomCurveAxes,
    plot: DebugOverlayRect,
    point: DebugOverlayPoint,
    clickCount: number,
    isEnabled = true,
  ): DebugOverlayZoomCurveDrag {
    if (!isEnabled) return { curve, draggedStop: undefined };
    const hit = DebugOverlayZoomCurveEditing.stopIndex(point, curve, axes, plot, DebugOverlayZoomCurveGraph.hitRadius);
    if (hit !== undefined) {
      if (clickCount >= 2) {
        return { curve: DebugOverlayZoomCurveEditing.removingStop(curve, hit) ?? curve, draggedStop: undefined };
      }
      return { curve, draggedStop: hit };
    }
    const edit = DebugOverlayZoomCurveEditing.settingStop(
      curve,
      DebugOverlayZoomCurveAxes.zoom(axes, point.x, plot),
      DebugOverlayZoomCurveAxes.value(axes, point.y, plot),
    );
    return { curve: edit.curve, draggedStop: edit.index };
  },

  /** The held stop dragged to `point` of the plot. Without a held stop, or on a disabled graph, nothing changes. */
  dragged(
    curve: ImmersiveMapZoomCurve,
    axes: DebugOverlayZoomCurveAxes,
    plot: DebugOverlayRect,
    point: DebugOverlayPoint,
    draggedStop: number | undefined,
    isEnabled = true,
  ): DebugOverlayZoomCurveDrag {
    if (!isEnabled || draggedStop === undefined) return { curve, draggedStop };
    const edit = DebugOverlayZoomCurveEditing.movingStop(
      curve,
      draggedStop,
      DebugOverlayZoomCurveAxes.zoom(axes, point.x, plot),
      DebugOverlayZoomCurveAxes.value(axes, point.y, plot),
    );
    return { curve: edit.curve, draggedStop: edit.index };
  },

  /** A secondary press at `point`: the stop under it removed, the curve as it is when no stop is there or it is the last. */
  secondaryPressed(
    curve: ImmersiveMapZoomCurve,
    axes: DebugOverlayZoomCurveAxes,
    plot: DebugOverlayRect,
    point: DebugOverlayPoint,
    isEnabled = true,
  ): ImmersiveMapZoomCurve {
    if (!isEnabled) return curve;
    const hit = DebugOverlayZoomCurveEditing.stopIndex(point, curve, axes, plot, DebugOverlayZoomCurveGraph.hitRadius);
    return hit === undefined ? curve : (DebugOverlayZoomCurveEditing.removingStop(curve, hit) ?? curve);
  },
} as const;
