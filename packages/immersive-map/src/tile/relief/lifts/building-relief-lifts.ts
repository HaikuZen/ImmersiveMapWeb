// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Tile } from "../../tile.ts";
import type { GroundReliefFrame } from "../frame/ground-relief-frame.ts";

/** What the lifts read of a tile: its buildings' anchors by ordinal, x and y two by two in the tile's render units (y up, 0 to 4096). */
export interface BuildingAnchorTile {
  readonly tile: Tile;
  readonly buildingAnchors: Float32Array;
}

/** A placement as the lifts read it: its tile and the terrain its ground rises by. */
export interface BuildingLiftPlacement {
  readonly resident: BuildingAnchorTile;
  readonly displacement: Tile | undefined;
}

/** One tile's lifts: the terrain's metres under each building's anchor, and the terrain they were read from. */
export interface BuildingLifts {
  readonly metres: Float32Array;
  readonly terrainId: number;
  readonly revision: number;
}

/**
 * The buildings' lifts over the ground relief, a port of the Swift
 * `BuildingReliefLifts`: for each drawn building placement, the terrain's
 * height under each volume's anchor, in the terrain's metres, which the
 * extruded vertex stage reads by the volume's ordinal (tile-extruded.wgsl,
 * `kExtrudedRelief`). Buildings on a slope stand level at the height of
 * their anchor. Metres, not world units, which change with the zoom, and
 * not as drawn, which changes with the relief's fade: the drawer binds the
 * units a metre rises by this frame beside them.
 *
 * A tile's lifts are made once, when its terrain arrives or changes (a weld,
 * `GroundReliefTile.revision`), and kept while the tile draws with the same
 * terrain. The tile is named by its object, so a tile allocated where a
 * released one was is not handed the old lifts.
 */
export class BuildingReliefLifts<R extends BuildingAnchorTile> {
  private byTile = new Map<R, BuildingLifts>();

  /** Lets go of every tile's lifts. */
  evict(): void {
    this.byTile.clear();
  }

  /**
   * The lifts of each placement, index-aligned with `placements`:
   * `undefined` for one with no buildings or whose terrain is not in. With
   * no relief every entry is `undefined` and the cache is let go.
   */
  update(placements: readonly (BuildingLiftPlacement & { readonly resident: R })[], relief: GroundReliefFrame | undefined): (BuildingLifts | undefined)[] {
    if (relief === undefined || !relief.isActive) {
      this.byTile.clear();
      return placements.map(() => undefined);
    }
    const kept = new Map<R, BuildingLifts>();
    const lifts = placements.map((placement) => {
      const resident = placement.resident;
      const anchors = resident.buildingAnchors;
      if (anchors.length === 0 || placement.displacement === undefined) return undefined;
      const ground = relief.relief(resident.tile, placement.displacement);
      if (ground === undefined) return undefined;
      const cached = this.byTile.get(resident) ?? kept.get(resident);
      if (cached !== undefined && cached.terrainId === ground.terrain.id && cached.revision === ground.terrain.revision && cached.metres.length === anchors.length / 2) {
        kept.set(resident, cached);
        return cached;
      }
      const metres = new Float32Array(anchors.length / 2);
      for (let index = 0; index < metres.length; index++) {
        // The anchor is render space (y up), the terrain's v grows from the north edge.
        metres[index] = ground.metresAtTileUV(anchors[index * 2]! / 4096, (4096 - anchors[index * 2 + 1]!) / 4096);
      }
      const made = { metres, terrainId: ground.terrain.id, revision: ground.terrain.revision };
      kept.set(resident, made);
      return made;
    });
    this.byTile = kept;
    return lifts;
  }
}
