// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Makes the working index buffers of `HiddenBuildingIndexBuffers` on the
 * GPU: a buffer of the layout's size, and a compute pass that fills it from
 * the tile's arena (tile/shaders/building-index-copy.wgsl), queued when the
 * buffer is made and encoded before the frame's render passes, so the
 * frame that makes a buffer draws from it.
 */

import copySource from "../shaders/building-index-copy.wgsl?raw";
import { copyRuns, type WorkingLayout } from "./hidden-building-index-buffers.ts";

const workgroupSize = 64;
const maximumWorkgroupsPerDimension = 65_535;

/** Where a tile's extruded indices are: the arena buffer, the first index in it and the index width. */
export interface BuildingIndexSource {
  readonly arena: GPUBuffer;
  /** The first extruded index, in indices from the arena's start. */
  readonly firstIndex: number;
  readonly indexFormat: GPUIndexFormat;
}

export class BuildingIndexCopier {
  private pipeline: GPUComputePipeline | undefined;
  private readonly layout: GPUBindGroupLayout;
  private pending: { group: GPUBindGroup; workgroups: [number, number]; scratch: GPUBuffer[] }[] = [];
  /** The scratch of the copies encoded in the frame being drawn, destroyed once it is submitted. */
  private submitted: GPUBuffer[] = [];

  constructor(private readonly device: GPUDevice) {
    const compute = GPUShaderStage.COMPUTE;
    this.layout = device.createBindGroupLayout({
      label: "building index copy",
      entries: [
        { binding: 0, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 1, visibility: compute, buffer: { type: "storage" } },
        { binding: 2, visibility: compute, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: compute, buffer: { type: "uniform" } },
      ],
    });
  }

  /** The working buffer of `layout` over `source`, its copy queued for the next `encode`. */
  make(source: BuildingIndexSource, layout: WorkingLayout): GPUBuffer | undefined {
    const { device } = this;
    const wide = source.indexFormat === "uint32";
    const words = wide ? layout.indexCount : Math.ceil(layout.indexCount / 2);
    const working = device.createBuffer({ label: "buildings without the replaced", size: Math.max(4, words * 4), usage: GPUBufferUsage.INDEX | GPUBufferUsage.STORAGE });
    // The runs from the arena's start, in indices.
    const triples = copyRuns(layout);
    for (let i = 1; i < triples.length; i += 4) triples[i]! += source.firstIndex;
    const runs = device.createBuffer({ label: "building index runs", size: Math.max(16, triples.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(runs, 0, triples);
    const threads = words;
    const groups = Math.ceil(threads / workgroupSize);
    const columns = Math.min(groups, maximumWorkgroupsPerDimension);
    const rows = Math.ceil(groups / columns);
    const parameters = device.createBuffer({ label: "building index copy", size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(parameters, 0, new Uint32Array([triples.length / 4, layout.indexCount, wide ? 1 : 0, columns * workgroupSize]));
    const group = device.createBindGroup({
      label: "building index copy",
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: source.arena } },
        { binding: 1, resource: { buffer: working } },
        { binding: 2, resource: { buffer: runs } },
        { binding: 3, resource: { buffer: parameters } },
      ],
    });
    this.pending.push({ group, workgroups: [columns, rows], scratch: [runs, parameters] });
    return working;
  }

  /** The queued copies, in one compute pass before the frame's render passes. */
  encode(encoder: GPUCommandEncoder): void {
    if (this.pending.length === 0) return;
    const pass = encoder.beginComputePass({ label: "building index copy" });
    pass.setPipeline(this.computePipeline());
    for (const copy of this.pending) {
      pass.setBindGroup(0, copy.group);
      pass.dispatchWorkgroups(copy.workgroups[0], copy.workgroups[1]);
      this.submitted.push(...copy.scratch);
    }
    pass.end();
    this.pending = [];
  }

  /** After the frame's submit: the copies' scratch buffers go (WebGPU keeps them until the work that reads them is done). */
  frameCommitted(): void {
    for (const buffer of this.submitted) buffer.destroy();
    this.submitted = [];
  }

  destroy(): void {
    for (const copy of this.pending) for (const buffer of copy.scratch) buffer.destroy();
    this.pending = [];
    this.frameCommitted();
  }

  private computePipeline(): GPUComputePipeline {
    this.pipeline ??= this.device.createComputePipeline({
      label: "building index copy",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module: this.device.createShaderModule({ label: "building index copy", code: copySource }), entryPoint: "copyBuildingIndices" },
    });
    return this.pipeline;
  }
}
