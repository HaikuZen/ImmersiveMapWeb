// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { TileGridSelectionGesture, TileGridSelectionMode } from "../../configuration/tile-grid-settings.ts";
import type { GeoCoordinate } from "../../geo/geo-coordinate.ts";
import { GeoScreenPlaceMath } from "../../geo/geo-screen-place-math.ts";
import type { GeoScreenProjectionFrameConstants } from "../../geo/geo-screen-projection-math.ts";
import type { ImmersiveMapGeoBounds } from "../../geo/immersive-map-geo-bounds.ts";
import { ImmersiveMapTileID } from "../../geo/immersive-map-tile-id.ts";
import { LayerPickMath } from "../../layers/selection/layer-pick-math.ts";
import type { ImmersiveMapSelectionKind } from "../../selection/immersive-map-selection.ts";
import type { SelectionPickData } from "../../selection/selectable-map-feature.ts";

/**
 * The tiles of the tile grid: the kind their pick data and a tap's hit go
 * by. A tile is never the map's single selection
 * (`ImmersiveMapSelectionController`): the grid keeps a set of its own, on
 * `ImmersiveMapTileGridController`.
 */
export const tileGridSelectionKind: ImmersiveMapSelectionKind = "tileGrid";

/**
 * Hit-test state of one rendered frame of the tile grid, the Swift
 * `TileGridSelectionSnapshot`: the zoom whose tiles it showed, the
 * projection it drew them with, and the rules a tap is held to, as the
 * frame's settings had them. What is on screen is what can be tapped: a
 * frame that showed no grid takes no tap.
 */
export class TileGridSelectionSnapshot implements SelectionPickData {
  static readonly empty = new TileGridSelectionSnapshot(0, 0, 0, undefined, 0, "tap", "multiple", null, null);

  readonly kind = tileGridSelectionKind;

  constructor(
    readonly frameIndex: number,
    readonly drawWidth: number,
    readonly drawHeight: number,
    /** The frame's projection, `undefined` for a frame that showed no grid or one whose tiles are not for tapping. */
    readonly projection: GeoScreenProjectionFrameConstants | undefined,
    /** The zoom of the tiles the frame showed. */
    readonly zoom: number,
    /** The gesture that selects a tile, and how many it may hold. */
    readonly gesture: TileGridSelectionGesture,
    readonly mode: TileGridSelectionMode,
    readonly selectionLimit: number | null,
    readonly selectableBounds: ImmersiveMapGeoBounds | null,
  ) {}

  /** The tile under `point` (drawable pixels, origin bottom-left) and the place on the map there. */
  hitTest(point: { readonly x: number; readonly y: number }): { readonly tile: ImmersiveMapTileID; readonly coordinate: GeoCoordinate } | undefined {
    if (this.projection === undefined) return undefined;
    const place = GeoScreenPlaceMath.place([point.x, point.y], this.projection);
    if (place === undefined) return undefined;
    return { tile: ImmersiveMapTileID.containingWorld(place.world[0], place.world[1], this.zoom), coordinate: LayerPickMath.coordinateOfWorld(place.world) };
  }
}
