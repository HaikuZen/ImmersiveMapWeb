// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The `scene-models` folder: the engine-side model and CPU presentation of
 * 3D models anchored at coordinates, a port of the Swift `SceneModels/`
 * folder. From the public descriptor to the per-frame presentation state
 * (position, orientation, scale, altitude, the flight along an
 * `ImmersiveMapGeoPath` through the shared sampler in `geo`), the hit
 * volumes the selection resolves a tap against, the asset parsing (glTF 2.0,
 * GLB and OBJ in place of Model I/O), and the GPU side beside them. No map
 * tile, style or label logic and no DOM.
 */

import type { GeoCoordinate } from "../geo/geo-coordinate.ts";

/** The asset formats the engine reads. */
export type SceneModelAssetFormat = "gltf" | "glb" | "obj";

/**
 * Where a model's asset lives.
 *
 * Web deviation from Swift: there a source is a local file URL and the
 * engine does no networking. Here a source is a URL the engine fetches:
 * same origin, or a server that allows the page by CORS. A relative URL is
 * resolved against the page (`document.baseURI`). A `.gltf` file's external
 * buffers and images, and an OBJ's `mtllib` and textures, are fetched
 * relative to the asset's own URL.
 *
 * `format` is read from the URL's extension (`.gltf`, `.glb`, `.obj`) or a
 * `data:` URL's media type when left out. Set it for `blob:` URLs and for
 * URLs without an extension. Models sharing a source (the same absolute URL
 * and format) share one loaded mesh.
 */
export interface ImmersiveMapSceneModelSource {
  readonly url: string;
  readonly format?: SceneModelAssetFormat;
}

export const ImmersiveMapSceneModelSource = Object.freeze({
  make(url: string | URL, format?: SceneModelAssetFormat): ImmersiveMapSceneModelSource {
    const href = typeof url === "string" ? url : url.href;
    return Object.freeze(format === undefined ? { url: href } : { url: href, format });
  },
});

/**
 * A 3D model (glTF 2.0, GLB or OBJ) anchored at a geographic coordinate, a
 * port of the Swift `ImmersiveMapSceneModel`. Rendered inside the map world
 * pass in flat, globe, and the morph between them. Sized in real-world
 * meters with the Web Mercator convention: together with the surrounding map
 * geometry the model inflates by 1/cos(latitude) toward the poles.
 *
 * One asset unit is one meter, and the asset's +Y is up (glTF's own
 * convention, and USD's in Swift).
 */
export interface ImmersiveMapSceneModel {
  /** A whole number up to 2^53, unique among the map's models. */
  readonly id: number;
  readonly source: ImmersiveMapSceneModelSource;
  readonly coordinate: GeoCoordinate;
  /** Offset above the map surface along the local up vector, in meters. */
  readonly altitudeMeters: number;
  /** Rotation about the local up axis, clockwise from north, in degrees. */
  readonly headingDegrees: number;
  /** Rotation about the local east axis, in degrees. */
  readonly pitchDegrees: number;
  /** Rotation about the model's forward axis, in degrees. */
  readonly rollDegrees: number;
  /** Multiplier over real-world meters. */
  readonly scale: number;
  /**
   * When set, the asset is uniformly rescaled so the largest extent of its
   * bounding box spans this many meters (applied before `scale`).
   */
  readonly fitDiameterMeters: number | null;
  /**
   * Whether the model cuts into the ground where it stands. A model sunk
   * below the surface (a negative `altitudeMeters`) would otherwise show its
   * underground part through the ground from every side. With this on, the
   * part below the surface is shown only where it is seen through the
   * model's own outline on the ground, as if the ground were dug out under
   * the model and left whole around it: an open pit, a sunken court, a
   * half-buried hall. Off, the model is drawn as it is.
   */
  readonly cutsIntoGround: boolean;
}

/** What a model is made from: the id, the source and the coordinate, the rest at its default. */
export interface ImmersiveMapSceneModelOptions {
  readonly id: number;
  readonly source: ImmersiveMapSceneModelSource | string;
  readonly coordinate: GeoCoordinate;
  readonly altitudeMeters?: number;
  readonly headingDegrees?: number;
  readonly pitchDegrees?: number;
  readonly rollDegrees?: number;
  readonly scale?: number;
  readonly fitDiameterMeters?: number | null;
  readonly cutsIntoGround?: boolean;
}

function make(options: ImmersiveMapSceneModelOptions): ImmersiveMapSceneModel {
  if (!Number.isSafeInteger(options.id)) throw new RangeError(`An ImmersiveMapSceneModel's id must be a safe integer, got ${String(options.id)}.`);
  const source = typeof options.source === "string" ? ImmersiveMapSceneModelSource.make(options.source) : options.source;
  return Object.freeze({
    id: options.id,
    source,
    coordinate: Object.freeze({ latitude: options.coordinate.latitude, longitude: options.coordinate.longitude }),
    altitudeMeters: options.altitudeMeters ?? 0,
    headingDegrees: options.headingDegrees ?? 0,
    pitchDegrees: options.pitchDegrees ?? 0,
    rollDegrees: options.rollDegrees ?? 0,
    scale: options.scale ?? 1,
    fitDiameterMeters: options.fitDiameterMeters ?? null,
    cutsIntoGround: options.cutsIntoGround ?? false,
  });
}

/** A copy of the model with the values given, the rest as they are. */
function withValues(model: ImmersiveMapSceneModel, values: Partial<Omit<ImmersiveMapSceneModel, "id">>): ImmersiveMapSceneModel {
  return Object.freeze({ ...model, ...values });
}

export const ImmersiveMapSceneModel = Object.freeze({ make, with: withValues });

/** A source resolved against the page: the absolute URL, the format (null when it cannot be told) and the mesh-sharing key. */
export interface ResolvedSceneModelSource {
  readonly url: string;
  readonly format: SceneModelAssetFormat | null;
  readonly key: string;
}

const formatsByExtension: Readonly<Record<string, SceneModelAssetFormat>> = Object.freeze({ gltf: "gltf", glb: "glb", obj: "obj" });

const formatsByMediaType: Readonly<Record<string, SceneModelAssetFormat>> = Object.freeze({
  "model/gltf+json": "gltf",
  "model/gltf-binary": "glb",
  "model/obj": "obj",
});

/** The format of a URL by its extension or, for a `data:` URL, its media type. Null when neither names one. */
export function sceneModelFormatOfURL(url: URL): SceneModelAssetFormat | null {
  if (url.protocol === "data:") {
    const mediaType = url.pathname.split(/[;,]/, 1)[0]!.trim().toLowerCase();
    return formatsByMediaType[mediaType] ?? null;
  }
  const path = url.pathname;
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot < path.lastIndexOf("/")) return null;
  return formatsByExtension[path.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * Resolves a source against `baseURL` (the page's `document.baseURI` on the
 * web). The format is the source's own, or the URL's. Throws a `TypeError`
 * for a URL that does not parse.
 */
export function resolveSceneModelSource(source: ImmersiveMapSceneModelSource, baseURL: string | URL): ResolvedSceneModelSource {
  const url = new URL(source.url, baseURL);
  const format = source.format ?? sceneModelFormatOfURL(url);
  return { url: url.href, format, key: `${format ?? "unknown"} ${url.href}` };
}

/**
 * The key models share a loaded mesh by: the absolute URL and the format. A
 * relative URL and its absolute form name the same mesh.
 */
export function sceneModelSourceKey(source: ImmersiveMapSceneModelSource, baseURL: string | URL): string {
  return resolveSceneModelSource(source, baseURL).key;
}
