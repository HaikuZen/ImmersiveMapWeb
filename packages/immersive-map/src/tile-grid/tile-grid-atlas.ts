// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The font the tile grid writes its texts with, as the grid reads it: the
 * bold label atlas's glyphs in the table the GPU draws them from, and the
 * layout of one line of text over it. The Swift grid asks `TextRenderer`
 * for a text's vertices. Here the main thread has no text layout (a map
 * tile's names are laid out by the Rust of the tile workers), and a tile's
 * text is one line, so the line's layout of the core's `text-layout`
 * (`TextLayout::line_layout`) is done here, once for every text.
 */

/** The parts of an atlas JSON the grid reads (packages/immersive-map/assets/atlas.json, as msdf-atlas-gen writes it). */
export interface TileGridAtlasSource {
  readonly atlas: { readonly distanceRange: number; readonly size: number; readonly width: number; readonly height: number };
  readonly metrics: { readonly emSize: number };
  readonly glyphs: readonly {
    readonly unicode: number;
    readonly advance: number;
    readonly planeBounds?: { readonly left: number; readonly bottom: number; readonly right: number; readonly top: number };
    readonly atlasBounds?: { readonly left: number; readonly bottom: number; readonly right: number; readonly top: number };
  }[];
}

/** Floats a glyph of the table: its box about the pen in ems (left, bottom, right, top), then its place in the atlas (left, bottom, right, top, v down). */
export const TILE_GRID_ATLAS_GLYPH_FLOATS = 8;

export interface TileGridAtlas {
  /** The glyphs as the GPU reads them (`TileGridAtlasGlyph` in tile-grid.wgsl). */
  readonly table: Float32Array;
  /** Each glyph's index in the table, by its code point. */
  readonly indices: ReadonlyMap<number, number>;
  /** Each glyph's advance, in ems. */
  readonly advances: Float32Array;
  /** Whether each glyph has a picture in the atlas: a space only advances. */
  readonly drawn: Uint8Array;
  /** The atlas's distance range, in texels. */
  readonly distanceRange: number;
  /** Atlas texels per em. */
  readonly emTexels: number;
  readonly emSize: number;
}

export function makeTileGridAtlas(source: TileGridAtlasSource): TileGridAtlas {
  const count = source.glyphs.length;
  const table = new Float32Array(count * TILE_GRID_ATLAS_GLYPH_FLOATS);
  const advances = new Float32Array(count);
  const drawn = new Uint8Array(count);
  const indices = new Map<number, number>();
  const { width, height } = source.atlas;
  source.glyphs.forEach((glyph, index) => {
    // A code point listed twice keeps its last entry.
    indices.set(glyph.unicode, index);
    advances[index] = glyph.advance;
    const plane = glyph.planeBounds;
    const bounds = glyph.atlasBounds;
    const o = index * TILE_GRID_ATLAS_GLYPH_FLOATS;
    if (plane !== undefined) table.set([plane.left, plane.bottom, plane.right, plane.top], o);
    if (bounds !== undefined) {
      // The atlas's y grows up from its bottom, the texture's v down from its top.
      table.set([bounds.left / width, 1 - bounds.bottom / height, bounds.right / width, 1 - bounds.top / height], o + 4);
      drawn[index] = 1;
    }
  });
  return { table, indices, advances, drawn, distanceRange: source.atlas.distanceRange, emTexels: source.atlas.size, emSize: source.metrics.emSize };
}

/** A text laid out round its own middle, as the grid's frame takes it (`map_frame::tile_grid`). */
export interface TileGridTextLayout {
  readonly widthEm: number;
  readonly heightEm: number;
  /**
   * The glyphs, four words each: the glyph's index in the atlas's table in
   * the high half of the first, then the pen from the text's middle in ems
   * (x right, y up) as two floats, and a word the frame fills.
   */
  readonly records: Uint32Array;
}

/**
 * One line of text at one em to the unit, `undefined` for a text that draws
 * nothing. A character the atlas lacks takes a quarter em and draws nothing.
 */
export function layOutTileGridText(atlas: TileGridAtlas, text: string): TileGridTextLayout | undefined {
  const glyphs: number[] = [];
  const pens: number[] = [];
  let x = 0;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const character of text) {
    if (character === "\n") continue;
    const index = atlas.indices.get(character.codePointAt(0)!);
    if (index === undefined) {
      x += atlas.emSize * 0.25;
      continue;
    }
    if (atlas.drawn[index] === 1 && index < 0x10000) {
      const o = index * TILE_GRID_ATLAS_GLYPH_FLOATS;
      glyphs.push(index);
      pens.push(x);
      minX = Math.min(minX, x + atlas.table[o]!);
      minY = Math.min(minY, atlas.table[o + 1]!);
      maxX = Math.max(maxX, x + atlas.table[o + 2]!);
      maxY = Math.max(maxY, atlas.table[o + 3]!);
    }
    x += atlas.advances[index]!;
  }
  const widthEm = maxX - minX;
  const heightEm = maxY - minY;
  if (glyphs.length === 0 || !(widthEm > 0) || !(heightEm > 0)) return undefined;
  const middleX = minX + widthEm / 2;
  const middleY = minY + heightEm / 2;
  const records = new Uint32Array(glyphs.length * 4);
  const floats = new Float32Array(records.buffer);
  for (let i = 0; i < glyphs.length; i++) {
    records[i * 4] = glyphs[i]! << 16;
    floats[i * 4 + 1] = pens[i]! - middleX;
    // The line's baseline is at zero.
    floats[i * 4 + 2] = -middleY;
  }
  return { widthEm, heightEm, records };
}
