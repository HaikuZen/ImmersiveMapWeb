// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** Swift's `ClosedRange<Double>`: both bounds included, `lowerBound <= upperBound`. */
export interface ClosedRange {
  readonly lowerBound: number;
  readonly upperBound: number;
}

/** `lowerBound ... upperBound`. Throws on an inverted range, as Swift traps on one. */
export function closedRange(lowerBound: number, upperBound: number): ClosedRange {
  if (!(lowerBound <= upperBound)) {
    throw new RangeError(`Range requires lowerBound <= upperBound: ${lowerBound} ... ${upperBound}`);
  }
  return { lowerBound, upperBound };
}
