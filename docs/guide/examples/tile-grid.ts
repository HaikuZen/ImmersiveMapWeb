// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/TileGrid.md.

import { ImmersiveMap, ImmersiveMapGeoBounds, ImmersiveMapTileGridController, ImmersiveMapTileID } from "@artembobkin/immersive-map";

/** The grid over the map, and what the user picks on it. */
export async function gridOfTiles(container: HTMLElement): Promise<ImmersiveMapTileGridController> {
  const grid = new ImmersiveMapTileGridController();
  grid.onSelectionChanged = (change) => {
    console.log(change.added, change.removed, change.selectedTiles.length);
  };

  const map = await ImmersiveMap.create({ container, camera: { city: "moscow", zoom: 13 }, tileGrid: grid });
  map.setSettings((settings) => settings.tileGridSettings({ zoomRange: [15, 15] }));
  return grid;
}

/** A grid attached to a running map, and taken away. */
export function attachAndDetach(map: ImmersiveMap, grid: ImmersiveMapTileGridController): void {
  map.tileGrid = grid;
  map.tileGrid = null;
}

/** Which tiles show and how the grid looks. */
export function look(map: ImmersiveMap): void {
  map.setSettings((settings) =>
    settings.tileGridSettings({
      zoomRange: [12, 15],
      lineColor: [0.9, 0.2, 0.2, 0.8],
      lineWidthPoints: 2,
      selectedFillColor: [0.9, 0.2, 0.2, 0.3],
      labelFormat: "xyz",
    }),
  );
}

/** The selection read and changed from code. */
export function selectionFromCode(grid: ImmersiveMapTileGridController): void {
  const tile = ImmersiveMapTileID.containing({ latitude: 55.7539, longitude: 37.6208 }, 15);
  grid.select(tile);
  grid.select(ImmersiveMapTileID.children(tile));
  grid.toggle(ImmersiveMapTileID.make(15, 19807, 10243));
  grid.deselect(tile);
  console.log(grid.isSelected(tile), grid.selectedTiles.map(ImmersiveMapTileID.key));
  grid.setSelectedTiles([tile]);
  grid.clearSelection();
}

/** A tile's own numbers. */
export function tileNumbers(): void {
  const tile = ImmersiveMapTileID.make(15, 19808, 10243);
  const bounds = ImmersiveMapTileID.bounds(tile);
  const center = ImmersiveMapTileID.center(tile);
  const parent = ImmersiveMapTileID.parent(tile);
  const url = `https://tiles.example.com/${ImmersiveMapTileID.key(tile)}.png`;
  console.log(bounds.southWest, bounds.northEast, center, parent, url);
}

/** A tap that acts at once. */
export function tapAtOnce(map: ImmersiveMap): void {
  map.setSettings((settings) => settings.doubleTapZoom(false));
}

/** Another gesture, and one tile at a time. */
export function gestureAndMode(map: ImmersiveMap): void {
  map.setSettings((settings) => settings.tileGridSettings({ selectionGesture: "doubleTap", selectionMode: "single" }));
}

/** What a tap may select. */
export function limits(map: ImmersiveMap, grid: ImmersiveMapTileGridController): void {
  const city = ImmersiveMapGeoBounds.make({ latitude: 55.55, longitude: 37.35 }, { latitude: 55.92, longitude: 37.85 });
  map.setSettings((settings) => settings.tileGridSelection({ limit: 20, selectableBounds: city }));

  grid.onTapRejected = (rejection) => {
    if (rejection.reason.kind === "limitReached") console.log(`no more than ${rejection.reason.limit} tiles`);
    else console.log(`${ImmersiveMapTileID.key(rejection.tile)} is outside the city`);
  };
}

/** A grid the user looks at and cannot change. */
export function readOnly(map: ImmersiveMap): void {
  map.setSettings((settings) => settings.tileGridSettings({ isTapSelectionEnabled: false }));
}

/** The app's own text inside each tile. */
export function ownTexts(grid: ImmersiveMapTileGridController, counts: ReadonlyMap<string, number>): void {
  grid.labelProvider = (tile) => {
    const count = counts.get(ImmersiveMapTileID.key(tile));
    return count === undefined ? null : `${count} orders`;
  };
  // The counts changed: the tiles in view are asked again.
  grid.reloadLabels();
}

/** No text, the borders alone. */
export function bordersAlone(map: ImmersiveMap): void {
  map.setSettings((settings) => settings.tileGridSettings({ labelFormat: "hidden" }));
}
