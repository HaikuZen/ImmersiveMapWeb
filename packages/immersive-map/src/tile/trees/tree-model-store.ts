// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The engine's tree model on the GPU, a port of the Swift `TreeModelMesh`
 * and `TreeModelStore`: the package's `tree_broadleaf.immtree`, fetched
 * once, read and checked (`TreeModelContents.read`), and put into one
 * buffer as it is, the levels drawn by their offsets into it. The frames
 * before it lands draw no trees, and its landing asks for a frame.
 */

import { TreeModelContents } from "./tree-model.ts";

/** The model file shipped in the package. */
export const bundledTreeModelURL = new URL("../../../assets/tree_broadleaf.immtree", import.meta.url).href;

export interface TreeModelMesh {
  readonly contents: TreeModelContents;
  /** The whole file: vertices and indices at the levels' offsets. */
  readonly buffer: GPUBuffer;
}

export class TreeModelStore {
  private loaded: TreeModelMesh | undefined;
  private destroyed = false;

  /** Starts the load. `onLoaded` asks the map for a frame. A model that cannot be loaded leaves the map without trees and says why. */
  constructor(
    private readonly device: GPUDevice,
    onLoaded: () => void,
    url: string = bundledTreeModelURL,
  ) {
    void this.load(url).then(
      (loaded) => {
        if (!loaded) return;
        onLoaded();
      },
      (error: unknown) => console.error(`ImmersiveMap could not load its tree model ${url}: ${String(error)}`),
    );
  }

  /** The model, `undefined` until it has landed. */
  get mesh(): TreeModelMesh | undefined {
    return this.loaded;
  }

  destroy(): void {
    this.destroyed = true;
    this.loaded?.buffer.destroy();
    this.loaded = undefined;
  }

  private async load(url: string): Promise<boolean> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    const contents = TreeModelContents.read(bytes);
    if (this.destroyed) return false;
    const buffer = this.device.createBuffer({
      label: "tree model",
      size: Math.ceil(contents.byteCount / 4) * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    });
    new Uint8Array(buffer.getMappedRange(), 0, contents.byteCount).set(new Uint8Array(bytes, 0, contents.byteCount));
    buffer.unmap();
    this.loaded = { contents, buffer };
    return true;
  }
}
