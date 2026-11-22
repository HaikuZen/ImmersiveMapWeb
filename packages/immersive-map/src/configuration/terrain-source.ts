// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * How a pixel of a terrain tile holds its height in metres
 * (`ImmersiveMapTerrainSource.encoding`). Both are RGB images, PNG or
 * WebP, and differ only in the arithmetic.
 *
 * - `terrarium`: red × 256 + green + blue / 256 − 32768. Mapterhorn, AWS
 *   Terrain Tiles and most open sources.
 * - `mapbox`: (red × 65536 + green × 256 + blue) × 0.1 − 10000. Mapbox
 *   Terrain-DEM and Terrain-RGB, and MapTiler's terrain.
 */
export type GroundReliefEncoding = "terrarium" | "mapbox";

/** Every encoding, in the order declared. */
export const groundReliefEncodings: readonly GroundReliefEncoding[] = Object.freeze(["terrarium", "mapbox"]);

/**
 * Where the ground relief's heights come from: terrain tiles at a URL
 * template, how their pixels hold a height, and the credit the data asks
 * for. Only the source: how the relief draws is
 * `ImmersiveMapSettings.groundRelief(...)`.
 *
 * ```ts
 * ImmersiveMapSettings.default
 *   .terrain(ImmersiveMapTerrainSource.make({
 *     tileURLTemplate: "https://terrain.example.com/{z}/{x}/{y}.png",
 *     encoding: "mapbox",
 *     credit: "© Example Terrain",
 *   }))
 *   .groundRelief({ isEnabled: true });
 * ```
 *
 * The default is `ImmersiveMapTerrainSource.mapterhorn`.
 */
export interface ImmersiveMapTerrainSource {
  /**
   * The terrain tiles: a URL with `{z}`, `{x}` and `{y}` in it, of square
   * images (PNG or WebP, of any size) whose pixels hold heights in
   * `encoding`. An HTTP 404 is a tile the source does not have.
   */
  readonly tileURLTemplate: string;
  /** How a pixel of a terrain tile holds its height. */
  readonly encoding: GroundReliefEncoding;
  /**
   * The credit the terrain's license asks for, laid on the attribution
   * line at the camera zooms the relief stands out of the plane at
   * (`GroundReliefSettings.appearZoom` up to `collapseZoom`). Null credits
   * nothing, for a source whose credit the app states itself with
   * `attributionSettings`.
   */
  readonly credit: string | null;
}

/** The fields of a terrain source, the template alone required. */
export interface ImmersiveMapTerrainSourceOptions {
  readonly tileURLTemplate: string;
  /** Terrarium by default. */
  readonly encoding?: GroundReliefEncoding | undefined;
  /** None by default. */
  readonly credit?: string | null | undefined;
}

function make(options: ImmersiveMapTerrainSourceOptions): ImmersiveMapTerrainSource {
  return Object.freeze({
    tileURLTemplate: options.tileURLTemplate,
    encoding: options.encoding ?? "terrarium",
    credit: options.credit ?? null,
  });
}

/** The terrain sources. */
export const ImmersiveMapTerrainSource = Object.freeze({
  make,

  /**
   * Mapterhorn's open global terrain, in Terrarium: 30 m everywhere to
   * zoom 12, and lidar deeper where a country publishes it. Credited as
   * Mapterhorn asks.
   */
  mapterhorn: make({
    tileURLTemplate: "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp",
    encoding: "terrarium",
    credit: "© Mapterhorn",
  }),
});
