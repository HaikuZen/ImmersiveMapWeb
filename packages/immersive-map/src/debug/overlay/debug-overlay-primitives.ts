// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgb, Rgba } from "../../configuration/color.ts";

/**
 * What the debug overlay draws, in the overlay canvas's own space: drawable
 * pixels with the origin at the top left and y down, the canvas laid over
 * the map canvas at the same pixel size. The planners flip the projector's
 * bottom-left y up into it.
 */
export type DebugOverlayPrimitive = DebugOverlayPolyline | DebugOverlayPolygon | DebugOverlayText;

/** A stroked line through `points` (x, y pairs), closed back to its first point when `closed`. */
export interface DebugOverlayPolyline {
  readonly kind: "polyline";
  readonly points: readonly number[];
  readonly closed: boolean;
  readonly color: Rgba;
  /** Drawable pixels. */
  readonly width: number;
}

/** A filled polygon through `points` (x, y pairs). */
export interface DebugOverlayPolygon {
  readonly kind: "polygon";
  readonly points: readonly number[];
  readonly color: Rgba;
}

/**
 * A run of text, outlined then filled. `x` and `y` are where its baseline
 * starts (`align` left) or centres (`align` center). Without `transform`
 * they are canvas pixels and `fontSize` and `strokeWidth` drawable pixels.
 * With it, text laid into the tile plane: the canvas matrix
 * `[a, b, c, d, e, f]` (`setTransform`) takes the run's own text pixels,
 * in which `x`, `y`, `fontSize` and `strokeWidth` are given, onto the
 * canvas.
 */
export interface DebugOverlayText {
  readonly kind: "text";
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  readonly align: "left" | "center";
  readonly color: Rgb;
  readonly strokeColor: Rgb;
  /** The outline's width outside the glyphs. */
  readonly strokeWidth: number;
  readonly transform?: readonly [number, number, number, number, number, number] | undefined;
}

/** A run of text measured at a font size, in the font's pixels: its advance width and its ink above and below the baseline. */
export interface DebugTextMeasure {
  readonly width: number;
  readonly ascent: number;
  readonly descent: number;
}

/** Measures runs of the overlay's font (`debugOverlayFont`). */
export interface DebugOverlayTextMeasurer {
  measure(text: string, fontSize: number): DebugTextMeasure;
}

/** The overlay's font family: bold, as the Swift overlay's atlas font. */
export const debugOverlayFontFamily = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** The CSS font of the overlay's text at `fontSize` pixels. */
export function debugOverlayFont(fontSize: number): string {
  return `bold ${fontSize}px ${debugOverlayFontFamily}`;
}

const measureCacheLimit = 4096;

/**
 * A measurer over a 2D context, caching each run by its size: the overlay
 * measures the same tile addresses frame after frame. The cache starts over
 * once it holds `measureCacheLimit` runs.
 */
export function canvasTextMeasurer(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D): DebugOverlayTextMeasurer {
  const cache = new Map<string, DebugTextMeasure>();
  return {
    measure(text: string, fontSize: number): DebugTextMeasure {
      const key = `${fontSize}|${text}`;
      const known = cache.get(key);
      if (known !== undefined) return known;
      context.font = debugOverlayFont(fontSize);
      const metrics = context.measureText(text);
      const measure = { width: metrics.width, ascent: metrics.actualBoundingBoxAscent, descent: metrics.actualBoundingBoxDescent };
      if (cache.size >= measureCacheLimit) cache.clear();
      cache.set(key, measure);
      return measure;
    },
  };
}

function cssColor(color: Rgb | Rgba): string {
  const r = Math.round(Math.min(Math.max(color[0], 0), 1) * 255);
  const g = Math.round(Math.min(Math.max(color[1], 0), 1) * 255);
  const b = Math.round(Math.min(Math.max(color[2], 0), 1) * 255);
  const a = color.length > 3 ? (color as Rgba)[3] : 1;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function tracePoints(context: CanvasRenderingContext2D, points: readonly number[]): void {
  context.beginPath();
  context.moveTo(points[0]!, points[1]!);
  for (let index = 2; index + 1 < points.length; index += 2) context.lineTo(points[index]!, points[index + 1]!);
}

/**
 * Paints the overlay's primitives into a 2D canvas of the map's drawable
 * size, in order: what comes later lies on what came before. The caller
 * clears the canvas first. A transformed text run's matrix replaces the
 * context's for that run, so the context draws untransformed otherwise.
 */
export function drawDebugOverlay(context: CanvasRenderingContext2D, primitives: readonly DebugOverlayPrimitive[]): void {
  context.save();
  context.lineCap = "butt";
  context.lineJoin = "miter";
  for (const primitive of primitives) {
    switch (primitive.kind) {
      case "polyline": {
        if (primitive.points.length < 4) break;
        tracePoints(context, primitive.points);
        if (primitive.closed) context.closePath();
        context.strokeStyle = cssColor(primitive.color);
        context.lineWidth = primitive.width;
        context.stroke();
        break;
      }
      case "polygon": {
        if (primitive.points.length < 6) break;
        tracePoints(context, primitive.points);
        context.closePath();
        context.fillStyle = cssColor(primitive.color);
        context.fill();
        break;
      }
      case "text": {
        const transform = primitive.transform;
        if (transform !== undefined) {
          context.save();
          context.setTransform(transform[0], transform[1], transform[2], transform[3], transform[4], transform[5]);
        }
        context.font = debugOverlayFont(primitive.fontSize);
        context.textAlign = primitive.align;
        context.textBaseline = "alphabetic";
        if (primitive.strokeWidth > 0) {
          // A stroke is centred on the outline, so twice the width leaves the width outside it.
          context.lineWidth = primitive.strokeWidth * 2;
          context.strokeStyle = cssColor(primitive.strokeColor);
          context.lineJoin = "round";
          context.strokeText(primitive.text, primitive.x, primitive.y);
          context.lineJoin = "miter";
        }
        context.fillStyle = cssColor(primitive.color);
        context.fillText(primitive.text, primitive.x, primitive.y);
        if (transform !== undefined) context.restore();
        break;
      }
    }
  }
  context.restore();
}
