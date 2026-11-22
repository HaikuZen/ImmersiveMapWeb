// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Leaves out of a model tile's draw the triangles that would draw no
 * sample (scene-models/shaders/model-tile-cull.wgsl). A compute pass before
 * the frame's render passes writes, for each tile the world pass draws, the
 * triangles it keeps of the runs the frame keeps (`visibleModelRuns`), in
 * the tile's own order, into the tile's culled index buffer, and their
 * count into the tile's indirect draw. Not in Swift: a tile of the Kremlin
 * drawn whole at zoom 14 is over a million triangles with no vertex shared
 * between them, most of them smaller than a pixel, and the world pass is
 * bound by their vertices.
 *
 * The draw's record goes as the indirect draw's first instance, which
 * needs `indirect-first-instance`, and the kept triangles are ranked by
 * subgroup ballots, which need `subgroups`: without both the tiles draw
 * their runs.
 */

import cullSource from "../shaders/model-tile-cull.wgsl?raw";
import type { Mat4 } from "../../math/matrix.ts";
import { type SampleGrid, sampleMarginPixels } from "./model-tile-culling.ts";
import type { ModelTileMesh } from "./model-tile-mesh.ts";

/** Triangles a workgroup of the cull and the pack takes (`workgroupSize` in the shader). */
const chunkTriangles = 256;
const maximumWorkgroupsPerDimension = 65_535;
/** Bytes of `CullParameters` in the shader. */
const parameterBytes = 112;

/** What a tile's culling keeps between frames: its parameters, its runs, its indirect draw and the group binding them. */
interface MeshCulling {
  readonly parameters: GPUBuffer;
  readonly runs: GPUBuffer;
  readonly drawArguments: GPUBuffer;
  /** Built again when the shared scratch grows. */
  group: GPUBindGroup | undefined;
  scratchGeneration: number;
  /** What the culled buffer was culled for (`cullKey`): a frame that asks the same again draws it as it is. */
  key: Float64Array | undefined;
}

/** One tile's culling of the frame. */
export interface TriangleCullJob {
  readonly mesh: ModelTileMesh;
  /** The camera's projection-view matrix (the camera uniform's), for telling whether the camera moved. */
  readonly projectionView: Mat4;
  /** The record's matrix: the stored positions into the flat world. */
  readonly model: Mat4;
  readonly depthBias: number;
  /** The runs the frame keeps: first triangle and count, pairs. */
  readonly runs: readonly number[];
  readonly triangleCount: number;
  /** The draw's record (its first instance). */
  readonly record: number;
}

export class ModelTileTriangleCuller {
  private pipelines: { cull: GPUComputePipeline; scan: GPUComputePipeline; pack: GPUComputePipeline } | undefined;
  private readonly layout: GPUBindGroupLayout;
  private readonly meshes = new Map<ModelTileMesh, MeshCulling>();
  /** Shared by the jobs, which run one after another: a workgroup's kept triangles, its count and its offset. */
  private scratch: { triangles: GPUBuffer; counts: GPUBuffer; offsets: GPUBuffer; triangleCapacity: number; generation: number } | undefined;
  private readonly staging = new ArrayBuffer(parameterBytes);
  private readonly stagingF32 = new Float32Array(this.staging);
  private readonly stagingU32 = new Uint32Array(this.staging);
  private readonly recordStaging = new Uint32Array(1);

  constructor(
    private readonly device: GPUDevice,
    /** The frame's camera uniform, the one the model tiles draw with. */
    private readonly cameraBuffer: GPUBuffer,
  ) {
    const compute = GPUShaderStage.COMPUTE;
    const uniform: GPUBufferBindingLayout = { type: "uniform" };
    const read: GPUBufferBindingLayout = { type: "read-only-storage" };
    const write: GPUBufferBindingLayout = { type: "storage" };
    this.layout = device.createBindGroupLayout({
      label: "model tile cull",
      entries: [uniform, uniform, read, read, read, write, write, write, write, write].map((buffer, binding) => ({ binding, visibility: compute, buffer })),
    });
  }

  /** The indirect draw of a tile culled this frame: its culled index buffer's kept triangles, under its record. */
  drawArguments(mesh: ModelTileMesh): GPUBuffer | undefined {
    return this.meshes.get(mesh)?.drawArguments;
  }

  /**
   * The frame's jobs, in one compute pass before the frame's render
   * passes: each tile's culled buffer then holds its kept triangles and its
   * indirect draw their count. A tile culled last time for the same camera,
   * matrix, drawable and runs (a still frame drawn again) is not culled
   * again: its draw only takes the frame's record.
   */
  encode(
    encoder: GPUCommandEncoder,
    jobs: readonly TriangleCullJob[],
    width: number,
    height: number,
    grid: SampleGrid,
    timestamps: (label: string) => { timestampWrites?: GPUComputePassTimestampWrites },
  ): void {
    this.forgetDestroyed();
    if (jobs.length === 0) return;
    const { device } = this;
    let pass: GPUComputePassEncoder | undefined;
    for (const job of jobs) {
      const culling = this.culling(job.mesh);
      // The draw's record is the frame's, culled again or not.
      this.recordStaging[0] = job.record;
      device.queue.writeBuffer(culling.drawArguments, 16, this.recordStaging);
      const key = cullKey(job, width, height, grid);
      if (culling.key !== undefined && keysEqual(culling.key, key)) continue;
      culling.key = key;
      const scratch = this.ensureScratch(Math.max(...jobs.map((other) => other.triangleCount)));
      const pipelines = this.computePipelines();
      pass ??= encoder.beginComputePass({ label: "model tile cull", ...timestamps("modelTileCull") });
      const runCount = job.runs.length / 2;
      const runs = new Uint32Array(runCount * 4);
      let output = 0;
      for (let i = 0; i < runCount; i++) {
        runs[i * 4] = output;
        runs[i * 4 + 1] = job.runs[i * 2]!;
        runs[i * 4 + 2] = job.runs[i * 2 + 1]!;
        output += job.runs[i * 2 + 1]!;
      }
      device.queue.writeBuffer(culling.runs, 0, runs);
      const groups = Math.ceil(job.triangleCount / chunkTriangles);
      const columns = Math.min(groups, maximumWorkgroupsPerDimension);
      const rows = Math.ceil(groups / columns);
      const f = this.stagingF32;
      const u = this.stagingU32;
      for (let i = 0; i < 16; i++) f[i] = job.model[i]!;
      f[16] = width;
      f[17] = height;
      f[18] = job.depthBias;
      u[19] = runCount;
      u[20] = job.triangleCount;
      u[21] = columns;
      f[22] = grid.step;
      f[23] = grid.phase;
      f[24] = sampleMarginPixels;
      device.queue.writeBuffer(culling.parameters, 0, this.staging);
      if (culling.group === undefined || culling.scratchGeneration !== scratch.generation) {
        culling.group = this.makeGroup(job.mesh, culling, scratch);
        culling.scratchGeneration = scratch.generation;
      }
      pass.setBindGroup(0, culling.group);
      pass.setPipeline(pipelines.cull);
      pass.dispatchWorkgroups(columns, rows);
      pass.setPipeline(pipelines.scan);
      pass.dispatchWorkgroups(1);
      pass.setPipeline(pipelines.pack);
      pass.dispatchWorkgroups(columns, rows);
    }
    pass?.end();
  }

  destroy(): void {
    for (const culling of this.meshes.values()) this.release(culling);
    this.meshes.clear();
    if (this.scratch !== undefined) {
      this.scratch.triangles.destroy();
      this.scratch.counts.destroy();
      this.scratch.offsets.destroy();
      this.scratch = undefined;
    }
  }

  private culling(mesh: ModelTileMesh): MeshCulling {
    let culling = this.meshes.get(mesh);
    if (culling === undefined) {
      const { device } = this;
      culling = {
        parameters: device.createBuffer({ label: "model tile cull", size: parameterBytes, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        runs: device.createBuffer({ label: "model tile cull runs", size: Math.max(16, mesh.models.length * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }),
        drawArguments: this.makeDrawArguments(),
        group: undefined,
        scratchGeneration: -1,
        key: undefined,
      };
      this.meshes.set(mesh, culling);
    }
    return culling;
  }

  /** An indirect draw of one instance from the first index: the scan writes its index count, each frame its first instance. */
  private makeDrawArguments(): GPUBuffer {
    const buffer = this.device.createBuffer({ label: "model tile culled draw", size: 20, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, mappedAtCreation: true });
    new Uint32Array(buffer.getMappedRange()).set([0, 1, 0, 0, 0]);
    buffer.unmap();
    return buffer;
  }

  private makeGroup(mesh: ModelTileMesh, culling: MeshCulling, scratch: NonNullable<ModelTileTriangleCuller["scratch"]>): GPUBindGroup {
    const buffers = [this.cameraBuffer, culling.parameters, mesh.vertexBuffer, mesh.indexBuffer, culling.runs, mesh.culledIndexBuffer, scratch.triangles, scratch.counts, scratch.offsets, culling.drawArguments];
    return this.device.createBindGroup({ label: "model tile cull", layout: this.layout, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
  }

  /** The shared scratch, grown to hold a job of `triangles` triangles. */
  private ensureScratch(triangles: number): NonNullable<ModelTileTriangleCuller["scratch"]> {
    const current = this.scratch;
    if (current !== undefined && current.triangleCapacity >= triangles) return current;
    const { device } = this;
    // Room for a quarter more, so a slightly larger tile does not make it again.
    const capacity = Math.ceil((Math.max(triangles, current?.triangleCapacity ?? 0) * 1.25) / chunkTriangles) * chunkTriangles;
    const groups = capacity / chunkTriangles;
    const usage = GPUBufferUsage.STORAGE;
    if (current !== undefined) {
      current.triangles.destroy();
      current.counts.destroy();
      current.offsets.destroy();
    }
    this.scratch = {
      triangles: device.createBuffer({ label: "model tile cull scratch", size: capacity * 12, usage }),
      counts: device.createBuffer({ label: "model tile cull counts", size: (groups + 1) * 4, usage }),
      offsets: device.createBuffer({ label: "model tile cull offsets", size: (groups + 1) * 4, usage }),
      triangleCapacity: capacity,
      generation: (current?.generation ?? 0) + 1,
    };
    return this.scratch;
  }

  private release(culling: MeshCulling): void {
    culling.parameters.destroy();
    culling.runs.destroy();
    culling.drawArguments.destroy();
  }

  /** Lets go of the buffers of the tiles the store dropped. */
  private forgetDestroyed(): void {
    for (const [mesh, culling] of this.meshes) {
      if (!mesh.isDestroyed) continue;
      this.release(culling);
      this.meshes.delete(mesh);
    }
  }

  private computePipelines(): NonNullable<ModelTileTriangleCuller["pipelines"]> {
    if (this.pipelines === undefined) {
      const { device } = this;
      const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
      const module = device.createShaderModule({ label: "model tile cull", code: `enable subgroups;\n${cullSource}` });
      const pipeline = (entryPoint: string) => device.createComputePipeline({ label: `model tile cull ${entryPoint}`, layout, compute: { module, entryPoint } });
      this.pipelines = { cull: pipeline("cullTriangles"), scan: pipeline("scanCounts"), pack: pipeline("packTriangles") };
    }
    return this.pipelines;
  }
}

/** Everything a tile's culling reads but its buffers: the camera, the draw's matrix and bias, the drawable, the samples and the runs. */
export function cullKey(job: Pick<TriangleCullJob, "projectionView" | "model" | "depthBias" | "runs">, width: number, height: number, grid: SampleGrid): Float64Array {
  const key = new Float64Array(37 + job.runs.length);
  key.set(job.projectionView, 0);
  key.set(job.model, 16);
  key.set([job.depthBias, width, height, grid.step, grid.phase], 32);
  key.set(job.runs, 37);
  return key;
}

export function keysEqual(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
