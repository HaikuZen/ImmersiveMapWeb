// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The 64-bit FNV-1a hash the Swift engine names caches by
 * (`StableFNV1aHasher`): stable across runs and platforms, so a namespace
 * computed here matches the one computed there for the same inputs.
 */
export class StableFNV1aHasher {
  private static readonly prime = 1099511628211n;
  private static readonly mask = (1n << 64n) - 1n;
  private hash = 1469598103934665603n;

  combine(value: bigint | number): this {
    this.hash ^= BigInt(value) & StableFNV1aHasher.mask;
    this.hash = (this.hash * StableFNV1aHasher.prime) & StableFNV1aHasher.mask;
    return this;
  }

  combineString(text: string): this {
    for (const byte of new TextEncoder().encode(text)) this.combine(byte);
    return this;
  }

  finalize(): bigint {
    return this.hash;
  }
}
