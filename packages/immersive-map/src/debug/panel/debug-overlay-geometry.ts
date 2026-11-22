// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The plain geometry and number formatting the debug panel's logic shares:
// rectangles and points in CSS pixels with y growing downward, as the DOM
// lays them out, and the few `String(format:)` forms the Swift panel prints
// its values with.

/** A point in CSS pixels, y growing downward unless a function says otherwise. */
export interface DebugOverlayPoint {
  readonly x: number;
  readonly y: number;
}

/** A size in CSS pixels. */
export interface DebugOverlaySize {
  readonly width: number;
  readonly height: number;
}

/** A rectangle in CSS pixels from its top left corner, y growing downward (Swift's flipped `CGRect`). */
export interface DebugOverlayRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The rectangle of the given origin and size. */
export function debugOverlayRect(x: number, y: number, width: number, height: number): DebugOverlayRect {
  return { x, y, width, height };
}

export function rectMaxX(rect: DebugOverlayRect): number {
  return rect.x + rect.width;
}

export function rectMaxY(rect: DebugOverlayRect): number {
  return rect.y + rect.height;
}

export function rectMidX(rect: DebugOverlayRect): number {
  return rect.x + rect.width / 2;
}

export function rectMidY(rect: DebugOverlayRect): number {
  return rect.y + rect.height / 2;
}

/**
 * The part two rectangles share. Two rectangles that do not overlap share
 * an empty rectangle at the second one's origin, where `CGRect` would
 * answer its null rectangle.
 */
export function rectIntersection(a: DebugOverlayRect, b: DebugOverlayRect): DebugOverlayRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const maxX = Math.min(rectMaxX(a), rectMaxX(b));
  const maxY = Math.min(rectMaxY(a), rectMaxY(b));
  if (maxX < x || maxY < y) {
    return { x: b.x, y: b.y, width: 0, height: 0 };
  }
  return { x, y, width: maxX - x, height: maxY - y };
}

/** A whole number the way Swift's `rounded()` takes it: a half goes away from zero. */
export function swiftRounded(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** `value` to `lower...upper`, as Swift's `min(max(value, lower), upper)`. */
export function clampTo(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper);
}

/** `String(format: "%.<digits>f", value)`. */
export function formatFixed(value: number, digits: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  return value.toFixed(digits);
}

/** `String(format: "%g", value)`: six significant digits, trailing zeros dropped, an exponent outside 1e-4 to 1e6. */
export function formatG(value: number): string {
  const precision = 6;
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const exponential = value.toExponential(precision - 1);
  const [mantissa = "0", exponentText = "0"] = exponential.split("e");
  const exponent = Number(exponentText);
  if (exponent < -4 || exponent >= precision) {
    const digits = withoutTrailingZeros(mantissa);
    const sign = exponent < 0 ? "-" : "+";
    return `${digits}e${sign}${String(Math.abs(exponent)).padStart(2, "0")}`;
  }
  return withoutTrailingZeros(value.toFixed(precision - 1 - exponent));
}

function withoutTrailingZeros(text: string): string {
  if (!text.includes(".")) return text;
  let trimmed = text;
  while (trimmed.endsWith("0")) trimmed = trimmed.slice(0, -1);
  if (trimmed.endsWith(".")) trimmed = trimmed.slice(0, -1);
  return trimmed;
}

/**
 * How a graph's value reads in a title or on a stop's label, shared by the
 * planners whose curves are lengths (the Swift `DebugOverlayValueText`).
 */
export const DebugOverlayValueText = {
  /** A length as it reads best: whole metres under a kilometre, kilometres with one decimal from there, a ".0" dropped. */
  meters(meters: number): string {
    if (meters < 1000) {
      return `${formatFixed(meters, 0)} m`;
    }
    const kilometers = formatFixed(meters / 1000, 1);
    return `${kilometers.endsWith(".0") ? kilometers.slice(0, -2) : kilometers} km`;
  },
} as const;
