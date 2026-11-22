// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Per-draw parameters, the WebGPU stand-in for Metal's `setVertexBytes`: one
 * storage array of fixed-size records, written once per frame. A draw takes a
 * record and passes its index as `firstInstance`, and the shader reads the
 * record at `instance_index`, so the bind group is set once a pass and not
 * once a draw (docs/benchmarks/B05-B07-encoding.md, B6).
 *
 * The staging grows as a frame needs, and the buffer with it. A bind group
 * built on the old buffer is rebuilt on its next request, so a drawer asks
 * for it before each draw and sets it when it changed. The draws encoded
 * before the growth still read the old buffer: it keeps its records and is
 * written too at the flush, then dropped with the frame.
 */

/** Bytes of one record: the tile draw (a matrix and four scalars). */
export const DRAW_RECORD_BYTES = 80;
const RECORD_FLOATS = DRAW_RECORD_BYTES / 4;

export class DrawParameters {
  private buffer: GPUBuffer;
  private staging: Float32Array<ArrayBuffer>;
  /** The staging's integer view, for the records' `i32` fields. */
  private stagingInt: Int32Array<ArrayBuffer>;
  private capacity: number;
  private used = 0;
  private readonly groups = new Map<GPUBindGroupLayout, GPUBindGroup>();
  /** Buffers outgrown this frame, with the records each holds. */
  private retired: { buffer: GPUBuffer; records: number }[] = [];

  constructor(
    private readonly device: GPUDevice,
    private readonly label: string,
    initialRecords = 512,
  ) {
    this.capacity = initialRecords;
    this.buffer = this.makeBuffer(initialRecords);
    this.staging = new Float32Array(initialRecords * RECORD_FLOATS);
    this.stagingInt = new Int32Array(this.staging.buffer);
  }

  /** Starts a frame: every record is free again. */
  reset(): void {
    this.used = 0;
    this.retired = [];
  }

  /** A record for one draw: its index (the draw's `firstInstance`) and its first float in `f32`, zeroed. */
  allocate(): { instance: number; index: number } {
    if (this.used >= this.capacity) this.grow(this.capacity * 2);
    const instance = this.used++;
    const index = instance * RECORD_FLOATS;
    this.staging.fill(0, index, index + RECORD_FLOATS);
    return { instance, index };
  }

  /** The records this frame allocated so far: its draw count. */
  get recordCount(): number {
    return this.used;
  }

  get f32(): Float32Array {
    return this.staging;
  }

  /** The same records as `i32`, for a record's integer fields (read again after an `allocate`, which may grow it). */
  get i32(): Int32Array {
    return this.stagingInt;
  }

  /** The bind group of the array for a layout whose binding 0 is a read-only storage buffer. */
  bindGroup(layout: GPUBindGroupLayout): GPUBindGroup {
    let group = this.groups.get(layout);
    if (!group) {
      group = this.device.createBindGroup({ label: this.label, layout, entries: [{ binding: 0, resource: { buffer: this.buffer } }] });
      this.groups.set(layout, group);
    }
    return group;
  }

  /** Uploads the records this frame used: one write. */
  flush(): void {
    if (this.used === 0) return;
    this.device.queue.writeBuffer(this.buffer, 0, this.staging, 0, this.used * RECORD_FLOATS);
    for (const old of this.retired) this.device.queue.writeBuffer(old.buffer, 0, this.staging, 0, Math.min(this.used, old.records) * RECORD_FLOATS);
  }

  destroy(): void {
    this.buffer.destroy();
  }

  private grow(records: number): void {
    const staging = new Float32Array(records * RECORD_FLOATS);
    staging.set(this.staging);
    this.staging = staging;
    this.stagingInt = new Int32Array(staging.buffer);
    // The draws already encoded this frame read the old buffer.
    this.retired.push({ buffer: this.buffer, records: this.capacity });
    this.buffer = this.makeBuffer(records);
    this.capacity = records;
    this.groups.clear();
  }

  private makeBuffer(records: number): GPUBuffer {
    return this.device.createBuffer({ label: this.label, size: records * DRAW_RECORD_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
}
