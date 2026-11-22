// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { type GeoCoordinate, geoCoordinate } from "../../geo/geo-coordinate.ts";
import { ImmersiveMapSelectionKind } from "../../selection/immersive-map-selection.ts";
import { ImmersiveMapLayer, type ImmersiveMapLayerOptions, type ImmersiveMapPoint, type ImmersiveMapPolygon, type ImmersiveMapPolyline } from "../immersive-map-layer.ts";
import { LayerSourceContent } from "../sources/layer-source-content.ts";
import { testLayerWasm } from "../testing/layer-test-jobs.ts";
import { parseLayerDocument } from "../worker/layer-jobs.ts";
import { LayerSelection } from "./layer-selection.ts";
import { LayerPickMath, LayerPickPlace, type World } from "./layer-pick-math.ts";
import { type LayerSelectionEntry, type LayerSelectionHit, LayerSelectionSnapshot } from "./layer-selection-snapshot.ts";

/** A flat map seen straight down: 1000 pixels to a world unit, y up. */
const straightDown = (world: World): [number, number] => [world[0] * 1000, (1 - world[1]) * 1000];

/** A tilted camera: the scale falls toward the north, and nothing shows past the horizon at y = 0.1. */
function tilted(world: World): [number, number] | undefined {
  const depth = world[1] - 0.1;
  if (!(depth > 0)) return undefined;
  return [500 + ((world[0] - 0.5) * 400) / depth, 300 / depth];
}

describe("LayerPickMath", () => {
  test("the place under a pixel is found on a flat map", () => {
    const place = LayerPickMath.place([250, 600], [0.9, 0.9], straightDown)!;
    expect(place.world[0]).toBeCloseTo(0.25, 6);
    expect(place.world[1]).toBeCloseTo(0.4, 6);
    // A thousandth of the world is a pixel here.
    const offset = place.pixelOffset([place.world[0] + 0.001, place.world[1]]);
    expect(Math.hypot(offset[0], offset[1])).toBeCloseTo(1, 6);
  });

  test("the place is found under a tilted camera from far away", () => {
    const target: World = [0.42, 0.15];
    const place = LayerPickMath.place(tilted(target)!, [0.5, 0.9], tilted)!;
    // Within the quarter of a pixel the search stops at.
    expect(Math.abs(place.world[0] - target[0])).toBeLessThan(1e-4);
    expect(Math.abs(place.world[1] - target[1])).toBeLessThan(1e-5);
  });

  test("a pixel off the map has no place", () => {
    // Nothing projects below the horizon's row of pixels.
    expect(LayerPickMath.place([500, -50], [0.5, 0.5], tilted)).toBeUndefined();
  });

  test("a world position is its coordinate", () => {
    const world = LayerPickMath.world(55.75, 37.6);
    const coordinate = LayerPickMath.coordinateOfWorld(world);
    expect(coordinate.latitude).toBeCloseTo(55.75, 9);
    expect(coordinate.longitude).toBeCloseTo(37.6, 9);
  });

  test("a ring holds what is inside it", () => {
    const ring: World[] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ];
    expect(LayerPickMath.ringContains(ring, [1, 1])).toBe(true);
    expect(LayerPickMath.ringContains(ring, [3, 1])).toBe(false);
    expect(LayerPickMath.distanceFromOriginToSegment([-1, 2], [1, 2])).toBeCloseTo(2, 12);
    // Past the segment's end, its end is the nearest.
    expect(LayerPickMath.distanceFromOriginToSegment([3, 4], [6, 8])).toBeCloseTo(5, 12);
  });
});

/** The place of a coordinate on a map of `pixelsPerDegree` at the equator, seen straight down. */
function placeAt(latitude: number, longitude: number, pixelsPerDegree = 100): LayerPickPlace {
  const scale = pixelsPerDegree * 360;
  return new LayerPickPlace(LayerPickMath.world(latitude, longitude), [scale, 0, 0, -scale]);
}

function entry(options: ImmersiveMapLayerOptions, shapes: { polygons?: ImmersiveMapPolygon[]; polylines?: ImmersiveMapPolyline[]; points?: ImmersiveMapPoint[] }): LayerSelectionEntry {
  return { layer: ImmersiveMapLayer.make(options), content: LayerSourceContent.fromShapes(shapes.polygons ?? [], shapes.polylines ?? [], shapes.points ?? []) };
}

function square(minimum: number, maximum: number, id?: number, holes: GeoCoordinate[][] = []): ImmersiveMapPolygon {
  return {
    id,
    exterior: [geoCoordinate(minimum, minimum), geoCoordinate(minimum, maximum), geoCoordinate(maximum, maximum), geoCoordinate(maximum, minimum)],
    holes,
  };
}

const hit = (entries: LayerSelectionEntry[], latitude: number, longitude: number): LayerSelectionHit | undefined => LayerSelectionSnapshot.hit(entries, placeAt(latitude, longitude), 1);

describe("LayerSelectionSnapshot", () => {
  test("a zone is hit in its fill and not in its hole", () => {
    const hole = [geoCoordinate(4, 4), geoCoordinate(4, 6), geoCoordinate(6, 6), geoCoordinate(6, 4)];
    const entries = [entry({ source: "zones" }, { polygons: [square(0, 10, 7, [hole])] })];
    const inside = hit(entries, 2, 2)!;
    expect(inside.layerID).toBe("zones");
    expect(inside.shapeID).toBe(7);
    expect(inside.coordinate.latitude).toBeCloseTo(2, 9);
    // A hole is not the zone.
    expect(hit(entries, 5, 5)).toBeUndefined();
    expect(hit(entries, 20, 2)).toBeUndefined();
  });

  test("a zone with no fill is hit on its outline alone", () => {
    const entries = [entry({ source: "zones", polygonStyle: { fillColor: [0, 0, 0, 0] } }, { polygons: [square(0, 10)] })];
    // A tap inside goes through to the map.
    expect(hit(entries, 5, 5)).toBeUndefined();
    // Three pixels off the edge is within reach, fifty pixels off is not.
    expect(hit(entries, 5, 0.03)).toBeDefined();
    expect(hit(entries, 5, 0.5)).toBeUndefined();
  });

  test("the nearest point wins and covers the zone under it", () => {
    const entries = [
      entry(
        { source: "mixed" },
        {
          polygons: [square(0, 10, 9)],
          points: [
            { id: 1, coordinate: geoCoordinate(5, 5) },
            { id: 2, coordinate: geoCoordinate(5, 5.1) },
          ],
        },
      ),
    ];
    // Two pixels from the second, eight from the first.
    expect(hit(entries, 5, 5.08)?.shapeID).toBe(2);
    expect(hit(entries, 5, 5.02)?.shapeID).toBe(1);
    // Away from the points, the zone.
    expect(hit(entries, 8, 8)?.shapeID).toBe(9);
  });

  test("a line is hit within its touch target", () => {
    const entries = [entry({ source: "lines" }, { polylines: [{ id: 3, coordinates: [geoCoordinate(0, 0), geoCoordinate(0, 10)] }] })];
    // Five pixels off a thin line, and twenty.
    expect(hit(entries, 0.05, 5)?.shapeID).toBe(3);
    expect(hit(entries, 0.2, 5)).toBeUndefined();
  });

  test("the layer drawn last is asked first", () => {
    const entries = [entry({ source: "under" }, { polygons: [square(0, 10)] }), entry({ source: "over" }, { polygons: [square(4, 6)] })];
    expect(hit(entries, 5, 5)?.layerID).toBe("over");
    expect(hit(entries, 2, 2)?.layerID).toBe("under");
  });

  test("a feature's simplestyle is laid over the layer's style for the tap too", () => {
    // The feature turns its zone's fill off: a tap inside goes through, its outline is hit.
    const parsed = parseLayerDocument(
      testLayerWasm,
      '{"type": "Feature", "properties": {"fill-opacity": 0}, "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]}}',
    );
    if (!parsed.ok) throw new Error("the document is GeoJSON");
    const entries = [{ layer: ImmersiveMapLayer.make({ source: "zones" }), content: new LayerSourceContent(parsed.buffers) }];
    expect(hit(entries, 5, 5)).toBeUndefined();
    expect(hit(entries, 5, 0.03)?.shapeID).toBe(0);
  });
});

describe("the ids of a source's shapes", () => {
  test("shapes go by their own id or their place in the source", () => {
    const content = LayerSourceContent.fromShapes([square(0, 1), square(0, 1, 40)], [{ coordinates: [] }], [{ coordinate: geoCoordinate(0, 0) }]);
    expect([content.polygonID(0), content.polygonID(1)]).toEqual([0, 40]);
    expect(content.polylineID(0)).toBe(2);
    expect(content.pointID(0)).toBe(3);
  });

  test("a GeoJSON feature's shapes go by its numeric id or its place", () => {
    const parsed = parseLayerDocument(
      testLayerWasm,
      `{"type": "FeatureCollection", "features": [
        {"type": "Feature", "id": 12, "geometry": {"type": "MultiPoint", "coordinates": [[1, 2], [3, 4]]}},
        {"type": "Feature", "id": "station-a", "geometry": {"type": "Point", "coordinates": [5, 6]}},
        {"type": "Feature", "geometry": {"type": "Point", "coordinates": [7, 8]}}
      ]}`,
    );
    if (!parsed.ok) throw new Error("the document is GeoJSON");
    const content = new LayerSourceContent(parsed.buffers);
    // A feature's parts share its id, and a feature with no numeric id goes by its place.
    expect([0, 1, 2, 3].map((i) => content.pointID(i))).toEqual([12, 12, 1, 2]);
  });
});

describe("LayerSelection", () => {
  test("a layer's kind names its layer", () => {
    const kind = ImmersiveMapSelectionKind.layer("zones");
    expect(ImmersiveMapSelectionKind.layerID(kind)).toBe("zones");
    expect(ImmersiveMapSelectionKind.layerID(ImmersiveMapSelectionKind.pin)).toBeNull();
    expect(kind).not.toBe(ImmersiveMapSelectionKind.layer("parks"));
  });

  test("a selection stands while the map holds its layer, and a tap reaches the app", () => {
    const layers = new Map([["zones", ImmersiveMapLayer.make({ source: "zones" })]]);
    const selection = new LayerSelection({ layer: (id) => layers.get(id) });
    expect(selection.owns(ImmersiveMapSelectionKind.layers)).toBe(true);
    expect(selection.owns(ImmersiveMapSelectionKind.layer("zones"))).toBe(true);
    expect(selection.owns(ImmersiveMapSelectionKind.pin)).toBe(false);
    expect(selection.contains({ kind: ImmersiveMapSelectionKind.layer("zones"), objectID: 1 })).toBe(true);
    expect(selection.contains({ kind: ImmersiveMapSelectionKind.layer("parks"), objectID: 1 })).toBe(false);

    const hitOnZone = { selection: { kind: ImmersiveMapSelectionKind.layer("zones"), objectID: 4 }, coordinate: geoCoordinate(1, 2) };
    // No action of the app: the tap is not taken.
    expect(selection.deliverTap(hitOnZone, { x: 3, y: 4 })).toBe(false);
    const events: number[] = [];
    selection.tapAction = (event) => events.push(event.shapeID);
    expect(selection.deliverTap(hitOnZone, { x: 3, y: 4 })).toBe(true);
    expect(events).toEqual([4]);
    // Nothing drawn, nothing hit.
    expect(selection.hitTest({ x: 0, y: 0 }, 2)).toBeNull();
  });
});
