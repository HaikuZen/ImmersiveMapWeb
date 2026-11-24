// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The `tile-grid` folder: the grid of XYZ tiles an app's user picks tiles
 * on, a port of the Swift `TileGrid` folder. Everything of the feature is
 * here: the app's handle (this controller and its events), the frame's grid
 * (`TileGridFrame`, over the Rust of ImmersiveMapCore: which zoom shows,
 * which tiles, the selected among them, the glyphs of their texts), the
 * texts (`TileGridLabels`, `tile-grid-atlas.ts`), the drawing
 * (`TileGridPipeline`, `TileGridRenderSubsystem`, `shaders/`) and the tap
 * (`selection/`). The grid names squares of the ground, not the map's own
 * tiles: nothing here reads the tile store, the planner or the archive, and
 * no other feature reads the grid. The map's side is
 * `ui/immersive-map-tile-grid-runtime.ts`.
 */

import type { TileGridSelectionMode } from "../configuration/tile-grid-settings.ts";
import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import { ImmersiveMapGeoBounds } from "../geo/immersive-map-geo-bounds.ts";
import { ImmersiveMapTileID, tileNumber } from "../geo/immersive-map-tile-id.ts";
import type { ImmersiveMapScreenPoint, ImmersiveMapSelectionSource } from "../selection/immersive-map-selection.ts";

/** A change of the tiles selected on the grid, by a tap or from code. */
export interface ImmersiveMapTileGridSelectionChange {
  /** Every selected tile after the change. */
  readonly selectedTiles: readonly ImmersiveMapTileID[];
  /** The tiles the change selected. */
  readonly added: readonly ImmersiveMapTileID[];
  /** The tiles the change deselected. */
  readonly removed: readonly ImmersiveMapTileID[];
  /** Who made the change: `"tap"` for the user, `"programmatic"` for the app's own call. */
  readonly source: ImmersiveMapSelectionSource;
}

/**
 * Why a tap on a tile selected nothing: as many tiles are selected as
 * `TileGridSettings.selectionLimit` allows, or the tile lies outside
 * `TileGridSettings.selectableBounds`.
 */
export type ImmersiveMapTileGridTapRejectionReason = { readonly kind: "limitReached"; readonly limit: number } | { readonly kind: "outsideSelectableBounds" };

/** A tap on a tile of the grid that selected nothing. */
export interface ImmersiveMapTileGridTapRejection {
  /** The tile under the tap. */
  readonly tile: ImmersiveMapTileID;
  readonly reason: ImmersiveMapTileGridTapRejectionReason;
  /** The place on the map under the tap. */
  readonly coordinate: GeoCoordinate;
  /** The tap in CSS pixels of the map's element, origin top left. */
  readonly screenPoint: ImmersiveMapScreenPoint;
}

/** The text of a tile, null or empty for a tile without one. */
export type ImmersiveMapTileGridLabelProvider = (tile: ImmersiveMapTileID) => string | null | undefined;

/** What a tap on a tile came to: the tile was selected or deselected, the tap selected nothing and is spent, or it is not the grid's and goes on as a tap on the map. */
export type TileGridTapOutcome = "toggled" | "rejected" | "passed";

/**
 * The app's handle on the tile grid: the tiles that are selected, the
 * events, and the text of a tile. Attach it with `ImmersiveMap.tileGrid`,
 * which also shows the grid:
 *
 * ```ts
 * const grid = new ImmersiveMapTileGridController();
 * grid.onSelectionChanged = (change) => console.log(change.selectedTiles);
 * map.tileGrid = grid;
 * map.settings = map.settings.tileGridSettings({ zoomRange: [15, 15] });
 * ```
 *
 * A tap on a tile selects it, a second tap deselects it, and any number of
 * tiles can be selected at once. The app reads the set at any time
 * (`selectedTiles`) and can change it from code. What the grid shows and
 * what a tap may select are settings (`TileGridSettings`): the limit and
 * the selectable area there govern the taps alone, and a change made from
 * code is applied as given.
 *
 * Everything runs on the main thread.
 */
export class ImmersiveMapTileGridController {
  private readonly selected = new Map<number, ImmersiveMapTileID>();
  private selectionRevisionValue = 0;
  private labelRevisionValue = 0;
  private provider: ImmersiveMapTileGridLabelProvider | null = null;
  private changeHandler: (() => void) | null = null;
  private changeHandlerOwner: object | null = null;

  /**
   * Called after every change of the selection, by a tap or from code, with
   * what changed. A call that leaves the selection as it was reports
   * nothing.
   */
  onSelectionChanged: ((change: ImmersiveMapTileGridSelectionChange) => void) | null = null;
  /** Called when a tap on a tile selects nothing: the limit is reached, or the tile is outside the selectable area. */
  onTapRejected: ((rejection: ImmersiveMapTileGridTapRejection) => void) | null = null;

  constructor(selectedTiles: Iterable<ImmersiveMapTileID> = []) {
    for (const tile of selectedTiles) this.insert(tile);
  }

  // MARK: The selection

  /** The selected tiles as they are now, of every zoom. */
  get selectedTiles(): ImmersiveMapTileID[] {
    return [...this.selected.values()];
  }

  get selectedCount(): number {
    return this.selected.size;
  }

  isSelected(tile: ImmersiveMapTileID): boolean {
    return this.selected.has(numberOf(tile));
  }

  /** Selects a tile, or every tile of a list. */
  select(tiles: ImmersiveMapTileID | Iterable<ImmersiveMapTileID>): void {
    this.mutate("programmatic", () => {
      for (const tile of each(tiles)) this.insert(tile);
    });
  }

  /** Deselects a tile, or every tile of a list. */
  deselect(tiles: ImmersiveMapTileID | Iterable<ImmersiveMapTileID>): void {
    this.mutate("programmatic", () => {
      for (const tile of each(tiles)) this.selected.delete(numberOf(tile));
    });
  }

  /** Selects a tile that is not selected and deselects one that is. Returns whether the tile is selected afterwards. */
  toggle(tile: ImmersiveMapTileID): boolean {
    let isSelected = false;
    this.mutate("programmatic", () => {
      if (!this.selected.delete(numberOf(tile))) {
        this.insert(tile);
        isSelected = true;
      }
    });
    return isSelected;
  }

  /** Replaces the selection with `tiles`. */
  setSelectedTiles(tiles: Iterable<ImmersiveMapTileID>): void {
    // Read before the selection is emptied: `tiles` may be the selection itself.
    const next = [...tiles];
    this.mutate("programmatic", () => {
      this.selected.clear();
      for (const tile of next) this.insert(tile);
    });
  }

  clearSelection(): void {
    this.mutate("programmatic", () => this.selected.clear());
  }

  // MARK: The texts

  /**
   * The text written inside a tile, in place of
   * `TileGridSettings.labelFormat`: a name the app has for the tile, a
   * count, a status. Null or an empty text leaves the tile without one. The
   * text is one line, of the characters the map's labels are written with.
   * Called for the tiles in view, and the answer is kept until
   * `reloadLabels()`.
   */
  get labelProvider(): ImmersiveMapTileGridLabelProvider | null {
    return this.provider;
  }

  set labelProvider(provider: ImmersiveMapTileGridLabelProvider | null) {
    this.provider = provider;
    this.reloadLabels();
  }

  /** Asks `labelProvider` again for every tile. Call it when what the provider answers has changed. */
  reloadLabels(): void {
    this.labelRevisionValue++;
    this.changeHandler?.();
  }

  // MARK: The map's side

  /** @internal Moves with every change of the selection: a frame copies the selection again when it has. */
  get selectionRevision(): number {
    return this.selectionRevisionValue;
  }

  /** @internal Moves whenever the app's texts may have changed: the texts of the tiles are kept until it does. */
  get labelRevision(): number {
    return this.labelRevisionValue;
  }

  /** @internal The selected tiles as the frame takes them: zoom, x and y, three ints each. */
  selectionTriples(): Int32Array {
    const triples = new Int32Array(this.selected.size * 3);
    let index = 0;
    for (const tile of this.selected.values()) {
      triples[index++] = tile.zoom;
      triples[index++] = tile.x;
      triples[index++] = tile.y;
    }
    return triples;
  }

  /**
   * @internal A tap on `tile`, under the limit and the area a tap is held
   * to, and in the mode the settings give: many tiles, or one, which a tap
   * on another tile moves. A selected tile is always deselected: neither
   * rule keeps a user from taking a tile back.
   */
  applyTap(
    tile: ImmersiveMapTileID,
    rules: { readonly mode: TileGridSelectionMode; readonly limit: number | null; readonly selectableBounds: ImmersiveMapGeoBounds | null },
    coordinate: GeoCoordinate,
    screenPoint: ImmersiveMapScreenPoint,
  ): TileGridTapOutcome {
    const key = numberOf(tile);
    if (!this.selected.has(key)) {
      let reason: ImmersiveMapTileGridTapRejectionReason | undefined;
      if (rules.selectableBounds !== null && !ImmersiveMapGeoBounds.overlaps(rules.selectableBounds, ImmersiveMapTileID.bounds(tile))) {
        reason = { kind: "outsideSelectableBounds" };
      } else if (rules.mode === "multiple" && rules.limit !== null && this.selected.size >= rules.limit) {
        reason = { kind: "limitReached", limit: rules.limit };
      }
      if (reason !== undefined) {
        this.onTapRejected?.({ tile, reason, coordinate, screenPoint });
        return reason.kind === "outsideSelectableBounds" ? "passed" : "rejected";
      }
    }
    this.mutate("tap", () => {
      if (!this.selected.delete(key)) {
        // One tile at a time: the selection moves to this one.
        if (rules.mode === "single") this.selected.clear();
        this.insert(tile);
      }
    });
    return "toggled";
  }

  /** @internal The map binds itself: it is asked for a frame when the app or a tap changes the grid. */
  setChangeHandler(handler: (() => void) | null, owner: object): void {
    this.changeHandler = handler;
    this.changeHandlerOwner = owner;
  }

  /**
   * @internal Clears the handler only if `owner` still owns it: tearing down
   * an old map must not detach the controller from a new one that has
   * already bound it to itself.
   */
  clearChangeHandler(owner: object): void {
    if (this.changeHandlerOwner !== owner) return;
    this.changeHandler = null;
    this.changeHandlerOwner = null;
  }

  private insert(tile: ImmersiveMapTileID): void {
    const made = ImmersiveMapTileID.make(tile.zoom, tile.x, tile.y);
    this.selected.set(numberOf(made), made);
  }

  /** Applies `change`, and when it left the selection other than it was asks the map for a frame and reports it. */
  private mutate(source: ImmersiveMapSelectionSource, change: () => void): void {
    const before = new Map(this.selected);
    change();
    const added: ImmersiveMapTileID[] = [];
    const removed: ImmersiveMapTileID[] = [];
    for (const [key, tile] of this.selected) if (!before.has(key)) added.push(tile);
    for (const [key, tile] of before) if (!this.selected.has(key)) removed.push(tile);
    if (added.length === 0 && removed.length === 0) return;
    this.selectionRevisionValue++;
    this.changeHandler?.();
    this.onSelectionChanged?.({ selectedTiles: this.selectedTiles, added, removed, source });
  }
}

/** A tile's number as the selection keys it, whatever the numbers it was written with. */
function numberOf(tile: ImmersiveMapTileID): number {
  const made = ImmersiveMapTileID.make(tile.zoom, tile.x, tile.y);
  return tileNumber(made.zoom, made.x, made.y);
}

function each(tiles: ImmersiveMapTileID | Iterable<ImmersiveMapTileID>): Iterable<ImmersiveMapTileID> {
  return Symbol.iterator in tiles ? tiles : [tiles];
}
