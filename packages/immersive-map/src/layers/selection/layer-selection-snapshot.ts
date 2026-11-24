// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../../geo/geo-coordinate.ts";
import { GeoScreenPlaceMath } from "../../geo/geo-screen-place-math.ts";
import type { GeoScreenProjectionFrameConstants } from "../../geo/geo-screen-projection-math.ts";
import { ImmersiveMapSelectionKind } from "../../selection/immersive-map-selection.ts";
import type { SelectionPickData } from "../../selection/selectable-map-feature.ts";
import { resolvePointStyle, resolvePolygonStyle, resolvePolylineStyle } from "../geojson/immersive-map-geojson.ts";
import type { ImmersiveMapLayer } from "../immersive-map-layer.ts";
import type { LayerSourceContent } from "../sources/layer-source-content.ts";
import { LayerPickMath, type LayerPickPlace } from "./layer-pick-math.ts";

/** The shape of a layer a tap landed on. */
export interface LayerSelectionHit {
  readonly layerID: string;
  readonly shapeID: number;
  /** The place on the map under the tap. */
  readonly coordinate: GeoCoordinate;
}

/** A layer a frame drew, with the shapes of its source. */
export interface LayerSelectionEntry {
  readonly layer: ImmersiveMapLayer;
  readonly content: LayerSourceContent;
}

/**
 * Hit-test state of one rendered frame, the Swift `LayerSelectionSnapshot`:
 * the layers it drew, in the order it drew them, each with the shapes of its
 * source, and the projection it drew them with. What is on screen is what can
 * be tapped: a hidden layer, one outside its zooms and one whose source is
 * not read are not here.
 */
export class LayerSelectionSnapshot implements SelectionPickData {
  /** A line thinner than this is hard to aim at: its hit area grows to this half width, in points. */
  static readonly minimumLineReachPoints = 8;
  /** A point smaller than this grows to this radius, in points. */
  static readonly minimumPointReachPoints = 16;

  static readonly empty = new LayerSelectionSnapshot(0, 0, 0, undefined, []);

  readonly kind = ImmersiveMapSelectionKind.layers;

  constructor(
    readonly frameIndex: number,
    readonly drawWidth: number,
    readonly drawHeight: number,
    /** The frame's projection, `undefined` for a frame that drew no layer. */
    readonly projection: GeoScreenProjectionFrameConstants | undefined,
    readonly entries: readonly LayerSelectionEntry[],
  ) {}

  /**
   * The shape under `point` (drawable pixels, origin bottom-left): of the
   * layer drawn last first, and within a layer its points, then its lines,
   * then its zones, as they cover each other on screen.
   */
  hitTest(point: { readonly x: number; readonly y: number }, pixelsPerPoint: number): LayerSelectionHit | undefined {
    const projection = this.projection;
    if (this.entries.length === 0 || projection === undefined) return undefined;
    const place = GeoScreenPlaceMath.place([point.x, point.y], projection);
    if (place === undefined) return undefined;
    return LayerSelectionSnapshot.hit(this.entries, place, pixelsPerPoint);
  }

  /** The shape of `entries` at a place on the map, the entry drawn last first. */
  static hit(entries: readonly LayerSelectionEntry[], place: LayerPickPlace, pixelsPerPoint: number): LayerSelectionHit | undefined {
    const coordinate = LayerPickMath.coordinateOfWorld(place.world);
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]!;
      const shapeID = hitTestEntry(entry, place, coordinate, pixelsPerPoint);
      if (shapeID !== undefined) return { layerID: entry.layer.id, shapeID, coordinate };
    }
    return undefined;
  }
}

function hitTestEntry(entry: LayerSelectionEntry, place: LayerPickPlace, coordinate: GeoCoordinate, pixelsPerPoint: number): number | undefined {
  const { layer, content } = entry;
  const { coordinates, polygons, rings, polylines, points, styles } = content.buffers;

  // The nearest point whose disc, or its touch target, holds the tap.
  let nearest: { id: number; distance: number } | undefined;
  for (let index = 0; index < content.pointCount; index++) {
    const style = resolvePointStyle(styles, points[index * 2 + 1]!, layer.pointStyle);
    if (!(style.radiusPoints + style.strokeWidthPoints > 0) || !(style.color[3] > 0 || style.strokeColor[3] > 0)) continue;
    const reach = Math.max(style.radiusPoints + style.strokeWidthPoints, LayerSelectionSnapshot.minimumPointReachPoints) * pixelsPerPoint;
    const margin = place.worldReach(reach) * 360;
    const at = points[index * 2]!;
    if (!LayerPickMath.boxHolds(coordinates, at, 1, coordinate, margin)) continue;
    const world = LayerPickMath.world(coordinates[at * 2 + 1]!, coordinates[at * 2]!);
    const offset = place.pixelOffset([world[0] + Math.round(place.world[0] - world[0]), world[1]]);
    const distance = Math.hypot(offset[0], offset[1]);
    if (distance <= reach && distance < (nearest?.distance ?? Number.POSITIVE_INFINITY)) nearest = { id: content.pointID(index), distance };
  }
  if (nearest !== undefined) return nearest.id;

  // The nearest line within its half width, or its touch target.
  for (let index = 0; index < content.polylineCount; index++) {
    const style = resolvePolylineStyle(styles, polylines[index * 3 + 2]!, layer.polylineStyle);
    if (!(style.color[3] > 0) || !(style.widthPoints > 0)) continue;
    const reach = Math.max(style.widthPoints / 2, LayerSelectionSnapshot.minimumLineReachPoints) * pixelsPerPoint;
    const distance = distanceToLine(coordinates, polylines[index * 3]!, polylines[index * 3 + 1]!, false, reach, place, coordinate);
    if (distance !== undefined && distance < (nearest?.distance ?? Number.POSITIVE_INFINITY)) nearest = { id: content.polylineID(index), distance };
  }
  if (nearest !== undefined) return nearest.id;

  // The zone drawn last that holds the tap in its fill, or has its outline under it when it has no fill.
  for (let index = content.polygonCount - 1; index >= 0; index--) {
    const firstRing = polygons[index * 3]!;
    const ringCount = polygons[index * 3 + 1]!;
    if (ringCount === 0) continue;
    const style = resolvePolygonStyle(styles, polygons[index * 3 + 2]!, layer.polygonStyle);
    if (style.fillColor[3] > 0) {
      const exteriorFirst = rings[firstRing * 2]!;
      const exteriorCount = rings[firstRing * 2 + 1]!;
      if (!LayerPickMath.boxHolds(coordinates, exteriorFirst, exteriorCount, coordinate, 0)) continue;
      const exterior = ringNear(coordinates, exteriorFirst, exteriorCount, place);
      if (exterior.length < 3 || !LayerPickMath.ringContains(exterior, place.world)) continue;
      let inHole = false;
      for (let r = 1; r < ringCount && !inHole; r++) {
        const hole = ringNear(coordinates, rings[(firstRing + r) * 2]!, rings[(firstRing + r) * 2 + 1]!, place);
        inHole = hole.length >= 3 && LayerPickMath.ringContains(hole, place.world);
      }
      if (!inHole) return content.polygonID(index);
    } else if (style.strokeColor[3] > 0 && style.strokeWidthPoints > 0) {
      const reach = Math.max(style.strokeWidthPoints / 2, LayerSelectionSnapshot.minimumLineReachPoints) * pixelsPerPoint;
      for (let r = 0; r < ringCount; r++) {
        if (distanceToLine(coordinates, rings[(firstRing + r) * 2]!, rings[(firstRing + r) * 2 + 1]!, true, reach, place, coordinate) !== undefined) return content.polygonID(index);
      }
    }
  }
  return undefined;
}

/** How far the tap is from a line on screen, `undefined` when farther than `reach` pixels. */
function distanceToLine(coordinates: Float64Array, first: number, count: number, closed: boolean, reach: number, place: LayerPickPlace, coordinate: GeoCoordinate): number | undefined {
  const margin = place.worldReach(reach) * 360;
  if (!LayerPickMath.boxHolds(coordinates, first, count, coordinate, margin)) return undefined;
  const offsets = ringNear(coordinates, first, count, place).map((point) => place.pixelOffset(point));
  const start = offsets[0];
  if (start === undefined) return undefined;
  let nearest = Math.hypot(start[0], start[1]);
  let previous = start;
  const sequence = closed ? [...offsets.slice(1), start] : offsets.slice(1);
  for (const offset of sequence) {
    nearest = Math.min(nearest, LayerPickMath.distanceFromOriginToSegment(previous, offset));
    previous = offset;
  }
  return nearest <= reach ? nearest : undefined;
}

/** A ring or a line in the world as the layer draws it, in the copy of the world the tap's place lies in. */
function ringNear(coordinates: Float64Array, first: number, count: number, place: LayerPickPlace): [number, number][] {
  const world = LayerPickMath.unwrappedWorld(coordinates, first, count);
  if (world.length === 0) return world;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const point of world) {
    minimum = Math.min(minimum, point[0]);
    maximum = Math.max(maximum, point[0]);
  }
  const shift = Math.round(place.world[0] - (minimum + maximum) / 2);
  if (shift !== 0) for (const point of world) point[0] += shift;
  return world;
}
