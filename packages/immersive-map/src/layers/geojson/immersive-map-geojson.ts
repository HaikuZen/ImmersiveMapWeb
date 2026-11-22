// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * GeoJSON (RFC 7946) as the layers read it, the TypeScript half of the Swift
 * `ImmersiveMapGeoJSON`. The document itself is read in Rust, in the layers'
 * worker (crates/layer-mesh, decision B11: `serde_json` in Wasm), into the
 * flat arrays of a source (`LayerSourceContent`). What stays here is what the
 * main thread needs of it: the errors, and the style records a shape
 * carries, laid over the style of the layer that draws it for a tap to be
 * tested against what is drawn (the mesh build lays them over the same way).
 *
 * A feature's simplestyle properties (`fill`, `fill-opacity`, `stroke`,
 * `stroke-opacity`, `stroke-width`, `marker-color`, `marker-size`,
 * `marker-radius`) are kept with the shapes of its geometry: a property the
 * feature does not state takes the layer's value. A line is always solid,
 * so of `stroke-opacity` only zero matters, which leaves the line out.
 */

import type { Rgba } from "../../configuration/color.ts";
import type { ImmersiveMapPointStyle, ImmersiveMapPolygonStyle, ImmersiveMapPolylineStyle } from "../immersive-map-layer.ts";

/** Why a GeoJSON document could not be read into a layer. */
export type ImmersiveMapGeoJSONError =
  /** The bytes are not JSON. */
  | { readonly kind: "invalidJSON" }
  /** An object has no `type`, or one GeoJSON does not define. */
  | { readonly kind: "unknownType"; readonly type: string }
  /** A geometry's `coordinates` are not shaped as its type requires, at the path given (the members from the document's root). */
  | { readonly kind: "invalidCoordinates"; readonly path: string };

/** The floats of one style record in a source's `styles`. */
export const STYLE_RECORD_FLOATS = 16;
/** A shape's style word when it carries none. */
export const NO_STYLE = 0xffff_ffff;

/** What a style record is, its first float. */
export const StyleRecordKind = {
  /** What a GeoJSON feature states, laid over the layer's style. */
  simple: 1,
  /** A zone's own style, in place of the layer's. */
  polygon: 2,
  polyline: 3,
  point: 4,
} as const;

/** The bits of a simplestyle record's mask (its second float): which properties the feature states. */
export const SimpleStyleBit = {
  fill: 1,
  fillOpacity: 2,
  stroke: 4,
  strokeOpacity: 8,
  strokeWidth: 16,
  markerColor: 32,
  markerRadius: 64,
} as const;

/** Writes a zone's own style as a record at float `index`. */
export function writePolygonStyleRecord(target: Float32Array, index: number, style: ImmersiveMapPolygonStyle): void {
  target[index] = StyleRecordKind.polygon;
  target.set(style.fillColor, index + 1);
  target.set(style.strokeColor, index + 5);
  target[index + 9] = style.strokeWidthPoints;
}

export function writePolylineStyleRecord(target: Float32Array, index: number, style: ImmersiveMapPolylineStyle): void {
  target[index] = StyleRecordKind.polyline;
  target.set(style.color, index + 1);
  target[index + 5] = style.widthPoints;
}

export function writePointStyleRecord(target: Float32Array, index: number, style: ImmersiveMapPointStyle): void {
  target[index] = StyleRecordKind.point;
  target.set(style.color, index + 1);
  target[index + 5] = style.radiusPoints;
  target.set(style.strokeColor, index + 6);
  target[index + 10] = style.strokeWidthPoints;
}

/**
 * The style a zone draws in: its own, or what its GeoJSON feature states
 * laid over the layer's, or the layer's (the Swift `ImmersiveMapLayer.style(of:)`).
 */
export function resolvePolygonStyle(styles: Float32Array, record: number, base: ImmersiveMapPolygonStyle): ImmersiveMapPolygonStyle {
  if (record === NO_STYLE) return base;
  const i = record * STYLE_RECORD_FLOATS;
  const kind = styles[i];
  if (kind === StyleRecordKind.polygon) {
    return { fillColor: rgba(styles, i + 1), strokeColor: rgba(styles, i + 5), strokeWidthPoints: Math.max(styles[i + 9]!, 0) };
  }
  if (kind !== StyleRecordKind.simple) return base;
  const mask = styles[i + 1]!;
  if ((mask & (SimpleStyleBit.fill | SimpleStyleBit.fillOpacity | SimpleStyleBit.stroke | SimpleStyleBit.strokeOpacity | SimpleStyleBit.strokeWidth)) === 0) return base;
  return {
    fillColor: overlay(styles, i + 2, mask & SimpleStyleBit.fill, i + 5, mask & SimpleStyleBit.fillOpacity, base.fillColor),
    strokeColor: overlay(styles, i + 6, mask & SimpleStyleBit.stroke, i + 9, mask & SimpleStyleBit.strokeOpacity, base.strokeColor),
    strokeWidthPoints: mask & SimpleStyleBit.strokeWidth ? styles[i + 10]! : base.strokeWidthPoints,
  };
}

export function resolvePolylineStyle(styles: Float32Array, record: number, base: ImmersiveMapPolylineStyle): ImmersiveMapPolylineStyle {
  if (record === NO_STYLE) return base;
  const i = record * STYLE_RECORD_FLOATS;
  const kind = styles[i];
  if (kind === StyleRecordKind.polyline) return { color: rgba(styles, i + 1), widthPoints: Math.max(styles[i + 5]!, 0) };
  if (kind !== StyleRecordKind.simple) return base;
  const mask = styles[i + 1]!;
  if ((mask & (SimpleStyleBit.stroke | SimpleStyleBit.strokeOpacity | SimpleStyleBit.strokeWidth)) === 0) return base;
  return {
    color: overlay(styles, i + 6, mask & SimpleStyleBit.stroke, i + 9, mask & SimpleStyleBit.strokeOpacity, base.color),
    widthPoints: mask & SimpleStyleBit.strokeWidth ? styles[i + 10]! : base.widthPoints,
  };
}

export function resolvePointStyle(styles: Float32Array, record: number, base: ImmersiveMapPointStyle): ImmersiveMapPointStyle {
  if (record === NO_STYLE) return base;
  const i = record * STYLE_RECORD_FLOATS;
  const kind = styles[i];
  if (kind === StyleRecordKind.point) {
    return { color: rgba(styles, i + 1), radiusPoints: Math.max(styles[i + 5]!, 0), strokeColor: rgba(styles, i + 6), strokeWidthPoints: Math.max(styles[i + 10]!, 0) };
  }
  if (kind !== StyleRecordKind.simple) return base;
  const mask = styles[i + 1]!;
  if ((mask & (SimpleStyleBit.markerColor | SimpleStyleBit.markerRadius)) === 0) return base;
  return {
    color: overlay(styles, i + 11, mask & SimpleStyleBit.markerColor, -1, 0, base.color),
    radiusPoints: mask & SimpleStyleBit.markerRadius ? styles[i + 14]! : base.radiusPoints,
    strokeColor: base.strokeColor,
    strokeWidthPoints: base.strokeWidthPoints,
  };
}

/** A readable message of a GeoJSON error. */
export function geoJSONErrorMessage(error: ImmersiveMapGeoJSONError): string {
  switch (error.kind) {
    case "invalidJSON":
      return "the document is not JSON";
    case "unknownType":
      return `unknown GeoJSON type ${error.type}`;
    case "invalidCoordinates":
      return `invalid coordinates at ${error.path}`;
  }
}

function rgba(values: Float32Array, index: number): Rgba {
  return [values[index]!, values[index + 1]!, values[index + 2]!, values[index + 3]!];
}

/** The feature's colour where it states one, its opacity where it states one, the layer's for the rest. */
function overlay(values: Float32Array, rgbIndex: number, hasRgb: number, opacityIndex: number, hasOpacity: number, base: Rgba): Rgba {
  return [
    hasRgb ? values[rgbIndex]! : base[0],
    hasRgb ? values[rgbIndex + 1]! : base[1],
    hasRgb ? values[rgbIndex + 2]! : base[2],
    hasOpacity ? values[opacityIndex]! : base[3],
  ];
}
