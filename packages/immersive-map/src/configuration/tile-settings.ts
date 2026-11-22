// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapAttribution } from "./attribution.ts";
import type { ImmersiveMapAttributionCredit } from "./attribution.ts";
import { deepFreeze, mergeOptions } from "./deep.ts";
import type { Options } from "./deep.ts";
import { ImmersiveMapTerrainSource } from "./terrain-source.ts";
import { ImmersiveMapTilesService } from "./tiles-service.ts";

export type { GroundReliefEncoding } from "./terrain-source.ts";

export interface CoverageSettings {
  /**
   * The deepest tile zoom the map asks the archive for, at most: null, the
   * default, takes the archive's own depth, the deepest zoom its header
   * names. A cap under it leaves the archive's deepest zooms unread. Past
   * the deepest zoom the camera keeps zooming and the deepest tiles are
   * stretched.
   */
  readonly maximumZoomLevel: number | null;
  /**
   * The archive's own depth, read from its header by the map, null while it
   * was never read. Not the app's to set: the map fills it in
   * (`ImmersiveMapSettings.resolvingArchiveDepth`).
   */
  readonly archiveMaximumZoomLevel: number | null;
  /**
   * How far past the visible ground the flat map's texture bands (the ring
   * rules with a `rasterSize`) ask for their tiles, as a share of the
   * footprint's reach from the camera: 0.25 by default, a quarter of the way
   * further out on every side, 0 for the visible ground alone. A far band's
   * tile has no resident stand-in when it comes into view (its ancestors are
   * the world cover, which nothing goes down to), so a turn of the camera
   * that brings one in shows a hole in the far ground for the frames its
   * load takes. With the margin the tile is asked for before it is in view,
   * and it is in by the time it is. The geometry bands take no margin: their
   * stand-ins cover a loading tile, and their tiles cost far more.
   */
  readonly rasterBandMarginShare: number;
}

/** The depth a map plans by before its archive's header was ever read: the hosted archive's. */
export const provisionalMaximumZoomLevel = ImmersiveMapTilesService.maximumTileZoomLevel;

export const defaultCoverageSettings: CoverageSettings = Object.freeze({
  maximumZoomLevel: null,
  archiveMaximumZoomLevel: null,
  rasterBandMarginShare: 0.25,
});

export function coverageSettings(options: Options<CoverageSettings> = {}): CoverageSettings {
  return deepFreeze(mergeOptions(defaultCoverageSettings, options));
}

/**
 * The deepest tile zoom the map asks for: the archive's depth, under the
 * cap when there is one. Before the archive's depth is known, the cap, or
 * the provisional depth without one.
 */
export function resolvedMaximumZoomLevel(coverage: CoverageSettings): number {
  const archive = coverage.archiveMaximumZoomLevel;
  if (archive === null) {
    return coverage.maximumZoomLevel ?? provisionalMaximumZoomLevel;
  }
  return Math.min(coverage.maximumZoomLevel ?? archive, archive);
}

export interface NetworkSettings {
  /** How many archive requests run at once. 5 by default. */
  readonly maxConcurrentFetches: number;
  /** How many tile requests may wait for a fetch slot. 50 by default. */
  readonly pendingRequestQueueCapacity: number;
  /**
   * The tile source: one PMTiles v3 archive over HTTP(S), read with range
   * requests. The archive holds MVT tiles, gzip-compressed or not. A query
   * string in the URL is sent as written, so a key can live there.
   */
  readonly tileArchiveURL: string;
  /**
   * HTTP header fields added to every archive request. This is how
   * header-based credentials travel, e.g. `{ Authorization: "Bearer xxx" }`.
   */
  readonly tileRequestHeaders: Readonly<Record<string, string>>;
}

export const defaultNetworkSettings: NetworkSettings = deepFreeze({
  maxConcurrentFetches: 5,
  pendingRequestQueueCapacity: 50,
  tileArchiveURL: ImmersiveMapTilesService.tileArchiveURL,
  tileRequestHeaders: {},
});

export function networkSettings(options: Options<NetworkSettings> = {}): NetworkSettings {
  return deepFreeze(mergeOptions(defaultNetworkSettings, options));
}

/** The default quota of the prepared tile cache on disk: 2 GiB. */
export const defaultPreparedDiskCacheSizeInBytes = 2 * 1024 * 1024 * 1024;

export interface CacheSettings {
  /** Whether the disk caches are emptied when the map starts. Off by default. */
  readonly clearDiskCachesOnLaunch: boolean;
  /**
   * On-disk cache of parsed and tessellated tiles: the layer every tile the
   * camera has already looked at comes back from, without the network. When
   * false, tiles are re-parsed from the raw bytes on every load.
   */
  readonly preparedTileCacheEnabled: boolean;
  /**
   * Compression of prepared tiles before they hit the disk cache. When
   * false, entries are written uncompressed: larger cache files in exchange
   * for less CPU (and battery) burned while exploring new areas. Both
   * variants stay readable regardless of this flag.
   */
  readonly preparedDiskCompressionEnabled: boolean;
  /** How long a prepared tile stays on disk, in seconds. A week by default. */
  readonly preparedDiskTimeToLive: number;
  /**
   * Root-wide byte quota for all prepared-tile format and style namespaces
   * (2 GiB by default). The most recently initialized map makes its quota
   * the active root-wide policy. Tiles stay in GPU memory only while a frame
   * draws them, so this quota decides how much of a revisited area comes
   * back without a re-download and re-parse.
   */
  readonly preparedDiskCacheSizeInBytes: number;
}

export const defaultCacheSettings: CacheSettings = Object.freeze({
  clearDiskCachesOnLaunch: false,
  preparedTileCacheEnabled: true,
  preparedDiskCompressionEnabled: true,
  preparedDiskTimeToLive: 7 * 24 * 60 * 60,
  preparedDiskCacheSizeInBytes: defaultPreparedDiskCacheSizeInBytes,
});

export function cacheSettings(options: Options<CacheSettings> = {}): CacheSettings {
  return deepFreeze(mergeOptions(defaultCacheSettings, options));
}

/** How many tiles are parsed at once by default. */
export const defaultMaximumConcurrentParses = 4;

export interface ParsingSettings {
  /** Draws the outline of every tile into it, a debugging aid. Off by default. */
  readonly addTestBorders: boolean;
  /**
   * How many tiles are parsed at once, at least one. A parse runs in a
   * worker and holds its slot until the tile is in the GPU's buffers and
   * saved. More slots land a burst of tiles sooner and take the cores the
   * frame and the rest of the page share with them, fewer keep a fast zoom
   * from crowding the device. 4 by default.
   */
  readonly maximumConcurrentParses: number;
}

export const defaultParsingSettings: ParsingSettings = Object.freeze({
  addTestBorders: false,
  maximumConcurrentParses: defaultMaximumConcurrentParses,
});

export function parsingSettings(options: Options<ParsingSettings> = {}): ParsingSettings {
  return deepFreeze(mergeOptions(defaultParsingSettings, options));
}

/**
 * The grids of the zooms the defaults name: 128 cells at the relief's zooms
 * 9 to 12, 64 at 13 and 32 at 14, and the globe's zooms the grid the sphere
 * is split by otherwise, 64 at 0 and 1 and 32 at 2 and 3.
 */
export const defaultGridByTileZoom: Readonly<Record<number, number>> = Object.freeze({
  0: 64,
  1: 64,
  2: 32,
  3: 32,
  9: 128,
  10: 128,
  11: 128,
  12: 128,
  13: 64,
  14: 32,
});

/**
 * The flattened ground: the tiles of the deep zooms, which the camera blows
 * up to many screens, carry their ground fills as one layer of triangles
 * that do not overlap instead of the layers a coarser tile stacks. Every
 * pixel of such a tile's ground is one fill, so nothing has to be ordered in
 * depth, which is what keeps the near ground whole at a street tilt, and no
 * triangle crosses a cell of the grid, which keeps the mesh ready for a
 * heightmap. Baked into the prepared tiles, so a change re-parses them.
 */
export interface GroundFlatteningSettings {
  /** Whether the ground is flattened at all. Off, every tile keeps its layers at every zoom. */
  readonly isEnabled: boolean;
  /**
   * The tile zoom the ground is flattened from: a tile of this zoom or
   * deeper is flattened whatever the camera's zoom, a coarser one keeps its
   * layers. Null, the default, is the tileset's deepest zoom
   * (`CoverageSettings.maximumZoomLevel`, `tileMaximumZoomLevel(...)`): only
   * the tiles the camera blows up to many screens are flattened, whatever
   * depth the archive is built to. With the ground relief on, the relief's
   * zoom stands in for this one (`GroundReliefSettings.appearZoom`).
   */
  readonly fromTileZoom: number | null;
  /**
   * The grid a flattened tile's triangles keep to, cells a side: no triangle
   * crosses a cell. More cells, more triangles. Clamped to `1...256`. With
   * the ground relief on, the relief is as fine as the grid: a cell of a
   * coarse tile covers far more ground than a cell of a deep one, so
   * `gridByTileZoom` gives the coarse zooms more cells. 16 by default.
   */
  readonly grid: number;
  /**
   * The grid of a tile zoom, over `grid` for the zooms it names. By default
   * the zooms the relief is drawn at (`GroundReliefSettings.appearZoom`,
   * `collapseZoom`) take a cell of about the same ground. A tile of 256
   * cells is some 130 thousand triangles, so the overrides cost memory and
   * parsing where the relief is drawn, and nothing without the relief, whose
   * zooms are not flattened at all (`fromTileZoom`). The globe's zooms,
   * should the relief be set to flatten them (`GroundReliefSettings.appearZoom`),
   * take the grid the sphere is split by otherwise: 64 cells at zooms 0 and
   * 1, 32 at 2 and 3, so the limb and the chords of the fills' edges stay as
   * round as they are. The relief's zooms take 128 cells at zooms 9 to 12
   * and 64 at 13, 33 thousand triangles a tile at most: a vertex per height
   * of the zoom 10 map the ground rises by
   * (`GroundReliefSettings.displacementMaximumZoom`) from zoom 12 on, every
   * second height at 11, every fourth at 10, which the eye does not tell
   * apart from the near ring's 53 m, the slopes' shading being per pixel and
   * finer. A finer displacement wants these raised with it.
   */
  readonly gridByTileZoom: Readonly<Record<number, number>>;
}

export const defaultGroundFlatteningSettings: GroundFlatteningSettings = deepFreeze({
  isEnabled: true,
  fromTileZoom: null,
  grid: 16,
  gridByTileZoom: defaultGridByTileZoom,
});

export function groundFlatteningSettings(options: Options<GroundFlatteningSettings> = {}): GroundFlatteningSettings {
  return deepFreeze(mergeOptions(defaultGroundFlatteningSettings, options));
}

/** The grid of a tile of `tileZoom`. */
export function groundFlatteningGrid(flattening: GroundFlatteningSettings, tileZoom: number): number {
  return flattening.gridByTileZoom[tileZoom] ?? flattening.grid;
}

/**
 * How the country around the point the camera looks at is read as
 * mountains or a plain (`GroundReliefSettings.surroundings`): the relief's
 * heights are read on the CPU over a disc around the point, and the span of
 * them, the highest less the lowest, says how mountainous the country is.
 * Read only while the frame is on the terrain. Tune it on the debug panel's
 * Relief tab, which shows the reading live.
 */
export interface TerrainSurroundingsSettings {
  /**
   * The radius of the disc the heights are read over, in metres, 4000 by
   * default, at least 1. Wider reads the region, so a town at the foot of a
   * range counts as mountains sooner, narrower reads the ground at hand, so
   * a wide valley floor counts as a plain.
   */
  readonly sampleRadiusMetres: number;
  /**
   * The span of heights under which the country is a plain, in metres, 150
   * by default: the mountainousness is 0 there, and the kind falls back to a
   * plain once the span is under it.
   */
  readonly plainBelowMetres: number;
  /**
   * The span of heights from which the country is mountains, in metres, 600
   * by default: the mountainousness is 1 there, and the kind rises to
   * mountains once the span reaches it. The band between the two thresholds
   * is the kind's hysteresis.
   */
  readonly mountainsAboveMetres: number;
  /**
   * How long the span takes to go half the way to a new reading, in
   * seconds, 0.5 by default: a pan into the mountains fades the reading in
   * rather than steps it. 0 follows at once.
   */
  readonly smoothingHalfLife: number;
}

const surroundingsClamps = {
  sampleRadiusMetres: (value: number) => Math.max(value, 1),
  plainBelowMetres: (value: number) => Math.max(value, 0),
  mountainsAboveMetres: (value: number) => Math.max(value, 0),
  smoothingHalfLife: (value: number) => Math.max(value, 0),
};

export const defaultTerrainSurroundingsSettings: TerrainSurroundingsSettings = Object.freeze({
  sampleRadiusMetres: 4000,
  plainBelowMetres: 150,
  mountainsAboveMetres: 600,
  smoothingHalfLife: 0.5,
});

/** The surroundings' reading, each value held to its floor as the Swift initializer holds it. */
export function terrainSurroundingsSettings(options: Options<TerrainSurroundingsSettings> = {}): TerrainSurroundingsSettings {
  return deepFreeze(mergeOptions(defaultTerrainSurroundingsSettings, options, surroundingsClamps));
}

/** Applies the floors of the surroundings' values, for an edit that sets them in place. */
export function withTerrainSurroundings(
  surroundings: TerrainSurroundingsSettings,
  options: Options<TerrainSurroundingsSettings>,
): TerrainSurroundingsSettings {
  return deepFreeze(mergeOptions(surroundings, options, surroundingsClamps));
}

/**
 * The flattened ground raised by a heightmap: each flattened tile
 * (`GroundFlatteningSettings`) takes its heights from a terrain tile over
 * it, of the zoom the relief's detail picks, or, where the terrain source
 * has none that deep, from the deepest one over it. The vertices of the
 * ground rise, so the relief is as fine as the flattening's grid. A tile is
 * shown with its terrain or not at all: until both are in, what stood on its
 * ground stands on.
 *
 * A first step of the terrain: only the ground's fills rise. The roads, the
 * ground lines, the buildings, the models, the labels and the ground's
 * shadows stay on the plane, so a hill covers the roads that cross it. Read
 * at draw time, not baked into the prepared tiles. Off by default, the map
 * lying flat and the tiles flattened from the flattening's own zoom, not
 * from the relief's (`appearZoom`): `groundRelief({ isEnabled: true })`
 * raises the ground on the terrain of `source`, Mapterhorn's open terrain by
 * default.
 */
export interface GroundReliefSettings {
  /** Whether the flattened ground rises. False by default. */
  readonly isEnabled: boolean;
  /**
   * Where the heights come from (`ImmersiveMapTerrainSource`): Mapterhorn's
   * open global terrain by default (`ImmersiveMapTerrainSource.mapterhorn`).
   * Set with `ImmersiveMapSettings.terrain(...)`.
   */
  readonly source: ImmersiveMapTerrainSource;
  /**
   * How much taller than the ground's real heights the relief is drawn: 1 is
   * true scale, 2 doubles every height. Raise it to see a gentle relief.
   */
  readonly exaggeration: number;
  /**
   * The camera zoom the relief rises out of the plane at: below it the map
   * is flat, no terrain is read or loaded and the camera stands on the
   * plane, and the rise is a short animation in time (`transitionSeconds`)
   * once the zoom crosses it, not a scaling with the zoom. 10 by default. 0
   * draws the relief from the plane's first frame. Read at the zoom a drag
   * over the terrain began with, held through the drag, as `collapseZoom`
   * is.
   *
   * It is also the tile zoom the ground is flattened from
   * (`groundReliefTileZoom`): only a flattened tile rises as geometry, and
   * the tiles drawn as geometry on the relief are the frame's own, of the
   * relief's zooms. A coarser tile is on the relief only in a far ring,
   * drawn from a texture on a raised grid, or for a moment as a stand-in,
   * drawn the same way or, when it was on the screen as geometry the frame
   * before, as it was until the slot's own tile lands, so it is parsed in
   * layers as off the relief, its fills, its roads and its memory spared the
   * flattening.
   */
  readonly appearZoom: number;
  /**
   * The camera zoom the relief collapses into the plane at: from this zoom
   * on the map is flat, and the collapse is a short animation in time
   * (`transitionSeconds`), not a scaling with the zoom, so a zoom crossing
   * it drops the mountains at once and a zoom crossing back raises them
   * again. The terrain sources are 30 m cells over most of the world, with
   * the buildings and the forests in them, and close up those cells read as
   * hills where there are none, so a street-level view stands on the plane
   * the way the big map services draw it. 13.7 by default. A zoom past the
   * deepest keeps the relief at every zoom. Once collapsed no terrain is
   * read or loaded and the camera stands on the plane. Read at the camera's
   * zoom as a drag over the terrain began with it, held through the drag,
   * and followed over a few frames once it ends
   * (`CameraSettings.animatedZoomHalfLife`): a drag slides the point the
   * camera looks at up and down the slopes, the zoom with it, and a
   * threshold read at the zoom of the moment would drop and raise the
   * mountains with every slope. The relief is never scaled with the zoom,
   * for the same reason.
   */
  readonly collapseZoom: number;
  /**
   * Whether the relief collapses where the terrain source has no tile at the
   * zoom the near ring reads it, under the point the camera looks at. True
   * by default. A missing tile is no hole: the ring draws the finest
   * ancestor the source has, and past the ancestor's own zoom its cells, 30
   * m over most of the world, read as hills where there are none, which is
   * what `collapseZoom` guards against. With this on the guard reads the
   * data: Mapterhorn has lidar past zoom 12 only where a country publishes
   * it, so there the relief stands to `collapseZoom`, and elsewhere it
   * collapses at the first zoom whose terrain tile the source does not have,
   * 13, and rises again as the zoom crosses back. Decided by the source's
   * answer (an HTTP 404, remembered for good), so the relief stands on the
   * ancestor for the frames the first answer takes. False keeps the relief
   * standing on the ancestor up to `collapseZoom`, for a source whose
   * coarser tiles are wanted past their zoom.
   */
  readonly collapsesWhereTerrainIsMissing: boolean;
  /**
   * How long the relief takes to rise out of the plane and to collapse back
   * into it, in seconds, when the zoom crosses `appearZoom` or
   * `collapseZoom`: 0.3 by default. 0 switches at once.
   */
  readonly transitionSeconds: number;
  /**
   * The coarsest terrain zoom a tile falls back to when the source has no
   * terrain tile at its own zoom. Mapterhorn covers the whole world to zoom
   * 12. 12 by default.
   */
  readonly minimumSourceZoom: number;
  /**
   * The zoom of the terrain tiles the camera flies over, 10 by default: one
   * map at every zoom, the map the point the camera looks at lies on and its
   * height over the ground is kept by. The ground is drawn by its rings' own
   * terrain, which the ring rules pick (the ring rule's `terrainZoomDrop`,
   * the debug panel's Tiles tab) and may be a finer map near the camera than
   * this one, disagreeing with it by their grids' difference, metres on a
   * ridge. One map for the camera, because a camera that read the map of the
   * zoom it has answers in a loop where a ray grazes a ridge: one zoom's map
   * says ridge, the arm shortens, the zoom crosses a level, the next map
   * says plain, the zoom crosses back, and the camera shakes between the
   * two. Raise it for a camera that hugs the drawn ground more closely at
   * the street zooms, at the cost of more terrain tiles read under the
   * camera.
   */
  readonly cameraTerrainZoom: number;
  /**
   * The finest terrain zoom the ground's vertices rise by, 10 by default: a
   * ring whose terrain is finer than this (the ring rule's
   * `terrainZoomDrop`, zoom 13 at the near ring of a zoom 13 frame) still
   * shades its slopes by that terrain, pixel by pixel, but displaces its
   * grid by this zoom's tile over it, one height every 53 m at zoom 10 on
   * the Alps' latitude. The grid then needs a vertex per height of this map,
   * 64 cells on a zoom 13 tile instead of 256, a sixteenth of the triangles,
   * and the fine terrain is spent where the eye reads it, on the shading:
   * the folds and ridges of a mountain are the light on its slopes, the
   * silhouette only its outline. Raise it for sharper summits and
   * silhouettes at the price of denser grids
   * (`GroundFlatteningSettings.gridByTileZoom` has to follow), lower it for
   * a lighter frame.
   */
  readonly displacementMaximumZoom: number;
  /**
   * How many terrain tiles load at once, at least one. The frame asks for
   * the terrain it needs nearest first, and the loads take that order. More
   * slots fill a fresh view sooner over a fast network, fewer leave the
   * network and the decoding cores to the map's tiles. 4 by default.
   */
  readonly maximumConcurrentLoads: number;
  /**
   * How many bytes of terrain tiles the frame has stopped reading are kept
   * for a frame that reads them again, the most recently released kept: a
   * zoom out below the relief's zoom and back, or a pan away and back, finds
   * its terrain without a load or a decode. The frame's own terrain is never
   * counted against it, it is kept for as long as the frame reads it. 50 MB
   * by default, about fifty tiles. 0 keeps nothing: every terrain the frame
   * stops reading is loaded again when it is read again. Lower it on a
   * device short of memory.
   */
  readonly releasedCacheBytes: number;
  /**
   * The height in metres the camera keeps over a ridge under it, the terrain
   * between the eye and the point it looks at that rises over that point.
   * Zero by default: the camera flies right up to the ridge and is held only
   * from going under its surface. Set, the margin grows with the ridge's
   * rise, from nothing over ground level with the point to this over a ridge
   * this much higher, so over level ground nothing ever holds the camera off
   * the point it looks at: the zoom goes to its own limit. Set it if the
   * near ground cuts into the view on a slope.
   */
  readonly cameraClearanceMetres: number;
  /**
   * Whether the mountains cast their shadows: the relief drawn into the
   * shadow map (`ShadowSettings`) as the buildings are, so a ridge darkens
   * the valley behind it from the scene's sun (`SceneLightSettings.direction`),
   * and the ground, its buildings and its labels' ground take the shadow.
   * Within the shadow map's windows only (`ShadowSettings.nearCoverageMeters`,
   * `farCoverageMeters`), fading at their rim, only with the shadows on and
   * from the zoom the shadows' strength rises from (14 by default, past the
   * zoom the relief collapses at, so the mountains cast only where that zoom
   * is set lower, and the hillshade carries them otherwise). The slopes' own
   * shading is the hillshade's (`ImmersiveMapHillshade`). True by default.
   * The shadow map is drawn again when the terrain under it changes, so a
   * camera at rest costs nothing.
   */
  readonly castsShadows: boolean;
  /**
   * How the country around the point the camera looks at is read as
   * mountains or a plain (`TerrainSurroundingsSettings`), the reading the
   * map reports as the terrain's surroundings.
   */
  readonly surroundings: TerrainSurroundingsSettings;
}

export const defaultGroundReliefSettings: GroundReliefSettings = deepFreeze({
  isEnabled: false,
  source: ImmersiveMapTerrainSource.mapterhorn,
  exaggeration: 1,
  appearZoom: 10,
  collapseZoom: 13.7,
  collapsesWhereTerrainIsMissing: true,
  transitionSeconds: 0.3,
  minimumSourceZoom: 12,
  cameraTerrainZoom: 10,
  displacementMaximumZoom: 10,
  maximumConcurrentLoads: 4,
  releasedCacheBytes: 50 * 2 ** 20,
  cameraClearanceMetres: 0,
  castsShadows: true,
  surroundings: defaultTerrainSurroundingsSettings,
});

export function groundReliefSettings(options: Options<GroundReliefSettings> = {}): GroundReliefSettings {
  return deepFreeze(mergeOptions(defaultGroundReliefSettings, options));
}

/**
 * The tile zoom of `appearZoom`: the zoom of the frame's tiles when the
 * relief rises, the tiles drawn as geometry on it, and the zoom the ground
 * is flattened from and a frame is on the terrain from. A tileset stopping
 * short of it is flattened from its deepest zoom (`deepestTileZoom`), which
 * stands in for every zoom past it.
 */
export function groundReliefTileZoom(relief: GroundReliefSettings, deepestTileZoom: number): number {
  const zoom = Number.isFinite(relief.appearZoom) ? Math.floor(Math.max(relief.appearZoom, 0)) : 0;
  return Math.max(0, Math.min(zoom, deepestTileZoom));
}

/**
 * The credit of the terrain's source, laid on the attribution line after
 * the overview's while the relief is on (`ImmersiveMapSettings.resolvedAttribution`),
 * at the camera zooms the relief stands out of the plane at, from
 * `appearZoom` up to `collapseZoom`: below and past them no terrain is read
 * and the map draws none of it. Null when the relief is off, never rises,
 * or its source states no credit.
 */
export function groundReliefCredit(relief: GroundReliefSettings): ImmersiveMapAttributionCredit | null {
  const text = relief.source.credit;
  if (!relief.isEnabled || text === null || !(relief.appearZoom < relief.collapseZoom)) {
    return null;
  }
  return ImmersiveMapAttribution.credit(text, { lowerBound: relief.appearZoom, upperBound: relief.collapseZoom });
}

/**
 * The tiles drawn from a texture: a ring rule that names a raster size
 * draws its tiles' ground through a texture of their fills, drawn from the
 * tile each frame and shown with its mipmaps, so the far ground is as
 * smooth as a texture and as current as the geometry. These are how the
 * textures are sampled. The size is the rule's, and every tile of a raster
 * ring is drawn into its texture every frame, so a rule's size is a cost of
 * the frame: 256 texels is plenty for a far ring.
 */
export interface RasterizationSettings {
  /**
   * The anisotropic filtering of the textures, 1 to 16 samples. The far
   * rings are seen almost edge on, where a texture without it blurs along
   * the view. Lower it only on a GPU short of bandwidth. 16 by default.
   */
  readonly maximumAnisotropy: number;
  /** Added to the mip level the GPU picks: above 0 the far ground is softer and quieter, below 0 sharper and busier. */
  readonly mipLevelBias: number;
}

export const defaultRasterizationSettings: RasterizationSettings = Object.freeze({
  maximumAnisotropy: 16,
  mipLevelBias: 0,
});

export function rasterizationSettings(options: Options<RasterizationSettings> = {}): RasterizationSettings {
  return deepFreeze(mergeOptions(defaultRasterizationSettings, options));
}

/**
 * The overview of the globe the engine ships: hand-drawn biomes laid into
 * the tiles of zooms 0 to 7 under the tile source's raster-derived land
 * cover, which the built-in style paints and draws the land cover over
 * (`BiomeStyles` of the theme, where the zooms are set).
 */
export interface OverviewSettings {
  /**
   * Whether the overview's layers are laid into the tiles. On by default.
   * Off, the overview zooms draw the tile source's own land cover alone: for
   * a source in another schema whose style has no use for the layers, or to
   * see the source's land cover on the globe. Part of the prepared tiles'
   * identity, so a change re-parses them.
   */
  readonly isEnabled: boolean;
  /**
   * The camera zoom the overview's credit (the biomes' license asks for one)
   * stays on the attribution line up to: from there on the map draws none of
   * the overview and the credit goes. 8 by default, where the built-in style
   * has faded the biomes out (the fade from tile zoom
   * `BiomeStyles.maximumTileZoom` to the next). Raise or lower it with a
   * theme that keeps the biomes to another zoom. A change applies live,
   * without a re-parse.
   */
  readonly creditMaximumZoom: number;
}

export const defaultOverviewSettings: OverviewSettings = Object.freeze({ isEnabled: true, creditMaximumZoom: 8 });

export function overviewSettings(options: Options<OverviewSettings> = {}): OverviewSettings {
  return deepFreeze(mergeOptions(defaultOverviewSettings, options));
}

export interface TileSettings {
  readonly coverage: CoverageSettings;
  readonly network: NetworkSettings;
  readonly cache: CacheSettings;
  readonly parsing: ParsingSettings;
  readonly groundFlattening: GroundFlatteningSettings;
  readonly groundRelief: GroundReliefSettings;
  readonly rasterization: RasterizationSettings;
  readonly overview: OverviewSettings;
}

export const defaultTileSettings: TileSettings = deepFreeze({
  coverage: defaultCoverageSettings,
  network: defaultNetworkSettings,
  cache: defaultCacheSettings,
  parsing: defaultParsingSettings,
  groundFlattening: defaultGroundFlatteningSettings,
  groundRelief: defaultGroundReliefSettings,
  rasterization: defaultRasterizationSettings,
  overview: defaultOverviewSettings,
});

export function tileSettings(options: Options<TileSettings> = {}): TileSettings {
  return deepFreeze(mergeOptions(defaultTileSettings, options));
}

/**
 * The tile zoom the ground is flattened from, with the relief in: the
 * relief's (`GroundReliefSettings.appearZoom`), the zoom of the frame's own
 * tiles when the relief rises, the tiles drawn as geometry on it. Else the
 * flattening's own, the tileset's deepest zoom when it names none, and null
 * when the flattening is off. Every reader of the flattening's zoom reads
 * this.
 */
export function resolvedGroundFlatteningFromTileZoom(tiles: TileSettings): number | null {
  if (tiles.groundRelief.isEnabled) {
    return groundReliefTileZoom(tiles.groundRelief, resolvedMaximumZoomLevel(tiles.coverage));
  }
  if (!tiles.groundFlattening.isEnabled) {
    return null;
  }
  return tiles.groundFlattening.fromTileZoom ?? resolvedMaximumZoomLevel(tiles.coverage);
}
