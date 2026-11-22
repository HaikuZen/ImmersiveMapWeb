// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { LayerMeshDiskCache } from "./cache/layer-mesh-disk-cache.ts";
import { ImmersiveMapLayer, type ImmersiveMapLayerOptions, type ImmersiveMapPoint, type ImmersiveMapPolygon, type ImmersiveMapPolyline } from "./immersive-map-layer.ts";
import type { ImmersiveMapLayerSourceError } from "./sources/layer-source-data.ts";
import { LayerSourceLibrary } from "./sources/layer-source-library.ts";
import { type LayerJobRunner, LayerWorkerClient } from "./worker/layer-worker-client.ts";

/** A GeoJSON document to register: at a URL, or held in memory under the app's identity. */
export type ImmersiveMapGeoJSONSource =
  /**
   * The document at `geoJSON`, fetched when a layer first draws the source,
   * and fetched again later when it is needed again. `identity` names its
   * contents when the app knows them (a version, an ETag): without one the
   * disk cache asks the server for the document's ETag or date.
   */
  | { readonly geoJSON: URL; readonly identity?: string | undefined }
  /**
   * A document in memory: its text, its UTF-8 bytes or the parsed object.
   * `identity` names this data and is the app's to choose: the map never
   * looks into the data to tell whether it changed.
   */
  | { readonly geoJSON: string | Uint8Array | ArrayBuffer | object; readonly identity: string };

/** Shapes built in code, under the app's identity: the same identity is the same shapes, and other shapes need another one. */
export interface ImmersiveMapShapesSource {
  readonly identity: string;
  readonly polygons?: readonly ImmersiveMapPolygon[] | undefined;
  readonly polylines?: readonly ImmersiveMapPolyline[] | undefined;
  readonly points?: readonly ImmersiveMapPoint[] | undefined;
}

export interface ImmersiveMapLayersControllerOptions {
  /** The layers to start with. */
  readonly layers?: readonly (ImmersiveMapLayer | ImmersiveMapLayerOptions)[] | undefined;
  /**
   * The most memory the shapes that are read may take at one time, in bytes:
   * 16 for a coordinate and a few words for a shape. Over it, the source
   * drawn last in the layers' order is refused (`limitExceeded`). 64 MB by
   * default, about four million coordinates.
   */
  readonly inputLimitBytes?: number | undefined;
  /**
   * The most disk the prepared layers may take, in bytes (IndexedDB). A
   * layer is prepared for the GPU once and kept, so the next session draws it
   * without reading its source again. The layers used least recently are
   * deleted over the limit, and zero keeps nothing. 256 MB by default.
   */
  readonly cacheLimitBytes?: number | undefined;
  /** @internal What reads the documents and builds the meshes: the layers' worker by default. */
  readonly jobs?: LayerJobRunner | undefined;
  /** @internal The disk cache, for a test that keeps its own database. */
  readonly meshCache?: LayerMeshDiskCache | undefined;
}

/**
 * Holds the app's own data a map draws, and is the app's handle to change
 * it, the Swift `ImmersiveMapLayersController`. The data is registered once,
 * under a name, and the layers say which of it to draw and how
 * (`ImmersiveMapLayer`):
 *
 * ```ts
 * const map = await ImmersiveMap.create({ container });
 * map.layers.register("districts", { geoJSON: new URL("/districts.geojson", location.href) });
 * map.layers.register("parks", { geoJSON: parksText, identity: "2026-11" });
 * map.layers.set([{ source: "districts" }]);
 * ```
 *
 * A registered source costs nothing until a layer draws it: it is then read
 * off the main thread, in the layers' worker, so an app can register every
 * document it has and draw the few the user picks. A layer is prepared for
 * the GPU once and kept on disk (`cacheLimitBytes`), so the next session
 * draws it without reading its source. The shapes that are read are let go
 * once the layer is prepared, unless the app listens to taps on its layers,
 * and are bounded by `inputLimitBytes`. A source that cannot be read, or
 * does not fit, is reported to `onSourceFailed`.
 *
 * The layers draw in the order the controller holds them, a later one over
 * an earlier one. An id names one layer: a layer set under an id the
 * controller already holds takes that layer's place. A changed layer is
 * prepared off the main thread, and the map goes on drawing the one it
 * replaces until then. Everything runs on the main thread.
 */
export class ImmersiveMapLayersController {
  /** The input limit of a controller that is given none: 64 MB. */
  static readonly defaultInputLimitBytes = 64 * 1024 * 1024;
  /** The disk cache limit of a controller that is given none: 256 MB. */
  static readonly defaultCacheLimitBytes = 256 * 1024 * 1024;

  /** @internal The registered sources and the ones that are read, shared with every map that draws this controller's layers. */
  readonly library: LayerSourceLibrary;

  private orderedLayers: readonly ImmersiveMapLayer[];
  private changeHandler: (() => void) | null = null;
  private changeHandlerOwner: object | null = null;
  private sourceFailed: ((name: string, error: ImmersiveMapLayerSourceError) => void) | null = null;

  constructor(options: ImmersiveMapLayersControllerOptions = {}) {
    const meshCache = options.meshCache ?? new LayerMeshDiskCache(options.cacheLimitBytes ?? ImmersiveMapLayersController.defaultCacheLimitBytes);
    this.library = new LayerSourceLibrary(options.inputLimitBytes ?? ImmersiveMapLayersController.defaultInputLimitBytes, meshCache, options.jobs ?? new LayerWorkerClient());
    this.orderedLayers = uniqued((options.layers ?? []).map((layer) => ImmersiveMapLayer.make(layer)));
  }

  /** The most memory the shapes that are read may take at one time, in bytes. */
  get inputLimitBytes(): number {
    return this.library.limitBytes;
  }

  /** The most disk the prepared layers may take, in bytes. */
  get cacheLimitBytes(): number {
    return this.library.meshCache.limitBytes;
  }

  /** Called when a source a layer draws cannot be read, or does not fit the input limit, with the source's name. */
  get onSourceFailed(): ((name: string, error: ImmersiveMapLayerSourceError) => void) | null {
    return this.sourceFailed;
  }

  set onSourceFailed(handler: ((name: string, error: ImmersiveMapLayerSourceError) => void) | null) {
    this.sourceFailed = handler;
    this.library.setFailureHandler(handler);
  }

  // MARK: Sources

  /**
   * Registers a source under `name`: a GeoJSON document (RFC 7946: a
   * FeatureCollection, a Feature, a GeometryCollection or a bare geometry)
   * at a URL or in memory, or shapes built in code. Polygons and
   * MultiPolygons are zones, LineStrings and MultiLineStrings lines, Points
   * and MultiPoints points. A feature's simplestyle properties (`fill`,
   * `fill-opacity`, `stroke`, `stroke-opacity`, `stroke-width`,
   * `marker-color`, `marker-size`, `marker-radius`) are laid over the style
   * of the layer that draws it. Registering the same data again (the same
   * URL and identity, or the same identity) does nothing.
   */
  register(name: string, source: ImmersiveMapGeoJSONSource | ImmersiveMapShapesSource): void {
    if ("geoJSON" in source) {
      const document = source.geoJSON;
      if (document instanceof URL) {
        this.library.register(name, { kind: "geoJSONURL", url: document.href, identity: source.identity });
        return;
      }
      if (typeof source.identity !== "string") throw new TypeError(`ImmersiveMap: the GeoJSON of source "${name}" is held in memory and needs an identity`);
      const held = document instanceof ArrayBuffer ? new Uint8Array(document) : document;
      this.library.register(name, { kind: "geoJSON", document: held, identity: source.identity });
      return;
    }
    if (typeof source.identity !== "string") throw new TypeError(`ImmersiveMap: the shapes of source "${name}" need an identity`);
    this.library.register(name, { kind: "shapes", polygons: source.polygons ?? [], polylines: source.polylines ?? [], points: source.points ?? [], identity: source.identity });
  }

  /** Removes a source. A layer that names it draws nothing until a source is registered under the name again. */
  unregister(name: string): void {
    this.library.unregister(name);
  }

  /** The names of the registered sources, in alphabetical order. */
  get sourceNames(): string[] {
    return this.library.names;
  }

  /** Why the source cannot be drawn, `undefined` when it can or was not tried. */
  failure(name: string): ImmersiveMapLayerSourceError | undefined {
    return this.library.failure(name);
  }

  // MARK: Layers

  /** The layers as they are now, in the order they draw. */
  get layers(): readonly ImmersiveMapLayer[] {
    return this.orderedLayers;
  }

  /** The layer with `id`, `undefined` when the controller holds none. */
  layer(id: string): ImmersiveMapLayer | undefined {
    return this.orderedLayers.find((layer) => layer.id === id);
  }

  /** Replaces every layer. A layer left out is let go, with what the map had prepared of it. */
  set(layers: readonly (ImmersiveMapLayer | ImmersiveMapLayerOptions)[]): void {
    this.mutate(() => uniqued(layers.map((layer) => ImmersiveMapLayer.make(layer))));
  }

  /** Puts each layer in the place of the one with its id, or after the last layer when the controller holds none with that id. */
  upsert(layers: ImmersiveMapLayer | ImmersiveMapLayerOptions | readonly (ImmersiveMapLayer | ImmersiveMapLayerOptions)[]): void {
    const list = (Array.isArray(layers) ? layers : [layers]) as readonly (ImmersiveMapLayer | ImmersiveMapLayerOptions)[];
    this.mutate((current) => {
      const ordered = [...current];
      for (const options of list) {
        const layer = ImmersiveMapLayer.make(options);
        const index = ordered.findIndex((l) => l.id === layer.id);
        if (index >= 0) ordered[index] = layer;
        else ordered.push(layer);
      }
      return ordered;
    });
  }

  /** Takes away the layer with the id, or the layers with the ids. */
  remove(ids: string | readonly string[]): void {
    const set = new Set(typeof ids === "string" ? [ids] : ids);
    this.mutate((current) => current.filter((layer) => !set.has(layer.id)));
  }

  clear(): void {
    this.mutate(() => []);
  }

  /** Shows or hides a layer. A hidden layer keeps what the map prepared of it while memory allows, so showing it again is immediate. */
  setVisible(id: string, isVisible: boolean): void {
    this.mutate((current) => current.map((layer) => (layer.id === id && layer.isVisible !== isVisible ? Object.freeze({ ...layer, isVisible }) : layer)));
  }

  // MARK: The map's side

  /** @internal */
  setChangeHandler(handler: (() => void) | null, owner: object): void {
    this.changeHandler = handler;
    this.changeHandlerOwner = owner;
  }

  /**
   * @internal Clears the handler only if `owner` still owns it: tearing down
   * an old map must not detach the controller from a new map that has
   * already bound it.
   */
  clearChangeHandler(owner: object): void {
    if (this.changeHandlerOwner !== owner) return;
    this.changeHandler = null;
    this.changeHandlerOwner = null;
  }

  /** Applies `change`, and tells the map when it left the layers other than they were: setting the same layers again asks for no frame. */
  private mutate(change: (current: readonly ImmersiveMapLayer[]) => readonly ImmersiveMapLayer[]): void {
    const before = this.orderedLayers;
    const after = Object.freeze([...change(before)]);
    this.orderedLayers = after;
    const same = before.length === after.length && before.every((layer, index) => ImmersiveMapLayer.equals(layer, after[index]!));
    if (!same) this.changeHandler?.();
  }
}

/** The layers with one layer to an id: the last one given under an id, in the place of the first. */
function uniqued(layers: readonly ImmersiveMapLayer[]): readonly ImmersiveMapLayer[] {
  const indexById = new Map<string, number>();
  const result: ImmersiveMapLayer[] = [];
  for (const layer of layers) {
    const index = indexById.get(layer.id);
    if (index !== undefined) result[index] = layer;
    else {
      indexById.set(layer.id, result.length);
      result.push(layer);
    }
  }
  return Object.freeze(result);
}
