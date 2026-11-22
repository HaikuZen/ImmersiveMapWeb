// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { type DepthStorage, TileArchiveDepths } from "./archive-depths.ts";

function memoryStorage(): DepthStorage & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v) };
}

describe("TileArchiveDepths", () => {
  it("knows nothing of an archive never read", () => {
    expect(new TileArchiveDepths(memoryStorage()).maximumZoom("a")).toBeNull();
  });

  it("keeps a depth across instances and reports only a change", () => {
    const storage = memoryStorage();
    const first = new TileArchiveDepths(storage);
    expect(first.observe(15, "a")).toBe(true);
    expect(first.observe(15, "a")).toBe(false);
    const next = new TileArchiveDepths(storage);
    expect(next.maximumZoom("a")).toBe(15);
    expect(next.maximumZoom("b")).toBeNull();
    expect(next.observe(14, "a")).toBe(true);
    expect(new TileArchiveDepths(storage).maximumZoom("a")).toBe(14);
  });

  it("ignores a kept value that is not a zoom", () => {
    const storage = memoryStorage();
    storage.setItem("immersive-map/archive-depth/a", "deep");
    expect(new TileArchiveDepths(storage).maximumZoom("a")).toBeNull();
  });
});
