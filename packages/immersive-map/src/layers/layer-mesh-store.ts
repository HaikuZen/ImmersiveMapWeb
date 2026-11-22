// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type LayerMeshChunk, LayerMeshFile } from "./cache/layer-mesh-file.ts";
import { ImmersiveMapLayer, type LayerMeshKey, layerStyleValues } from "./immersive-map-layer.ts";
import type { LayerSourceContent } from "./sources/layer-source-content.ts";
import type { LayerSourceIdentity } from "./sources/layer-source-data.ts";
import type { LayerSourceLibrary } from "./sources/layer-source-library.ts";

/**
 * A layer on the GPU: its buffers and the chunks that draw from them, the
 * Swift `LayerMesh`. Immutable after creation.
 */
export interface LayerMesh {
  readonly key: LayerMeshKey;
  readonly chunks: readonly LayerMeshChunk[];
  /** The zones' vertices (vertex buffer) and indices (index buffer, u32). */
  readonly fillVertices: GPUBuffer | undefined;
  readonly fillIndices: GPUBuffer | undefined;
  /** The lines' segments, an instance each. */
  readonly lineSegments: GPUBuffer | undefined;
  /** The lines of a single vertex, then the points, an instance each. */
  readonly discs: GPUBuffer | undefined;
  /** What the buffers take on the GPU. */
  readonly gpuBytes: number;
  destroy(): void;
}

/** Turns a mesh file into a mesh, `undefined` for a file that is not a mesh of this version. */
export type LayerMeshFactory = (key: LayerMeshKey, file: ArrayBuffer) => LayerMesh | undefined;

/**
 * The GPU form of a mesh file (decision B3: the buffers are made mapped at
 * creation and filled from the file's blocks), `undefined` for a file that
 * is not a mesh of this version.
 */
export function gpuLayerMesh(device: GPUDevice, key: LayerMeshKey, file: ArrayBuffer): LayerMesh | undefined {
  const contents = LayerMeshFile.decode(file);
  if (contents === undefined) return undefined;
  const buffer = (block: { offset: number; size: number }, usage: GPUBufferUsageFlags, label: string): GPUBuffer | undefined => {
    if (block.size === 0) return undefined;
    // A mapped buffer's size is a multiple of 4: every struct of a block is.
    const size = Math.ceil(block.size / 4) * 4;
    const gpu = device.createBuffer({ label, size, usage, mappedAtCreation: true });
    new Uint8Array(gpu.getMappedRange()).set(new Uint8Array(file, block.offset, block.size));
    gpu.unmap();
    return gpu;
  };
  const fillVertices = buffer(contents.fillVertices, GPUBufferUsage.VERTEX, "layer fill vertices");
  const fillIndices = buffer(contents.fillIndices, GPUBufferUsage.INDEX, "layer fill indices");
  const lineSegments = buffer(contents.lineSegments, GPUBufferUsage.VERTEX, "layer line segments");
  const discs = buffer(contents.discs, GPUBufferUsage.VERTEX, "layer discs");
  const buffers = [fillVertices, fillIndices, lineSegments, discs];
  return {
    key,
    chunks: contents.chunks,
    fillVertices,
    fillIndices,
    lineSegments,
    discs,
    gpuBytes: buffers.reduce((sum, b) => sum + (b?.size ?? 0), 0),
    destroy: () => {
      for (const b of buffers) b?.destroy();
    },
  };
}

/** What a frame gets of the store: the meshes and the shapes of `layers`, index-aligned with them, and how many are still on their way. */
export interface LayerMeshFrame {
  readonly meshes: readonly (LayerMesh | undefined)[];
  readonly contents: readonly (LayerSourceContent | undefined)[];
  readonly pendingCount: number;
}

/**
 * Holds the layers of the app's data on the GPU for the frames, the Swift
 * `LayerMeshStore`. A layer is prepared when a frame first draws it, off the
 * main thread: from its mesh on disk when it was prepared before
 * (`LayerMeshDiskCache`), and otherwise from its source's shapes
 * (`LayerSourceLibrary`), which are read for it and whose mesh the layers'
 * worker builds and is then kept on disk for the next time. A frame is asked
 * for through `onChange` at each step. A layer whose source or styles
 * changed (`ImmersiveMapLayer.meshKey`) is prepared again, and the frames go
 * on drawing its last mesh until the new one is ready. A layer no longer set
 * is let go, and so is one that is not drawn when memory runs short
 * (`releaseUndrawn`).
 */
export class LayerMeshStore {
  private meshesByID = new Map<string, LayerMesh>();
  /** The key each layer is being prepared for, from the disk or from its shapes. */
  private preparing = new Map<string, LayerMeshKey>();
  /** The keys the disk holds no mesh for: these are built from shapes. */
  private readonly missedOnDisk = new Set<LayerMeshKey>();
  /** The ids of the layers the last frame drew. */
  private drawnIDs = new Set<string>();
  /** The library this store is a client of, the last frame's. */
  private library: LayerSourceLibrary | undefined;
  /**
   * The sources the last frame was building from: the next frame names them
   * again first, so their shapes are not let go between its two looks at the
   * library.
   */
  private lastBuildingSources = new Set<string>();
  private destroyed = false;

  constructor(
    private readonly factory: LayerMeshFactory,
    /** A frame is wanted: a source was read, a mesh landed. */
    private readonly onChange: () => void,
  ) {}

  /** The meshes of every layer on the GPU, for the frame's counters. */
  get meshCount(): number {
    return this.meshesByID.size;
  }

  /**
   * The meshes of `layers`, index-aligned with them, `undefined` for a layer
   * with none, and how many of the layers the frame draws are still on their
   * way: their mesh being loaded, their source being read, their mesh being
   * built, or drawn from the mesh of what they were before a change. `zoom`
   * is the camera's: only the layers that draw at it are prepared. Lets go of
   * the meshes of the layers no longer among `layers`.
   */
  meshes(layers: readonly ImmersiveMapLayer[], zoom: number, library: LayerSourceLibrary | undefined): LayerMeshFrame {
    this.observe(library);
    const drawn = layers.filter((layer) => ImmersiveMapLayer.draws(layer, zoom));
    const drawnSources: string[] = [];
    for (const layer of drawn) if (!drawnSources.includes(layer.source)) drawnSources.push(layer.source);
    const allSources = new Set(layers.map((layer) => layer.source));
    // What the sources are, to know which layers are to be built from
    // shapes, then again with those named, which starts their reads.
    let states = library?.states(allSources, drawnSources, this.lastBuildingSources, this) ?? new Map();
    const cache = library?.meshCache;

    const toRestore: { layer: ImmersiveMapLayer; key: LayerMeshKey; identity: LayerSourceIdentity }[] = [];
    const toBuild: { layer: ImmersiveMapLayer; key: LayerMeshKey; content: LayerSourceContent; identity: LayerSourceIdentity }[] = [];
    const building = new Set<string>();
    let pendingCount = 0;
    const ids = new Set(layers.map((layer) => layer.id));
    for (const [id, mesh] of this.meshesByID) {
      if (ids.has(id)) continue;
      mesh.destroy();
      this.meshesByID.delete(id);
    }
    for (const id of this.preparing.keys()) if (!ids.has(id)) this.preparing.delete(id);
    this.drawnIDs = new Set(drawn.map((layer) => layer.id));
    const result = layers.map((layer): LayerMesh | undefined => {
      // A layer draws nothing when its source is not registered, cannot be
      // read or was refused for the limit.
      const state = states.get(layer.source);
      if (state === undefined || state.isFailed) {
        this.meshesByID.get(layer.id)?.destroy();
        this.meshesByID.delete(layer.id);
        this.preparing.delete(layer.id);
        return undefined;
      }
      const key = ImmersiveMapLayer.meshKey(layer, state.revision);
      const mesh = this.meshesByID.get(layer.id);
      if (mesh?.key === key || !this.drawnIDs.has(layer.id)) return mesh;
      pendingCount++;
      // The disk first.
      if (cache?.isEnabled === true && !this.missedOnDisk.has(key)) {
        if (this.preparing.get(layer.id) !== key) {
          this.preparing.set(layer.id, key);
          toRestore.push({ layer, key, identity: state.identity });
        }
        return mesh;
      }
      building.add(layer.source);
      if (state.content !== undefined && this.preparing.get(layer.id) !== key) {
        this.preparing.set(layer.id, key);
        toBuild.push({ layer, key, content: state.content, identity: state.identity });
      }
      return mesh;
    });
    if (!setsEqual(building, this.lastBuildingSources)) {
      states = library?.states(allSources, drawnSources, building, this) ?? states;
      this.lastBuildingSources = building;
    }
    for (const item of toRestore) void this.restore(item.layer, item.key, item.identity, library!);
    for (const item of toBuild) void this.build(item.layer, item.key, item.content, item.identity, library!);
    return { meshes: result, contents: layers.map((layer) => states.get(layer.source)?.content), pendingCount };
  }

  /** Lets go of the meshes of the layers the last frame did not draw, and of the shapes no map needs. Both come back when a frame draws the layer again. */
  releaseUndrawn(): void {
    for (const [id, mesh] of this.meshesByID) {
      if (this.drawnIDs.has(id)) continue;
      mesh.destroy();
      this.meshesByID.delete(id);
    }
    this.library?.releaseUnneeded();
  }

  /** Lets go of every mesh. The frames prepare again what they draw. */
  releaseAll(): void {
    for (const mesh of this.meshesByID.values()) mesh.destroy();
    this.meshesByID.clear();
    this.preparing.clear();
  }

  /** Lets go of everything and leaves the library: what is still on its way is dropped when it lands. */
  destroy(): void {
    this.destroyed = true;
    this.releaseAll();
    this.library?.removeClient(this);
    this.library = undefined;
  }

  private observe(library: LayerSourceLibrary | undefined): void {
    if (this.library === library) return;
    this.library?.removeClient(this);
    this.library = library;
    library?.addClient(this, () => {
      if (!this.destroyed) this.onChange();
    });
  }

  /** Loads the layer's mesh from the disk. A miss is remembered, and the next frame builds the layer from its shapes. */
  private async restore(layer: ImmersiveMapLayer, key: LayerMeshKey, identity: LayerSourceIdentity, library: LayerSourceLibrary): Promise<void> {
    const cache = library.meshCache;
    let mesh: LayerMesh | undefined;
    try {
      const name = await cache.entryName(identity, layer.source, layerStyleValues(layer));
      const file = name === undefined ? undefined : await cache.get(name);
      if (name !== undefined && file !== undefined) {
        mesh = this.destroyed ? undefined : this.factory(key, file);
        // Not a mesh of this version, or cut short: it is written anew by the build that follows.
        if (mesh === undefined) await cache.remove(name);
      }
    } catch {
      mesh = undefined;
    }
    if (this.destroyed) {
      mesh?.destroy();
      return;
    }
    if (this.preparing.get(layer.id) !== key) {
      mesh?.destroy();
    } else {
      this.preparing.delete(layer.id);
      if (mesh !== undefined) this.land(layer.id, mesh);
      else this.missedOnDisk.add(key);
    }
    this.onChange();
  }

  /** Builds the layer's mesh from its source's shapes in the layers' worker, and keeps it on disk. */
  private async build(layer: ImmersiveMapLayer, key: LayerMeshKey, content: LayerSourceContent, identity: LayerSourceIdentity, library: LayerSourceLibrary): Promise<void> {
    const styles = layerStyleValues(layer);
    let file: ArrayBuffer | undefined;
    try {
      file = await library.jobs.build(content.buffers, styles);
    } catch {
      file = undefined;
    }
    if (this.destroyed) return;
    const mesh = file === undefined ? undefined : this.factory(key, file);
    const cache = library.meshCache;
    if (mesh !== undefined && file !== undefined && cache.isEnabled) {
      // The disk has it now: the next time it is loaded from there.
      this.missedOnDisk.delete(key);
      const bytes = file;
      void cache
        .entryName(identity, layer.source, styles)
        .then((name) => (name === undefined ? undefined : cache.store(bytes, name)))
        .catch(() => undefined);
    }
    if (this.preparing.get(layer.id) !== key) {
      mesh?.destroy();
      return;
    }
    this.preparing.delete(layer.id);
    if (mesh === undefined) return;
    this.land(layer.id, mesh);
    this.onChange();
  }

  private land(id: string, mesh: LayerMesh): void {
    const previous = this.meshesByID.get(id);
    if (previous !== undefined && previous !== mesh) previous.destroy();
    this.meshesByID.set(id, mesh);
  }
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
