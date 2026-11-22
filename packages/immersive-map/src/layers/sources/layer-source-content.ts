// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../../geo/geo-coordinate.ts";
import { ImmersiveMapPointStyle, ImmersiveMapPolygonStyle, ImmersiveMapPolylineStyle, type ImmersiveMapPoint, type ImmersiveMapPolygon, type ImmersiveMapPolyline } from "../immersive-map-layer.ts";
import { NO_STYLE, STYLE_RECORD_FLOATS, writePointStyleRecord, writePolygonStyleRecord, writePolylineStyleRecord } from "../geojson/immersive-map-geojson.ts";

/**
 * The flat arrays a source's shapes are held in: what the layers' worker
 * hands back for a GeoJSON document (crates/layer-mesh) and what shapes
 * built in code are laid into, so no shape is a JavaScript object once it is
 * read. Structured-cloneable and transferable as it is.
 *
 * - `coordinates`: longitude and latitude in degrees, interleaved.
 * - `polygons`: three words a zone, its first ring, its ring count and its
 *   style record (`NO_STYLE` for none).
 * - `rings`: two words a ring, its first coordinate and its coordinate
 *   count. A zone's first ring is its outline, the others its holes.
 * - `polylines`: three words a line, its first coordinate, its coordinate
 *   count and its style record.
 * - `points`: two words a point, its coordinate and its style record.
 * - `ids`: one a shape, the zones first, then the lines, then the points,
 *   `NaN` for a shape that has none.
 * - `styles`: the style records, `STYLE_RECORD_FLOATS` floats each
 *   (immersive-map-geojson.ts).
 */
export interface LayerSourceBuffers {
  readonly coordinates: Float64Array<ArrayBuffer>;
  readonly polygons: Uint32Array<ArrayBuffer>;
  readonly rings: Uint32Array<ArrayBuffer>;
  readonly polylines: Uint32Array<ArrayBuffer>;
  readonly points: Uint32Array<ArrayBuffer>;
  readonly ids: Float64Array<ArrayBuffer>;
  readonly styles: Float32Array<ArrayBuffer>;
}

/**
 * The shapes of a source, read and ready to be drawn: shared by every layer
 * that draws the source and by every map that draws those layers, the Swift
 * `LayerSourceContent`. Every shape has an id here: its own, or its place
 * among the source's shapes, the zones counted first, then the lines, then
 * the points. Immutable.
 */
export class LayerSourceContent {
  readonly buffers: LayerSourceBuffers;
  readonly polygonCount: number;
  readonly polylineCount: number;
  readonly pointCount: number;
  /**
   * The memory the shapes take, what the input limit counts
   * (`ImmersiveMapLayersController.inputLimitBytes`): the bytes of the
   * arrays, 16 for every coordinate and a few words for each shape.
   */
  readonly byteSize: number;

  constructor(buffers: LayerSourceBuffers) {
    this.polygonCount = Math.floor(buffers.polygons.length / 3);
    this.polylineCount = Math.floor(buffers.polylines.length / 3);
    this.pointCount = Math.floor(buffers.points.length / 2);
    const ids = buffers.ids;
    // A shape with no id goes by its place among the shapes.
    for (let index = 0; index < ids.length; index++) if (Number.isNaN(ids[index])) ids[index] = index;
    this.buffers = buffers;
    this.byteSize =
      buffers.coordinates.byteLength + buffers.polygons.byteLength + buffers.rings.byteLength + buffers.polylines.byteLength + buffers.points.byteLength + ids.byteLength + buffers.styles.byteLength;
  }

  /** Shapes built in code (`ImmersiveMapLayersController.register(name, { polygons, polylines, points })`) in the flat arrays. */
  static fromShapes(polygons: readonly ImmersiveMapPolygon[], polylines: readonly ImmersiveMapPolyline[], points: readonly ImmersiveMapPoint[]): LayerSourceContent {
    let coordinateCount = points.length;
    let ringCount = 0;
    let styleCount = 0;
    for (const polygon of polygons) {
      coordinateCount += polygon.exterior.length;
      ringCount += 1 + (polygon.holes?.length ?? 0);
      for (const hole of polygon.holes ?? []) coordinateCount += hole.length;
      if (polygon.style) styleCount++;
    }
    for (const polyline of polylines) {
      coordinateCount += polyline.coordinates.length;
      if (polyline.style) styleCount++;
    }
    for (const point of points) if (point.style) styleCount++;

    const coordinates = new Float64Array(coordinateCount * 2);
    const polygonWords = new Uint32Array(polygons.length * 3);
    const rings = new Uint32Array(ringCount * 2);
    const polylineWords = new Uint32Array(polylines.length * 3);
    const pointWords = new Uint32Array(points.length * 2);
    const ids = new Float64Array(polygons.length + polylines.length + points.length);
    const styles = new Float32Array(styleCount * STYLE_RECORD_FLOATS);
    let coordinate = 0;
    let ring = 0;
    let style = 0;
    let shape = 0;
    const put = (list: readonly GeoCoordinate[]): number => {
      const first = coordinate;
      for (const c of list) {
        coordinates[coordinate * 2] = c.longitude;
        coordinates[coordinate * 2 + 1] = c.latitude;
        coordinate++;
      }
      return first;
    };
    const putRing = (list: readonly GeoCoordinate[]): void => {
      rings[ring * 2] = put(list);
      rings[ring * 2 + 1] = list.length;
      ring++;
    };
    polygons.forEach((polygon, index) => {
      polygonWords[index * 3] = ring;
      polygonWords[index * 3 + 1] = 1 + (polygon.holes?.length ?? 0);
      putRing(polygon.exterior);
      for (const hole of polygon.holes ?? []) putRing(hole);
      if (polygon.style) {
        writePolygonStyleRecord(styles, style * STYLE_RECORD_FLOATS, ImmersiveMapPolygonStyle.make(polygon.style));
        polygonWords[index * 3 + 2] = style++;
      } else polygonWords[index * 3 + 2] = NO_STYLE;
      ids[shape++] = polygon.id ?? Number.NaN;
    });
    polylines.forEach((polyline, index) => {
      polylineWords[index * 3] = put(polyline.coordinates);
      polylineWords[index * 3 + 1] = polyline.coordinates.length;
      if (polyline.style) {
        writePolylineStyleRecord(styles, style * STYLE_RECORD_FLOATS, ImmersiveMapPolylineStyle.make(polyline.style));
        polylineWords[index * 3 + 2] = style++;
      } else polylineWords[index * 3 + 2] = NO_STYLE;
      ids[shape++] = polyline.id ?? Number.NaN;
    });
    points.forEach((point, index) => {
      pointWords[index * 2] = put([point.coordinate]);
      if (point.style) {
        writePointStyleRecord(styles, style * STYLE_RECORD_FLOATS, ImmersiveMapPointStyle.make(point.style));
        pointWords[index * 2 + 1] = style++;
      } else pointWords[index * 2 + 1] = NO_STYLE;
      ids[shape++] = point.id ?? Number.NaN;
    });
    return new LayerSourceContent({ coordinates, polygons: polygonWords, rings, polylines: polylineWords, points: pointWords, ids, styles });
  }

  /** The id of the zone at `index`. */
  polygonID(index: number): number {
    return this.buffers.ids[index]!;
  }

  polylineID(index: number): number {
    return this.buffers.ids[this.polygonCount + index]!;
  }

  pointID(index: number): number {
    return this.buffers.ids[this.polygonCount + this.polylineCount + index]!;
  }

  /** The coordinates from `first`, `count` of them, as the GeoJSON reads them. */
  coordinatesOf(first: number, count: number): GeoCoordinate[] {
    const c = this.buffers.coordinates;
    const out: GeoCoordinate[] = new Array(count);
    for (let i = 0; i < count; i++) out[i] = { latitude: c[(first + i) * 2 + 1]!, longitude: c[(first + i) * 2]! };
    return out;
  }

  /** The point at `index`'s coordinate. */
  pointCoordinate(index: number): GeoCoordinate {
    const at = this.buffers.points[index * 2]!;
    return { latitude: this.buffers.coordinates[at * 2 + 1]!, longitude: this.buffers.coordinates[at * 2]! };
  }
}
