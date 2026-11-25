// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type ImmersiveMap, ImmersiveMapTileGridController, ImmersiveMapTileID } from "@artembobkin/immersive-map";

/**
 * The playground's `grid=1`: the tile grid over the map, a tap on a tile
 * selecting it. `gridZoom=15` shows the tiles of one zoom alone,
 * `gridGesture=doubleTap` (or `secondaryTap`) selects by another gesture,
 * `gridMode=single` holds one tile at a time, `gridLimit=5` caps the
 * selection, `gridSelect=15/19805/10240,15/19806/10240` selects from the
 * start, `gridNames=1` writes a text of the page's own inside each tile and
 * `gridFrames=0` draws every tile whole (the measurement's other variant,
 * docs/benchmarks/B23-tile-grid.md). The selection and the taps turned away
 * are kept in `window.tileGrid` and `window.tileGridEvents`.
 */
export function addSampleTileGrid(map: ImmersiveMap, params: URLSearchParams): void {
  const grid = new ImmersiveMapTileGridController();
  const events: unknown[] = [];
  grid.onSelectionChanged = (change) => events.push({ kind: "selection", added: change.added.map(ImmersiveMapTileID.key), removed: change.removed.map(ImmersiveMapTileID.key), source: change.source, count: change.selectedTiles.length });
  grid.onTapRejected = (rejection) => events.push({ kind: "rejected", tile: ImmersiveMapTileID.key(rejection.tile), reason: rejection.reason.kind });
  const preset = params.get("gridSelect");
  if (preset) grid.select(preset.split(",").flatMap((key) => ImmersiveMapTileID.fromKey(key) ?? []));
  if (params.get("gridNames") === "1") grid.labelProvider = (tile) => (tile.x % 2 === 0 ? `tile ${tile.x % 100}-${tile.y % 100}` : null);

  const zoom = params.get("gridZoom");
  const gesture = params.get("gridGesture");
  const limit = params.get("gridLimit");
  let settings = map.settings.tileGridSettings({
    ...(zoom === null ? {} : { zoomRange: [Number(zoom.split("-")[0]), Number(zoom.split("-")[1] ?? zoom)] as const }),
    ...(gesture === "doubleTap" || gesture === "secondaryTap" ? { selectionGesture: gesture } : {}),
    ...(params.get("gridMode") === "single" ? { selectionMode: "single" as const } : {}),
    ...(limit === null ? {} : { selectionLimit: Number(limit) }),
  });
  // A tap that selects at once, and a second one that takes the tile back.
  if (params.get("gridDoubleTapZoom") === "0") settings = settings.doubleTapZoom(false);
  map.settings = settings;
  map.tileGrid = grid;
  Object.assign(window, { tileGrid: grid, tileGridEvents: events, ImmersiveMapTileID });
}
