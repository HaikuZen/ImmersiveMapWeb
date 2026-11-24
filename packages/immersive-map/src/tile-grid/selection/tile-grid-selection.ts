// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapTileID, tileNumber } from "../../geo/immersive-map-tile-id.ts";
import type { ImmersiveMapScreenPoint, ImmersiveMapSelectionKind } from "../../selection/immersive-map-selection.ts";
import { type MapTapKind, type SelectableMapFeature, type SelectionHit, type SelectionPickData, selectionPixelPoint } from "../../selection/selectable-map-feature.ts";
import type { ImmersiveMapTileGridController } from "../immersive-map-tile-grid-controller.ts";
import { tileGridSelectionKind, TileGridSelectionSnapshot } from "./tile-grid-selection-snapshot.ts";

/** The grid a tap can change: the app's controller as the map holds it. */
export interface TileGridSelectionSource {
  /** The attached controller, null when the map shows no grid. */
  readonly tileGridController: ImmersiveMapTileGridController | null;
}

/**
 * The tile grid's side of a tap (`SelectableMapFeature`), the Swift
 * `TileGridSelection`: the tap is turned into the tile under it, of the
 * zoom the last frame on screen showed (`TileGridSelectionSnapshot`), and
 * the tile is selected or deselected in the app's controller, which holds
 * any number of them. The tap is the gesture the settings name (`tapKind`):
 * a single tap, a double tap, which the grid then takes from the zoom, or a
 * secondary one. The grid lies on the ground under everything else, so it
 * is asked last, and it takes no part in the map's single selection beyond
 * ending it: a tap on a tile is a tap away from the pin or the model that
 * was selected.
 */
export class TileGridSelection implements SelectableMapFeature {
  private snapshot = TileGridSelectionSnapshot.empty;

  constructor(private readonly source: TileGridSelectionSource) {}

  /** A tile in a selection's object id (`ImmersiveMapTileID.number`). */
  static objectID(tile: ImmersiveMapTileID): number {
    return tileNumber(tile.zoom, tile.x, tile.y);
  }

  static tile(objectID: number): ImmersiveMapTileID {
    const side = 16_777_216;
    const y = objectID % side;
    const rest = (objectID - y) / side;
    const x = rest % side;
    return { zoom: (rest - x) / side, x, y };
  }

  owns(kind: ImmersiveMapSelectionKind): boolean {
    return kind === tileGridSelectionKind;
  }

  updatePickData(pickData: SelectionPickData): void {
    if (!(pickData instanceof TileGridSelectionSnapshot) || pickData.frameIndex < this.snapshot.frameIndex) return;
    this.snapshot = pickData;
  }

  resetPickData(): void {
    this.snapshot = TileGridSelectionSnapshot.empty;
  }

  hitTest(point: ImmersiveMapScreenPoint, contentsScale: number): SelectionHit | null {
    const snapshot = this.snapshot;
    if (this.source.tileGridController === null || snapshot.drawHeight <= 0) return null;
    const hit = snapshot.hitTest(selectionPixelPoint(point, snapshot.drawHeight, contentsScale));
    if (hit === undefined) return null;
    return { selection: { kind: tileGridSelectionKind, objectID: TileGridSelection.objectID(hit.tile) }, coordinate: hit.coordinate };
  }

  /** Never: a tile is not the map's single selection. */
  contains(): boolean {
    return false;
  }

  setSelected(): void {}

  get clearsSelectionOnTap(): boolean {
    return true;
  }

  /** The gesture the settings of the frame on screen give the grid. */
  get tapKind(): MapTapKind {
    const gesture = this.snapshot.gesture;
    return gesture === "tap" ? "single" : gesture === "doubleTap" ? "double" : "secondary";
  }

  /** While the grid shows tiles a gesture may select, the gesture is the grid's: a double tap then selects and does not zoom. */
  get claimsItsTapKind(): boolean {
    return this.source.tileGridController !== null && this.snapshot.projection !== undefined;
  }

  deliverTap(hit: SelectionHit, point: ImmersiveMapScreenPoint): boolean {
    const controller = this.source.tileGridController;
    if (controller === null || hit.coordinate === null) return false;
    const snapshot = this.snapshot;
    const outcome = controller.applyTap(
      TileGridSelection.tile(hit.selection.objectID),
      { mode: snapshot.mode, limit: snapshot.selectionLimit, selectableBounds: snapshot.selectableBounds },
      hit.coordinate,
      point,
    );
    return outcome !== "passed";
  }
}
