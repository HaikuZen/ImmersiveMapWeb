// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * What the tile workers' parser is told, built from the map's settings: the
 * port of the Swift `TileParseOptions.init(settings:)` with the style and
 * the label policy beside it, as the JSON the Wasm `TileParser` reads
 * (crates/worker-wasm `ParserConfig`, camelCase). Everything a prepared tile
 * depends on is in here, so the config's fingerprint names the prepared
 * cache's namespace (`preparedTileCacheNamespace`).
 */

import { deepEqual } from "../../configuration/deep.ts";
import type { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import type { LabelFallbackPolicy } from "../../configuration/label-settings.ts";
import { resolvedGroundFlatteningFromTileZoom, resolvedMaximumZoomLevel } from "../../configuration/tile-settings.ts";
import { defaultMapStyle, nightMapStyle, type ProtomapsBasemapTheme } from "../../style/theme.ts";
import { StableFNV1aHasher } from "../../utils/fnv1a.ts";
import { BuildingCoveragePlanner } from "../placement/building-coverage-planner.ts";

/** The grid a flattened tile keeps to stays in this range (the Swift `groundFlatteningGridRange`). */
const groundFlatteningGridRange = { lowerBound: 1, upperBound: 256 } as const;

const clampGrid = (grid: number): number => Math.min(Math.max(grid, groundFlatteningGridRange.lowerBound), groundFlatteningGridRange.upperBound);

/** `TileParseOptions` as the parser reads it. */
export interface TileParseOptionsConfig {
  readonly labelsEnabled: boolean;
  readonly addTestBorders: boolean;
  readonly buildingMinimumSourceZoom: number;
  readonly buildingDeepestSourceZoom: number | null;
  readonly groundFlatteningFromTileZoom: number | null;
  readonly groundFlatteningGrid: number;
  /** By tile zoom, the zoom as a decimal string (a JSON object's key). */
  readonly groundFlatteningGridByTileZoom: Readonly<Record<string, number>>;
  readonly groundReliefEnabled: boolean;
  readonly treeMinimumSourceZoom: number | null;
  readonly treeMaximumPerTile: number;
}

/** The whole parser configuration (crates/worker-wasm `ParserConfig`). */
export interface TileParserConfig {
  /** The built-in palette the theme starts from. */
  readonly palette: "light" | "night";
  /** A theme of the app's own, in place of the palette's: present only when the style is neither built-in one. */
  readonly theme?: ProtomapsBasemapTheme;
  /** The label language's code. */
  readonly language: string;
  readonly fallbackPolicy: LabelFallbackPolicy;
  /** The code points the label atlases carry, ascending. */
  readonly glyphs: readonly number[];
  readonly options: TileParseOptionsConfig;
}

/**
 * The parse options of the settings (the Swift `TileParseOptions.init(settings:)`):
 * the buildings from the zoom they draw from, the flattening as the tiles
 * resolve it, the trees from the buildings' zoom while they are on.
 */
export function tileParseOptionsConfig(settings: ImmersiveMapSettings): TileParseOptionsConfig {
  const tiles = settings.tiles;
  const buildingMinimumSourceZoom = BuildingCoveragePlanner.minimumDrawZoom(settings);
  const grids: Record<string, number> = {};
  for (const [zoom, grid] of Object.entries(tiles.groundFlattening.gridByTileZoom)) grids[zoom] = clampGrid(grid);
  return {
    labelsEnabled: settings.data.labels.isEnabled,
    addTestBorders: tiles.parsing.addTestBorders,
    buildingMinimumSourceZoom,
    buildingDeepestSourceZoom: resolvedMaximumZoomLevel(tiles.coverage),
    groundFlatteningFromTileZoom: resolvedGroundFlatteningFromTileZoom(tiles),
    groundFlatteningGrid: clampGrid(tiles.groundFlattening.grid),
    groundFlatteningGridByTileZoom: grids,
    groundReliefEnabled: tiles.groundRelief.isEnabled,
    // The Swift `TreeCoveragePlanner.minimumSourceZoom(settings:)`: the buildings' zoom, nothing with the trees off.
    treeMinimumSourceZoom: settings.scene.trees.isEnabled ? buildingMinimumSourceZoom : null,
    treeMaximumPerTile: Math.max(settings.scene.trees.maximumPerTile, 0),
  };
}

/**
 * The parser configuration of the settings. `glyphs` are the code points the
 * label atlases carry (`labelAtlasGlyphs`): a name the atlases cannot draw
 * falls back as the label policy says, at parse time.
 */
export function tileParserConfig(settings: ImmersiveMapSettings, glyphs: readonly number[]): TileParserConfig {
  const mapStyle = settings.data.mapStyle;
  const labels = settings.data.labels;
  const night = deepEqual(mapStyle, nightMapStyle);
  const builtIn = night || deepEqual(mapStyle, defaultMapStyle);
  return {
    palette: night ? "night" : "light",
    ...(builtIn ? {} : { theme: mapStyle.theme }),
    language: labels.language.code,
    fallbackPolicy: labels.fallbackPolicy,
    glyphs,
    options: tileParseOptionsConfig(settings),
  };
}

/** What a label atlas's JSON holds of interest here (`assets/atlas*.json`). */
export interface LabelAtlasGlyphs {
  readonly glyphs: readonly { readonly unicode: number }[];
}

/**
 * The code points the label atlases carry: those of every atlas, once each,
 * ascending (the Swift `VectorTileLabelGlyphCoverage(atlasData:thinAtlasData:)`).
 */
export function labelAtlasGlyphs(atlases: readonly LabelAtlasGlyphs[]): number[] {
  const scalars = new Set<number>();
  for (const atlas of atlases) for (const glyph of atlas.glyphs) scalars.add(glyph.unicode);
  return [...scalars].sort((a, b) => a - b);
}

/**
 * The prepared cache's namespace for a source and a parser configuration:
 * the archive (its URL whole, and the names of the headers sent with it,
 * never their values, which are credentials), whether the overview is laid
 * in, and the configuration's fingerprint. The worker adds the arena format
 * and the style revision the Wasm parser reports. A tile parsed under one
 * namespace is never served to a map that wants another (the Swift
 * `PreparedTileCacheIdentity`).
 */
export function preparedTileCacheNamespace(settings: ImmersiveMapSettings, archiveURL: string, config: TileParserConfig): string {
  const source = new StableFNV1aHasher().combineString(archiveURL);
  for (const field of Object.keys(settings.tiles.network.tileRequestHeaders).sort()) source.combineString(`header:${field}`);
  const parse = new StableFNV1aHasher().combineString(JSON.stringify(config));
  return `u${source.finalize().toString(16)}-p${parse.finalize().toString(16)}-o${settings.tiles.overview.isEnabled ? 1 : 0}`;
}
