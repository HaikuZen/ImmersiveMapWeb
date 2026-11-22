// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgb, Rgba } from "../../configuration/color.ts";
import type { ScreenPointOutput } from "../../geo/geo-screen-projection-math.ts";
import type { Vec2 } from "../../math/vec.ts";
import type { Tile } from "../../tile/tile.ts";

/** One piece of a tile's outline in tile UV. */
export interface TileOverlayLineSegment {
  readonly start: Vec2;
  readonly end: Vec2;
}

/**
 * The screen axes a run of text is laid along: the screen offset of one text
 * pixel to the right (`xAxis`) and one text pixel up (`yAxis`), in drawable
 * pixels with y up.
 */
export interface TileWatermarkScreenPlacement {
  readonly xAxis: Vec2;
  readonly yAxis: Vec2;
}

/** The size of a laid-out run of text at its font size, in text pixels (the Swift `TextMetrics.size`). */
export interface DebugTextMetrics {
  readonly width: number;
  readonly height: number;
}

/** A point of a tile to project: the UV in the tile and the tile it belongs to (the Swift `TilePointInput`). */
export interface DebugTilePointInput {
  readonly uv: Vec2;
  readonly tile: Tile;
}

/** A run of screen-aligned text: `position` is the baseline's left end, drawable pixels with y up (the Swift `TextEntry`). */
export interface DebugTextEntry {
  readonly text: string;
  readonly position: Vec2;
  readonly scale: number;
}

/** How a run of text is set: its fill, its outline and the outline's width in drawable pixels (the Swift `TextStyleUniform`). */
export interface DebugTextStyle {
  readonly textColor: Rgb;
  readonly strokeColor: Rgb;
  readonly strokeWidthPx: number;
}

/**
 * The fixed look of the debug overlay, the Swift `DebugOverlayRenderer`'s
 * constants: colours with alpha, widths and sizes in drawable pixels, and
 * fractions of a grid cell.
 */
export const DebugOverlayStyle = {
  tileOutlineThicknessPx: 3.5,
  tileWatermarkTerrainColor: [0.45, 0.9, 1.0] as Rgb,
  tileWatermarkFlatColor: [1.0, 0.45, 0.4] as Rgb,
  /** A thin stroke: the thick one of the tile labels runs into the neighbouring glyphs at the watermarks' size. */
  tileWatermarkStrokeWidthPx: 1.5,
  tileWatermarkGapPx: 10,
  tileWatermarkMaxWidthUV: 0.22,
  tileWatermarkMaxHeightUV: 0.04,
  tileWatermarkPaddingPx: [8.0, 4.0] as Vec2,
  tileLabelStrokeColor: [0.0, 0.0, 0.0] as Rgb,
  tileOutlineAlpha: 0.95,
  tileOutlineColor: [1.0, 0.95, 0.2, 0.95] as Rgba,
  roadLabelTileOutlineColor: [0.0, 0.85, 1.0, 0.95] as Rgba,
  labelBoundsVisibleColor: [0.2, 1.0, 0.35, 0.9] as Rgba,
  labelBoundsHiddenColor: [1.0, 0.25, 0.2, 0.9] as Rgba,
  roadLabelBoundsVisibleColor: [0.0, 0.85, 1.0, 0.9] as Rgba,
  roadLabelBoundsHiddenColor: [1.0, 0.65, 0.1, 0.9] as Rgba,
  labelBoundsThicknessPx: 1.5,
  tileGridLineThicknessPx: 1.5,
  /**
   * Below this, in drawable pixels, a cell has no room for its four-line
   * stamp, so the cell keeps its lines and loses its text.
   */
  tileGridMinimumCellScreenPixels: 48.0,
  tileGridCellMaxWidthFraction: 0.86,
  /**
   * Dark enough that a road name or a POI label under the stamp stops
   * competing with it, translucent enough that what is under the cell can
   * still be seen.
   */
  tileGridCellPlateColor: [0.0, 0.0, 0.0, 0.62] as Rgba,
  tileGridCellPlatePaddingFraction: 0.03,
  tileGridCellLineHeightFractions: [0.15, 0.26, 0.15, 0.15] as readonly number[],
  tileGridCellExtraLineHeightFraction: 0.12,
  tileGridCellLineGapFraction: 0.04,
  /** The axes' colours: x red, y green, z blue. */
  axisColors: [
    [1, 0, 0, 1],
    [0, 1, 0, 1],
    [0, 0, 1, 1],
  ] as readonly Rgba[],
  /** The atlas font's line height in ems, what a line of the overlay's text advances by. */
  atlasLineHeightEms: 1.362,
} as const;

/**
 * The debug overlay's geometry and placement decisions (the static helpers
 * of the Swift `DebugOverlayRenderer`): pure functions of tile UV and screen
 * points.
 */
export const DebugOverlayGeometry = {
  /** A grid of `gridSize x gridSize` points inside the tile, evenly spaced and off its edges, row by row from the north. */
  makeTileWatermarkUVs(gridSize = 3): Vec2[] {
    const clampedGridSize = Math.max(1, gridSize);
    const step = 1.0 / (clampedGridSize + 1);
    const uvs: Vec2[] = [];
    for (let row = 1; row <= clampedGridSize; row++) {
      for (let column = 1; column <= clampedGridSize; column++) uvs.push([column * step, row * step]);
    }
    return uvs;
  },

  /**
   * The tile's outline cut into `segmentCountPerEdge` pieces an edge, so on
   * the globe it follows the sphere: for each piece index the north, east,
   * south and west pieces in turn, running clockwise round the tile.
   */
  makeTileOverlaySegments(segmentCountPerEdge: number): TileOverlayLineSegment[] {
    const clampedSegments = Math.max(1, segmentCountPerEdge);
    const step = 1.0 / clampedSegments;
    const segments: TileOverlayLineSegment[] = [];
    for (let index = 0; index < clampedSegments; index++) {
      const start = index * step;
      const end = (index + 1) * step;
      segments.push({ start: [start, 0.0], end: [end, 0.0] });
      segments.push({ start: [1.0, start], end: [1.0, end] });
      segments.push({ start: [1.0 - start, 1.0], end: [1.0 - end, 1.0] });
      segments.push({ start: [0.0, 1.0 - start], end: [0.0, 1.0 - end] });
    }
    return segments;
  },

  /**
   * The width of a tile's outline: the deepest zoom of the frame takes the
   * thinnest line, and every zoom coarser than it six pixels more, up to a
   * cap, so the edges of up to six zooms lying on one line are all seen,
   * each showing three pixels past the next on either side.
   */
  tileOutlineThickness(zoom: number, deepestZoom: number): number {
    const step = 6;
    return Math.min(4 + step * Math.max(0, deepestZoom - zoom), 40);
  },

  /**
   * Whether a cell's screen bounding box has room for its stamp, measured
   * only when all four corners (`cornerPoints[cellIndex * 4 ...]`) project
   * in front of the camera: a cell straddling the near plane has no
   * meaningful size and no useful place to put its stamp. The short side
   * decides.
   */
  isCellLargeEnoughForText(cornerPoints: readonly ScreenPointOutput[], cellIndex: number, minimumScreenSize: number): boolean {
    const base = cellIndex * 4;
    if (base < 0 || base + 3 >= cornerPoints.length) return false;
    let minX = Number.MAX_VALUE;
    let minY = Number.MAX_VALUE;
    let maxX = -Number.MAX_VALUE;
    let maxY = -Number.MAX_VALUE;
    for (let offset = 0; offset < 4; offset++) {
      const point = cornerPoints[base + offset]!;
      if (point.visible === 0 || !Number.isFinite(point.positionX) || !Number.isFinite(point.positionY)) return false;
      minX = Math.min(minX, point.positionX);
      minY = Math.min(minY, point.positionY);
      maxX = Math.max(maxX, point.positionX);
      maxY = Math.max(maxY, point.positionY);
    }
    return Math.min(maxX - minX, maxY - minY) >= minimumScreenSize;
  },

  /**
   * Height of every stamped line as a fraction of the cell, the code line
   * taller than the rest. A substituted cell stamps one line more than the
   * usual four.
   */
  cellLineHeightFractions(lineCount: number): number[] {
    const base = DebugOverlayStyle.tileGridCellLineHeightFractions;
    if (lineCount <= base.length) return base.slice(0, Math.max(0, lineCount));
    return [...base, ...new Array<number>(lineCount - base.length).fill(DebugOverlayStyle.tileGridCellExtraLineHeightFraction)];
  },

  /** Where a tile's label stands: the mean of its grid points on screen, `undefined` when the tile shows no point. */
  makeTileLabelAnchor(visiblePoints: readonly Vec2[]): Vec2 | undefined {
    if (visiblePoints.length === 0) return undefined;
    let x = 0;
    let y = 0;
    for (const point of visiblePoints) {
      x += point[0];
      y += point[1];
    }
    return [x / visiblePoints.length, y / visiblePoints.length];
  },

  /**
   * The UV a text pixel spans when a run of `metrics` is fitted, with its
   * padding, into a box of `maxWidthUV` by `maxHeightUV`, `undefined` for an
   * empty run.
   */
  tileWatermarkUVScale(metrics: DebugTextMetrics, maxWidthUV: number, maxHeightUV: number, paddingPx: Vec2): number | undefined {
    if (!(metrics.width > 0) || !(metrics.height > 0)) return undefined;
    const paddedWidth = metrics.width + paddingPx[0] * 2.0;
    const paddedHeight = metrics.height + paddingPx[1] * 2.0;
    return Math.min(maxWidthUV / paddedWidth, maxHeightUV / paddedHeight);
  },

  /**
   * The three tile points a run of text laid into the tile plane is placed
   * by: its anchor, one text pixel east of it and one text pixel north of
   * it. Up on the map is minus v, since `uv.y` grows southward.
   */
  makeTileWatermarkProjectionPointInputs(
    anchorUV: Vec2,
    metrics: DebugTextMetrics,
    tile: Tile,
    maxWidthUV: number,
    maxHeightUV: number,
    paddingPx: Vec2 = [0, 0],
  ): DebugTilePointInput[] {
    const uvScale = DebugOverlayGeometry.tileWatermarkUVScale(metrics, maxWidthUV, maxHeightUV, paddingPx);
    if (uvScale === undefined) return [];
    return [
      { uv: anchorUV, tile },
      { uv: [anchorUV[0] + uvScale, anchorUV[1]], tile },
      { uv: [anchorUV[0], anchorUV[1] - uvScale], tile },
    ];
  },

  /**
   * The screen axes of a run of text laid into the tile plane, from its
   * projected anchor and the projections of one text pixel east and north of
   * it. Near the projection singularity (clip w toward 0) the axes blow up
   * and a single glyph smears across the whole screen, so the run is
   * dropped when the axes are not finite, its screen size is extreme, or it
   * lies entirely outside the viewport.
   */
  makeTileWatermarkScreenPlacement(
    center: Vec2,
    xUnitPoint: Vec2,
    yUnitPoint: Vec2,
    textSize: Vec2,
    viewportSize: Vec2,
    maxViewportSpanFactor = 2.0,
  ): TileWatermarkScreenPlacement | undefined {
    const xAxis: Vec2 = [xUnitPoint[0] - center[0], xUnitPoint[1] - center[1]];
    const yAxis: Vec2 = [yUnitPoint[0] - center[0], yUnitPoint[1] - center[1]];
    const halfWidth = textSize[0] * 0.5;
    const halfHeight = textSize[1] * 0.5;
    const halfExtentX = Math.abs(xAxis[0]) * halfWidth + Math.abs(yAxis[0]) * halfHeight;
    const halfExtentY = Math.abs(xAxis[1]) * halfWidth + Math.abs(yAxis[1]) * halfHeight;
    if (!Number.isFinite(center[0]) || !Number.isFinite(center[1]) || !Number.isFinite(halfExtentX) || !Number.isFinite(halfExtentY)) return undefined;
    const maxScreenSpan = maxViewportSpanFactor * Math.max(viewportSize[0], viewportSize[1]);
    if (!(Math.max(halfExtentX, halfExtentY) * 2.0 <= maxScreenSpan)) return undefined;
    if (center[0] + halfExtentX < 0.0 || center[0] - halfExtentX > viewportSize[0] || center[1] + halfExtentY < 0.0 || center[1] - halfExtentY > viewportSize[1]) {
      return undefined;
    }
    return { xAxis, yAxis };
  },

  /** Lines of text stacked round `anchor`, the first on top, each `lineAdvance` below the last (y up). */
  makeTileTextEntries(anchor: Vec2, lines: readonly string[], scale: number, lineAdvance: number, padding: Vec2 = [6.0, 6.0]): DebugTextEntry[] {
    if (lines.length === 0) return [];
    const startY = anchor[1] + (lines.length - 1) * lineAdvance * 0.5;
    return lines.map((text, index) => ({ text, position: [anchor[0] + padding[0], startY - index * lineAdvance + padding[1]], scale }));
  },

  /** How far one line of the overlay's text at `scale` advances. */
  makeLineAdvance(scale: number): number {
    return Math.max(DebugOverlayStyle.atlasLineHeightEms * scale + 4.0, scale + 4.0);
  },

  /** The style of the text laid into the tile plane: the grid's stamps. */
  makeTileWatermarkTextStyle(): DebugTextStyle {
    return { textColor: [1.0, 0.95, 0.2], strokeColor: [0.0, 0.0, 0.0], strokeWidthPx: 2.0 };
  },
} as const;
