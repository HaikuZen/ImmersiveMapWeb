// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapGeoJSONError } from "../geojson/immersive-map-geojson.ts";
import type { ImmersiveMapPoint, ImmersiveMapPolygon, ImmersiveMapPolyline } from "../immersive-map-layer.ts";

/**
 * What an app registered under a source's name
 * (`ImmersiveMapLayersController.register`), the Swift `LayerSourceData`.
 * Each kind states what it is without being read: a document at a URL by
 * its URL, data handed over in memory by the identity the app gives it.
 * Nothing here is hashed. Two registrations are the same data when they
 * state the same, so an app that registers its sources on every update
 * reads nothing twice, and a layer prepared in an earlier session is found
 * again on disk (`LayerMeshDiskCache`).
 */
export type LayerSourceData =
  /** A GeoJSON document at a URL, fetched when its shapes are needed. `identity` names its contents when the app knows them. */
  | { readonly kind: "geoJSONURL"; readonly url: string; readonly identity: string | undefined }
  /** A GeoJSON document in memory: its text, its UTF-8 bytes or the parsed object. */
  | { readonly kind: "geoJSON"; readonly document: string | Uint8Array | object; readonly identity: string }
  /** Shapes built in code. */
  | {
      readonly kind: "shapes";
      readonly polygons: readonly ImmersiveMapPolygon[];
      readonly polylines: readonly ImmersiveMapPolyline[];
      readonly points: readonly ImmersiveMapPoint[];
      readonly identity: string;
    };

/**
 * What a source's data is told apart by, the Swift `LayerSourceIdentity`.
 * A file there is its path, size and date. A URL here is the URL, with the
 * identity the app gave it when it gave one, and otherwise with what the
 * server says of the response (its ETag, or its date and length) when the
 * disk cache looks it up. Data in memory is the identity the app gave it.
 */
export type LayerSourceIdentity = { readonly kind: "url"; readonly url: string; readonly identity: string | undefined } | { readonly kind: "named"; readonly name: string };

export function layerSourceIdentity(data: LayerSourceData): LayerSourceIdentity {
  return data.kind === "geoJSONURL" ? { kind: "url", url: data.url, identity: data.identity } : { kind: "named", name: data.identity };
}

export function layerSourceIdentitiesEqual(a: LayerSourceIdentity, b: LayerSourceIdentity): boolean {
  if (a.kind === "url") return b.kind === "url" && a.url === b.url && a.identity === b.identity;
  return b.kind === "named" && a.name === b.name;
}

/** Two registrations are the same data when they are of one kind and state one identity. The data itself is never looked into. */
export function layerSourceDataEqual(a: LayerSourceData, b: LayerSourceData): boolean {
  return a.kind === b.kind && layerSourceIdentitiesEqual(layerSourceIdentity(a), layerSourceIdentity(b));
}

/** Why a registered source cannot be drawn (`ImmersiveMapLayersController.onSourceFailed`), the Swift `ImmersiveMapLayerSourceError`. */
export type ImmersiveMapLayerSourceError =
  /** The document could not be fetched, for the reason given. */
  | { readonly kind: "unreadableFile"; readonly reason: string }
  /** The document is not GeoJSON. */
  | { readonly kind: "invalidGeoJSON"; readonly error: ImmersiveMapGeoJSONError }
  /**
   * The source's shapes take `bytes`, and with the other sources being drawn
   * that is over the controller's input limit of `limit` bytes. The source
   * is read again when one of the others stops being drawn.
   */
  | { readonly kind: "limitExceeded"; readonly bytes: number; readonly limit: number };
