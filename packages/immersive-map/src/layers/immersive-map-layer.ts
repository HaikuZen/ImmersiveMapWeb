// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The public model of the layers of the app's own data, a port of the Swift
 * `ImmersiveMapLayer.swift`: a layer (`ImmersiveMapLayer`), the styles it
 * draws its shapes in and the shapes an app builds in code.
 *
 * ```ts
 * map.layers.register("zones", { geoJSON: new URL("/zones.geojson", location.href) });
 * map.layers.register("stations", { identity: "v1", points: coordinates.map((coordinate) => ({ coordinate })) });
 * map.layers.set([
 *   { source: "zones", polygonStyle: { fillColor: [0.9, 0.3, 0.2, 0.3] } },
 *   { source: "stations", zoomRange: { lowerBound: 12, upperBound: 30 } },
 * ]);
 * ```
 *
 * A layer lies on the ground, over the map's fills and roads and under its
 * names and buildings, on the globe, on the flat map and through the morph
 * between them. Every shape draws in the layer's style for its kind unless
 * it carries its own. Several layers can draw one source, each its own way.
 * A layer is a small value: setting the same layers again redraws nothing.
 */

import type { Rgba } from "../configuration/color.ts";
import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import type { ClosedRange } from "../math/closed-range.ts";

/**
 * How a zone draws: its fill and the line round it. Colours are RGBA in
 * 0...1, the alpha straight. A zero alpha or a zero width leaves the part
 * out. The fill may be translucent. The line round it is always solid: any
 * alpha of `strokeColor` above zero draws it opaque, as a line is.
 */
export interface ImmersiveMapPolygonStyle {
  readonly fillColor: Rgba;
  readonly strokeColor: Rgba;
  /** The outline's width on screen, in points. */
  readonly strokeWidthPoints: number;
}

export interface ImmersiveMapPolygonStyleOptions {
  readonly fillColor?: Rgba | undefined;
  readonly strokeColor?: Rgba | undefined;
  readonly strokeWidthPoints?: number | undefined;
}

export const ImmersiveMapPolygonStyle = Object.freeze({
  /** The style with the values given, the defaults for the rest: a translucent blue fill and a 2 point blue outline. */
  make(options: ImmersiveMapPolygonStyleOptions = {}): ImmersiveMapPolygonStyle {
    return Object.freeze({
      fillColor: color(options.fillColor, [0.18, 0.47, 0.96, 0.25]),
      strokeColor: color(options.strokeColor, [0.18, 0.47, 0.96, 1]),
      strokeWidthPoints: width(options.strokeWidthPoints, 2),
    });
  },
  equals(a: ImmersiveMapPolygonStyle, b: ImmersiveMapPolygonStyle): boolean {
    return rgbaEqual(a.fillColor, b.fillColor) && rgbaEqual(a.strokeColor, b.strokeColor) && a.strokeWidthPoints === b.strokeWidthPoints;
  },
});

/**
 * How a line draws. Its joins and its ends are round. A line is always
 * solid: the alpha of `color` only says whether the line draws, zero leaving
 * it out and any other value drawing it opaque. A line is drawn in parts
 * that overlap, so a translucent one would darken itself at every vertex,
 * and a solid one costs the GPU nothing where its parts overlap. Its edge is
 * not softened: turn on MSAA (`ImmersiveMapSettings.msaa`) for smooth edges.
 */
export interface ImmersiveMapPolylineStyle {
  readonly color: Rgba;
  /** The width on screen, in points. */
  readonly widthPoints: number;
}

export interface ImmersiveMapPolylineStyleOptions {
  readonly color?: Rgba | undefined;
  readonly widthPoints?: number | undefined;
}

export const ImmersiveMapPolylineStyle = Object.freeze({
  /** The style with the values given, the defaults for the rest: a blue line 3 points wide. */
  make(options: ImmersiveMapPolylineStyleOptions = {}): ImmersiveMapPolylineStyle {
    return Object.freeze({ color: color(options.color, [0.18, 0.47, 0.96, 1]), widthPoints: width(options.widthPoints, 3) });
  },
  equals(a: ImmersiveMapPolylineStyle, b: ImmersiveMapPolylineStyle): boolean {
    return rgbaEqual(a.color, b.color) && a.widthPoints === b.widthPoints;
  },
});

/** How a point draws: a disc with a ring round it. */
export interface ImmersiveMapPointStyle {
  readonly color: Rgba;
  /** The disc's radius on screen, in points, the ring outside it. */
  readonly radiusPoints: number;
  readonly strokeColor: Rgba;
  readonly strokeWidthPoints: number;
}

export interface ImmersiveMapPointStyleOptions {
  readonly color?: Rgba | undefined;
  readonly radiusPoints?: number | undefined;
  readonly strokeColor?: Rgba | undefined;
  readonly strokeWidthPoints?: number | undefined;
}

export const ImmersiveMapPointStyle = Object.freeze({
  /** The style with the values given, the defaults for the rest: a blue disc of 4 points with a white ring of 1. */
  make(options: ImmersiveMapPointStyleOptions = {}): ImmersiveMapPointStyle {
    return Object.freeze({
      color: color(options.color, [0.18, 0.47, 0.96, 1]),
      radiusPoints: width(options.radiusPoints, 4),
      strokeColor: color(options.strokeColor, [1, 1, 1, 1]),
      strokeWidthPoints: width(options.strokeWidthPoints, 1),
    });
  },
  equals(a: ImmersiveMapPointStyle, b: ImmersiveMapPointStyle): boolean {
    return rgbaEqual(a.color, b.color) && a.radiusPoints === b.radiusPoints && rgbaEqual(a.strokeColor, b.strokeColor) && a.strokeWidthPoints === b.strokeWidthPoints;
  },
});

/**
 * A zone: an exterior ring and the holes cut out of it. The rings need not
 * be closed (a ring whose last coordinate repeats its first is taken as it
 * is) and may run either way round. A zone across the 180th meridian is
 * drawn whole when its longitudes run on past ±180 instead of jumping back.
 */
export interface ImmersiveMapPolygon {
  /**
   * Names the zone in a selection and in a tap event, within its source.
   * Left out, the zone goes by its place among the source's shapes.
   */
  readonly id?: number | undefined;
  readonly exterior: readonly GeoCoordinate[];
  readonly holes?: readonly (readonly GeoCoordinate[])[] | undefined;
  /** The zone's own style, the layer's when left out. */
  readonly style?: ImmersiveMapPolygonStyleOptions | undefined;
}

/** A line through its coordinates: a path, a track, a border. */
export interface ImmersiveMapPolyline {
  /** Names the line in a selection and in a tap event, within its source. Left out, its place among the source's shapes. */
  readonly id?: number | undefined;
  readonly coordinates: readonly GeoCoordinate[];
  /** The line's own style, the layer's when left out. */
  readonly style?: ImmersiveMapPolylineStyleOptions | undefined;
}

/** A point: a dot of a size on screen, whatever the zoom. */
export interface ImmersiveMapPoint {
  /** Names the point in a selection and in a tap event, within its source. Left out, its place among the source's shapes. */
  readonly id?: number | undefined;
  readonly coordinate: GeoCoordinate;
  /** The point's own style, the layer's when left out. */
  readonly style?: ImmersiveMapPointStyleOptions | undefined;
}

/**
 * A layer of the app's own data drawn over the map: how one registered
 * source is drawn. Make one with `ImmersiveMapLayer.make`, or hand the
 * controller its options, which it makes the layer of.
 */
export interface ImmersiveMapLayer {
  /** The layer's identity among the map's layers. */
  readonly id: string;
  /** The name of the registered source the layer draws. */
  readonly source: string;
  /** How the shapes of each kind draw when they carry no style of their own. */
  readonly polygonStyle: ImmersiveMapPolygonStyle;
  readonly polylineStyle: ImmersiveMapPolylineStyle;
  readonly pointStyle: ImmersiveMapPointStyle;
  /** Whether the layer draws. A hidden layer keeps what the map prepared of it while memory allows, so showing it again is immediate. */
  readonly isVisible: boolean;
  /** The camera zooms the layer draws at. */
  readonly zoomRange: ClosedRange;
  /**
   * Whether the ground relief nearer the camera hides the layer: a mountain
   * in front of a zone covers it. Off by default, the layer shows over the
   * ground everywhere, over the mountains as on the plain, since it lies on
   * the plane and not on the slopes. Either way the buildings, the models
   * and the trees standing in front of it cover it. Applies live.
   */
  readonly hidesBehindTerrain: boolean;
}

/** The fields of a layer, the source alone required. */
export interface ImmersiveMapLayerOptions {
  /** The source's name unless given, which several layers of one source need. */
  readonly id?: string | undefined;
  readonly source: string;
  readonly polygonStyle?: ImmersiveMapPolygonStyleOptions | undefined;
  readonly polylineStyle?: ImmersiveMapPolylineStyleOptions | undefined;
  readonly pointStyle?: ImmersiveMapPointStyleOptions | undefined;
  /** True by default. */
  readonly isVisible?: boolean | undefined;
  /** 0 ... 30 by default. */
  readonly zoomRange?: ClosedRange | undefined;
  /** False by default. */
  readonly hidesBehindTerrain?: boolean | undefined;
}

export const ImmersiveMapLayer = Object.freeze({
  /** The layer the options state, the defaults for the rest. A layer passes through unchanged. */
  make(options: ImmersiveMapLayerOptions | ImmersiveMapLayer): ImmersiveMapLayer {
    const zoomRange = options.zoomRange ?? { lowerBound: 0, upperBound: 30 };
    return Object.freeze({
      id: options.id ?? options.source,
      source: options.source,
      polygonStyle: ImmersiveMapPolygonStyle.make(options.polygonStyle),
      polylineStyle: ImmersiveMapPolylineStyle.make(options.polylineStyle),
      pointStyle: ImmersiveMapPointStyle.make(options.pointStyle),
      isVisible: options.isVisible ?? true,
      zoomRange: Object.freeze({ lowerBound: zoomRange.lowerBound, upperBound: zoomRange.upperBound }),
      hidesBehindTerrain: options.hidesBehindTerrain ?? false,
    });
  },

  /** Whether the two state the same, field by field. */
  equals(a: ImmersiveMapLayer, b: ImmersiveMapLayer): boolean {
    return (
      a.id === b.id &&
      a.source === b.source &&
      a.isVisible === b.isVisible &&
      a.hidesBehindTerrain === b.hidesBehindTerrain &&
      a.zoomRange.lowerBound === b.zoomRange.lowerBound &&
      a.zoomRange.upperBound === b.zoomRange.upperBound &&
      ImmersiveMapPolygonStyle.equals(a.polygonStyle, b.polygonStyle) &&
      ImmersiveMapPolylineStyle.equals(a.polylineStyle, b.polylineStyle) &&
      ImmersiveMapPointStyle.equals(a.pointStyle, b.pointStyle)
    );
  },

  /** Whether the layer draws at the camera's `zoom`. */
  draws(layer: ImmersiveMapLayer, zoom: number): boolean {
    return layer.isVisible && zoom >= layer.zoomRange.lowerBound && zoom <= layer.zoomRange.upperBound;
  },

  /**
   * What the GPU form of the layer depends on: its source's data as of
   * `sourceRevision` and the styles baked into it. A change of visibility,
   * zoom range or how the terrain hides it is not one.
   */
  meshKey(layer: ImmersiveMapLayer, sourceRevision: number): LayerMeshKey {
    return `${layer.source}\u0000${sourceRevision}\u0000${layerStyleValues(layer).join(",")}`;
  },
});

/** What a layer's GPU form is made of (`LayerMeshStore`), as one comparable string. */
export type LayerMeshKey = string;

/** The number of floats `layerStyleValues` writes. */
export const LAYER_STYLE_FLOATS = 24;

/**
 * The layer's styles as the mesh build reads them (crates/layer-mesh), in
 * f32: the polygon's fill, stroke and width, the polyline's colour and
 * width, the point's colour, radius, stroke colour and stroke width.
 */
export function layerStyleValues(layer: ImmersiveMapLayer): Float32Array {
  const values = new Float32Array(LAYER_STYLE_FLOATS);
  const { polygonStyle: polygon, polylineStyle: polyline, pointStyle: point } = layer;
  values.set(polygon.fillColor, 0);
  values.set(polygon.strokeColor, 4);
  values[8] = polygon.strokeWidthPoints;
  values.set(polyline.color, 9);
  values[13] = polyline.widthPoints;
  values.set(point.color, 14);
  values[18] = point.radiusPoints;
  values.set(point.strokeColor, 19);
  values[23] = point.strokeWidthPoints;
  return values;
}

function color(value: Rgba | undefined, fallback: Rgba): Rgba {
  const c = value ?? fallback;
  return Object.freeze([c[0], c[1], c[2], c[3]] as const);
}

function width(value: number | undefined, fallback: number): number {
  return Math.max(value ?? fallback, 0);
}

function rgbaEqual(a: Rgba, b: Rgba): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}
