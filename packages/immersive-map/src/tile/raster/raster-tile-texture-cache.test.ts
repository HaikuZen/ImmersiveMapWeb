// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { RasterTextureCache } from "./raster-tile-texture-cache.ts";

interface FakeTexture {
  readonly id: number;
  readonly size: number;
  disposed: boolean;
}

function makeCache() {
  let next = 0;
  const made: FakeTexture[] = [];
  const cache = new RasterTextureCache<object, FakeTexture>(
    (size) => {
      const texture = { id: next++, size, disposed: false };
      made.push(texture);
      return texture;
    },
    (texture) => {
      texture.disposed = true;
    },
  );
  return { cache, made };
}

describe("RasterTextureCache", () => {
  const tileA = {};
  const tileB = {};

  test("a texture is drawn once, and again only when what it shows changes", () => {
    const { cache } = makeCache();
    const request = { key: "a", resident: tileA, size: 64, signature: 1 };
    const [first] = cache.assign([request]);
    expect(first!.needsBake).toBe(true);
    // Not committed yet: drawn again.
    expect(cache.assign([request])[0]!.needsBake).toBe(true);
    cache.drawn("a", first!.texture, 1);
    const [still] = cache.assign([request]);
    expect(still).toEqual({ texture: first!.texture, needsBake: false });
    expect(cache.assign([{ ...request, signature: 2 }])[0]!.needsBake, "a fade moved").toBe(true);
    cache.drawn("a", first!.texture, 2);
    const [reloaded] = cache.assign([{ ...request, resident: {}, signature: 2 }]);
    expect(reloaded!.needsBake, "a new load of the tile").toBe(true);
    expect(reloaded!.texture).toBe(first!.texture);
  });

  test("another size takes another texture, the old one goes free for the next tile of its size", () => {
    const { cache, made } = makeCache();
    const [small] = cache.assign([{ key: "a", resident: tileA, size: 64, signature: 1 }]);
    const [large] = cache.assign([{ key: "a", resident: tileA, size: 128, signature: 1 }]);
    expect(large!.texture.size).toBe(128);
    expect(large!.needsBake).toBe(true);
    const [reused] = cache.assign([
      { key: "a", resident: tileA, size: 128, signature: 1 },
      { key: "b", resident: tileB, size: 64, signature: 1 },
    ]);
    expect(reused!.texture).toBe(large!.texture);
    expect(cache.assign([{ key: "b", resident: tileB, size: 64, signature: 1 }])[0]!.texture).toBe(small!.texture);
    expect(made).toHaveLength(2);
  });

  test("a commit for a texture the tile no longer holds records nothing", () => {
    const { cache } = makeCache();
    const [first] = cache.assign([{ key: "a", resident: tileA, size: 64, signature: 1 }]);
    cache.assign([{ key: "a", resident: tileA, size: 128, signature: 1 }]);
    cache.drawn("a", first!.texture, 1);
    expect(cache.assign([{ key: "a", resident: tileA, size: 128, signature: 1 }])[0]!.needsBake).toBe(true);
  });

  test("a size keeps at most its slack free, and nothing is kept out of the raster rings", () => {
    const { cache, made } = makeCache();
    const many = Array.from({ length: RasterTextureCache.poolSlack + 4 }, (_, i) => ({ key: `t${i}`, resident: {}, size: 64, signature: 0 }));
    cache.assign(many);
    cache.assign([{ key: "other", resident: {}, size: 64, signature: 0 }]);
    expect(made.filter((t) => t.disposed)).toHaveLength(4);
    expect(cache.textureCount).toBe(1 + RasterTextureCache.poolSlack);
    cache.assign([]);
    expect(cache.textureCount).toBe(0);
    expect(made.every((t) => t.disposed)).toBe(true);
  });
});
