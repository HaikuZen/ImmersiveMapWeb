// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { expect, test } from "vitest";
import { StableFNV1aHasher } from "./fnv1a.ts";

// The Swift hasher's seed is 1469598103934665603, one digit short of the
// textbook FNV-1a offset basis (14695981039346656037). The engine has always
// named its caches and label keys with it, so the port keeps it.
const seed = 1469598103934665603n;
const prime = 1099511628211n;
const mask = (1n << 64n) - 1n;

test("the hasher is FNV-1a over UTF-8 bytes with the Swift engine's seed", () => {
  expect(new StableFNV1aHasher().combineString("").finalize()).toBe(seed);
  expect(new StableFNV1aHasher().combineString("a").finalize()).toBe(((seed ^ 97n) * prime) & mask);
  let expected = seed;
  for (const byte of new TextEncoder().encode("ё/1")) expected = ((expected ^ BigInt(byte)) * prime) & mask;
  expect(new StableFNV1aHasher().combineString("ё/1").finalize()).toBe(expected);
  expect(new StableFNV1aHasher().combine(2n ** 64n + 5n).finalize()).toBe(((seed ^ 5n) * prime) & mask);
});
