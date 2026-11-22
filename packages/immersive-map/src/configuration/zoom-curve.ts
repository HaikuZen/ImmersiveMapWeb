// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A value that follows the camera zoom: stops of a value at a zoom, and a
 * smooth blend between neighbouring stops, as `{ zoom: value }`. Below the
 * first stop the value is the first stop's, above the last the last's. A
 * single value is a curve with one stop (at zoom 0), the same at every
 * zoom.
 *
 * Between two stops the value runs on a smoothstep of the zoom, the curve
 * `ImmersiveMapZoomFade` runs on, so it starts and arrives at rest: a zoom
 * gesture crossing a stop sees no kink, and a setting reached at a stop
 * holds there instead of overshooting it. Evaluated against the camera zoom
 * each frame, so a zoom gesture plays the change.
 *
 * Every setting that takes a curve takes either form (`ZoomCurveInput`):
 *
 * ```ts
 * settings.shadows({ strength: 0.3 });
 * settings.groundFog({ heightMeters: { 13: 400, 14: 100, 15: 15 } });
 * ```
 *
 * and stores the stops form, its keys the zooms written canonically
 * (`"15.5"`), so two curves of the same stops are equal field by field.
 */
export type ImmersiveMapZoomCurve = Readonly<Record<number, number>>;

/** Either form of a curve: one value at every zoom, or stops by zoom in any order. */
export type ZoomCurveInput = number | ImmersiveMapZoomCurve;

/** One stop of a curve. */
export interface ZoomCurveStop {
  readonly zoom: number;
  readonly value: number;
}

/**
 * How a curve runs between two stops. `smooth` is a smoothstep of the zoom
 * from one value to the next: it starts and arrives at rest. `geometric` is
 * the same ratio for every step of zoom, the way the map's scale changes
 * (twice per zoom level): for a length on the ground, so two stops a few
 * zooms apart follow the map in between. It falls back to `smooth` where a
 * stop is not above zero.
 */
export type ZoomCurveInterpolation = "smooth" | "geometric";

/**
 * The curve of either form. A number is one stop at zoom 0. Stops need at
 * least one entry and finite zooms, and since an object holds a key once,
 * two stops never lie at one zoom (which would be a jump the curve does not
 * make). Throws a `RangeError` otherwise, as the Swift curve traps.
 */
export function zoomCurve(input: ZoomCurveInput): ImmersiveMapZoomCurve {
  if (typeof input === "number") {
    return Object.freeze({ 0: input });
  }
  const out: Record<number, number> = {};
  let count = 0;
  for (const [key, value] of Object.entries(input)) {
    const zoom = Number(key);
    if (!Number.isFinite(zoom)) {
      throw new RangeError(`A zoom curve's stops lie at finite zooms, got "${key}"`);
    }
    if (typeof value !== "number") {
      throw new RangeError(`A zoom curve's stop at zoom ${key} is not a number`);
    }
    out[zoom] = value;
    count += 1;
  }
  if (count === 0) {
    throw new RangeError("A zoom curve needs at least one stop");
  }
  return Object.freeze(out);
}

/** The stops of a curve, in increasing zoom. */
export function zoomCurveStops(curve: ImmersiveMapZoomCurve): ZoomCurveStop[] {
  return Object.entries(curve)
    .map(([key, value]) => ({ zoom: Number(key), value }))
    .sort((a, b) => a.zoom - b.zoom);
}

/** The value of a curve at a camera zoom. An empty curve is 0. */
export function zoomCurveValue(
  curve: ImmersiveMapZoomCurve,
  zoom: number,
  interpolation: ZoomCurveInterpolation = "smooth",
): number {
  const stops = zoomCurveStops(curve);
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (first === undefined || last === undefined) {
    return 0;
  }
  if (zoom <= first.zoom) {
    return first.value;
  }
  if (zoom >= last.zoom) {
    return last.value;
  }
  // The segment the zoom lies in: the first stop past it and the one
  // before. A curve holds a handful of stops, so a linear scan.
  let upper = stops.findIndex((stop) => stop.zoom > zoom);
  if (upper < 1) {
    upper = stops.length - 1;
  }
  const from = stops[upper - 1];
  const to = stops[upper];
  if (from === undefined || to === undefined) {
    return last.value;
  }
  const t = Math.min(Math.max((zoom - from.zoom) / (to.zoom - from.zoom), 0), 1);
  if (interpolation === "geometric" && from.value > 0 && to.value > 0) {
    return from.value * Math.pow(to.value / from.value, t);
  }
  const eased = t * t * (3 - 2 * t);
  return from.value + (to.value - from.value) * eased;
}

/** The value, when the curve is the same at every zoom (one stop), and null otherwise. */
export function zoomCurveConstantValue(curve: ImmersiveMapZoomCurve): number | null {
  const stops = zoomCurveStops(curve);
  return stops.length === 1 && stops[0] !== undefined ? stops[0].value : null;
}

/** The curve with `change` applied to the value of every stop. */
export function mapZoomCurve(curve: ImmersiveMapZoomCurve, change: (value: number) => number): ImmersiveMapZoomCurve {
  const out: Record<number, number> = {};
  for (const stop of zoomCurveStops(curve)) {
    out[stop.zoom] = change(stop.value);
  }
  return Object.freeze(out);
}
