// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { LayerMeshDiskCache } from "../cache/layer-mesh-disk-cache.ts";
import type { LayerJobRunner } from "../worker/layer-worker-client.ts";
import type { LayerDocument } from "../worker/layer-worker-protocol.ts";
import { LayerSourceContent } from "./layer-source-content.ts";
import { type ImmersiveMapLayerSourceError, type LayerSourceData, layerSourceDataEqual, type LayerSourceIdentity, layerSourceIdentity } from "./layer-source-data.ts";

/** A source as a frame sees it (`LayerSourceLibrary.states`). */
export interface LayerSourceState {
  /** Changes when the source is registered with other data. */
  readonly revision: number;
  /** The shapes, `undefined` while they are not read. */
  readonly content: LayerSourceContent | undefined;
  /** Whether the shapes are on their way. */
  readonly isLoading: boolean;
  /** Whether the source cannot be drawn: unreadable, or refused for the limit. */
  readonly isFailed: boolean;
  /** What the source's data is told apart by: what a mesh kept on disk goes by. */
  readonly identity: LayerSourceIdentity;
}

interface Entry {
  data: LayerSourceData;
  revision: number;
  content: LayerSourceContent | undefined;
  isLoading: boolean;
  failure: ImmersiveMapLayerSourceError | undefined;
}

interface Client {
  onChange: () => void;
  /** The sources whose shapes the client needed last, in the order of its layers. */
  needed: string[];
}

/**
 * The sources an app registered with a layers controller, and the ones that
 * are read, the Swift `LayerSourceLibrary`. A source costs nothing until its
 * shapes are needed: to build the mesh of a layer that draws it, when the
 * disk holds none (`LayerMeshDiskCache`), and to test a tap against, when
 * the app listens to taps on its layers (`shapesWanted`). It is then read
 * off the main thread, a GeoJSON document in the layers' worker, and its
 * shapes are let go as soon as nothing needs them. The shapes held are
 * bounded by the input limit: over it, the source drawn last in the layers'
 * order is refused (`limitExceeded`).
 *
 * One library serves every map that draws the controller's layers: each is
 * a client that says what it draws every frame and is told when a source it
 * waits for has been read.
 */
export class LayerSourceLibrary {
  readonly limitBytes: number;
  private wantsShapes = false;
  private readonly entries = new Map<string, Entry>();
  private nextRevision = 1;
  private readonly clients = new Map<object, Client>();
  private failureHandler: ((name: string, error: ImmersiveMapLayerSourceError) => void) | null = null;

  constructor(
    limitBytes: number,
    /** Where the meshes of the layers are kept between sessions. */
    readonly meshCache: LayerMeshDiskCache,
    /** What reads the GeoJSON documents and builds the meshes (the layers' worker). */
    readonly jobs: LayerJobRunner,
  ) {
    this.limitBytes = Math.max(limitBytes, 0);
  }

  /**
   * Whether the shapes of every drawn source are kept at hand, for a tap to
   * be tested against: on while the app listens to taps on its layers or
   * holds a selection. Off, a drawn layer needs its mesh alone.
   */
  get shapesWanted(): boolean {
    return this.wantsShapes;
  }

  set shapesWanted(value: boolean) {
    const changed = this.wantsShapes !== value;
    this.wantsShapes = value;
    if (changed) this.notifyClients();
  }

  // MARK: The app's side

  /** Registers `data` under `name`, in the place of what was there. Nothing changes when it is the data already registered. */
  register(name: string, data: LayerSourceData): void {
    const existing = this.entries.get(name);
    if (existing && layerSourceDataEqual(existing.data, data)) return;
    this.entries.set(name, { data, revision: this.nextRevision++, content: undefined, isLoading: false, failure: undefined });
    this.retryRefused();
    this.notifyClients();
  }

  unregister(name: string): void {
    if (!this.entries.delete(name)) return;
    this.retryRefused();
    this.notifyClients();
  }

  /** The registered names, in alphabetical order. */
  get names(): string[] {
    return [...this.entries.keys()].sort();
  }

  failure(name: string): ImmersiveMapLayerSourceError | undefined {
    return this.entries.get(name)?.failure;
  }

  /** Whether the shapes of `name` are read and held. */
  isLoaded(name: string): boolean {
    return this.entries.get(name)?.content !== undefined;
  }

  /** The memory of the shapes that are read, what the limit bounds. */
  get loadedBytes(): number {
    return this.totalBytes();
  }

  setFailureHandler(handler: ((name: string, error: ImmersiveMapLayerSourceError) => void) | null): void {
    this.failureHandler = handler;
  }

  // MARK: The frames' side

  /** Adds a map that draws from the library. `onChange` is called when a source was registered, removed or read. */
  addClient(client: object, onChange: () => void): void {
    this.clients.set(client, { onChange, needed: [] });
  }

  removeClient(client: object): void {
    this.clients.delete(client);
  }

  /** Whether any map draws from the library. */
  get hasClients(): boolean {
    return this.clients.size > 0;
  }

  /**
   * The states of `sources`, none for a name nothing is registered under.
   * `drawn` are the sources the client's frame draws, in the order of its
   * layers, and `building` those among them a mesh is to be built from. The
   * shapes of a source are needed while it is in `building`, and while it
   * is drawn when `shapesWanted`: a needed source that is not read starts to
   * be, and the shapes no client needs are let go.
   */
  states(sources: ReadonlySet<string>, drawn: readonly string[], building: ReadonlySet<string>, client: object): Map<string, LayerSourceState> {
    const needed = this.wantsShapes ? [...drawn] : drawn.filter((name) => building.has(name));
    const entry = this.clients.get(client);
    if (entry) entry.needed = needed;
    const allNeeded = this.neededByAnyClient();
    // What nobody needs any more is let go, and a source refused for the
    // limit may fit in the room that makes.
    let released = false;
    for (const [name, e] of this.entries) {
      if (e.content !== undefined && !allNeeded.has(name)) {
        e.content = undefined;
        released = true;
      }
    }
    if (released) this.retryRefused();
    const toLoad: { name: string; revision: number; data: LayerSourceData }[] = [];
    for (const name of needed) {
      const e = this.entries.get(name);
      if (!e || e.content !== undefined || e.isLoading || e.failure !== undefined) continue;
      e.isLoading = true;
      toLoad.push({ name, revision: e.revision, data: e.data });
    }
    const result = new Map<string, LayerSourceState>();
    for (const name of sources) {
      const e = this.entries.get(name);
      if (!e) continue;
      result.set(name, { revision: e.revision, content: e.content, isLoading: e.isLoading, isFailed: e.failure !== undefined, identity: layerSourceIdentity(e.data) });
    }
    for (const load of toLoad) void this.load(load.name, load.revision, load.data);
    return result;
  }

  /** Lets go of the shapes of every source no map needs now. They are read again when they are needed. */
  releaseUnneeded(): void {
    const allNeeded = this.neededByAnyClient();
    for (const [name, e] of this.entries) if (!allNeeded.has(name)) e.content = undefined;
  }

  // MARK: Reading

  private async load(name: string, revision: number, data: LayerSourceData): Promise<void> {
    let content: LayerSourceContent | undefined;
    let failure: ImmersiveMapLayerSourceError | undefined;
    if (data.kind === "shapes") {
      content = LayerSourceContent.fromShapes(data.polygons, data.polylines, data.points);
    } else {
      const outcome = await this.jobs.parse(layerDocument(data));
      if (outcome.ok) content = new LayerSourceContent(outcome.buffers);
      else failure = outcome.error;
    }
    this.finishLoad(name, revision, content, failure);
  }

  private finishLoad(name: string, revision: number, content: LayerSourceContent | undefined, failure: ImmersiveMapLayerSourceError | undefined): void {
    const entry = this.entries.get(name);
    // The source was registered anew or removed while this was read: what was read is of no use.
    if (!entry || entry.revision !== revision) return;
    entry.isLoading = false;
    let failures: [string, ImmersiveMapLayerSourceError][] = [];
    if (content !== undefined) {
      entry.content = content;
      failures = this.enforceLimit();
    } else if (failure !== undefined) {
      entry.failure = failure;
      failures = [[name, failure]];
    }
    this.notifyClients();
    const handler = this.failureHandler;
    if (handler) for (const [failedName, error] of failures) handler(failedName, error);
  }

  /**
   * Brings the shapes held under the limit: those of the sources no map
   * needs go first, then the needed sources from the last of the layers'
   * order are refused. Returns the refused.
   */
  private enforceLimit(): [string, ImmersiveMapLayerSourceError][] {
    let total = this.totalBytes();
    if (total <= this.limitBytes) return [];
    const neededOrder = [...this.clients.values()].flatMap((client) => client.needed);
    const allNeeded = new Set(neededOrder);
    for (const name of [...this.entries.keys()].sort()) {
      if (total <= this.limitBytes) break;
      if (allNeeded.has(name)) continue;
      const e = this.entries.get(name)!;
      total -= e.content?.byteSize ?? 0;
      e.content = undefined;
    }
    const refused: [string, ImmersiveMapLayerSourceError][] = [];
    for (const name of neededOrder.reverse()) {
      if (total <= this.limitBytes) break;
      const e = this.entries.get(name);
      const size = e?.content?.byteSize;
      if (e === undefined || size === undefined) continue;
      const failure: ImmersiveMapLayerSourceError = { kind: "limitExceeded", bytes: size, limit: this.limitBytes };
      total -= size;
      e.content = undefined;
      e.failure = failure;
      refused.push([name, failure]);
    }
    return refused;
  }

  /** The sources refused for the limit may fit now that the set of sources changed: the next frame that draws one reads it again. */
  private retryRefused(): void {
    for (const e of this.entries.values()) if (e.failure?.kind === "limitExceeded") e.failure = undefined;
  }

  private totalBytes(): number {
    let total = 0;
    for (const e of this.entries.values()) total += e.content?.byteSize ?? 0;
    return total;
  }

  private neededByAnyClient(): Set<string> {
    const needed = new Set<string>();
    for (const client of this.clients.values()) for (const name of client.needed) needed.add(name);
    return needed;
  }

  private notifyClients(): void {
    for (const client of [...this.clients.values()]) client.onChange();
  }
}

/** The document the worker reads for registered GeoJSON. */
function layerDocument(data: Exclude<LayerSourceData, { kind: "shapes" }>): LayerDocument {
  if (data.kind === "geoJSONURL") return { kind: "url", url: data.url };
  const document = data.document;
  if (typeof document === "string") return { kind: "text", text: document };
  if (document instanceof Uint8Array) return { kind: "bytes", bytes: document };
  return { kind: "object", object: document };
}
