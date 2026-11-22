// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** A half-open range of camera zoom, `lowerBound` up to and not including `upperBound`. */
export interface ZoomRange {
  readonly lowerBound: number;
  readonly upperBound: number;
}

/** One credit on the attribution line. */
export interface ImmersiveMapAttributionCredit {
  /** The words, as the data's license asks for them. */
  readonly text: string;
  /**
   * The camera zooms the credited data is on screen at, a half-open range
   * of camera zoom (`{ lowerBound: 0, upperBound: 8 }` is zoom 0 up to, not
   * including, 8). Null shows the credit at every zoom. The badge drops the
   * credit outside the range, so a credit is shown where its data is and
   * not where the map draws none of it.
   */
  readonly zoomRange: ZoomRange | null;
}

/**
 * Map data source attribution: what a product using third-party data is
 * obligated to display. It belongs to the data, not the engine: the tile
 * source brings the tiles, so it knows whose data they are and under
 * which license they are served, and the engine adds the credit of the
 * data it ships itself (the overview of the globe).
 *
 * The badge is one line of credits along the map's edge, in the order
 * given, each one shown at the camera zooms its data is on screen at. A
 * data set that the map draws through a few zooms only, as the overview
 * of the globe, is credited at those zooms and not past them.
 *
 * The data's credits are what the licenses require. The engine's own,
 * `ImmersiveMapAttribution.engineCredit`, opens the line by default as a
 * courtesy the MIT license does not ask for, and goes with
 * `AttributionSettings.showsEngineCredit`.
 */
export interface ImmersiveMapAttribution {
  /** The credits, in the order they are shown on the line. */
  readonly credits: readonly ImmersiveMapAttributionCredit[];
  /** Where a tap on the badge leads. Usually the data source's license page. */
  readonly linkURL: string | null;
}

/** One credit, at every zoom unless a range is given. */
function credit(text: string, zoomRange: ZoomRange | null = null): ImmersiveMapAttributionCredit {
  return Object.freeze({ text, zoomRange: zoomRange === null ? null : Object.freeze({ ...zoomRange }) });
}

/** An attribution of credits, in the order they are shown. */
function make(credits: readonly ImmersiveMapAttributionCredit[], linkURL: string | null = null): ImmersiveMapAttribution {
  return Object.freeze({ credits: Object.freeze([...credits]), linkURL });
}

/** One credit for every zoom, the common case of one data source. */
function single(text: string, linkURL: string | null = null): ImmersiveMapAttribution {
  return make([credit(text)], linkURL);
}

/**
 * Whether a credit shows at a camera zoom. An unknown zoom (null, before
 * the camera is placed) shows every credit: the safe side of a license.
 */
function isShown(entry: ImmersiveMapAttributionCredit, zoom: number | null): boolean {
  if (zoom === null || entry.zoomRange === null) {
    return true;
  }
  return zoom >= entry.zoomRange.lowerBound && zoom < entry.zoomRange.upperBound;
}

/** No words to show at any zoom. */
function isEmpty(attribution: ImmersiveMapAttribution): boolean {
  return attribution.credits.every((entry) => entry.text.length === 0);
}

/** The credits with words that show at a camera zoom, in order. */
function creditsAtZoom(attribution: ImmersiveMapAttribution, zoom: number | null): ImmersiveMapAttributionCredit[] {
  return attribution.credits.filter((entry) => entry.text.length > 0 && isShown(entry, zoom));
}

/** The attribution with a credit added at the end of the line. */
function appending(attribution: ImmersiveMapAttribution, entry: ImmersiveMapAttributionCredit): ImmersiveMapAttribution {
  return make([...attribution.credits, entry], attribution.linkURL);
}

/** The credit of the overview's biomes (CC BY 4.0), the data the engine lays into the globe's tiles itself. */
const overviewCreditText = "Biomes © RESOLVE, CC BY 4.0";

/** The attribution values and their arithmetic. */
export const ImmersiveMapAttribution = Object.freeze({
  make,
  single,
  credit,
  isShown,
  isEmpty,
  creditsAtZoom,
  appending,

  /**
   * Empty attribution: the badge draws nothing. The default for sources
   * whose data source is unknown to the engine. If such a source serves OSM
   * or other data that requires attribution, its author must set it.
   */
  none: make([]),

  /**
   * The engine's own credit, the first on the default badge's line
   * (`ImmersiveMapSettings.resolvedAttribution`). A courtesy, not a
   * license term: `AttributionSettings.showsEngineCredit` drops it.
   */
  engineCredit: credit("Powered by ImmersiveMap"),

  /** Minimal attribution for OpenStreetMap data (ODbL). */
  openStreetMap: single("© OpenStreetMap contributors", "https://www.openstreetmap.org/copyright"),

  /** The words of the overview's credit. */
  overviewCreditText,

  /**
   * The overview's credit, shown from zoom 0 up to `maximumZoom`
   * (`TileSettings.OverviewSettings.creditMaximumZoom`).
   */
  overviewCredit(maximumZoom: number): ImmersiveMapAttributionCredit {
    return credit(overviewCreditText, { lowerBound: 0, upperBound: maximumZoom });
  },
});
