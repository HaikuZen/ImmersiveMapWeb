// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/TileSource.md.

import { ImmersiveMap, ImmersiveMapByteCount, ImmersiveMapSettings, ImmersiveMapTilesService } from "@immersive-map/web";

/** The hosted archive the map draws by default. */
export const hostedArchive: string = ImmersiveMapTilesService.tileArchiveURL;

/** An archive of the app's own. */
export async function ownArchive(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({
    container,
    settings: ImmersiveMapSettings.default.tileArchive("https://tiles.example.com/planet.pmtiles"),
  });
  return map;
}

/** The same archive through the `url` option, which takes the place of the settings' archive. */
export async function ownArchiveOption(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({ container, url: "https://tiles.example.com/planet.pmtiles" });
  return map;
}

/** Credentials sent as headers with every archive request. */
export function archiveWithHeaders(token: string): ImmersiveMapSettings {
  const settings = ImmersiveMapSettings.default.tileArchive("https://tiles.example.com/planet.pmtiles", {
    Authorization: `Bearer ${token}`,
  });
  return settings;
}

/** A cap on the tile zoom the map asks the archive for. */
export const shallowArchive: ImmersiveMapSettings = ImmersiveMapSettings.default.tileMaximumZoomLevel(14);

/** A map with no network: the archive served by the app's own origin, and no model archive. */
export async function offlineMap(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({
    container,
    settings: ImmersiveMapSettings.default
      .tileArchive("/maps/city.pmtiles"),
  });
  return map;
}

/** A larger disk cache of prepared tiles. */
export const largerCache: ImmersiveMapSettings = ImmersiveMapSettings.default.preparedTileDiskCacheSize(ImmersiveMapByteCount.gigabytes(4));

/** The other units of a byte count. */
export const cacheSizes: ImmersiveMapByteCount[] = [
  ImmersiveMapByteCount.megabytes(1.5),
  ImmersiveMapByteCount.kilobytes(512),
  ImmersiveMapByteCount.bytes(1_000_000),
];
