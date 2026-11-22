// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgb, Rgba } from "../../configuration/color.ts";
import type { ScreenPointOutput } from "../../geo/geo-screen-projection-math.ts";
import { mat4TransformInto } from "../../math/matrix.ts";
import type { Vec2 } from "../../math/vec.ts";
import type { DebugOverlayControlSnapshot } from "../../render/debug/debug-overlay-control-state.ts";
import type { DebugFrameReport, DebugLabelBox } from "../../render/debug/debug-frame-report.ts";
import { DebugTileGridDensity } from "../../render/debug/debug-tile-grid-density.ts";
import { inOwnSlot, type PlaceTile, type ResidentTile, visibleTileKey } from "../../tile/placement/place-tile.ts";
import { DebugOverlayGeometry, DebugOverlayStyle, type DebugTextStyle } from "./debug-overlay-geometry.ts";
import type { DebugOverlayPrimitive, DebugOverlayTextMeasurer } from "./debug-overlay-primitives.ts";
import { DebugOverlayText, flatTerrainTag } from "./debug-overlay-text.ts";
import { DebugOverlayTileProjector } from "./debug-overlay-tile-projector.ts";
import { DebugTileGridCenterTile } from "./debug-tile-grid-center-tile.ts";
import { DebugTileGridMath, type TileGridUVRect } from "./debug-tile-grid-math.ts";
import { DebugTileZoomPalette } from "./debug-tile-zoom-palette.ts";

/** The overlay switches a plan reads (`DebugOverlayControlSnapshot`). */
export type DebugOverlayPlanControls = Pick<
  DebugOverlayControlSnapshot,
  "axesEnabled" | "tileLayersEnabled" | "tileGridEnabled" | "tileGridDensity" | "roadLabelTilesEnabled" | "baseLabelBoundsEnabled" | "roadLabelBoundsEnabled"
>;

/** What a plan is made with besides the frame. */
export interface DebugOverlayPlanOptions {
  /** Measures the overlay's text, `canvasTextMeasurer` of the overlay canvas. */
  readonly measurer: DebugOverlayTextMeasurer;
  /** `DebugSettings.diagnosticsScale`: the size the overlay's text is set from. */
  readonly diagnosticsScale: number;
}

/** What of the frame the overlay reads. */
export type DebugOverlayFrame = Pick<
  DebugFrameReport,
  "drawWidth" | "drawHeight" | "projection" | "projectionView" | "placements" | "mapCameraState" | "reliefFrame" | "activeRoadLabelTiles" | "labelBoxes"
>;

/** The size a text the overlay lays out is set at, from the settings' diagnostics size. */
function overlayTextScale(diagnosticsScale: number): number {
  return Math.max(diagnosticsScale * 0.5, 28.0);
}

/** On the flat map a tile edge is one straight piece, on the globe eight that follow the sphere. */
function segmentCountPerEdge(frame: DebugOverlayFrame): number {
  return frame.projection.mode === "flat" ? 1 : 8;
}

const withAlpha = (color: Rgb, alpha: number): Rgba => [color[0], color[1], color[2], alpha];

/** A piece of a line in tile UV and its two ends on screen. */
interface ProjectedSegment {
  readonly startUV: Vec2;
  readonly endUV: Vec2;
  readonly start: ScreenPointOutput;
  readonly end: ScreenPointOutput;
}

const sameUV = (a: Vec2, b: Vec2): boolean => a[0] === b[0] && a[1] === b[1];

/**
 * Stroked lines through the projected pieces, in canvas space: a run of
 * pieces that meet end to start in UV and are all on screen becomes one line,
 * so the corners join instead of leaving notches, and a piece with an end
 * off screen breaks the run (the Swift overlay drops such a piece).
 */
function chainSegments(segments: readonly ProjectedSegment[], drawHeight: number, color: Rgba, width: number, out: DebugOverlayPrimitive[]): void {
  let points: number[] = [];
  let firstUV: Vec2 | undefined;
  let lastUV: Vec2 | undefined;
  const flush = (): void => {
    if (points.length >= 4 && firstUV !== undefined && lastUV !== undefined) {
      const closed = points.length > 4 && sameUV(firstUV, lastUV);
      out.push({ kind: "polyline", points: closed ? points.slice(0, -2) : points, closed, color, width });
    }
    points = [];
    firstUV = undefined;
    lastUV = undefined;
  };
  for (const segment of segments) {
    if (segment.start.visible === 0 || segment.end.visible === 0) {
      flush();
      continue;
    }
    if (lastUV === undefined || !sameUV(lastUV, segment.startUV)) {
      flush();
      points.push(segment.start.positionX, drawHeight - segment.start.positionY);
      firstUV = segment.startUV;
    }
    points.push(segment.end.positionX, drawHeight - segment.end.positionY);
    lastUV = segment.endUV;
  }
  flush();
}

function projectSegments(projector: DebugOverlayTileProjector, placeTile: PlaceTile<ResidentTile>, segments: readonly { start: Vec2; end: Vec2 }[]): ProjectedSegment[] {
  return segments.map((segment) => ({
    startUV: segment.start,
    endUV: segment.end,
    start: projector.project(placeTile.placeIn, segment.start[0], segment.start[1]),
    end: projector.project(placeTile.placeIn, segment.end[0], segment.end[1]),
  }));
}

/** The outline's pieces in the order they run round the tile: each edge's pieces in turn, north, east, south, west. */
function perimeterSegments(count: number): { start: Vec2; end: Vec2 }[] {
  const segments = DebugOverlayGeometry.makeTileOverlaySegments(count);
  const ordered: { start: Vec2; end: Vec2 }[] = [];
  for (let edge = 0; edge < 4; edge++) {
    for (let index = 0; index < count; index++) ordered.push(segments[index * 4 + edge]!);
  }
  return ordered;
}

function appendTileOutline(
  projector: DebugOverlayTileProjector,
  placeTile: PlaceTile<ResidentTile>,
  outline: readonly { start: Vec2; end: Vec2 }[],
  drawHeight: number,
  width: number,
  color: Rgba,
  out: DebugOverlayPrimitive[],
): void {
  chainSegments(projectSegments(projector, placeTile, outline), drawHeight, color, width, out);
}

/** A screen-aligned run of text from a baseline-left position with y up. */
function screenText(text: string, position: Vec2, fontSize: number, drawHeight: number, style: DebugTextStyle): DebugOverlayPrimitive {
  return {
    kind: "text",
    text,
    x: position[0],
    y: drawHeight - position[1],
    fontSize,
    align: "left",
    color: style.textColor,
    strokeColor: style.strokeColor,
    strokeWidth: style.strokeWidthPx,
  };
}

/** The 7 x 7 grid points of a tile whose on-screen mean carries its label: dense, so the label slides as the points leave the screen one by one. */
const tileLabelAnchorUVs = DebugOverlayGeometry.makeTileWatermarkUVs(7);

/**
 * The world's axes from the origin, one render unit long, x red, y green and
 * z blue (the Swift `drawAxes`), one pixel wide. An axis whose end is
 * behind the camera is left out.
 */
export function planDebugAxes(frame: Pick<DebugOverlayFrame, "projectionView" | "drawWidth" | "drawHeight">, out: DebugOverlayPrimitive[] = []): DebugOverlayPrimitive[] {
  const clip = [0, 0, 0, 0];
  const screen = (x: number, y: number, z: number): Vec2 | undefined => {
    mat4TransformInto(clip, frame.projectionView, x, y, z, 1);
    const w = clip[3]!;
    if (!(w > 0)) return undefined;
    return [((clip[0]! / w) * 0.5 + 0.5) * frame.drawWidth, frame.drawHeight - ((clip[1]! / w) * 0.5 + 0.5) * frame.drawHeight];
  };
  const origin = screen(0, 0, 0);
  if (origin === undefined) return out;
  const ends = [screen(1, 0, 0), screen(0, 1, 0), screen(0, 0, 1)];
  ends.forEach((end, axis) => {
    if (end === undefined) return;
    out.push({ kind: "polyline", points: [origin[0], origin[1], end[0], end[1]], closed: false, color: DebugOverlayStyle.axisColors[axis]!, width: 1 });
  });
  return out;
}

/**
 * Every placement's outline and label (the Swift `drawTileOverlay`). The
 * outlines take the colour of the slot's zoom, as the labels, and are
 * thicker the coarser the zoom, the coarse ones drawn first: a coarse tile's
 * edge runs under the edges of the finer tiles that split it, and it would
 * be covered whole by an outline of one width, where a thinner line over a
 * thicker one leaves both to be seen.
 *
 * One label per placement, on the screen rather than in the tile: upright
 * and of one size at any pitch and bearing. It stands at the mean of the
 * tile's grid points that project onto the screen (`makeTileLabelAnchor`):
 * the address in its zoom's colour, the terrain tag in its own on the
 * relief, and under them the source when the tile stands in for another, in
 * the source's zoom's colour. The lines first, then the addresses by zoom,
 * then the terrain tags.
 */
export function planDebugTileOverlay(frame: DebugOverlayFrame, options: DebugOverlayPlanOptions, out: DebugOverlayPrimitive[] = []): DebugOverlayPrimitive[] {
  const placeTiles = frame.placements;
  if (placeTiles.length === 0) return out;
  const projector = new DebugOverlayTileProjector(frame.projection);
  const outline = perimeterSegments(segmentCountPerEdge(frame));
  const labelScale = Math.max(overlayTextScale(options.diagnosticsScale) * 0.6, 18.0);
  const lineAdvance = DebugOverlayGeometry.makeLineAdvance(labelScale);
  const width = (text: string): number => options.measurer.measure(text, labelScale).width;
  const relief = frame.reliefFrame !== undefined && frame.reliefFrame.isActive ? frame.reliefFrame : undefined;
  const viewportWidth = frame.drawWidth;
  const viewportHeight = frame.drawHeight;

  let deepestZoom = 0;
  for (const placeTile of placeTiles) deepestZoom = Math.max(deepestZoom, placeTile.placeIn.tile.z);
  const addressEntries = new Map<number, { text: string; position: Vec2 }[]>();
  const terrainEntries: { text: string; position: Vec2 }[] = [];
  const addAddress = (zoom: number, text: string, position: Vec2): void => {
    const entries = addressEntries.get(zoom);
    if (entries === undefined) addressEntries.set(zoom, [{ text, position }]);
    else entries.push({ text, position });
  };

  const sorted = [...placeTiles].sort((a, b) => a.placeIn.tile.z - b.placeIn.tile.z);
  for (const placeTile of sorted) {
    const zoom = placeTile.placeIn.tile.z;
    appendTileOutline(
      projector,
      placeTile,
      outline,
      frame.drawHeight,
      DebugOverlayGeometry.tileOutlineThickness(zoom, deepestZoom),
      withAlpha(DebugTileZoomPalette.color(zoom), DebugOverlayStyle.tileOutlineAlpha),
      out,
    );

    const visiblePoints: Vec2[] = [];
    for (const point of projector.projectAll(placeTile.placeIn, tileLabelAnchorUVs)) {
      if (point.visible !== 0 && point.positionX >= 0 && point.positionY >= 0 && point.positionX <= viewportWidth && point.positionY <= viewportHeight) {
        visiblePoints.push([point.positionX, point.positionY]);
      }
    }
    const anchor = DebugOverlayGeometry.makeTileLabelAnchor(visiblePoints);
    if (anchor === undefined) continue;
    const addressText = DebugOverlayText.formatTileAddress(placeTile.placeIn.tile);
    let terrainText: string | undefined;
    if (relief !== undefined) {
      const terrain = placeTile.displacement;
      terrainText = DebugOverlayText.formatTerrainTag(placeTile.resident.tile, terrain === undefined ? undefined : relief.relief(placeTile.resident.tile, terrain));
    }
    const addressWidth = width(addressText);
    const totalWidth = addressWidth + (terrainText === undefined ? 0 : width(terrainText) + DebugOverlayStyle.tileWatermarkGapPx);
    const left = anchor[0] - totalWidth * 0.5;
    addAddress(zoom, addressText, [left, anchor[1]]);
    if (terrainText !== undefined) terrainEntries.push({ text: terrainText, position: [left + addressWidth + DebugOverlayStyle.tileWatermarkGapPx, anchor[1]] });
    if (!inOwnSlot(placeTile)) {
      const sourceText = `src ${DebugOverlayText.formatTileAddress(placeTile.resident.tile)}`;
      addAddress(placeTile.resident.tile.z, sourceText, [anchor[0] - width(sourceText) * 0.5, anchor[1] - lineAdvance]);
    }
  }

  const strokeColor = DebugOverlayStyle.tileLabelStrokeColor;
  const strokeWidthPx = DebugOverlayStyle.tileWatermarkStrokeWidthPx;
  for (const zoom of [...addressEntries.keys()].sort((a, b) => a - b)) {
    const style: DebugTextStyle = { textColor: DebugTileZoomPalette.color(zoom), strokeColor, strokeWidthPx };
    for (const entry of addressEntries.get(zoom)!) out.push(screenText(entry.text, entry.position, labelScale, frame.drawHeight, style));
  }
  // The terrain tags: the raised ones in their colour, the flat ones apart.
  for (const isFlat of [false, true]) {
    const style: DebugTextStyle = { textColor: isFlat ? DebugOverlayStyle.tileWatermarkFlatColor : DebugOverlayStyle.tileWatermarkTerrainColor, strokeColor, strokeWidthPx };
    for (const entry of terrainEntries) {
      if ((entry.text === flatTerrainTag) === isFlat) out.push(screenText(entry.text, entry.position, labelScale, frame.drawHeight, style));
    }
  }
  return out;
}

/**
 * The placement the grid is drawn on: the tile under the camera centre, the
 * wrapped copy nearest the middle of the view when several contain it. The
 * horizon backdrop takes no part: it is no ground of the planner's.
 */
export function debugTileGridCenterPlacement(frame: DebugOverlayFrame): PlaceTile<ResidentTile> | undefined {
  const placements = frame.placements.filter((placeTile) => !placeTile.isHorizonBackdrop);
  const candidates = DebugTileGridCenterTile.candidates(placements, frame.mapCameraState.centerWorldMercator);
  if (candidates.length < 2) return candidates[0];
  // Wrapped copies of one tile all contain the centre: only their place on screen tells them apart.
  const projector = new DebugOverlayTileProjector(frame.projection);
  const centers = candidates.map((candidate) => projector.project(candidate.placeIn, 0.5, 0.5));
  return DebugTileGridCenterTile.nearestToViewportCenter(candidates, centers, [frame.drawWidth, frame.drawHeight]);
}

/** One line of a cell's stamp laid into the tile: its anchor, the UV a text pixel spans, and its measure. */
interface StampLine {
  readonly text: string;
  readonly anchorUV: Vec2;
  readonly uvScale: number;
  readonly width: number;
  readonly ascent: number;
  readonly descent: number;
}

/**
 * Divides the tile under the camera centre into `density x density` cells
 * and stamps each cell with the tile it belongs to, its cell code and its
 * tile-local bounds (the Swift `drawTileGridOverlay`). Only that one tile:
 * the grid exists so a screenshot of a region names the slice of tile
 * geometry to go read, and repeating it over every visible tile would bury
 * the map it is drawn over. The plates first, so the grid lines draw over
 * them and the text over both. The stamps are laid into the tile plane, so
 * they tilt with it.
 */
export function planDebugTileGridOverlay(frame: DebugOverlayFrame, density: number, options: DebugOverlayPlanOptions, out: DebugOverlayPrimitive[] = []): DebugOverlayPrimitive[] {
  const placeTile = debugTileGridCenterPlacement(frame);
  if (placeTile === undefined) return out;
  const clampedDensity = DebugTileGridDensity.clamp(density);
  const projector = new DebugOverlayTileProjector(frame.projection);
  const drawHeight = frame.drawHeight;
  const placeIn = placeTile.placeIn;

  // The cells big enough on screen for their stamp, and their lines.
  const scale = overlayTextScale(options.diagnosticsScale);
  const cellSpanUV = 1.0 / clampedDensity;
  const cornerPoints: ScreenPointOutput[] = [];
  for (let row = 0; row < clampedDensity; row++) {
    for (let column = 0; column < clampedDensity; column++) {
      const rect = DebugTileGridMath.cellUVRect(column, row, clampedDensity);
      cornerPoints.push(...projectRectCorners(projector, placeTile, rect));
    }
  }
  const lines: StampLine[] = [];
  const plates: TileGridUVRect[] = [];
  for (let row = 0; row < clampedDensity; row++) {
    for (let column = 0; column < clampedDensity; column++) {
      if (!DebugOverlayGeometry.isCellLargeEnoughForText(cornerPoints, row * clampedDensity + column, DebugOverlayStyle.tileGridMinimumCellScreenPixels)) continue;
      const plate = layOutCellStamp(
        DebugTileGridMath.cellLabelLines(placeIn.tile, column, row, clampedDensity, placeTile.resident.tile),
        DebugTileGridMath.cellUVRect(column, row, clampedDensity),
        cellSpanUV,
        scale,
        options,
        lines,
      );
      if (plate !== undefined) plates.push(plate);
    }
  }

  for (const plate of plates) {
    const corners = projectRectCorners(projector, placeTile, plate);
    if (!corners.every((corner) => corner.visible !== 0)) continue;
    const points: number[] = [];
    for (const corner of corners) points.push(corner.positionX, drawHeight - corner.positionY);
    out.push({ kind: "polygon", points, color: DebugOverlayStyle.tileGridCellPlateColor });
  }

  // The grid lines, the interior then the border over it, each line's pieces in a run so a line strokes whole.
  const segments = DebugTileGridMath.makeGridSegments(clampedDensity, segmentCountPerEdge(frame));
  const pieces = segmentCountPerEdge(frame);
  for (const isBorder of [false, true]) {
    const ordered: { start: Vec2; end: Vec2 }[] = [];
    for (let lineIndex = 0; lineIndex <= clampedDensity; lineIndex++) {
      for (let orientation = 0; orientation < 2; orientation++) {
        for (let piece = 0; piece < pieces; piece++) {
          const segment = segments[(lineIndex * pieces + piece) * 2 + orientation]!;
          if (segment.isBorder === isBorder) ordered.push(segment);
        }
      }
    }
    const width = isBorder ? DebugOverlayStyle.tileOutlineThicknessPx : DebugOverlayStyle.tileGridLineThicknessPx;
    chainSegments(projectSegments(projector, placeTile, ordered), drawHeight, DebugOverlayStyle.tileOutlineColor, width, out);
  }

  const style = DebugOverlayGeometry.makeTileWatermarkTextStyle();
  const viewport: Vec2 = [frame.drawWidth, frame.drawHeight];
  for (const line of lines) {
    const center = projector.project(placeIn, line.anchorUV[0], line.anchorUV[1]);
    const east = projector.project(placeIn, line.anchorUV[0] + line.uvScale, line.anchorUV[1]);
    const north = projector.project(placeIn, line.anchorUV[0], line.anchorUV[1] - line.uvScale);
    if (center.visible === 0 || east.visible === 0 || north.visible === 0) continue;
    const placement = DebugOverlayGeometry.makeTileWatermarkScreenPlacement(
      [center.positionX, center.positionY],
      [east.positionX, east.positionY],
      [north.positionX, north.positionY],
      [line.width, line.ascent + line.descent],
      viewport,
    );
    if (placement === undefined) continue;
    const { xAxis, yAxis } = placement;
    // Text pixels (x right, y down) onto the canvas (y down) through the axes (y up).
    const transform = [xAxis[0], -xAxis[1], -yAxis[0], yAxis[1], center.positionX, drawHeight - center.positionY] as const;
    const pixelScale = Math.sqrt(Math.abs(xAxis[0] * yAxis[1] - xAxis[1] * yAxis[0]));
    if (!(pixelScale > 0)) continue;
    out.push({
      kind: "text",
      text: line.text,
      x: 0,
      // The run's ink centred on its anchor: the baseline sits below the middle by half the ascent less the descent.
      y: (line.ascent - line.descent) * 0.5,
      fontSize: scale,
      align: "center",
      color: style.textColor,
      strokeColor: style.strokeColor,
      strokeWidth: style.strokeWidthPx / pixelScale,
      transform,
    });
  }
  return out;
}

function projectRectCorners(projector: DebugOverlayTileProjector, placeTile: PlaceTile<ResidentTile>, rect: TileGridUVRect): ScreenPointOutput[] {
  return [
    projector.project(placeTile.placeIn, rect.minU, rect.minV),
    projector.project(placeTile.placeIn, rect.maxU, rect.minV),
    projector.project(placeTile.placeIn, rect.maxU, rect.maxV),
    projector.project(placeTile.placeIn, rect.minU, rect.maxV),
  ];
}

/**
 * Lays a cell's lines out, top down from the cell's middle, each fitted to
 * its share of the cell's height and to most of its width, and returns the
 * plate that covers them: the same fit the projection applies, so the plate
 * covers exactly what is drawn rather than the box a line was allowed.
 */
function layOutCellStamp(
  texts: readonly string[],
  rect: TileGridUVRect,
  cellSpanUV: number,
  scale: number,
  options: DebugOverlayPlanOptions,
  out: StampLine[],
): TileGridUVRect | undefined {
  const heightFractions = DebugOverlayGeometry.cellLineHeightFractions(texts.length);
  if (texts.length === 0 || heightFractions.length !== texts.length) return undefined;
  const gapUV = DebugOverlayStyle.tileGridCellLineGapFraction * cellSpanUV;
  const totalHeightUV = heightFractions.reduce((sum, fraction) => sum + fraction * cellSpanUV, 0) + gapUV * (texts.length - 1);
  const centerU = (rect.minU + rect.maxU) * 0.5;
  const centerV = (rect.minV + rect.maxV) * 0.5;
  const maxWidthUV = DebugOverlayStyle.tileGridCellMaxWidthFraction * cellSpanUV;
  // `uv.y` grows southward, so the stack runs from the first line down.
  let lineTopV = centerV - totalHeightUV * 0.5;
  const anchors: Vec2[] = [];
  const halfSizes: Vec2[] = [];
  texts.forEach((text, index) => {
    const lineHeightUV = heightFractions[index]! * cellSpanUV;
    const measure = options.measurer.measure(text, scale);
    const metrics = { width: measure.width, height: measure.ascent + measure.descent };
    const anchorUV: Vec2 = [centerU, lineTopV + lineHeightUV * 0.5];
    const uvScale = DebugOverlayGeometry.tileWatermarkUVScale(metrics, maxWidthUV, lineHeightUV, [0, 0]);
    if (uvScale !== undefined) {
      out.push({ text, anchorUV, uvScale, width: measure.width, ascent: measure.ascent, descent: measure.descent });
      anchors.push(anchorUV);
      halfSizes.push([metrics.width * 0.5 * uvScale, metrics.height * 0.5 * uvScale]);
    }
    lineTopV += lineHeightUV + gapUV;
  });
  return DebugTileGridMath.makeStampPlate(anchors, halfSizes, DebugOverlayStyle.tileGridCellPlatePaddingFraction * cellSpanUV);
}

/** The outlines of the tile slots the road labels were laid out in this frame (the Swift `drawRoadLabelTileOverlay`). */
export function planDebugRoadLabelTileOverlay(frame: DebugOverlayFrame, out: DebugOverlayPrimitive[] = []): DebugOverlayPrimitive[] {
  const active = frame.activeRoadLabelTiles;
  if (active === undefined || active.length === 0) return out;
  const keys = new Set(active.map(visibleTileKey));
  const projector = new DebugOverlayTileProjector(frame.projection);
  const outline = perimeterSegments(segmentCountPerEdge(frame));
  for (const placeTile of frame.placements) {
    if (!keys.has(visibleTileKey(placeTile.placeIn))) continue;
    appendTileOutline(projector, placeTile, outline, frame.drawHeight, DebugOverlayStyle.tileOutlineThicknessPx, DebugOverlayStyle.roadLabelTileOutlineColor, out);
  }
  return out;
}

function appendLabelBoxes(boxes: readonly DebugLabelBox[], visibleColor: Rgba, hiddenColor: Rgba, drawHeight: number, out: DebugOverlayPrimitive[]): void {
  for (const box of boxes) {
    if (!(box.halfSize[0] > 0) || !(box.halfSize[1] > 0)) continue;
    const minX = box.center[0] - box.halfSize[0];
    const maxX = box.center[0] + box.halfSize[0];
    const minY = drawHeight - (box.center[1] - box.halfSize[1]);
    const maxY = drawHeight - (box.center[1] + box.halfSize[1]);
    out.push({
      kind: "polyline",
      points: [minX, minY, maxX, minY, maxX, maxY, minX, maxY],
      closed: true,
      color: box.isVisible ? visibleColor : hiddenColor,
      width: DebugOverlayStyle.labelBoundsThicknessPx,
    });
  }
}

/**
 * The frames of the frame's labels on screen (the Swift
 * `drawLabelBoundsOverlay`), visible and hidden (by collision, the label
 * horizon or a fade): base labels green and red, road labels (one glyph per
 * frame) cyan and orange, as they take part in the same collision solver.
 * Each kind only while its switch is on.
 */
export function planDebugLabelBoundsOverlay(
  frame: DebugOverlayFrame,
  controls: Pick<DebugOverlayPlanControls, "baseLabelBoundsEnabled" | "roadLabelBoundsEnabled">,
  out: DebugOverlayPrimitive[] = [],
): DebugOverlayPrimitive[] {
  const boxes = frame.labelBoxes;
  if (boxes === undefined) return out;
  if (controls.baseLabelBoundsEnabled) appendLabelBoxes(boxes.boxes, DebugOverlayStyle.labelBoundsVisibleColor, DebugOverlayStyle.labelBoundsHiddenColor, frame.drawHeight, out);
  if (controls.roadLabelBoundsEnabled) {
    appendLabelBoxes(boxes.roadBoxes, DebugOverlayStyle.roadLabelBoundsVisibleColor, DebugOverlayStyle.roadLabelBoundsHiddenColor, frame.drawHeight, out);
  }
  return out;
}

/**
 * The whole overlay for a frame, in the Swift `RendererDebugOverlayDrawer`
 * order: the axes, the tile outlines and labels, the tile grid, the road
 * label tiles, the label frames, each only while its switch is on.
 */
export function planDebugOverlay(frame: DebugOverlayFrame, controls: DebugOverlayPlanControls, options: DebugOverlayPlanOptions): DebugOverlayPrimitive[] {
  const out: DebugOverlayPrimitive[] = [];
  if (controls.axesEnabled) planDebugAxes(frame, out);
  if (controls.tileLayersEnabled) planDebugTileOverlay(frame, options, out);
  if (controls.tileGridEnabled) planDebugTileGridOverlay(frame, controls.tileGridDensity, options, out);
  if (controls.roadLabelTilesEnabled) planDebugRoadLabelTileOverlay(frame, out);
  if (controls.baseLabelBoundsEnabled || controls.roadLabelBoundsEnabled) planDebugLabelBoundsOverlay(frame, controls, out);
  return out;
}
