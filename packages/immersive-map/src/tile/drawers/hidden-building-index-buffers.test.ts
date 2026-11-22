// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { ReplacedBuildings } from "../../render/core/scene-model-frame-state.ts";
import { tileBuildingRanges } from "../tile-building-range.ts";
import { copyRuns, HiddenBuildingIndexBuffers, type HiddenBuildingIndices, type HiddenBuildingTile, workingLayout, type WorkingLayout } from "./hidden-building-index-buffers.ts";

/**
 * Swift `HiddenBuildingIndexBuffersTests`: the working index buffer a tile's
 * buildings draw from while models stand in for some of them. The GPU copy
 * itself (building-index-copy.wgsl) runs the triples `copyRuns` makes: the
 * tests read the indices a layout keeps through them.
 */

/** A tile of three buildings, 3, 6 and 3 indices long, with ids 1, 2 and 3, of zoom 15. */
function makeTile(): HiddenBuildingTile & { indices: number[] } {
  return {
    zoom: 15,
    ranges: tileBuildingRanges([
      [1, 0, 3],
      [2, 3, 6],
      [3, 9, 3],
    ]),
    indexCount: 12,
    quarterIndexStarts: [],
    indices: Array.from({ length: 12 }, (_, i) => i),
  };
}

/** A fake GPU buffer that remembers the layout it was made for. */
interface FakeBuffer {
  readonly layout: WorkingLayout;
  destroyed: boolean;
  destroy(): void;
}

function makeBuffers(): { buffers: HiddenBuildingIndexBuffers<object>; made: FakeBuffer[]; live: Set<object> } {
  const made: FakeBuffer[] = [];
  const live = new Set<object>();
  const buffers = new HiddenBuildingIndexBuffers<object>(
    (_owner, layout) => {
      const buffer: FakeBuffer = {
        layout,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      made.push(buffer);
      return buffer as unknown as GPUBuffer;
    },
    (owner) => live.has(owner),
  );
  return { buffers, made, live };
}

/** The indices a working buffer holds: the tile's, through the copy's triples. */
function contents(indices: HiddenBuildingIndices, tile: { indices: number[] }): { buffer: FakeBuffer; indices: number[] } {
  if (indices.kind !== "working") throw new Error(`expected a working buffer, got ${indices.kind}`);
  const buffer = indices.buffer as unknown as FakeBuffer;
  const triples = copyRuns(buffer.layout);
  const out: number[] = [];
  for (let i = 0; i < triples.length; i += 4) {
    expect(triples[i]).toBe(out.length);
    for (let k = 0; k < triples[i + 2]!; k++) out.push(tile.indices[triples[i + 1]! + k]!);
  }
  expect(out.length).toBe(indices.indexCount);
  return { buffer, indices: out };
}

function hiding(buffers: HiddenBuildingIndexBuffers<object>, owner: object, tile: HiddenBuildingTile, ids: number[]): HiddenBuildingIndices {
  buffers.update(new ReplacedBuildings(ids.length === 0 ? {} : { 15: ids }));
  return buffers.indices(owner, tile);
}

describe("HiddenBuildingIndexBuffers", () => {
  it("copies the runs one after another", () => {
    const source = Array.from({ length: 12 }, (_, i) => 100 + i);
    const layout = workingLayout([[0, 2], [5, 8], [11, 12]], []);
    const triples = copyRuns(layout);
    const out: number[] = [];
    for (let i = 0; i < triples.length; i += 4) for (let k = 0; k < triples[i + 2]!; k++) out.push(source[triples[i + 1]! + k]!);
    expect(out).toEqual([100, 101, 105, 106, 107, 111]);
  });

  it("draws the tile's own indices with nothing of it hidden", () => {
    const { buffers } = makeBuffers();
    const tile = makeTile();
    const owner = {};
    expect(hiding(buffers, owner, tile, []).kind).toBe("whole");
    // A building of another tile changes nothing here.
    expect(hiding(buffers, owner, tile, [77]).kind).toBe("whole");
  });

  it("leaves a hidden building out of the working buffer", () => {
    const { buffers } = makeBuffers();
    const tile = makeTile();
    const owner = {};
    expect(contents(hiding(buffers, owner, tile, [2]), tile).indices).toEqual([0, 1, 2, 9, 10, 11]);
    expect(contents(hiding(buffers, owner, tile, [1, 3]), tile).indices).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it("draws nothing of a tile with every building hidden", () => {
    const { buffers } = makeBuffers();
    expect(hiding(buffers, {}, makeTile(), [1, 2, 3]).kind).toBe("none");
  });

  it("builds the working buffer once", () => {
    const { buffers, made } = makeBuffers();
    const tile = makeTile();
    const owner = {};
    const first = contents(hiding(buffers, owner, tile, [2]), tile).buffer;
    const second = contents(hiding(buffers, owner, tile, [2]), tile).buffer;
    expect(second).toBe(first);
    expect(made.length).toBe(1);
  });

  it("keeps the working buffer while nothing is hidden", () => {
    const { buffers } = makeBuffers();
    const tile = makeTile();
    const owner = {};
    const first = contents(hiding(buffers, owner, tile, [2]), tile).buffer;
    expect(hiding(buffers, owner, tile, []).kind).toBe("whole");
    expect(contents(hiding(buffers, owner, tile, [2]), tile).buffer).toBe(first);
  });

  it("keeps the working buffer through a change elsewhere", () => {
    const { buffers } = makeBuffers();
    const tile = makeTile();
    const owner = {};
    const first = contents(hiding(buffers, owner, tile, [2]), tile).buffer;
    expect(contents(hiding(buffers, owner, tile, [2, 500, 600]), tile).buffer).toBe(first);
    const rebuilt = contents(hiding(buffers, owner, tile, [2, 3, 500]), tile);
    // A change in this tile's buildings builds the buffer again, and the old one goes.
    expect(rebuilt.buffer).not.toBe(first);
    expect(first.destroyed).toBe(true);
    expect(rebuilt.indices).toEqual([0, 1, 2]);
  });

  it("gives a tile the hidden buildings of its own zoom", () => {
    const { buffers } = makeBuffers();
    const tile = makeTile();
    const owner = {};
    buffers.update(new ReplacedBuildings({ 14: [2], 15: [77] }));
    // A list for zoom 14 does not reach a tile of zoom 15.
    expect(buffers.indices(owner, tile).kind).toBe("whole");
    buffers.update(new ReplacedBuildings({ 14: [2], 15: [1] }));
    expect(contents(buffers.indices(owner, tile), tile).indices).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("gives each tile a working buffer of its own", () => {
    const { buffers } = makeBuffers();
    const first = makeTile();
    const second = makeTile();
    const a = contents(hiding(buffers, {}, first, [2]), first).buffer;
    const b = contents(hiding(buffers, {}, second, [2]), second).buffer;
    expect(a).not.toBe(b);
  });

  it("lays a tile kept by quarters out quarter after quarter", () => {
    // Quarters of 3, 3, 3 and 3 indices, the building of the second quarter hidden.
    const layout = workingLayout([[0, 3], [6, 12]], [0, 3, 6, 9, 12]);
    expect(layout.quarterStarts).toEqual([0, 3, 3, 6, 9]);
    expect(layout.indexCount).toBe(9);
    expect(layout.segments).toEqual([[[0, 3]], [], [[6, 9]], [[9, 12]]]);
  });

  it("drops the working buffers of released tiles on a sweep", () => {
    const { buffers, made, live } = makeBuffers();
    const owners = Array.from({ length: HiddenBuildingIndexBuffers.minimumSweepEntryCount + 1 }, () => ({}));
    buffers.update(new ReplacedBuildings({ 15: [2] }));
    const kept = owners[0]!;
    live.add(kept);
    for (const owner of owners) buffers.indices(owner, makeTile());
    expect(made.filter((b) => b.destroyed).length).toBe(owners.length - 1);
    expect(made[0]!.destroyed).toBe(false);
  });
});
