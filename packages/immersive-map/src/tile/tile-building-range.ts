// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Where each building's volume sits in a tile's extruded index buffer, a
 * port of the Swift `TileBuildingRange`: the indices from `indexStart`,
 * `indexCount` of them, belong to the building whose tile feature id is
 * `featureID`. The parser writes them sorted by feature id, then by start
 * (the arena metadata's `buildingRanges`).
 *
 * A tile keeps these beside its extruded geometry so the frame can leave a
 * building out without parsing the tile again: when a model stands in for
 * a building, the drawer draws from a copy of the indices without the
 * ranges of that building's id (`HiddenBuildingIndexBuffers`).
 *
 * Feature ids are plain numbers here: the default schema's ids (the OSM
 * element's kind above bit 44, its id below) stay under 2^53.
 */

/** A tile's ranges, columns of numbers: the ids ascending, each id's ranges by start. */
export interface TileBuildingRanges {
  readonly featureIDs: Float64Array;
  readonly indexStarts: Uint32Array;
  readonly indexCounts: Uint32Array;
}

/** The ranges as the arena metadata carries them, ids as decimal strings. */
export function tileBuildingRanges(ranges: readonly (readonly [string | number, number, number])[]): TileBuildingRanges {
  const count = ranges.length;
  const featureIDs = new Float64Array(count);
  const indexStarts = new Uint32Array(count);
  const indexCounts = new Uint32Array(count);
  ranges.forEach(([id, start, length], i) => {
    featureIDs[i] = Number(id);
    indexStarts[i] = start;
    indexCounts[i] = length;
  });
  return { featureIDs, indexStarts, indexCounts };
}

/**
 * The runs of a tile's `indexCount` extruded indices to draw when the
 * buildings in `hiddenFeatureIDs` are left out, ascending, as [start, end).
 * `undefined` when `ranges` holds none of them, and the tile draws whole.
 */
export function buildingIndexRuns(ranges: TileBuildingRanges, indexCount: number, hiddenFeatureIDs: ReadonlySet<number>): [number, number][] | undefined {
  const count = ranges.featureIDs.length;
  if (hiddenFeatureIDs.size === 0 || count === 0) return undefined;
  const hidden: [number, number][] = [];
  for (const featureID of hiddenFeatureIDs) {
    // The first range of the id, by bisection.
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (ranges.featureIDs[middle]! < featureID) low = middle + 1;
      else high = middle;
    }
    while (low < count && ranges.featureIDs[low] === featureID) {
      const start = ranges.indexStarts[low]!;
      hidden.push([start, start + ranges.indexCounts[low]!]);
      low++;
    }
  }
  if (hidden.length === 0) return undefined;
  hidden.sort((a, b) => a[0] - b[0]);
  const runs: [number, number][] = [];
  let cursor = 0;
  for (const [start, end] of hidden) {
    if (start > cursor) runs.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < indexCount) runs.push([cursor, indexCount]);
  return runs;
}
