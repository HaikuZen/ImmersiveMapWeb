// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Where model tiles come from, the main thread's side of the model tile
 * worker (`model-tile-worker.ts`, the Swift `ModelTileSource`): a tile is
 * requested apart from the map's own tiles, by a worker of its own with its
 * own archive client, its own Wasm and its own disk cache. What comes back
 * is the tile decoded and checked, ready for the GPU, or `missing` for a
 * tile the archive does not hold. A failure is a `ModelTileLoadFailure`.
 */

import type { Tile } from "../../tile/tile.ts";
import { workerFailure } from "../../worker/worker-failure.ts";
import { ModelTileLoadFailure } from "./model-tile-store.ts";
import type { DecodedModelTile, FromModelTileWorker, ModelTileWorkerConfig, ToModelTileWorker } from "./model-tile-worker-protocol.ts";

type Answer = { readonly kind: "tile"; readonly tile: DecodedModelTile; readonly decodeMilliseconds: number } | { readonly kind: "missing" };

export class ModelTileSource {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (answer: Answer) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private failure: Error | undefined;
  private destroyed = false;

  constructor(config: ModelTileWorkerConfig) {
    this.worker = new Worker(new URL("./model-tile-worker.ts", import.meta.url), { type: "module", name: "model-tiles" });
    this.worker.addEventListener("message", (event: MessageEvent<FromModelTileWorker>) => this.receive(event.data));
    this.worker.addEventListener("error", (event) => this.fail(workerFailure("model tile worker", event)));
    this.post({ type: "init", config });
  }

  /** The tile decoded, or `missing`. Rejects with a `ModelTileLoadFailure`. */
  load(tile: Tile): Promise<Answer> {
    if (this.failure !== undefined) return Promise.reject(new ModelTileLoadFailure("unavailable", this.failure.message));
    const id = this.nextId++;
    return new Promise<Answer>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: "load", id, tile });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.worker.terminate();
    this.fail(new Error("the model tile source was destroyed"));
  }

  private post(message: ToModelTileWorker): void {
    this.worker.postMessage(message);
  }

  private receive(message: FromModelTileWorker): void {
    switch (message.type) {
      case "ready":
        return;
      case "init-error":
        this.fail(new Error(`the model tile worker could not start: ${message.message}`));
        return;
      case "tile":
        this.settle(message.id)?.resolve({ kind: "tile", tile: message.tile, decodeMilliseconds: message.decodeMilliseconds });
        return;
      case "missing":
        this.settle(message.id)?.resolve({ kind: "missing" });
        return;
      case "failed":
        this.settle(message.id)?.reject(new ModelTileLoadFailure(message.kind, message.reason));
        return;
    }
  }

  private settle(id: number): { resolve: (answer: Answer) => void; reject: (error: Error) => void } | undefined {
    const entry = this.pending.get(id);
    this.pending.delete(id);
    return entry;
  }

  /** Every load on its way fails, and every later one at once. */
  private fail(error: Error): void {
    this.failure = error;
    for (const entry of this.pending.values()) entry.reject(new ModelTileLoadFailure("unavailable", error.message));
    this.pending.clear();
  }
}
