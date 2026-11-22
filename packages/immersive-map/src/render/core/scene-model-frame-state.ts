// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * What the models tell the rest of a frame, a port of the Swift
 * `SceneModelFrameState`, `ReplacedBuildings` and `StaticModelCasterKey`
 * (`FrameContextSharedState`): the map's buildings the drawn models stand
 * in for, the model tiles still on their way (the buildings under them
 * wait), and what the models cast into the shadow map. It lives in Render
 * because both the models and the buildings read it, and neither reaches
 * into the other.
 */

import type { ShadowCasterKeyPlacement } from "../../shadows/shadow-map-reuse-controller.ts";
import { type Tile, tileKey } from "../../tile/tile.ts";

/**
 * The map's own buildings a frame leaves out, by tile feature id: a model
 * drawn this frame stands in for each.
 *
 * An id names a building only within a zoom. The deepest map tiles carry
 * one feature per OSM element, and the tiles above them merge buildings
 * into groups that go by the id of one member, so the same id is one
 * building in one zoom and a group of buildings in another. A model tile
 * therefore lists what it replaces zoom by zoom (`byMapTileZoom`), and a
 * map tile takes the list of its own zoom.
 */
export class ReplacedBuildings {
  static readonly none: ReplacedBuildings = new ReplacedBuildings(new Map());

  /** Left out of the map tiles of one zoom, by that zoom. */
  readonly byMapTileZoom: ReadonlyMap<number, ReadonlySet<number>>;

  constructor(byMapTileZoom: ReadonlyMap<number, ReadonlySet<number>> | Readonly<Record<number, readonly number[]>> = new Map()) {
    if (byMapTileZoom instanceof Map) {
      this.byMapTileZoom = byMapTileZoom as ReadonlyMap<number, ReadonlySet<number>>;
    } else {
      const map = new Map<number, ReadonlySet<number>>();
      for (const [zoom, ids] of Object.entries(byMapTileZoom as Readonly<Record<number, readonly number[]>>)) map.set(Number(zoom), new Set(ids));
      this.byMapTileZoom = map;
    }
  }

  get isEmpty(): boolean {
    for (const ids of this.byMapTileZoom.values()) if (ids.size > 0) return false;
    return true;
  }

  /**
   * The ids left out of a map tile of `zoom`: the list of that zoom, and
   * for a tile deeper than every list the deepest one, since the tiles
   * below the archive's deepest carry the same one feature per element. A
   * shallower tile with no list of its own takes none: its ids are groups
   * the deeper lists know nothing of.
   */
  ids(forMapTileZoom: number): ReadonlySet<number> {
    const exact = this.byMapTileZoom.get(forMapTileZoom);
    if (exact !== undefined) return exact;
    let deepest = -1;
    for (const zoom of this.byMapTileZoom.keys()) deepest = Math.max(deepest, zoom);
    if (deepest >= 0 && forMapTileZoom > deepest) return this.byMapTileZoom.get(deepest) ?? emptyIds;
    return emptyIds;
  }

  /** These buildings and the ones of `other`, zoom by zoom. */
  union(other: ReadonlyMap<number, ReadonlySet<number>>): ReplacedBuildings {
    if (other.size === 0) return this;
    const merged = new Map<number, Set<number>>();
    for (const [zoom, ids] of this.byMapTileZoom) merged.set(zoom, new Set(ids));
    for (const [zoom, ids] of other) {
      const into = merged.get(zoom);
      if (into === undefined) merged.set(zoom, new Set(ids));
      else for (const id of ids) into.add(id);
    }
    return new ReplacedBuildings(merged);
  }

  /** The same ids for every zoom (the Swift `Equatable`). */
  equals(other: ReplacedBuildings): boolean {
    if (this === other) return true;
    const zooms = new Set([...this.byMapTileZoom.keys(), ...other.byMapTileZoom.keys()]);
    for (const zoom of zooms) {
      const a = this.byMapTileZoom.get(zoom) ?? emptyIds;
      const b = other.byMapTileZoom.get(zoom) ?? emptyIds;
      if (a.size !== b.size) return false;
      for (const id of a) if (!b.has(id)) return false;
    }
    return true;
  }
}

const emptyIds: ReadonlySet<number> = new Set();

/**
 * The models' part of one frame. The scene models' subsystem starts it
 * over each frame and the model tiles' subsystem adds to it, both before
 * the buildings update.
 */
export class SceneModelFrameState {
  /** A scene model is animating: the frames keep coming. */
  hasActiveAnimations = false;
  /** At least one model survived the light's culling this frame: it opens the shadow gate with the buildings. */
  hasShadowCasters = false;
  /** At least one of those casters can move between frames (the app's scene models): the shadow map renders again every frame while one is in it. */
  hasMovingShadowCasters = false;
  /**
   * The casters that never move, the model tiles, one key each in the
   * shadow map's caster set (`ShadowMapReuseController.casterKey`): the
   * map renders again when the set changes.
   */
  staticShadowCasters: ShadowCasterKeyPlacement[] = [];
  /**
   * The map's own buildings this frame leaves out. A building is named
   * only once its model is loaded and shown, so there is never a frame
   * with neither.
   */
  replacedBuildings: ReplacedBuildings = ReplacedBuildings.none;
  /** At least one model draws in the world pass this frame. */
  hasDrawnModels = false;
  /**
   * The model tiles (`ModelTileStore.tileZoom`) still on their way this
   * frame, by `tileKey`: the buildings under them wait, so the ones a model
   * stands in for are left out from their first frame instead of standing
   * until the model comes.
   */
  pendingModelTiles: ReadonlySet<string> = new Set();
  /** Whether a model tile is still rising out of the ground. */
  isRising = false;

  /** Starts a frame over. */
  reset(): void {
    this.hasActiveAnimations = false;
    this.hasShadowCasters = false;
    this.hasMovingShadowCasters = false;
    this.staticShadowCasters = [];
    this.replacedBuildings = ReplacedBuildings.none;
    this.hasDrawnModels = false;
    this.pendingModelTiles = new Set();
    this.isRising = false;
  }
}

/** The model tile (zoom `modelTileZoom`) a map tile lies in, by `tileKey`: a coarser map tile is its own key. */
export function modelTileKeyOver(tile: Tile, modelTileZoom: number): string {
  const shift = Math.max(tile.z - modelTileZoom, 0);
  return tileKey({ x: tile.x >> shift, y: tile.y >> shift, z: tile.z - shift });
}
