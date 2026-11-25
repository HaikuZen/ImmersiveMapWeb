// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { LayerSourceBuffers } from "../sources/layer-source-content.ts";
import { buildLayerMesh, type LayerParseOutcome, type LayerWasmModule, parseLayerDocument } from "./layer-jobs.ts";
import { type FromLayerWorker, type LayerDocument, type ToLayerWorker } from "./layer-worker-protocol.ts";

/** What reads the documents of the app's sources and builds the meshes of its layers. */
export interface LayerJobRunner {
  /** The document's shapes in a source's arrays, or the error it is. */
  parse(document: LayerDocument): Promise<LayerParseOutcome>;
  /** A layer's mesh file from its source's arrays (copied, never taken) and its styles (`layerStyleValues`). */
  build(content: LayerSourceBuffers, styles: Float32Array): Promise<ArrayBuffer>;
  /** Ends what the runner holds. A job asked for afterwards starts it again. */
  release(): void;
}

/**
 * The layers' worker (layer-worker.ts) as the map's job runner. The worker
 * is made on the first job, and ended once it has nothing to do and its
 * Wasm memory has grown past `retainedMemoryBytes` (a large document read,
 * a large mesh built): Wasm memory never shrinks, and the end of the worker
 * is the only way it goes back to the system. The next job
 * makes a new one, whose module the browser has compiled already.
 */
export class LayerWorkerClient implements LayerJobRunner {
  /** The memory a worker may keep between jobs: 32 MB, a few megabytes of GeoJSON. */
  static readonly defaultRetainedMemoryBytes = 32 * 1024 * 1024;

  private worker: Worker | undefined;
  private readonly pending = new Map<number, { resolve: (message: FromLayerWorker) => void; reject: (error: Error) => void }>();
  private nextId = 1;
  private wasmBytes = 0;
  /** How many workers were ended for their memory, for a test of the policy. */
  terminations = 0;

  constructor(
    private readonly retainedMemoryBytes = LayerWorkerClient.defaultRetainedMemoryBytes,
    private readonly makeWorker: () => Worker = () => new Worker(new URL("./layer-worker.ts", import.meta.url), { type: "module", name: "layers" }),
  ) {}

  async parse(document: LayerDocument): Promise<LayerParseOutcome> {
    const resolved = document.kind === "url" ? { kind: "url" as const, url: new URL(document.url, globalThis.location?.href).href } : document;
    try {
      // The app's bytes are copied, never taken: the source is read again when it is needed again.
      const message = await this.post({ type: "parse", id: this.nextId++, document: resolved }, []);
      if (message.type === "parsed") return { ok: true, buffers: message.buffers };
      if (message.type === "failed") return { ok: false, error: message.error };
      return { ok: false, error: { kind: "unreadableFile", reason: "the layers' worker answered out of turn" } };
    } catch (error) {
      return { ok: false, error: { kind: "unreadableFile", reason: error instanceof Error ? error.message : String(error) } };
    }
  }

  async build(content: LayerSourceBuffers, styles: Float32Array): Promise<ArrayBuffer> {
    const message = await this.post({ type: "build", id: this.nextId++, content, styles }, []);
    if (message.type === "built") return message.file;
    throw new Error(message.type === "failed" ? message.error.kind === "unreadableFile" ? message.error.reason : message.error.kind : "the layers' worker answered out of turn");
  }

  release(): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const pending of this.pending.values()) pending.reject(new Error("the layers' worker was ended"));
    this.pending.clear();
  }

  private post(message: ToLayerWorker, transfer: Transferable[]): Promise<FromLayerWorker> {
    const worker = (this.worker ??= this.startWorker());
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject });
      worker.postMessage(message, transfer);
    });
  }

  private startWorker(): Worker {
    const worker = this.makeWorker();
    worker.addEventListener("message", (event: MessageEvent<FromLayerWorker>) => {
      const message = event.data;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      this.wasmBytes = message.wasmBytes;
      pending?.resolve(message);
      this.endIfOversized(worker);
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      if (this.worker !== worker) return;
      this.worker = undefined;
      worker.terminate();
      for (const pending of this.pending.values()) pending.reject(new Error(`the layers' worker failed: ${event.message}`));
      this.pending.clear();
    });
    return worker;
  }

  /** An idle worker whose memory grew past what is kept between jobs is ended. */
  private endIfOversized(worker: Worker): void {
    if (this.worker !== worker || this.pending.size > 0 || this.wasmBytes <= this.retainedMemoryBytes) return;
    worker.terminate();
    this.worker = undefined;
    this.wasmBytes = 0;
    this.terminations++;
  }
}

/**
 * The jobs run in the calling thread over a module already loaded: the
 * tests' runner, the same Rust calls the worker makes.
 */
export class InProcessLayerJobs implements LayerJobRunner {
  constructor(
    private readonly wasm: LayerWasmModule,
    private readonly fetchDocument: (url: string) => Promise<Uint8Array> = async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  ) {}

  async parse(document: LayerDocument): Promise<LayerParseOutcome> {
    let input: string | Uint8Array;
    try {
      input = document.kind === "url" ? await this.fetchDocument(document.url) : document.kind === "text" ? document.text : document.kind === "bytes" ? document.bytes : JSON.stringify(document.object);
    } catch (error) {
      return { ok: false, error: { kind: "unreadableFile", reason: error instanceof Error ? error.message : String(error) } };
    }
    return parseLayerDocument(this.wasm, input);
  }

  build(content: LayerSourceBuffers, styles: Float32Array): Promise<ArrayBuffer> {
    return Promise.resolve(buildLayerMesh(this.wasm, content, styles));
  }

  release(): void {}
}
