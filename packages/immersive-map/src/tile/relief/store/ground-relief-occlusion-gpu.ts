// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import shaderSource from "./ground-relief-occlusion-gpu.wgsl?raw";

/**
 * The terrain tiles' occlusion of the sky on the GPU (decision B10,
 * docs/benchmarks/B10-occlusion.md), the Swift `GroundReliefOcclusion`: for
 * a grid of `resolution` points a side over a tile, the mean over
 * `directions` directions of the sine of the horizon's elevation, the
 * steepest line of sight to the terrain out to the radius, 255 for a point
 * that sees no sky. A compute shader reads the relief's own `r16float`
 * height texture and writes an `r8unorm` texture, the same bytes the Swift
 * engine computes on the CPU (checked by the benchmark against the Rust
 * port in crates/bench-wasm). The terrain is read within the tile alone.
 *
 * The rays (texel offsets and one over the metres of each step) are built
 * here in f32 exactly as Swift builds them, so the offsets round alike.
 */

export interface GroundReliefOcclusionGpuKey {
  readonly radiusMetres: number;
  readonly directions: number;
  readonly resolution: number;
}

const f = Math.fround;
const PI32 = f(Math.PI);

/** The ground metres a texel of a terrain tile of `size` texels a side spans at the tile's middle latitude, in f32 (the Swift `metresPerTexel(tile:size:)`). */
export function occlusionMetresPerTexel(z: number, y: number, size: number): number {
  const count = 2 ** Math.max(z, 0);
  const middleY = Math.min(Math.max((y + 0.5) / count, 0), 1);
  const latitude = 2 * Math.atan(Math.exp((1 - 2 * middleY) * Math.PI)) - Math.PI / 2;
  const sideMetres = (2 * Math.PI * 6_378_137 * Math.cos(latitude)) / count;
  return f(sideMetres / Math.max(size, 1));
}

/** The distances the lines of sight step out at, in texels: every texel near, then growing by a quarter each step, out to the radius (the Swift `steps(radiusTexels:)`). */
export function occlusionSteps(radiusTexels: number): number[] {
  const steps: number[] = [];
  let distance = 1;
  while (distance <= radiusTexels) {
    steps.push(distance);
    distance = Math.max(distance + 1, Math.floor(f(distance * 1.25)));
  }
  return steps;
}

/** Half away from zero, as Swift's `rounded()`. */
const roundAway = (value: number) => Math.sign(value) * Math.round(Math.abs(value));

/**
 * The rays as the shader reads them, direction by direction, step by step,
 * four words each: the x and y offsets in texels (i32), one over the step's
 * ground metres (f32), a pad.
 */
export function occlusionRays(metresPerTexel: number, key: GroundReliefOcclusionGpuKey): { data: ArrayBuffer; stepCount: number } {
  const distances = occlusionSteps(f(key.radiusMetres / metresPerTexel));
  const data = new ArrayBuffer(Math.max(1, key.directions * distances.length) * 16);
  const ints = new Int32Array(data);
  const floats = new Float32Array(data);
  let index = 0;
  for (let direction = 0; direction < key.directions; direction++) {
    const angle = f(f(f(2 * PI32) * direction) / key.directions);
    const x = f(Math.cos(angle));
    const y = f(Math.sin(angle));
    for (const distance of distances) {
      ints[index * 4] = roundAway(f(x * distance));
      ints[index * 4 + 1] = roundAway(f(y * distance));
      floats[index * 4 + 2] = f(1 / f(distance * metresPerTexel));
      index++;
    }
  }
  return { data, stepCount: distances.length };
}

export class GroundReliefOcclusionGpu {
  private readonly pipeline: GPUComputePipeline;
  /** The rays, parameters and bytes of computations encoded but not yet known to be submitted. */
  private encoded: GPUBuffer[] = [];

  constructor(private readonly device: GPUDevice) {
    this.pipeline = device.createComputePipeline({
      label: "terrain occlusion",
      layout: "auto",
      compute: { module: device.createShaderModule({ label: "terrain occlusion", code: shaderSource }), entryPoint: "main" },
    });
  }

  /**
   * The occlusion of a tile's heights (`r16float`, `size` squared, row 0
   * north) under a key clamped as `GroundReliefOcclusionKey.make` clamps
   * it, encoded and submitted on its own: an `r8unorm` texture of
   * `key.resolution` squared, for the caller to keep and destroy. A key that
   * computes nothing gives one texel of 0.
   */
  compute(heights: GPUTexture, tile: { x: number; y: number; z: number }, key: GroundReliefOcclusionGpuKey): GPUTexture {
    const encoder = this.device.createCommandEncoder({ label: "terrain occlusion" });
    const texture = this.encode(encoder, heights, tile, key);
    this.device.queue.submit([encoder.finish()]);
    this.submitted();
    return texture;
  }

  /**
   * The same into the caller's encoder (a frame's, or several tiles in one
   * submit), its own compute pass, with the pass's timestamps where given.
   * The caller calls `submitted()` once the encoder is submitted.
   */
  encode(
    encoder: GPUCommandEncoder,
    heights: GPUTexture,
    tile: { x: number; y: number; z: number },
    key: GroundReliefOcclusionGpuKey,
    timestampWrites?: GPUComputePassTimestampWrites,
  ): GPUTexture {
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
    const resolution = key.resolution;
    if (resolution <= 0 || !(key.radiusMetres > 0)) {
      const none = this.device.createTexture({ label: "terrain occlusion (none)", size: [1, 1], format: "r8unorm", usage });
      this.device.queue.writeTexture({ texture: none }, new Uint8Array(1), {}, [1, 1]);
      return none;
    }
    const size = heights.width;
    const { data, stepCount } = occlusionRays(occlusionMetresPerTexel(tile.z, tile.y, size), key);
    const rowBytes = Math.ceil(resolution / 256) * 256;
    const rays = this.device.createBuffer({ label: "terrain occlusion rays", size: data.byteLength, usage: GPUBufferUsage.STORAGE, mappedAtCreation: true });
    new Uint8Array(rays.getMappedRange()).set(new Uint8Array(data));
    rays.unmap();
    const params = this.device.createBuffer({ label: "terrain occlusion params", size: 32, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
    const words = params.getMappedRange();
    new Uint32Array(words, 0, 4).set([size, resolution, key.directions, stepCount]);
    new Float32Array(words, 16, 1)[0] = 255 / key.directions;
    new Uint32Array(words, 20, 1)[0] = rowBytes / 4;
    params.unmap();
    // Zeroed at creation: the shader ORs each point's byte into its word.
    const bytes = this.device.createBuffer({ label: "terrain occlusion bytes", size: rowBytes * resolution, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const texture = this.device.createTexture({ label: "terrain occlusion", size: [resolution, resolution], format: "r8unorm", usage });
    const bindGroup = this.device.createBindGroup({
      label: "terrain occlusion",
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: heights.createView() },
        { binding: 1, resource: { buffer: rays } },
        { binding: 2, resource: { buffer: bytes } },
        { binding: 3, resource: { buffer: params } },
      ],
    });
    const pass = encoder.beginComputePass(timestampWrites ? { label: "terrain occlusion", timestampWrites } : { label: "terrain occlusion" });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    const groups = Math.ceil(resolution / 8);
    pass.dispatchWorkgroups(groups, groups);
    pass.end();
    encoder.copyBufferToTexture({ buffer: bytes, bytesPerRow: rowBytes }, { texture }, [resolution, resolution]);
    this.encoded.push(rays, params, bytes);
    return texture;
  }

  /** The encoded computations are submitted: their scratch buffers are freed once the GPU is done with them. */
  submitted(): void {
    for (const buffer of this.encoded) buffer.destroy();
    this.encoded = [];
  }

  destroy(): void {
    this.submitted();
  }
}
