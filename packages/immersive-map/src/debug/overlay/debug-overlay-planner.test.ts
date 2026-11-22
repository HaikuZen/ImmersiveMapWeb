// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The drawing decisions of the Swift `DebugOverlayRenderer` as screen-space
// primitives: which tiles, which colours and widths, which text, in which
// order, through the frame's real projection.

import { describe, expect, test } from "vitest";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { DebugOverlayControlSnapshot } from "../../render/debug/debug-overlay-control-state.ts";
import { makePlaceTile, type PlaceTile, type ResidentTile } from "../../tile/placement/place-tile.ts";
import type { Tile } from "../../tile/tile.ts";
import { DebugOverlayGeometry, DebugOverlayStyle } from "./debug-overlay-geometry.ts";
import {
  debugTileGridCenterPlacement,
  planDebugAxes,
  planDebugLabelBoundsOverlay,
  planDebugOverlay,
  planDebugRoadLabelTileOverlay,
  planDebugTileGridOverlay,
  planDebugTileOverlay,
} from "./debug-overlay-planner.ts";
import type { DebugOverlayPolygon, DebugOverlayPolyline, DebugOverlayPrimitive, DebugOverlayText, DebugOverlayTextMeasurer } from "./debug-overlay-primitives.ts";
import { DebugTileZoomPalette } from "./debug-tile-zoom-palette.ts";
import { makeDebugFrameReport } from "./testing/debug-frame-report-fixture.ts";

/** A fixed-pitch measurer: every character six tenths of the font size wide. */
const measurer: DebugOverlayTextMeasurer = {
  measure: (text, fontSize) => ({ width: text.length * fontSize * 0.6, ascent: fontSize * 0.7, descent: fontSize * 0.2 }),
};
const options = { measurer, diagnosticsScale: 60 };

const latitude = 55.75;
const longitude = 37.61;

/** The tile of `zoom` under the point the fixtures' camera looks at. */
function tileUnderCentre(zoom: number): Tile {
  const center = ImmersiveMapProjection.worldMercator((latitude * Math.PI) / 180, (longitude * Math.PI) / 180);
  const count = 2 ** zoom;
  return { x: Math.floor(center[0] * count), y: Math.floor(center[1] * count), z: zoom };
}

/** A camera looking at the middle of `tile`, so the tile lies whole round the middle of the view. */
function cameraOverMiddle(tile: Tile, zoom: number) {
  const count = 2 ** tile.z;
  return {
    latitude: (ImmersiveMapProjection.latitudeFromNormalizedWorldY((tile.y + 0.5) / count) * 180) / Math.PI,
    longitude: (ImmersiveMapProjection.longitudeFromNormalizedWorldX((tile.x + 0.5) / count) * 180) / Math.PI,
    zoom,
  };
}

function place(slot: Tile, source: Tile = slot, worldWrap = 0, isHorizonBackdrop = false): PlaceTile<ResidentTile> {
  return makePlaceTile({ tile: source }, { tile: slot, worldWrap }, { isHorizonBackdrop });
}

const polylines = (primitives: readonly DebugOverlayPrimitive[]) => primitives.filter((p): p is DebugOverlayPolyline => p.kind === "polyline");
const texts = (primitives: readonly DebugOverlayPrimitive[]) => primitives.filter((p): p is DebugOverlayText => p.kind === "text");
const polygons = (primitives: readonly DebugOverlayPrimitive[]) => primitives.filter((p): p is DebugOverlayPolygon => p.kind === "polygon");

const allOff: DebugOverlayControlSnapshot = {
  axesEnabled: false,
  tileLayersEnabled: false,
  wireframeEnabled: false,
  roadLabelTilesEnabled: false,
  baseLabelBoundsEnabled: false,
  roadLabelBoundsEnabled: false,
  tileGridEnabled: false,
  tileGridDensity: 6,
  ringRuleSets: { sets: [] },
  labelDistanceRules: [],
  localLabelMaximumDistanceMeters: undefined,
  labelPerspectiveMinimumScale: undefined,
};

describe("planDebugTileOverlay", () => {
  test("a tile under the camera is outlined whole in its zoom's colour and labelled at its middle", () => {
    const tile = tileUnderCentre(14);
    const frame = makeDebugFrameReport(cameraOverMiddle(tile, 14), [place(tile)]);
    const primitives = planDebugTileOverlay(frame, options);

    const [outline, ...otherLines] = polylines(primitives);
    expect(otherLines).toEqual([]);
    expect(outline?.closed).toBe(true);
    // One piece an edge on the flat map: the four corners.
    expect(outline?.points).toHaveLength(8);
    expect(outline?.width).toBe(4);
    expect(outline?.color).toEqual([...DebugTileZoomPalette.color(14), 0.95]);

    const [label, ...otherTexts] = texts(primitives);
    expect(otherTexts).toEqual([]);
    expect(label?.text).toBe(`${tile.x}/${tile.y}/${tile.z}`);
    expect(label?.color).toEqual(DebugTileZoomPalette.color(14));
    expect(label?.strokeWidth).toBe(1.5);
    // max(max(60 * 0.5, 28) * 0.6, 18).
    expect(label?.fontSize).toBe(18);
    // The label is centred on the mean of the tile's points on screen.
    const xs = outline!.points.filter((_, index) => index % 2 === 0);
    const ys = outline!.points.filter((_, index) => index % 2 === 1);
    const tileMiddleX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const tileMiddleY = (Math.min(...ys) + Math.max(...ys)) / 2;
    const labelWidth = label!.text.length * 18 * 0.6;
    expect(Math.abs(label!.x + labelWidth / 2 - tileMiddleX)).toBeLessThan(1);
    expect(Math.abs(label!.y - tileMiddleY)).toBeLessThan(1);
  });

  test("the coarser zoom is outlined first and thicker", () => {
    const fine = tileUnderCentre(14);
    const coarse = tileUnderCentre(12);
    const frame = makeDebugFrameReport({ latitude, longitude, zoom: 14.5 }, [place(fine), place(coarse)]);
    const lines = polylines(planDebugTileOverlay(frame, options));
    expect(lines.map((line) => line.width)).toEqual([DebugOverlayGeometry.tileOutlineThickness(12, 14), 4]);
    expect(lines[0]?.color).toEqual([...DebugTileZoomPalette.color(12), 0.95]);
  });

  test("a stand-in names its source under the address, in the source's zoom's colour", () => {
    const slot = tileUnderCentre(14);
    const source = tileUnderCentre(13);
    const frame = makeDebugFrameReport({ latitude, longitude, zoom: 14.5 }, [place(slot, source)]);
    const labels = texts(planDebugTileOverlay(frame, options));
    // The addresses by zoom, the coarsest first: the source's line before the slot's.
    const address = labels.find((label) => !label.text.startsWith("src"));
    const sourceLine = labels.find((label) => label.text.startsWith("src"));
    expect(address?.text).toBe(`${slot.x}/${slot.y}/${slot.z}`);
    expect(sourceLine?.text).toBe(`src ${source.x}/${source.y}/${source.z}`);
    expect(sourceLine?.color).toEqual(DebugTileZoomPalette.color(13));
    // One line advance under it, y down on the canvas.
    expect(sourceLine!.y - address!.y).toBeCloseTo(DebugOverlayGeometry.makeLineAdvance(18), 6);
  });

  test("a tile off screen keeps its outline, off the canvas, and loses its label", () => {
    const far = tileUnderCentre(14);
    const frame = makeDebugFrameReport({ latitude, longitude, zoom: 14.5 }, [place({ ...far, x: far.x + 40 })]);
    const primitives = planDebugTileOverlay(frame, options);
    expect(texts(primitives)).toEqual([]);
    for (const line of polylines(primitives)) expect(Math.min(...line.points.filter((_, index) => index % 2 === 0))).toBeGreaterThan(frame.drawWidth);
  });

  test("on the globe an edge follows the sphere in eight pieces", () => {
    const tile = tileUnderCentre(2);
    const frame = makeDebugFrameReport({ latitude, longitude, zoom: 2 }, [place(tile)]);
    expect(frame.projection.mode).toBe("globe");
    const lines = polylines(planDebugTileOverlay(frame, options));
    expect(lines.length).toBeGreaterThan(0);
    const pointCount = lines.reduce((sum, line) => sum + line.points.length / 2 + (line.closed ? 0 : -1), 0);
    expect(pointCount).toBeGreaterThan(4);
  });
});

describe("planDebugTileGridOverlay", () => {
  test("the centre tile is divided into stamped cells: plates, then lines, then text", () => {
    const tile = tileUnderCentre(15);
    const frame = makeDebugFrameReport(cameraOverMiddle(tile, 14.6), [place(tile), place(tileUnderCentre(14))]);
    const primitives = planDebugTileGridOverlay(frame, 4, options);
    const kinds = primitives.map((primitive) => primitive.kind);
    const lastPolygon = kinds.lastIndexOf("polygon");
    const firstLine = kinds.indexOf("polyline");
    const lastLine = kinds.lastIndexOf("polyline");
    const firstText = kinds.indexOf("text");
    expect(lastPolygon).toBeLessThan(firstLine);
    expect(lastLine).toBeLessThan(firstText);

    const plates = polygons(primitives);
    const stamps = texts(primitives);
    // Every cell has room for its stamp: a plate and four lines each.
    expect(plates).toHaveLength(16);
    expect(stamps).toHaveLength(16 * 4);
    expect(plates[0]?.color).toEqual(DebugOverlayStyle.tileGridCellPlateColor);
    expect(stamps.map((stamp) => stamp.text)).toContain("C4");
    expect(stamps.map((stamp) => stamp.text)).toContain(`${tile.x}/${tile.y}/${tile.z}`);
    // Laid into the tile plane: each run carries its matrix and is set centred on its anchor.
    for (const stamp of stamps) {
      expect(stamp.transform).toBeDefined();
      expect(stamp.align).toBe("center");
    }

    const lines = polylines(primitives);
    expect(new Set(lines.map((line) => line.width))).toEqual(new Set([DebugOverlayStyle.tileGridLineThicknessPx, DebugOverlayStyle.tileOutlineThicknessPx]));
    for (const line of lines) expect(line.color).toEqual(DebugOverlayStyle.tileOutlineColor);
  });

  test("a density nobody can select snaps to the nearest offered one", () => {
    const frame = makeDebugFrameReport({ latitude, longitude, zoom: 15.2 }, [place(tileUnderCentre(15))]);
    expect(polygons(planDebugTileGridOverlay(frame, 5, options))).toHaveLength(16);
  });

  test("cells too small on screen keep their lines and lose their stamps", () => {
    const frame = makeDebugFrameReport({ latitude, longitude, zoom: 12.2 }, [place(tileUnderCentre(15))]);
    const primitives = planDebugTileGridOverlay(frame, 8, options);
    expect(texts(primitives)).toEqual([]);
    expect(polygons(primitives)).toEqual([]);
    expect(polylines(primitives).length).toBeGreaterThan(0);
  });

  test("a substituted slot stamps the source tile", () => {
    const slot = tileUnderCentre(15);
    const source = tileUnderCentre(14);
    const frame = makeDebugFrameReport({ latitude, longitude, zoom: 15.2 }, [place(slot, source)]);
    expect(texts(planDebugTileGridOverlay(frame, 2, options)).map((stamp) => stamp.text)).toContain(`src ${source.x}/${source.y}/${source.z}`);
  });

  test("the horizon backdrop is never the grid's tile", () => {
    const world = { x: 0, y: 0, z: 0 };
    const tile = tileUnderCentre(15);
    const frame = makeDebugFrameReport({ latitude, longitude, zoom: 15.2 }, [place(world, world, 0, true), place(tile)]);
    expect(debugTileGridCenterPlacement(frame)?.placeIn.tile).toEqual(tile);
  });
});

describe("planDebugRoadLabelTileOverlay", () => {
  test("only the slots the road labels were laid out in are outlined", () => {
    const tile = tileUnderCentre(14);
    const neighbour = { ...tile, x: tile.x + 1 };
    const frame = makeDebugFrameReport({ latitude, longitude, zoom: 14.5 }, [place(tile), place(neighbour)], {
      activeRoadLabelTiles: [{ tile, worldWrap: 0 }],
    });
    const lines = polylines(planDebugRoadLabelTileOverlay(frame));
    expect(lines).toHaveLength(1);
    expect(lines[0]?.color).toEqual(DebugOverlayStyle.roadLabelTileOutlineColor);
    expect(lines[0]?.width).toBe(DebugOverlayStyle.tileOutlineThicknessPx);
    expect(planDebugRoadLabelTileOverlay(makeDebugFrameReport({ latitude, longitude, zoom: 14.5 }, [place(tile)]))).toEqual([]);
  });
});

describe("planDebugLabelBoundsOverlay", () => {
  const frame = makeDebugFrameReport({ latitude, longitude, zoom: 14.5 }, [], {
    labelBoxes: {
      boxes: [
        { center: [100, 500], halfSize: [20, 10], isVisible: true },
        { center: [200, 500], halfSize: [20, 10], isVisible: false },
        { center: [300, 500], halfSize: [0, 10], isVisible: true },
      ],
      roadBoxes: [{ center: [400, 100], halfSize: [5, 5], isVisible: true }],
    },
  });

  test("the base labels' frames are green when shown and red when hidden, y down on the canvas", () => {
    const lines = polylines(planDebugLabelBoundsOverlay(frame, { baseLabelBoundsEnabled: true, roadLabelBoundsEnabled: false }));
    expect(lines.map((line) => line.color)).toEqual([DebugOverlayStyle.labelBoundsVisibleColor, DebugOverlayStyle.labelBoundsHiddenColor]);
    expect(lines[0]?.closed).toBe(true);
    expect(lines[0]?.points).toEqual([80, 110, 120, 110, 120, 90, 80, 90]);
  });

  test("the road labels' frames only with their switch", () => {
    const lines = polylines(planDebugLabelBoundsOverlay(frame, { baseLabelBoundsEnabled: false, roadLabelBoundsEnabled: true }));
    expect(lines.map((line) => line.color)).toEqual([DebugOverlayStyle.roadLabelBoundsVisibleColor]);
  });
});

describe("planDebugOverlay", () => {
  test("nothing switched on draws nothing", () => {
    const frame = makeDebugFrameReport({ latitude, longitude, zoom: 14.5 }, [place(tileUnderCentre(14))]);
    expect(planDebugOverlay(frame, allOff, options)).toEqual([]);
  });

  test("the axes come first, then the tiles", () => {
    const frame = makeDebugFrameReport({ latitude, longitude, zoom: 14.5 }, [place(tileUnderCentre(14))]);
    const axes = planDebugAxes(frame);
    // An axis whose end lies behind the eye is left out, so the z axis may be missing straight down.
    expect(axes.map((axis) => (axis as DebugOverlayPolyline).color)).toEqual(DebugOverlayStyle.axisColors.slice(0, axes.length));
    expect(axes.length).toBeGreaterThanOrEqual(2);
    const primitives = planDebugOverlay(frame, { ...allOff, axesEnabled: true, tileLayersEnabled: true }, options);
    expect(primitives.slice(0, axes.length)).toEqual(axes);
    expect(primitives.length).toBeGreaterThan(axes.length);
  });
});
