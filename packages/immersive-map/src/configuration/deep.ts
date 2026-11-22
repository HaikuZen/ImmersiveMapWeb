// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The plain-data helpers the settings and the style are built with. A
// settings value is a tree of plain objects, arrays, numbers, strings,
// booleans and nulls: it crosses to a Web Worker by structured clone and
// to disk by JSON, so nothing in it is a class instance or a function.

/** A value with every `readonly` taken off, all the way down: the draft an edit writes into. */
export type DeepMutable<T> = T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;

/**
 * The options of a value: every field optional, `undefined` meaning "leave
 * it as configured". The fields named in `CurveKeys` are zoom curves and
 * take either form of one (`ZoomCurveInput`: a number, the same at every
 * zoom, or stops `{ 12: 3000, 16: 400 }`).
 */
export type Options<T, CurveKeys extends keyof T = never> = {
  readonly [K in keyof T]?: (K extends CurveKeys ? number | Readonly<Record<number, number>> : T[K]) | undefined;
};

/**
 * Whether two plain-data values are equal, field by field, the way Swift's
 * synthesized `==` compares them: numbers by `===` (so `0 === -0`, and a
 * NaN equals nothing), objects by their own keys whatever their order.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqual(a[index], b[index])) {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(b)) {
    return false;
  }
  const left = a as Readonly<Record<string, unknown>>;
  const right = b as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!Object.hasOwn(right, key) || !deepEqual(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

/**
 * Freezes a plain-data value and everything in it, and returns it. A part
 * already frozen is taken as frozen through, so a value that shares most
 * of its tree with an earlier one costs only its new parts.
 */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

/**
 * `base` with the fields `options` gives, a field left `undefined` kept as
 * it is. Only `base`'s own fields are taken. The fields named in
 * `transforms` pass through their function first (a curve normalized, a
 * value clamped).
 */
export function mergeOptions<T extends object>(
  base: T,
  options: object | undefined,
  transforms?: Readonly<Partial<Record<keyof T, (value: never) => unknown>>>,
): T {
  if (options === undefined) {
    return base;
  }
  const out = { ...base } as unknown as Record<string, unknown>;
  const table = (transforms ?? {}) as Readonly<Record<string, ((value: unknown) => unknown) | undefined>>;
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || !Object.hasOwn(base, key)) {
      continue;
    }
    const transform = table[key];
    out[key] = transform === undefined ? value : transform(value);
  }
  return out as unknown as T;
}

/** A clamp of `value` to `lower...upper`, as Swift's `min(max(value, lower), upper)`. */
export function clamp(value: number, lower: number, upper: number): number {
  return Math.min(Math.max(value, lower), upper);
}
