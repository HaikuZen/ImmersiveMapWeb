// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The look of the built-in style (the Protomaps basemap) as plain values,
// mirroring Swift's `ProtomapsBasemapTheme` field for field. Every field
// name is the Swift property's, which is also the JSON name the `map-style`
// crate reads and writes (serde camelCase), so a theme crosses to the Rust
// worker as it is. Colours are RGBA (`Rgba`) or RGB (`Rgb`) in 0...1, zoom
// curves are `{ zoom: value }`, and an absent Swift optional is `null`.
//
// The rules that read a theme (the layer logic, the route signs' matching,
// the cache fingerprint) live with the style in the `map-style` crate. This
// module holds the values, the two shipped themes and the few readings the
// settings need.

import type { Rgb, Rgba } from "../configuration/color.ts";
import { deepEqual, deepFreeze } from "../configuration/deep.ts";
import type { DeepMutable } from "../configuration/deep.ts";
import { zoomCurve, zoomCurveValue } from "../configuration/zoom-curve.ts";
import type { ImmersiveMapZoomCurve, ZoomCurveInput } from "../configuration/zoom-curve.ts";

// MARK: Labels

/** The two faces of the label font. */
export type LabelFontWeight = "bold" | "thin";

/** How far the letters are grown past the font's outline by default, in layout points. */
export const defaultEmboldenPoints = 0.375;

export interface LabelAppearance {
  readonly fillColor: Rgb;
  readonly strokeColor: Rgb;
  /** Halo width as a fraction of the em, so it tracks the text size. */
  readonly haloEm: number;
  /**
   * Em size in layout points (CSS pixels), not device pixels: the engine
   * multiplies by the display's pixels-per-point at render time, so a value
   * here reads at the same physical size on a 2x desktop display and a 3x
   * phone.
   */
  readonly sizePoints: number;
  readonly weight: LabelFontWeight;
  /** Whether the label is set in capitals. */
  readonly uppercased: boolean;
  /** How far the letters are grown past the font's outline, in layout points. */
  readonly emboldenPoints: number;
  /**
   * Extra room after every letter, in ems: the tracking of a name spaced
   * out over the land it names.
   */
  readonly letterSpacingEm: number;
  /**
   * The opacity of the label, fill and halo alike: 1 solid, less lets the
   * map show through a name laid over it.
   */
  readonly opacity: number;
  /**
   * How softly the halo ends: the share of its width over which it fades
   * out into the map, 0 a halo solid to its edge.
   */
  readonly haloSoftness: number;
}

/** The fields of a label appearance: the colours, the halo, the size and the weight required. */
export interface LabelAppearanceOptions {
  readonly fillColor: Rgb;
  readonly strokeColor: Rgb;
  readonly haloEm: number;
  readonly sizePoints: number;
  readonly weight: LabelFontWeight;
  readonly uppercased?: boolean | undefined;
  readonly emboldenPoints?: number | undefined;
  readonly letterSpacingEm?: number | undefined;
  readonly opacity?: number | undefined;
  readonly haloSoftness?: number | undefined;
}

/** A label appearance, the unstated fields at their defaults. */
export function labelAppearance(options: LabelAppearanceOptions): LabelAppearance {
  return deepFreeze({
    fillColor: options.fillColor,
    strokeColor: options.strokeColor,
    haloEm: options.haloEm,
    sizePoints: options.sizePoints,
    weight: options.weight,
    uppercased: options.uppercased ?? false,
    emboldenPoints: options.emboldenPoints ?? defaultEmboldenPoints,
    letterSpacingEm: options.letterSpacingEm ?? 0,
    opacity: options.opacity ?? 1,
    haloSoftness: options.haloSoftness ?? 0,
  });
}

/**
 * The colours of the POI icons' plates, one per category of place, RGB in
 * `0...1`: the icon stands white on the plate, and the POI's name is set in
 * the same colour. The categories are the built-in style's reading of the
 * basemap's POI kinds.
 */
export interface PoiCategoryColors {
  /** Restaurants and fast food. */
  readonly food: Rgb;
  /** Cafés and bakeries. */
  readonly coffee: Rgb;
  /** Bars, pubs and clubs. */
  readonly bar: Rgb;
  /** Shops and markets. */
  readonly shop: Rgb;
  /** Hotels and hostels. */
  readonly hotel: Rgb;
  /** Hospitals, pharmacies and clinics. */
  readonly health: Rgb;
  /** Schools, universities and libraries. */
  readonly education: Rgb;
  /** Museums, theatres and attractions. */
  readonly culture: Rgb;
  /** Parks, gardens and sports grounds. */
  readonly leisure: Rgb;
  /** Stations, stops, fuel and parking. */
  readonly transport: Rgb;
  /** Offices and public services. */
  readonly civic: Rgb;
  /** Places of worship. */
  readonly worship: Rgb;
}

/** The day's plates. */
export const defaultPoiCategoryColors: PoiCategoryColors = deepFreeze({
  food: [0.85, 0.4, 0.12],
  coffee: [0.58, 0.37, 0.18],
  bar: [0.62, 0.16, 0.34],
  shop: [0.16, 0.44, 0.78],
  hotel: [0.66, 0.26, 0.6],
  health: [0.82, 0.22, 0.26],
  education: [0.22, 0.46, 0.52],
  culture: [0.46, 0.3, 0.66],
  leisure: [0.22, 0.54, 0.3],
  transport: [0.32, 0.42, 0.55],
  civic: [0.4, 0.44, 0.52],
  worship: [0.55, 0.45, 0.22],
});

/** The plates with `change` applied to each, the way a theme sinks them into a night. */
export function mapPoiCategoryColors(colors: PoiCategoryColors, change: (color: Rgb) => Rgb): PoiCategoryColors {
  return deepFreeze({
    food: change(colors.food),
    coffee: change(colors.coffee),
    bar: change(colors.bar),
    shop: change(colors.shop),
    hotel: change(colors.hotel),
    health: change(colors.health),
    education: change(colors.education),
    culture: change(colors.culture),
    leisure: change(colors.leisure),
    transport: change(colors.transport),
    civic: change(colors.civic),
    worship: change(colors.worship),
  });
}

export interface LabelStyles {
  readonly city: LabelAppearance;
  readonly town: LabelAppearance;
  /**
   * The districts of a city: its neighbourhoods and the larger quarters
   * they make up, and the places smaller than a town (a village, a hamlet,
   * a named square).
   */
  readonly district: LabelAppearance;
  /**
   * A country's name: the name of a land, not of a point, so by default it
   * is set apart from the places in it, in spaced capitals above every
   * city's size.
   */
  readonly country: LabelAppearance;
  /**
   * A region's name (a state, a province, a land): under the country's, in
   * the same manner, above a city's.
   */
  readonly region: LabelAppearance;
  readonly poi: LabelAppearance;
  readonly water: LabelAppearance;
  readonly road: LabelAppearance;
  /**
   * The plates of the POI icons, one colour per category of place
   * (`PoiCategoryColors`). A POI of no category wears `poi`'s fill.
   */
  readonly poiCategories: PoiCategoryColors;
}

/**
 * Sizes are layout points: the pixel size this style used before labels
 * carried a unit, divided by the 2x reference scale the palette was
 * authored against.
 *
 * The curve below is the design, not the final size. Sizes are raised to
 * the floor for readable type where they fall under it, and that happens
 * once, where a style is resolved, so that a class derived from another (an
 * ocean label is the water appearance a few points larger) is measured
 * against the floor after its own adjustment rather than on top of a base
 * that was already lifted.
 *
 * Every name is laid over the map a little transparent (0.8, the countries
 * and the regions lighter still), and every halo fades out over the outer
 * half of its width, so a name reads without standing out of the map as a
 * sticker would.
 */
export const defaultLabelStyles: LabelStyles = deepFreeze({
  city: labelAppearance({
    fillColor: [0.2, 0.2, 0.22],
    strokeColor: [1, 1, 1],
    haloEm: 0.153,
    sizePoints: 15,
    weight: "bold",
    opacity: 0.8,
    haloSoftness: 0.5,
  }),
  town: labelAppearance({
    fillColor: [0.3, 0.3, 0.32],
    strokeColor: [1, 1, 1],
    haloEm: 0.173,
    sizePoints: 11,
    weight: "thin",
    opacity: 0.8,
    haloSoftness: 0.5,
  }),
  // The districts are lettered like the streets, the deep black being the
  // cities' alone: light grey capitals in the thin face with a little added
  // weight and a narrow halo, so a district names the stretch of the city it
  // lies over without standing out of it.
  district: labelAppearance({
    fillColor: [0.45, 0.45, 0.46],
    strokeColor: [1, 1, 1],
    haloEm: 0.1,
    sizePoints: 10,
    weight: "thin",
    uppercased: true,
    emboldenPoints: 0.2,
    opacity: 0.8,
    haloSoftness: 0.5,
  }),
  // A country's name is the name of a land: spaced capitals in the thin face
  // with a little added weight, a shade above a capital's size (16.5), in a
  // lighter grey of its own with a narrow halo, so it reads as lettering over
  // the country and not as one more town, and a globe full of them stays
  // quiet. Both are lettering laid over the land, so they let the map show
  // through them. A region's name is the same manner, a city's size and
  // lighter still.
  country: labelAppearance({
    fillColor: [0.38, 0.37, 0.44],
    strokeColor: [1, 1, 1],
    haloEm: 0.1,
    sizePoints: 17,
    weight: "thin",
    uppercased: true,
    emboldenPoints: 0.3,
    letterSpacingEm: 0.12,
    opacity: 0.65,
    haloSoftness: 0.5,
  }),
  region: labelAppearance({
    fillColor: [0.46, 0.45, 0.51],
    strokeColor: [1, 1, 1],
    haloEm: 0.1,
    sizePoints: 15,
    weight: "thin",
    uppercased: true,
    emboldenPoints: 0.3,
    letterSpacingEm: 0.1,
    opacity: 0.7,
    haloSoftness: 0.5,
  }),
  poi: labelAppearance({
    fillColor: [0.4, 0.42, 0.4],
    strokeColor: [1, 1, 1],
    haloEm: 0.225,
    sizePoints: 8,
    weight: "thin",
    opacity: 0.8,
    haloSoftness: 0.5,
  }),
  // The water names lie on the water: a deeper blue of its own hue and no
  // halo, so they read as part of the surface.
  water: labelAppearance({
    fillColor: [0.29, 0.49, 0.71],
    strokeColor: [1, 1, 1],
    haloEm: 0,
    sizePoints: 9.5,
    weight: "thin",
    opacity: 0.8,
  }),
  // The street names stay under the places and the landmarks: small light
  // grey capitals in the thin face with a little added weight and a narrow
  // halo, the way a commercial map letters its streets, so a street reads as
  // a street and never outweighs the city it runs through.
  road: labelAppearance({
    fillColor: [0.45, 0.45, 0.46],
    strokeColor: [1, 1, 1],
    haloEm: 0.1,
    sizePoints: 11,
    weight: "thin",
    uppercased: true,
    emboldenPoints: 0.2,
    opacity: 0.8,
    haloSoftness: 0.5,
  }),
  poiCategories: defaultPoiCategoryColors,
});

/**
 * The zoom a POI category waits for, whatever the basemap ranks the POI
 * at. The categories not named here follow the basemap alone.
 */
export interface PoiCategoryZooms {
  /**
   * Universities, colleges and institutes: many, large and named at
   * length, so they would crowd out the landmarks at z13.
   */
  readonly campus: number;
  /** Shops, other than malls, department stores and markets. */
  readonly shop: number;
  /**
   * The street-level services: post and parcel offices, banks and cash
   * machines, pharmacies, clinics and doctors, schools and kindergartens,
   * offices of the state, embassies, police and fire stations, public
   * toilets, fuel and charging.
   */
  readonly service: number;
  /**
   * The pieces of transit: stops, platforms, metro entrances, taxi ranks,
   * parking and bike docks. The stations themselves follow the basemap.
   */
  readonly transitDetail: number;
}

/**
 * Zoom thresholds that decide whether a label class is drawn at all (as
 * opposed to `LabelStyles`, which only decides how a drawn label looks).
 *
 * The default is a density curve, not a filter: a city centre reads at
 * every zoom instead of drowning in names. A POI shows from the zoom the
 * basemap ranks it at (its `min_zoom`), so the landmarks, the parks and the
 * metro lead at z13 and z14, and the restaurants, cafés and shops come in
 * at z16 and z17. On top of that, the categories that help only someone
 * standing in the street (post offices, cash machines, clinics, schools,
 * stops and entrances, parking, named plots without a symbol) wait for the
 * street zooms, and so do the house numbers and the longest names.
 */
export interface LabelVisibility {
  /**
   * Whether a POI needs an icon to be labelled at all.
   *
   * A category the icon set does not recognize (an office, a company, a
   * monument, a named building) has nothing to draw but its name, and those
   * names are the bulk of a city centre's POIs: bare text over the
   * buildings, in the type size of a landmark, saying nothing about what the
   * place is. The default draws their names alone, without an icon, from
   * `poiIconlessMinimumZoom` on. Set to `true` to leave them out altogether.
   */
  readonly poiRequiresIcon: boolean;
  /**
   * Minimum camera zoom from which icon-less POIs (offices, companies, and
   * other categories outside the set of recognized icons) are drawn. POIs
   * with an icon draw from the regular threshold, so overview zooms keep
   * only icon POIs while the dense scatter of text-only labels kicks in
   * deeper. Read only when `poiRequiresIcon` is `false`, since otherwise
   * icon-less POIs are not drawn at any zoom.
   */
  readonly poiIconlessMinimumZoom: number;
  /**
   * Minimum camera zoom from which any POI label (icon or icon-less) is
   * drawn, applied on top of the rank-derived thresholds. The default 0
   * keeps the rank behavior. A value above the camera's maximum zoom hides
   * POIs entirely (useful for clean cinematic footage).
   */
  readonly poiMinimumZoom: number;
  /**
   * Whether a POI waits for the zoom the basemap ranks it at, its
   * `min_zoom`. Off, every POI a tile ships competes from the tile's own
   * zoom, and only the collisions thin them out.
   */
  readonly poiFollowsSourceMinimumZoom: boolean;
  /** The zooms whole POI categories wait for. */
  readonly poiCategoryMinimumZoom: PoiCategoryZooms;
  /**
   * A POI whose name runs past `poiLongNameCharacterCount` characters waits
   * for this zoom: a name that wraps to three lines is a block of text, not
   * a label, until the map has room for it.
   */
  readonly poiLongNameMinimumZoom: number;
  readonly poiLongNameCharacterCount: number;
  /** Minimum camera zoom of the house numbers. */
  readonly addressMinimumZoom: number;
  /**
   * The camera zoom a country's name goes away at: shown below it, hidden
   * from it on. The basemap ships the names of the countries into the
   * street zooms, where a name that stands for the whole land reads as one
   * more town among the towns. The default keeps it to the views that hold
   * a country, up to zoom 7.
   */
  readonly countryMaximumZoom: number;
  /**
   * The camera zoom a region's name goes away at, as `countryMaximumZoom`:
   * a state or a province is read a couple of zooms deeper than its
   * country.
   */
  readonly regionMaximumZoom: number;
  /**
   * Whether the local detail, the icon-less POIs (a memorial, an office, a
   * ticket window) and the house numbers, shows only near the camera: in
   * the three by three tiles around the look-at tile, and there within
   * `LabelBaseSettings.localDetailMaximumDistanceMeters` of the camera. They
   * are what one reads standing next to them, and on a tilted map the
   * street beyond would fill with small text saying nothing at that
   * distance. Off, they show wherever their zoom lets them. Baked into the
   * prepared tiles, so a change re-parses them.
   */
  readonly localDetailInLookAtTileOnly: boolean;
}

export const defaultLabelVisibility: LabelVisibility = deepFreeze({
  poiRequiresIcon: false,
  poiIconlessMinimumZoom: 17,
  poiMinimumZoom: 0,
  poiFollowsSourceMinimumZoom: true,
  poiCategoryMinimumZoom: { campus: 14, shop: 16, service: 17, transitDetail: 17 },
  poiLongNameMinimumZoom: 17,
  poiLongNameCharacterCount: 32,
  addressMinimumZoom: 17,
  countryMaximumZoom: 8,
  regionMaximumZoom: 10,
  localDetailInLookAtTileOnly: true,
});

// MARK: Roads

/**
 * The road classes the style draws, the tiers it folds the Protomaps
 * `roads` layer's `kind` and `kind_detail` into: a `highway` is a motorway,
 * a `major_road` is a trunk, primary, secondary or tertiary by its detail, a
 * `minor_road` is minor or service, a `path` is a path. `other` stands for
 * every road the style draws without naming its class.
 */
export type RoadClass = "motorway" | "trunk" | "primary" | "secondary" | "tertiary" | "minor" | "service" | "path" | "other";

/** Every road class, in the order declared. */
export const roadClasses: readonly RoadClass[] = Object.freeze([
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "minor",
  "service",
  "path",
  "other",
]);

/** One colour per road class, plus the rail, the casing and the paint on the asphalt. */
export interface RoadLayerStyles {
  readonly motorway: Rgba;
  readonly trunk: Rgba;
  readonly primary: Rgba;
  readonly secondary: Rgba;
  readonly tertiary: Rgba;
  readonly minor: Rgba;
  readonly service: Rgba;
  readonly path: Rgba;
  readonly rail: Rgba;
  readonly casing: Rgba;
  /**
   * The paint on the asphalt: the arrows of a one-way street. Fully opaque,
   * since two overlapping quads of a translucent colour composite twice and
   * stamp a denser patch.
   */
  readonly marking: Rgba;
}

/** An off-white that reads on the asphalt grey without glaring. */
export const defaultRoadMarking: Rgba = Object.freeze([0.97, 0.97, 0.96, 1.0]);

/**
 * Asphalt streets in the driving-map manner: every drive tier is the same
 * cool neutral grey, one road surface across the network, and importance
 * reads as width alone, motorways widest down to narrow service alleys.
 * Paths keep their warm gravel tone (they are not asphalt) and the casing
 * the style derives from these fills is a uniformly darker grey, so every
 * road sits in a slightly deeper edge.
 */
export const defaultRoadLayerStyles: RoadLayerStyles = deepFreeze({
  motorway: [0.757, 0.769, 0.784, 1.0],
  trunk: [0.757, 0.769, 0.784, 1.0],
  primary: [0.757, 0.769, 0.784, 1.0],
  secondary: [0.757, 0.769, 0.784, 1.0],
  tertiary: [0.757, 0.769, 0.784, 1.0],
  minor: [0.757, 0.769, 0.784, 1.0],
  service: [0.757, 0.769, 0.784, 1.0],
  // A pedestrian path is a warm sand tone a clear step under the ground,
  // the way Apple draws park walks: visible against the beige land and
  // against park green, yet quiet enough that the footway network stays a
  // texture rather than a second road system. It used to be the exact
  // ground off-white, which made every path invisible until it crossed a
  // park.
  path: [0.898, 0.871, 0.812, 1.0],
  rail: [0.741, 0.741, 0.765, 1.0],
  casing: [0.718, 0.725, 0.735, 1.0],
  marking: defaultRoadMarking,
});

/**
 * One value per road class (`RoadClass`), `other` standing for every road
 * the style draws without naming its class.
 */
export interface RoadClassValues<Value> {
  readonly motorway: Value;
  readonly trunk: Value;
  readonly primary: Value;
  readonly secondary: Value;
  readonly tertiary: Value;
  readonly minor: Value;
  readonly service: Value;
  readonly path: Value;
  readonly other: Value;
}

/** The value of a road class. */
export function roadClassValue<Value>(values: RoadClassValues<Value>, roadClass: RoadClass): Value {
  return values[roadClass];
}

/**
 * How wide the roads of the street era draw and from where, as opposed to
 * `RoadLayerStyles`, which is only their colours.
 */
export interface RoadMetrics {
  /**
   * The width of a class as a symbol, in points: what it draws at on screen
   * from `symbolZoom` up to `worldLockZoom`.
   */
  readonly symbolWidthPoints: RoadClassValues<number>;
  /**
   * The width of a class over a country view, in points: what it draws at
   * up to `overviewZoom`. Between `overviewZoom` and `symbolZoom` the width
   * grows from this to `symbolWidthPoints` by the same ratio per zoom level,
   * continuous in camera zoom, so a road never steps in width, neither with
   * the camera nor when the engine swaps the tile level serving it.
   */
  readonly overviewWidthPoints: RoadClassValues<number>;
  /** The camera zoom up to which a road is its overview stroke. */
  readonly overviewZoom: number;
  /** The camera zoom from which a road is its full symbol. */
  readonly symbolZoom: number;
  /**
   * The opacity of the overview stroke. It grows to one along with the
   * width, by `symbolZoom`. One by default: a road is opaque at every zoom,
   * which is what lets the engine shade each of its pixels once, with no
   * blending. Below one the stroke is a veil that lets the ground colours
   * stay the picture over a country view, and the roads blend until
   * `symbolZoom`.
   */
  readonly overviewOpacity: number;
  /**
   * The opacity of the overview stroke on the globe, `0...1`: a veil the
   * globe's view lays over the roads, so the painted ground stays the
   * picture of a continent and the roads a net over it. 0.6 by default. One
   * is the same stroke as on the plane. It holds through the globe's view
   * and its unroll into the plane, is handed over with the globe's air at
   * the end of the unroll (`PresentationSettings.airHandoverStart` to
   * `airHandoverEnd`), and the plane never has it, whatever
   * `overviewOpacity` says there. The engine blends each stroke once on the
   * globe, so the veil never darkens where two strokes cross.
   */
  readonly globeOpacity: number;
  /**
   * The camera zoom from which a road's width is fixed on the ground
   * instead of on screen. Up to it a road is a symbol of
   * `symbolWidthPoints`. Past it the road keeps the ground width the symbol
   * had at this zoom, so it doubles on screen with every zoom level, like
   * the blocks and the buildings around it, and never thins into a hairline
   * at street level. The handover is continuous in camera zoom. Zero keeps
   * every road a symbol at every zoom.
   */
  readonly worldLockZoom: number;
  /**
   * Whether the automobile roads wear a casing: an outline a point wide on
   * each side of a road's symbol that eases in at street zoom, and the kerb
   * of a measured junction surface. Off by default: the roads read as one
   * sheet of asphalt against the ground, and an outline around every street
   * turns the sheet back into separate ribbons.
   */
  readonly drawsCasing: boolean;
  /**
   * The tile zoom a class first draws at. The style draws what the tiles
   * carry from this zoom on. The default is 0 for every class, so a road
   * shows from the first tile the Protomaps basemap ships it in (motorways
   * from z4, trunks from z6, primaries from z7, secondaries from z10, the
   * minor network from z12).
   */
  readonly minimumTileZoom: RoadClassValues<number>;
}

/**
 * With every drive tier sharing one asphalt grey, width is the whole
 * hierarchy, so the ramp is spread wide.
 */
export const defaultSymbolWidthPoints: RoadClassValues<number> = Object.freeze({
  motorway: 13.65,
  trunk: 12.7,
  primary: 11.7,
  secondary: 5.0,
  tertiary: 4.5,
  minor: 4.0,
  service: 2.5,
  path: 2.0,
  other: 2.0,
});

/** The country view's ladder: hairlines whose rank still reads as width alone. */
export const defaultOverviewWidthPoints: RoadClassValues<number> = Object.freeze({
  motorway: 1.3,
  trunk: 1.1,
  primary: 0.9,
  secondary: 0.8,
  tertiary: 0.7,
  minor: 0.6,
  service: 0.5,
  path: 0.4,
  other: 0.4,
});

/**
 * No class is held back: the basemap's own tile levels decide where each
 * road first appears.
 */
export const defaultRoadMinimumTileZoom: RoadClassValues<number> = Object.freeze({
  motorway: 0,
  trunk: 0,
  primary: 0,
  secondary: 0,
  tertiary: 0,
  minor: 0,
  service: 0,
  path: 0,
  other: 0,
});

export const defaultRoadMetrics: RoadMetrics = deepFreeze({
  symbolWidthPoints: defaultSymbolWidthPoints,
  overviewWidthPoints: defaultOverviewWidthPoints,
  overviewZoom: 6,
  symbolZoom: 14,
  overviewOpacity: 1,
  globeOpacity: 0.6,
  worldLockZoom: 15,
  drawsCasing: false,
  minimumTileZoom: defaultRoadMinimumTileZoom,
});

// MARK: The globe's overview

/**
 * The biomes of the globe's overview: the colour of each of the fourteen
 * biomes of RESOLVE Ecoregions 2017 the engine lays into the tiles of the
 * overview zooms, the tones the tiles' own land cover draws over them in,
 * and the zooms of both. A biome is a region of one climate and vegetation,
 * so the palette is a physical atlas's: the forests in the greens, deepest
 * in the tropics and bluest in the taiga, the grasslands and the savannas in
 * the pale yellow-greens, the deserts alone in the sand, the tundra in a
 * grey-green a step off the ice. Everything that grows is a green, so a
 * cream on the map is dry ground and nothing else. Every value is baked into
 * the prepared tiles, so a change re-parses them.
 */
export interface BiomeStyles {
  /** `tropical_moist_forest`: the Amazon, the Congo, Southeast Asia. */
  readonly tropicalMoistForest: Rgba;
  /** `tropical_dry_forest`: the deciduous forests of India, Mexico, the Chaco. */
  readonly tropicalDryForest: Rgba;
  /** `tropical_conifer_forest`: the pine forests of Mexico and the Caribbean. */
  readonly tropicalConiferForest: Rgba;
  /** `temperate_broadleaf_forest`: Europe, the eastern United States, East Asia. */
  readonly temperateBroadleafForest: Rgba;
  /** `temperate_conifer_forest`: the Rockies, the Cascades, the Alps, Siberia's south. */
  readonly temperateConiferForest: Rgba;
  /** `boreal_forest`: the taiga of Canada, Scandinavia and Siberia. */
  readonly borealForest: Rgba;
  /** `tropical_grassland`: the savannas of Africa, the Cerrado, northern Australia. */
  readonly tropicalGrassland: Rgba;
  /** `temperate_grassland`: the prairies, the pampas, the steppes. */
  readonly temperateGrassland: Rgba;
  /** `flooded_grassland`: the Pantanal, the Sudd, the Okavango. */
  readonly floodedGrassland: Rgba;
  /** `montane_grassland`: the Tibetan plateau, the Andean puna, the Ethiopian highlands. */
  readonly montaneGrassland: Rgba;
  /** `tundra`: the Arctic coasts, the Antarctic shore, the high north. */
  readonly tundra: Rgba;
  /** `mediterranean_scrub`: the Mediterranean, California, the Cape, southwest Australia. */
  readonly mediterraneanScrub: Rgba;
  /** `desert`: the Sahara, Arabia, Central Asia, the Australian outback. */
  readonly desert: Rgba;
  /** `mangrove`: the tropical tidal forests. */
  readonly mangrove: Rgba;
  /**
   * The forests of the tiles' own land cover and land use drawn over the
   * biomes, from `coverMinimumTileZoom`: a step darker than the forest
   * biomes, so a wood reads on them.
   */
  readonly forestCover: Rgba;
  /**
   * The fields drawn over the biomes: the hue of the temperate forest biomes
   * they mostly lie on, a shade lighter (the same hue and chroma, the
   * lightness up by a twentieth), so a plain reads as open land on a wooded
   * biome and the greens layer in one tone, the biome, the fields on it, the
   * woods on both. Not a wheat, which stood in one row with the deserts and
   * made France read as the Sahara, and not a yellower green, which cut the
   * fields out of the map instead of laying them on it.
   */
  readonly farmlandCover: Rgba;
  /**
   * The bare ground (the basemap's `barren`, the sand and the rock of the
   * land use) drawn over the biomes: the sand.
   */
  readonly barrenCover: Rgba;
  /**
   * The deepest tile zoom the biomes draw at, 7 by default, the last zoom
   * the basemap ships its land cover for. Through it the biomes paint the
   * land in place of the tiles' own land cover and land use, which draw over
   * them from `coverMinimumTileZoom`, and the biomes fade out with the land
   * cover over camera zoom 7 to 8, where the street map's land tone and land
   * use take over. The overview archive goes to tile zoom 7, so a deeper
   * zoom draws no biomes. A lower zoom hands the land to the source's land
   * cover earlier, and a negative zoom never draws the biomes.
   */
  readonly maximumTileZoom: number;
  /**
   * The tile zoom from which the tiles' own forests, fields, bare ground,
   * wetlands and ice draw over the biomes, in the cover tones above, 2 by
   * default. Under it the globe is the biomes alone, with the ice and the
   * cities: a region of one climate in one tone. From it the cover gives the
   * ground its structure, the fields against the woods, and the holes
   * between the land cover's raster-derived blobs show the biome instead of
   * bare land.
   */
  readonly coverMinimumTileZoom: number;
  /**
   * How many camera zooms the cover takes to come in over the biomes from
   * `coverMinimumTileZoom`, 1 by default: the forests, the fields and the
   * bare ground of the first cover tiles fade in with the camera over that
   * span rather than appearing whole at the zoom, a fixed fade by the
   * camera's zoom, not an animation. Zero shows them whole from the zoom. A
   * span longer than one zoom fades the tiles of the next zooms too, while
   * the camera is within it.
   */
  readonly coverFadeInZooms: number;
}

/** The atlas palette. */
export const defaultBiomeStyles: BiomeStyles = deepFreeze({
  tropicalMoistForest: [0.624, 0.812, 0.541, 1.0],
  tropicalDryForest: [0.706, 0.847, 0.58, 1.0],
  tropicalConiferForest: [0.651, 0.82, 0.561, 1.0],
  temperateBroadleafForest: [0.667, 0.835, 0.576, 1.0],
  temperateConiferForest: [0.639, 0.812, 0.576, 1.0],
  borealForest: [0.686, 0.827, 0.643, 1.0],
  tropicalGrassland: [0.812, 0.886, 0.643, 1.0],
  temperateGrassland: [0.788, 0.865, 0.654, 1.0],
  floodedGrassland: [0.741, 0.855, 0.698, 1.0],
  montaneGrassland: [0.804, 0.863, 0.69, 1.0],
  tundra: [0.867, 0.894, 0.839, 1.0],
  mediterraneanScrub: [0.788, 0.851, 0.604, 1.0],
  desert: [0.949, 0.922, 0.808, 1.0],
  mangrove: [0.741, 0.855, 0.698, 1.0],
  forestCover: [0.58, 0.77, 0.49, 1.0],
  farmlandCover: [0.728, 0.865, 0.654, 1.0],
  barrenCover: [0.95, 0.91, 0.78, 1.0],
  maximumTileZoom: 7,
  coverMinimumTileZoom: 2,
  coverFadeInZooms: 1,
});

/** The colour fields of the biomes, in the order declared. */
export const biomeColorKeys = Object.freeze([
  "tropicalMoistForest",
  "tropicalDryForest",
  "tropicalConiferForest",
  "temperateBroadleafForest",
  "temperateConiferForest",
  "borealForest",
  "tropicalGrassland",
  "temperateGrassland",
  "floodedGrassland",
  "montaneGrassland",
  "tundra",
  "mediterraneanScrub",
  "desert",
  "mangrove",
  "forestCover",
  "farmlandCover",
  "barrenCover",
] as const);

/**
 * The road network of the globe's overview: the Natural Earth 1:10m roads
 * the engine lays into the tiles of the overview zooms (layer `road`) in
 * place of the basemap's own roads, which at those zooms are the motorways
 * alone, a few pieces in most of the world, since the trunks arrive at tile
 * zoom 6. The network is one continuous line per road, ranked 3
 * (continental) to 7 (regional), and draws through `maximumTileZoom`, where
 * the basemap's trunks take over. The roads of the map's own tiles are
 * hidden through that zoom. The same tones are what the basemap's own
 * overview strokes wear on the globe past the network's zoom, through the
 * unroll into the plane, where the asphalt arrives. Every value is baked
 * into the prepared tiles, so a change re-parses them.
 */
export interface OverviewRoadStyles {
  /** The main roads, rank up to `majorMaximumRank`: the yellow of an atlas's highways over the painted land. */
  readonly major: Rgba;
  /** The rest of the network, thinner and paler. */
  readonly minor: Rgba;
  readonly majorWidthPoints: number;
  readonly minorWidthPoints: number;
  /** The last rank that draws as a main road, 4 by default: the continental routes and the first regional ones. */
  readonly majorMaximumRank: number;
  /**
   * The last tile zoom the network draws at, 5 by default, the zoom before
   * the basemap ships its trunks. The archive carries the roads through
   * tile zoom 5, so a higher value shows nothing more.
   */
  readonly maximumTileZoom: number;
}

export const defaultOverviewRoadStyles: OverviewRoadStyles = deepFreeze({
  major: [0.961, 0.78, 0.302, 1.0],
  minor: [0.945, 0.863, 0.6, 1.0],
  majorWidthPoints: 1.6,
  minorWidthPoints: 1.0,
  majorMaximumRank: 4,
  maximumTileZoom: 5,
});

// MARK: Trees

/**
 * The trees a fill grows: the engine's tree model stood on a lattice over
 * the fill, at `spacingMetres`, each tree of its own height.
 */
export interface TreeFillStyle {
  /**
   * The distance between neighbouring trees in metres, the lattice's cell:
   * 9 for a wood whose crowns touch, 20 and more for the scattered trees of
   * a park.
   */
  readonly spacingMetres: number;
  /** The height of the shortest tree in metres: every tree takes its own height between the two. */
  readonly minimumHeightMetres: number;
  /** The height of the tallest tree in metres. */
  readonly maximumHeightMetres: number;
  /**
   * How far from a road's edge a tree keeps, in metres, beyond the road's
   * own width as the style draws it: the verge no trunk stands on, whatever
   * the fill says. Every road of the ground counts, a park's paths among
   * them, not the tunnels and the bridges. 3 by default.
   */
  readonly roadClearanceMetres: number;
}

/**
 * The trees of a fill. The spacing is at least half a metre, the heights
 * at least zero and the tallest never under the shortest, the clearance at
 * least zero.
 */
export function treeFillStyle(options: {
  readonly spacingMetres: number;
  /** The shortest and the tallest tree, in metres. */
  readonly heightMetres: readonly [number, number];
  readonly roadClearanceMetres?: number | undefined;
}): TreeFillStyle {
  const minimumHeightMetres = Math.max(options.heightMetres[0], 0);
  return Object.freeze({
    spacingMetres: Math.max(options.spacingMetres, 0.5),
    minimumHeightMetres,
    maximumHeightMetres: Math.max(options.heightMetres[1], minimumHeightMetres),
    roadClearanceMetres: Math.max(options.roadClearanceMetres ?? 3, 0),
  });
}

/**
 * A tree that stands at a point the data maps it at (OpenStreetMap's
 * `natural=tree`): one tree of the engine's model there, sized and turned
 * by a hash of its place, among the trees the fills grow (`TreeFillStyle`).
 * The scattered trees keep off its crown, so a mapped tree in a park is
 * never doubled.
 */
export interface TreePointStyle {
  /**
   * The height of the shortest mapped tree in metres: each takes its own
   * between the two, since the data states none.
   */
  readonly minimumHeightMetres: number;
  /** The height of the tallest mapped tree in metres. */
  readonly maximumHeightMetres: number;
  /** How far from a mapped tree no scattered tree stands, in metres: about its crown's radius. */
  readonly crownClearanceMetres: number;
}

/** The mapped trees, the heights and the clearance at least zero. */
export function treePointStyle(options: {
  readonly heightMetres: readonly [number, number];
  readonly crownClearanceMetres?: number | undefined;
}): TreePointStyle {
  const minimumHeightMetres = Math.max(options.heightMetres[0], 0);
  return Object.freeze({
    minimumHeightMetres,
    maximumHeightMetres: Math.max(options.heightMetres[1], minimumHeightMetres),
    crownClearanceMetres: Math.max(options.crownClearanceMetres ?? 4, 0),
  });
}

/**
 * The colours of the trees that stand on the woods and the parks
 * (`TreeFillStyle`, `TreeSettings`). The tree model carries no colour of its
 * own, only which part a point belongs to and how deep in the crown it
 * lies, and the frame colours it from here: the crown runs from
 * `crownShadeColor` at its underside to `crownColor` at its top, the trunk
 * is `trunkColor`, each tree a shade lighter or darker than the next. Drawn
 * at frame time, never baked into the prepared tiles, so a change needs no
 * re-parse. RGB in 0...1.
 */
export interface ImmersiveMapTreePalette {
  /** The crown's top, in the light. */
  readonly crownColor: Rgb;
  /** The crown's underside, in its own shade. */
  readonly crownShadeColor: Rgb;
  readonly trunkColor: Rgb;
}

/** The tree palettes. */
export const ImmersiveMapTreePalette = Object.freeze({
  /**
   * The day's trees: a crown a touch deeper than the map's wood, so a tree
   * reads on it, lightening to the wood's own tone at the top.
   */
  default: deepFreeze<ImmersiveMapTreePalette>({
    crownColor: [0.64, 0.82, 0.46],
    crownShadeColor: [0.4, 0.63, 0.36],
    trunkColor: [0.48, 0.36, 0.25],
  }),
  /**
   * The night's trees, for the night palette (`nightTheme`): the crown a dim
   * green over the night's wood, the trunk nearly lost in the dark.
   */
  night: deepFreeze<ImmersiveMapTreePalette>({
    crownColor: [0.17, 0.3, 0.22],
    crownShadeColor: [0.08, 0.16, 0.13],
    trunkColor: [0.14, 0.12, 0.11],
  }),
});

/**
 * The trees the street zooms' greenery grows (`TreeFillStyle`): the
 * engine's tree model stood over the fills, each kind at its own spacing
 * and height, null for a kind that grows none. When they draw is the
 * settings' (`TreeSettings`). Baked into the prepared tiles, so a change
 * re-parses them.
 */
export interface TreeStyles {
  /** The trees of a wood or a forest (`landuse` forest and wood): a close stand, the crowns touching. */
  readonly wood: TreeFillStyle | null;
  /** The trees of the parks, the gardens, the cemeteries and the reserves: scattered, with lawn between them. */
  readonly park: TreeFillStyle | null;
  /**
   * The trees the data maps one by one, at their points (the basemap's
   * `pois` of kind `tree`, OpenStreetMap's `natural=tree`): the street
   * trees, the trees of a square. Null plants none.
   */
  readonly mapped: TreePointStyle | null;
  /** The colours of every tree (`ImmersiveMapTreePalette`), drawn at frame time: a change needs no re-parse. */
  readonly palette: ImmersiveMapTreePalette;
}

export const defaultTreeStyles: TreeStyles = deepFreeze({
  wood: treeFillStyle({ spacingMetres: 9, heightMetres: [7, 11] }),
  park: treeFillStyle({ spacingMetres: 22, heightMetres: [6, 10] }),
  mapped: treePointStyle({ heightMetres: [7, 12], crownClearanceMetres: 4 }),
  palette: ImmersiveMapTreePalette.default,
});

// MARK: Layers and features

export interface LayerStyles {
  readonly land: Rgba;
  readonly water: Rgba;
  readonly wood: Rgba;
  readonly grass: Rgba;
  readonly farmland: Rgba;
  readonly ice: Rgba;
  readonly sand: Rgba;
  readonly wetland: Rgba;
  readonly park: Rgba;
  readonly residential: Rgba;
  readonly industrial: Rgba;
  readonly boundary: Rgba;
  readonly aeroway: Rgba;
  readonly roads: RoadLayerStyles;
  /** The biomes of the globe's overview, over the land of the overview zooms in place of the land cover (`BiomeStyles`). */
  readonly biomes: BiomeStyles;
  /** The road network of the globe's overview (`OverviewRoadStyles`). */
  readonly overviewRoads: OverviewRoadStyles;
  /** The trees of the street zooms' woods and parks (`TreeStyles`). */
  readonly trees: TreeStyles;
}

/**
 * A light, warm, low-contrast palette in the manner of the system maps
 * people already know: a warm off-white ground, soft pastel greens, a clear
 * light blue for water, and asphalt-grey streets whose majors run wider,
 * not darker. Contrast is spent on what carries meaning (water, parks, the
 * road hierarchy) and taken out of everything that used to compete with the
 * labels and the buildings for attention.
 */
export const defaultLayerStyles: LayerStyles = deepFreeze({
  land: [0.973, 0.965, 0.941, 1.0],
  water: [0.647, 0.812, 0.945, 1.0],
  // Landcover greens are opaque: they cover whole tiles (a tile can be
  // entirely forest or grass), and a translucent green over the near-white
  // `land` base reads as a washed, pale fill, and does so per whole tile, so
  // adjacent tiles jump in tone. Opaque keeps the green saturated and
  // consistent.
  wood: [0.667, 0.835, 0.576, 1.0],
  grass: [0.757, 0.886, 0.643, 1.0],
  // Farmland is a pale wheat, not a green: cultivated land covers most of a
  // continental plain (65% of a Central-Russia overview tile), and as a
  // green it merged with woods and grass into one camouflage field. As a
  // near-ground cream it recedes, and forests read as green shapes on a
  // light land the way region maps draw them.
  farmland: [0.914, 0.922, 0.792, 1.0],
  ice: [0.937, 0.957, 0.973, 1.0],
  sand: [0.949, 0.922, 0.808, 1.0],
  // Wetland and bog cover huge areas in Russia's lowlands. A near-grey tint
  // made whole regions read as desaturated. A muted green reads as the
  // vegetation it is.
  wetland: [0.741, 0.855, 0.698, 1.0],
  park: [0.757, 0.886, 0.643, 1.0],
  // The built-up tints sit a hair under the ground: enough that a city reads
  // as a city over a region view, not enough to grey the streets.
  residential: [0.961, 0.945, 0.914, 1.0],
  industrial: [0.949, 0.941, 0.925, 1.0],
  boundary: [0.52, 0.15, 0.72, 0.9],
  aeroway: [0.886, 0.882, 0.902, 1.0],
  roads: defaultRoadLayerStyles,
  biomes: defaultBiomeStyles,
  overviewRoads: defaultOverviewRoadStyles,
  trees: defaultTreeStyles,
});

export interface FeatureStyles {
  readonly buildingFillColor: Rgba;
  /**
   * Whether buildings rise out of their footprints on the flat map. Off,
   * every footprint stays a flat fill in the building colour, the way
   * buildings draw on the globe. Baked into the prepared tiles, so a change
   * re-parses them, like any other theme change.
   */
  readonly buildingExtrusion: boolean;
  /**
   * Whether the POIs and the house numbers inside an extruded building
   * belong to it: the POI naming the building itself (a hotel, a mall, the
   * same OSM element as the building) stands on its roof, the way a
   * skyscraper's name sits on its top, and the places inside it stay on the
   * ground but are never hidden by the building they are in, only by the
   * buildings in front of it. Off, every label stays on the ground and any
   * building can hide it. Baked into the prepared tiles, so a change
   * re-parses them.
   */
  readonly labelsStandOnRoofs: boolean;
  /**
   * The radius, in metres, an extruded building's edges are rounded by: the
   * corners of its footprint and the rim of its roof, so the blocks read
   * soft rather than as sharp boxes. Zero keeps the boxes. Baked into the
   * prepared tiles, so a change re-parses them.
   */
  readonly buildingEdgeRadius: number;
}

/**
 * A warm light grey a step under the ground: the roof of a building
 * separates from the street around it, and its walls, which the renderer
 * shades down from this, separate from the roof.
 */
export const defaultFeatureStyles: FeatureStyles = deepFreeze({
  buildingFillColor: [0.906, 0.89, 0.863, 1.0],
  buildingExtrusion: true,
  labelsStandOnRoofs: true,
  buildingEdgeRadius: 1.5,
});

// MARK: Route signs

/**
 * The outline of a route sign. `rectangle` has corners rounded by
 * `cornerRadiusEm`: the plate most countries number their roads on.
 * `capsule` is a rectangle with fully round ends. `escutcheon` is a
 * heraldic shield: a flat top, straight sides, and a bottom that comes to a
 * point, the United States' Interstate and US highway signs.
 */
export type RouteShieldShape = "rectangle" | "capsule" | "escutcheon";

/** What a route's number is drawn on. */
export interface RouteShieldAppearance {
  readonly shape: RouteShieldShape;
  readonly fillColor: Rgb;
  readonly textColor: Rgb;
  readonly borderColor: Rgb;
  /** The width of the border inside the outline, as a fraction of the em. Zero draws none. */
  readonly borderEm: number;
  /** The corner radius of a `rectangle` (and of an `escutcheon`'s top corners), as a fraction of the em. */
  readonly cornerRadiusEm: number;
  /** The room between the number and each side of the sign, as a fraction of the em. A sign is never narrower than it is tall. */
  readonly paddingEm: number;
  /**
   * A band across the top of the sign in its own colour (the red crown of
   * an Interstate sign), null for a sign in one colour. The number sits in
   * the part below it.
   */
  readonly headerColor: Rgb | null;
  /** The band's height as a fraction of the sign's. */
  readonly headerFraction: number;
}

/**
 * A route sign: a rectangle by default, the border the plate's own colour
 * unless one is given, the widths at least zero and the band at most half
 * the sign.
 */
export function routeShieldAppearance(options: {
  readonly shape?: RouteShieldShape | undefined;
  readonly fillColor: Rgb;
  readonly textColor: Rgb;
  readonly borderColor?: Rgb | null | undefined;
  readonly borderEm?: number | undefined;
  readonly cornerRadiusEm?: number | undefined;
  readonly paddingEm?: number | undefined;
  readonly headerColor?: Rgb | null | undefined;
  readonly headerFraction?: number | undefined;
}): RouteShieldAppearance {
  return deepFreeze({
    shape: options.shape ?? "rectangle",
    fillColor: options.fillColor,
    textColor: options.textColor,
    borderColor: options.borderColor ?? options.fillColor,
    borderEm: Math.max(0, options.borderEm ?? 0),
    cornerRadiusEm: Math.max(0, options.cornerRadiusEm ?? 0.2),
    paddingEm: Math.max(0, options.paddingEm ?? 0.35),
    headerColor: options.headerColor ?? null,
    headerFraction: Math.min(Math.max(options.headerFraction ?? 0.25, 0), 0.5),
  });
}

/** One network's sign. */
export interface RouteShieldRule {
  /**
   * The network pattern, compared without regard to case, one segment per
   * colon. `*` stands for any one segment, and as the last segment for one
   * or more: `US:*` matches `US:CA` and `US:NJ:CR`, `US:*:*` only the
   * second.
   */
  readonly network: string;
  /** The sign, null for a network that is not signed at all. */
  readonly appearance: RouteShieldAppearance | null;
}

/**
 * The route signs: which networks are signed and on what sign, how large
 * the numbers are, how often a road repeats them, and from which tile zoom
 * each road class carries them.
 *
 * A route is matched against `rules` in order, and the first rule whose
 * network pattern matches decides its sign. The same order is the order the
 * signs stand in on a road that carries several routes, so the rules list
 * the national networks before the European one: a road signed `М-9` and
 * `E22` reads `М-9` first. A route no rule matches (and a route of no
 * network, a bare `ref`) takes `fallback`.
 */
export interface RouteShields {
  readonly rules: readonly RouteShieldRule[];
  /** The sign of a route no rule matches, null to leave such routes unsigned. */
  readonly fallback: RouteShieldAppearance | null;
  /** The em size of the numbers in layout points. */
  readonly sizePoints: number;
  readonly weight: LabelFontWeight;
  /** The least distance between two copies of a road's signs, in layout points at the tile's zoom. */
  readonly spacingPoints: number;
  /** The most signs one road carries side by side. */
  readonly maximumCount: number;
  /** The tile zoom a road class first carries its signs at. */
  readonly minimumTileZoom: RoadClassValues<number>;
}

/**
 * A plain plate for a route of a network no rule names: white, with a grey
 * edge and a dark number, a sign that says "route" without claiming any
 * country's colours.
 */
export const defaultRouteShieldFallback: RouteShieldAppearance = routeShieldAppearance({
  fillColor: [1, 1, 1],
  textColor: [0.25, 0.25, 0.27],
  borderColor: [0.58, 0.59, 0.61],
  borderEm: 0.08,
});

/**
 * The motorways and trunks carry their signs from the first road-path tile,
 * z8. The lesser classes follow as the map gets room for them, and the
 * service roads and paths carry none.
 */
export const defaultRouteShieldMinimumTileZoom: RoadClassValues<number> = Object.freeze({
  motorway: 8,
  trunk: 8,
  primary: 9,
  secondary: 11,
  tertiary: 12,
  minor: 13,
  service: 99,
  path: 99,
  other: 99,
});

/**
 * The signs as each country posts them on its roads: the colours of the
 * plate and of the number, and the white or black edge the plate has. The
 * national networks come first, so a road that is also a European route
 * leads with its national number, and the European routes follow on their
 * green plate. The Asian Highway numbers, the US truck, historic and
 * auto-trail routes and the US county routes are not signed.
 */
export const defaultRouteShieldRules: readonly RouteShieldRule[] = (() => {
  const white: Rgb = [1, 1, 1];
  const black: Rgb = [0.08, 0.08, 0.08];
  const red: Rgb = [0.827, 0.133, 0.145];
  const green: Rgb = [0.0, 0.502, 0.271];
  const blue: Rgb = [0.0, 0.345, 0.667];
  const yellow: Rgb = [1.0, 0.8, 0.0];
  const border = 0.09;

  const whiteOnRed = routeShieldAppearance({ fillColor: red, textColor: white, borderColor: white, borderEm: border });
  const whiteOnGreen = routeShieldAppearance({ fillColor: green, textColor: white, borderColor: white, borderEm: border });
  const whiteOnBlue = routeShieldAppearance({ fillColor: blue, textColor: white, borderColor: white, borderEm: border });
  const blackOnYellow = routeShieldAppearance({ fillColor: yellow, textColor: black, borderColor: black, borderEm: 0.07 });
  const rule = (network: string, appearance: RouteShieldAppearance | null): RouteShieldRule => ({ network, appearance });

  return deepFreeze([
    // Russia: sign 6.14.1, a white number on red.
    rule("ru:national", whiteOnRed),
    // Germany: the Autobahn on blue, the Bundesstraße on yellow.
    rule("BAB", whiteOnBlue),
    rule("DE:national", blackOnYellow),
    // The United Kingdom's motorways, on their lighter blue.
    rule(
      "UK:motorway",
      routeShieldAppearance({ fillColor: [0.0, 0.475, 0.757], textColor: white, borderColor: white, borderEm: border }),
    ),
    // France: the autoroutes and routes nationales on red, the
    // départementales on yellow.
    rule("FR:A-road", whiteOnRed),
    rule("FR:N-road", whiteOnRed),
    rule("FR:*:D-road", blackOnYellow),
    // Italy: the autostrade on green, the strade statali on blue.
    rule("IT:A-road", whiteOnGreen),
    rule("IT", whiteOnBlue),
    // Spain: the autovías and autopistas on blue.
    rule("ES:A-road", whiteOnBlue),
    rule("ES:AP-highway", whiteOnBlue),
    rule("ES:R-highway", whiteOnBlue),
    // Poland: the motorways, expressways and national roads on red, the
    // voivodeship roads on yellow.
    rule("PL:motorway", whiteOnRed),
    rule("PL:expressway", whiteOnRed),
    rule("PL:national", whiteOnRed),
    rule("PL:regional", blackOnYellow),
    // Japan: the expressway numbers on green, the national routes on blue.
    rule("JP:E", whiteOnGreen),
    rule("JP:national", whiteOnBlue),
    // The United States: the Interstate's blue shield under its red crown,
    // the US highway's white shield, and the state routes on a white oval.
    rule(
      "US:I",
      routeShieldAppearance({
        shape: "escutcheon",
        fillColor: [0.0, 0.247, 0.529],
        textColor: white,
        borderColor: white,
        borderEm: border,
        headerColor: [0.686, 0.118, 0.176],
      }),
    ),
    rule(
      "US:US",
      routeShieldAppearance({ shape: "escutcheon", fillColor: white, textColor: black, borderColor: black, borderEm: border }),
    ),
    rule("US:I:*", null),
    rule("US:US:*", null),
    rule("US:*:*", null),
    rule(
      "US:*",
      routeShieldAppearance({ shape: "capsule", fillColor: white, textColor: black, borderColor: black, borderEm: border }),
    ),
    // The European routes, after every national network.
    rule("e-road", whiteOnGreen),
    rule("AsianHighway", null),
    rule("AH", null),
  ]);
})();

export const defaultRouteShields: RouteShields = deepFreeze({
  rules: defaultRouteShieldRules,
  fallback: defaultRouteShieldFallback,
  sizePoints: 11,
  weight: "bold",
  spacingPoints: 220,
  maximumCount: 2,
  minimumTileZoom: defaultRouteShieldMinimumTileZoom,
});

// MARK: The relief and the labels' opacity

/**
 * How the ground's slopes are shaded where the relief stands
 * (`GroundReliefSettings`), stated by the style like every other colour of
 * the map: a slope turned toward the light takes the highlight, a slope
 * turned away from it the shadow, and level ground keeps its own colour.
 * The light is the scene's (`SceneLightSettings.direction`, the sun the
 * buildings cast their shadows by), and the slopes are the terrain's own,
 * read per pixel from the terrain tiles, so the shading is finer than the
 * relief's grid. Drawn at frame time, never baked into the prepared tiles,
 * so a change needs no re-parse.
 */
export interface ImmersiveMapHillshade {
  /**
   * How strongly the slopes are shaded: 0 draws none, 1 takes a slope that
   * faces the light square on, or turns away from it entirely, all the way
   * to its colour. 0.76 by default.
   */
  readonly intensity: number;
  /** The colour a slope turned away from the light is drawn toward, RGBA in 0...1. The alpha caps how far, 0.34 by default. */
  readonly shadowColor: Rgba;
  /**
   * The colour a slope turned toward the light is drawn toward, RGBA in
   * 0...1. The alpha caps how far, 0.18 by default: the light side of a
   * mountain keeps the map's colour, the shade side carries the form.
   */
  readonly highlightColor: Rgba;
  /**
   * Where the shading starts to fade, in metres from the eye, by the camera
   * zoom (read at the zoom the relief stands by): 60 km at zoom 10, 4 km at
   * 14 and 250 m at 18 by default, halving with every zoom between the stops
   * as the map's scale does (the curve runs geometrically), which keeps the
   * fade at about the same place on screen. The shading is for the ground
   * near the camera. Far off, a pixel spans many of the terrain's heights
   * and the slopes it falls on change from frame to frame, so the shading
   * there only shimmers, and the far ground is read by its outline anyway.
   * In metres, like the ground fog's lengths, so the same curve means the
   * same ground on every screen and at every pitch.
   */
  readonly fadeStartMeters: ImmersiveMapZoomCurve;
  /**
   * Where the shading has faded out, in the same metres by the zoom: twice
   * the start by default (120 km at zoom 10 to 500 m at 18). Past it no
   * slope is shaded, and the ground there costs nothing for it. Raise both
   * to shade further out, lower them if the far ground still shimmers.
   */
  readonly fadeEndMeters: ImmersiveMapZoomCurve;
}

/** A hillshade, the unstated fields at their defaults. */
export function hillshade(
  options: {
    readonly intensity?: number | undefined;
    readonly shadowColor?: Rgba | undefined;
    readonly highlightColor?: Rgba | undefined;
    readonly fadeStartMeters?: ZoomCurveInput | undefined;
    readonly fadeEndMeters?: ZoomCurveInput | undefined;
  } = {},
): ImmersiveMapHillshade {
  return deepFreeze({
    intensity: options.intensity ?? 0.76,
    shadowColor: options.shadowColor ?? [0.05, 0.07, 0.15, 0.34],
    highlightColor: options.highlightColor ?? [1, 0.98, 0.92, 0.18],
    fadeStartMeters: zoomCurve(options.fadeStartMeters ?? { 10: 60_000, 14: 4000, 18: 250 }),
    fadeEndMeters: zoomCurve(options.fadeEndMeters ?? { 10: 120_000, 14: 8000, 18: 500 }),
  });
}

export const defaultHillshade: ImmersiveMapHillshade = hillshade();

/** No shading. */
export const noHillshade: ImmersiveMapHillshade = hillshade({ intensity: 0 });

/**
 * How much the ground is darkened where the terrain around it hides the
 * sky, where the relief stands (`GroundReliefSettings`), stated by the
 * style like the hillshade: the floor of a valley sees a strip of sky
 * between the ridges and takes less of its light than a summit or an open
 * slope, which see it all. The occlusion is computed from the terrain tiles
 * themselves, once a tile lands: for a grid of points over the tile, how
 * high the terrain rises against the sky in each of `directions` directions
 * out to `radiusMeters`, averaged. In metres on the ground, so it reads the
 * same at every zoom, a valley kilometres wide as dark from afar as from
 * near. Drawn at frame time, never baked into the prepared tiles, so a
 * change needs no re-parse, only the terrain tiles computed again.
 */
export interface ImmersiveMapTerrainOcclusion {
  /** Whether the ground is darkened. True by default. */
  readonly isEnabled: boolean;
  /**
   * How dark a point the terrain hides the sky from entirely is drawn, 0 to
   * 1: 0 draws nothing, 1 draws it black. 0.6 by default: a deep valley reads
   * clearly darker, the colours of the map still show.
   */
  readonly strength: number;
  /**
   * How far out the terrain is looked at for what hides the sky, in metres
   * on the ground. 3000 by default: a valley between ridges a few kilometres
   * apart is read whole, a hill reads against its own surroundings. Farther
   * reads wider valleys at more computing per tile, nearer only the folds.
   */
  readonly radiusMeters: number;
  /**
   * How many directions the sky is looked at in, 4 to 32. 8 by default. More
   * directions smooth the result, at a cost in computing that grows with
   * them.
   */
  readonly directions: number;
  /**
   * How many points a side the occlusion is computed for over a terrain
   * tile, 16 to 1024. 128 by default: with the terrain tiles of 512 texels,
   * one point for every four texels, finer than the relief's grid. Raise it
   * for sharper folds at four times the computing with each doubling.
   */
  readonly resolution: number;
}

export const defaultTerrainOcclusion: ImmersiveMapTerrainOcclusion = Object.freeze({
  isEnabled: true,
  strength: 0.6,
  radiusMeters: 3000,
  directions: 8,
  resolution: 128,
});

/** No darkening. */
export const noTerrainOcclusion: ImmersiveMapTerrainOcclusion = Object.freeze({
  ...defaultTerrainOcclusion,
  isEnabled: false,
});

/**
 * How opaque the map's names and its POIs are, by the zoom: a factor over
 * each label's own opacity (`LabelAppearance.opacity`), 0 to 1, so a name
 * laid over the land can fade as the map grows busy, or the POIs give way
 * to the places at the zooms where both stand.
 *
 * Read at the zoom the labels are planned by on every frame, so a zoom
 * gesture plays the change. Drawn at frame time, never baked into the
 * prepared tiles: a change needs no re-parse.
 *
 * ```ts
 * applyTheme(defaultTheme, (theme) => {
 *   theme.labelOpacity.pois = { 14: 0.6, 16: 1 };
 * });
 * ```
 */
export interface ImmersiveMapLabelOpacity {
  /**
   * Every name but the POIs': the places, the countries and the regions,
   * the waters and the streets. 1 at every zoom by default.
   */
  readonly names: ImmersiveMapZoomCurve;
  /** The POIs, their icon plates and their names alike. 1 at every zoom by default. */
  readonly pois: ImmersiveMapZoomCurve;
}

export const defaultLabelOpacity: ImmersiveMapLabelOpacity = Object.freeze({
  names: zoomCurve(1),
  pois: zoomCurve(1),
});

/** The label opacity of one frame: the two factors read at the frame's zoom, each held to 0...1. */
export interface LabelOpacityFrame {
  readonly names: number;
  readonly pois: number;
}

/** The two factors of the label opacity at a zoom, each held to 0...1. */
export function labelOpacityFrame(opacity: ImmersiveMapLabelOpacity, zoom: number): LabelOpacityFrame {
  return {
    names: Math.min(Math.max(zoomCurveValue(opacity.names, zoom), 0), 1),
    pois: Math.min(Math.max(zoomCurveValue(opacity.pois, zoom), 0), 1),
  };
}

// MARK: The theme

/**
 * The colours of what no tile paints, stated by the style like every other
 * colour of the map: the map's ground where no tile has arrived yet (the
 * flat map's clear colour, and the tint of its horizon fog), and the two
 * polar caps past the last Mercator tile row, the north continuing the open
 * ocean and the south the ice sheet.
 */
export interface ImmersiveMapBaseColors {
  readonly map: Rgba;
  readonly northCap: Rgba;
  readonly southCap: Rgba;
}

/**
 * The look of the built-in style (the Protomaps basemap) as plain values:
 * the colour of every layer and road class, the building fill, the label
 * appearances and which labels show, and the route signs. An app recolours
 * the map by changing a field of the default and never touches the layer
 * logic:
 *
 * ```ts
 * ImmersiveMapSettings.default.mapStyle(protomapsBasemapMapStyle(applyTheme(defaultTheme, (theme) => {
 *   theme.layers.water = [0.2, 0.4, 0.8, 1];
 *   theme.layers.roads.motorway = [0.95, 0.6, 0.2, 1];
 * })));
 * ```
 *
 * Colours are RGBA in 0...1. Every value is part of the prepared tiles'
 * identity, so a change rebakes the prepared tiles by itself, but the
 * values drawn at frame time (the hillshade, the terrain occlusion, the
 * labels' opacity and the trees' palette), which are baked into nothing.
 */
export interface ProtomapsBasemapTheme {
  readonly labels: LabelStyles;
  /**
   * The labels the globe wears, null for `labels`: the fill and the halo of
   * a name on the globe's view, the unroll into the plane included, come
   * from here and the plane's from `labels`, handed over with the globe's
   * air at the end of the unroll. The size, the weight, the halo's width and
   * the opacity are always those of `labels`. The night palette sets the
   * day's here, with `globeLayers`. Baked into the prepared tiles, so a
   * change re-parses them.
   */
  readonly globeLabels: LabelStyles | null;
  readonly labelVisibility: LabelVisibility;
  readonly layers: LayerStyles;
  /**
   * The palette the globe wears, null for `layers`: the ground of the
   * globe's view, the unroll into the plane included, takes its colours
   * from here and the plane from `layers`, handed over with the globe's air
   * at the end of the unroll. The night palette sets the day's here, so the
   * planet keeps its daylight and its sun while the map in it is dark. The
   * caps past the poles follow it. Baked into the prepared tiles, so a
   * change re-parses them.
   */
  readonly globeLayers: LayerStyles | null;
  readonly features: FeatureStyles;
  readonly roadMetrics: RoadMetrics;
  readonly routeShields: RouteShields;
  /** How the slopes are shaded where the ground relief stands (`ImmersiveMapHillshade`). */
  readonly hillshade: ImmersiveMapHillshade;
  /** How the ground is darkened where the terrain hides the sky, where the ground relief stands (`ImmersiveMapTerrainOcclusion`). */
  readonly terrainOcclusion: ImmersiveMapTerrainOcclusion;
  /**
   * How opaque the names and the POIs are by the zoom, a factor over each
   * label's own opacity (`ImmersiveMapLabelOpacity`). Drawn at frame time, so
   * a change re-parses nothing.
   */
  readonly labelOpacity: ImmersiveMapLabelOpacity;
}

/** The built-in look, unchanged. */
export const defaultTheme: ProtomapsBasemapTheme = deepFreeze({
  labels: defaultLabelStyles,
  globeLabels: null,
  labelVisibility: defaultLabelVisibility,
  layers: defaultLayerStyles,
  globeLayers: null,
  features: defaultFeatureStyles,
  roadMetrics: defaultRoadMetrics,
  routeShields: defaultRouteShields,
  hillshade: defaultHillshade,
  terrainOcclusion: defaultTerrainOcclusion,
  labelOpacity: defaultLabelOpacity,
});

/**
 * A copy of `theme` with the changes the function makes to a draft of it:
 * the way to state a theme as the default plus a few differences. The
 * original is untouched, and the copy is frozen like every theme.
 */
export function applyTheme(
  theme: ProtomapsBasemapTheme,
  change: (theme: DeepMutable<ProtomapsBasemapTheme>) => void,
): ProtomapsBasemapTheme {
  const draft = structuredClone(theme) as DeepMutable<ProtomapsBasemapTheme>;
  change(draft);
  return deepFreeze(draft as ProtomapsBasemapTheme);
}

/** The colours of the trees (`TreeStyles.palette`). */
export function themeTreePalette(theme: ProtomapsBasemapTheme): ImmersiveMapTreePalette {
  return theme.layers.trees.palette;
}

/**
 * What no tile paints, from the same palette: the land where no tile has
 * arrived, the water past the northern rim, the ice past the southern one.
 * The caps are the globe's, so they wear the globe's palette where the theme
 * has one.
 */
export function themeBaseColors(theme: ProtomapsBasemapTheme): ImmersiveMapBaseColors {
  const globe = theme.globeLayers ?? theme.layers;
  return { map: theme.layers.land, northCap: globe.water, southCap: globe.ice };
}

/** The theme with the values drawn at frame time set to the defaults' (the rest is what the tiles are prepared by). */
function preparedPart(theme: ProtomapsBasemapTheme): ProtomapsBasemapTheme {
  const withDefaultPalette = (layers: LayerStyles): LayerStyles => ({
    ...layers,
    trees: { ...layers.trees, palette: ImmersiveMapTreePalette.default },
  });
  return {
    ...theme,
    layers: withDefaultPalette(theme.layers),
    globeLayers: theme.globeLayers === null ? null : withDefaultPalette(theme.globeLayers),
    hillshade: defaultHillshade,
    terrainOcclusion: defaultTerrainOcclusion,
    labelOpacity: defaultLabelOpacity,
  };
}

/**
 * Whether two themes prepare the same tiles: equal in every value but the
 * ones drawn at frame time (the hillshade, the terrain occlusion, the
 * labels' opacity, the trees' palette). The values the Swift theme's cache
 * fingerprint folds in.
 */
export function themesPrepareAlike(a: ProtomapsBasemapTheme, b: ProtomapsBasemapTheme): boolean {
  return deepEqual(preparedPart(a), preparedPart(b));
}

// MARK: The night

/**
 * The night palette: the same map in the dark, the land a deep blue-grey,
 * the water a deep navy, the greens and the fields of the day's palette and
 * the biomes of the globe sunk into the night at a fifth of their light with
 * a blue cast, the roads a warm grey over the dark land and the overview's
 * highways an amber net, the buildings a shade above the land, and every
 * label a light grey on a black halo, graded as the day's greys are, never
 * white: a white name on a dark map reads as a lamp. The slopes shade by
 * the moon: a deeper shadow and a cool, faint highlight. Every plate keeps
 * its colour, sunk to the night's light: the route signs their countries'
 * colours and the POI icons their categories', since a white or a bright
 * plate is a lamp on a dark map. The road metrics and the label visibility
 * are the day's.
 *
 * The globe is the day's: the night is the map's, not the planet's, so the
 * ground of the globe's view wears the day's palette (`globeLayers`) and its
 * names the day's lettering (`globeLabels`) under the globe's own sun, and
 * the night comes in with the plane's air at the end of the unroll, with
 * the sky, the fog and the asphalt of the roads.
 *
 * The map's air, the sky, the horizon and the ground fog, is a setting
 * rather than a theme (`nightFogSettings`), so the map of a night goes on
 * with `ImmersiveMapSettings.night()`, which sets both, or with
 * `.mapStyle(nightMapStyle)` and `.fogSettings(nightFogSettings)` one by
 * one.
 */
export const nightTheme: ProtomapsBasemapTheme = (() => {
  /** The day's tone sunk into the night: a fifth of its light with a blue cast, so a forest stays a greener dark than a field. */
  const sunk = (color: Rgba): Rgba => [color[0] * 0.22 + 0.03, color[1] * 0.22 + 0.04, color[2] * 0.22 + 0.07, color[3]];
  /**
   * A plate in the night's light: half its day's light with a blue cast, so
   * a white plate is a grey one and a red plate a dark red, its hue kept.
   */
  const sunkPlate = (color: Rgb): Rgb => [color[0] * 0.5 + 0.02, color[1] * 0.5 + 0.03, color[2] * 0.5 + 0.05];
  const scaled = (color: Rgb, factor: number): Rgb => [color[0] * factor, color[1] * factor, color[2] * factor];
  /**
   * A route sign in the night's light: the plate, its edge and its band
   * sunk, the edge a step further so it does not ring the plate, and a light
   * number dimmed to a grey, a dark one as it is.
   */
  const sunkSign = (sign: RouteShieldAppearance): RouteShieldAppearance => {
    const number = (color: Rgb): Rgb => (color[0] + color[1] + color[2] > 1.5 ? scaled(color, 0.74) : color);
    return {
      ...sign,
      fillColor: sunkPlate(sign.fillColor),
      borderColor: scaled(sunkPlate(sign.borderColor), 0.85),
      headerColor: sign.headerColor === null ? null : sunkPlate(sign.headerColor),
      textColor: number(sign.textColor),
    };
  };

  return applyTheme(defaultTheme, (theme) => {
    const layers = theme.layers;
    layers.land = [0.09, 0.1, 0.13, 1];
    layers.water = [0.04, 0.09, 0.2, 1];
    layers.wood = [0.06, 0.14, 0.11, 1];
    layers.grass = [0.08, 0.16, 0.12, 1];
    layers.farmland = [0.1, 0.14, 0.1, 1];
    layers.wetland = [0.07, 0.14, 0.13, 1];
    layers.sand = [0.16, 0.15, 0.13, 1];
    layers.ice = [0.3, 0.32, 0.36, 1];
    layers.park = [0.08, 0.17, 0.13, 1];
    layers.residential = [0.12, 0.12, 0.15, 1];
    layers.industrial = [0.14, 0.13, 0.15, 1];
    layers.aeroway = [0.16, 0.16, 0.19, 1];
    layers.boundary = [0.58, 0.36, 0.78, 0.9];
    const base: [number, number, number, number] = [0.42, 0.4, 0.36, 1];
    const minor: [number, number, number, number] = [0.24, 0.24, 0.28, 1];
    layers.roads = {
      motorway: [...base],
      trunk: [...base],
      primary: [...base],
      secondary: [...minor],
      tertiary: [...minor],
      minor: [...minor],
      service: [...minor],
      path: [...minor],
      rail: [...minor],
      casing: [0.06, 0.06, 0.08, 0.95],
      marking: [0.55, 0.53, 0.48, 1],
    };
    // The globe's overview in the dark: every biome and cover tone sunk
    // from the day's, so the continents keep their climates in the night,
    // and the highways an amber net.
    for (const key of biomeColorKeys) {
      layers.biomes[key] = [...sunk(defaultBiomeStyles[key])];
    }
    layers.overviewRoads.major = [0.72, 0.58, 0.26, 1];
    layers.overviewRoads.minor = [0.42, 0.39, 0.3, 1];
    layers.trees.palette = structuredClone(ImmersiveMapTreePalette.night) as DeepMutable<ImmersiveMapTreePalette>;

    theme.globeLayers = structuredClone(defaultLayerStyles) as DeepMutable<LayerStyles>;
    theme.globeLabels = structuredClone(defaultLabelStyles) as DeepMutable<LabelStyles>;

    theme.routeShields.rules = theme.routeShields.rules.map((rule) => ({
      network: rule.network,
      appearance: rule.appearance === null ? null : (structuredClone(sunkSign(rule.appearance)) as DeepMutable<RouteShieldAppearance>),
    }));
    theme.routeShields.fallback =
      theme.routeShields.fallback === null
        ? null
        : (structuredClone(sunkSign(theme.routeShields.fallback)) as DeepMutable<RouteShieldAppearance>);

    theme.features.buildingFillColor = [0.18, 0.19, 0.23, 1];

    // The day's greys mirrored into the dark, graded as the day's are: the
    // cities the lightest, the villages and the lettering of the lands a
    // step dimmer, none of them white. A white name on a dark map reads as
    // a lamp, not as ink.
    const stroke: [number, number, number] = [0.02, 0.03, 0.06];
    const fills: readonly (readonly [Exclude<keyof LabelStyles, "poiCategories">, [number, number, number]])[] = [
      ["city", [0.84, 0.86, 0.92]],
      ["town", [0.74, 0.77, 0.84]],
      ["district", [0.6, 0.63, 0.71]],
      ["country", [0.66, 0.68, 0.78]],
      ["region", [0.6, 0.62, 0.72]],
      ["poi", [0.62, 0.65, 0.73]],
      ["road", [0.6, 0.62, 0.68]],
      ["water", [0.42, 0.58, 0.84]],
    ];
    for (const [key, fill] of fills) {
      theme.labels[key].fillColor = fill;
      theme.labels[key].strokeColor = [...stroke];
    }
    // The POI plates in their categories' colours, sunk.
    theme.labels.poiCategories = structuredClone(
      mapPoiCategoryColors(theme.labels.poiCategories, sunkPlate),
    ) as DeepMutable<PoiCategoryColors>;

    theme.hillshade.shadowColor = [0.0, 0.01, 0.04, 0.45];
    theme.hillshade.highlightColor = [0.55, 0.65, 0.95, 0.12];
  });
})();

// MARK: The style

/**
 * The built-in style: draws the Protomaps basemap tiles of the hosted
 * archive with a theme. The default of `ImmersiveMapSettings.default`, and
 * `protomapsBasemapMapStyle(applyTheme(defaultTheme, ...))` is the same look
 * with a few colours changed.
 */
export interface ProtomapsBasemapMapStyle {
  readonly theme: ProtomapsBasemapTheme;
}

/** The built-in style in a theme, the default one unless another is given. */
export function protomapsBasemapMapStyle(theme: ProtomapsBasemapTheme = defaultTheme): ProtomapsBasemapMapStyle {
  return Object.freeze({ theme });
}

/** The built-in look, unchanged. */
export const defaultMapStyle: ProtomapsBasemapMapStyle = protomapsBasemapMapStyle(defaultTheme);

/** The built-in style in the night palette (`nightTheme`). */
export const nightMapStyle: ProtomapsBasemapMapStyle = protomapsBasemapMapStyle(nightTheme);
