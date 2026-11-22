// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The map's WebGPU device and what it can do. Every optional feature the
 * engine has a use for is asked for when the adapter has it, and each one's
 * absence has a fallback inside WebGPU.
 */

export interface GpuCapabilities {
  /** `half` arithmetic in WGSL. */
  shaderF16: boolean;
  /** `clip_distances` in WGSL. */
  clipDistances: boolean;
  /** The depth-stencil format the engine prefers (the Metal depth32Float_stencil8). */
  depth32Stencil8: boolean;
  /** GPU pass timing. */
  timestampQuery: boolean;
  /** Block-compressed textures of desktop GPUs and of Apple and mobile GPUs. */
  textureCompressionBC: boolean;
  textureCompressionASTC: boolean;
  /** Linear filtering of float32 textures (the relief's heights). */
  float32Filterable: boolean;
  /** A first instance other than 0 in an indirect draw (the model tiles' culled draws name their record by it). */
  indirectFirstInstance: boolean;
  /** Subgroup operations in WGSL (the model tiles' triangle culling ranks by ballots). */
  subgroups: boolean;
}

export interface GpuContext {
  readonly device: GPUDevice;
  readonly adapterInfo: GPUAdapterInfo;
  readonly capabilities: GpuCapabilities;
  readonly colorFormat: GPUTextureFormat;
  readonly depthStencilFormat: GPUTextureFormat;
}

const OPTIONAL_FEATURES: GPUFeatureName[] = [
  "shader-f16",
  "clip-distances",
  "depth32float-stencil8",
  "timestamp-query",
  "texture-compression-bc",
  "texture-compression-astc",
  "float32-filterable",
  "indirect-first-instance",
  "subgroups",
];

export async function createGpuContext(): Promise<GpuContext> {
  if (!navigator.gpu) throw new Error("ImmersiveMap needs WebGPU, which this browser does not provide.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("ImmersiveMap found no WebGPU adapter.");
  const requiredFeatures = OPTIONAL_FEATURES.filter((f) => adapter.features.has(f));
  // The limits the engine leans on, as high as the adapter goes.
  const requiredLimits: Record<string, number> = {
    maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxTextureArrayLayers: adapter.limits.maxTextureArrayLayers,
  };
  const device = await adapter.requestDevice({ requiredFeatures, requiredLimits });
  device.addEventListener("uncapturederror", (event) => console.error(`ImmersiveMap WebGPU: ${(event as GPUUncapturedErrorEvent).error.message}`));
  const has = (f: GPUFeatureName) => device.features.has(f);
  const capabilities: GpuCapabilities = {
    shaderF16: has("shader-f16"),
    clipDistances: has("clip-distances"),
    depth32Stencil8: has("depth32float-stencil8"),
    timestampQuery: has("timestamp-query"),
    textureCompressionBC: has("texture-compression-bc"),
    textureCompressionASTC: has("texture-compression-astc"),
    float32Filterable: has("float32-filterable"),
    indirectFirstInstance: has("indirect-first-instance"),
    subgroups: has("subgroups"),
  };
  return {
    device,
    adapterInfo: adapter.info,
    capabilities,
    colorFormat: navigator.gpu.getPreferredCanvasFormat(),
    // depth24plus-stencil8 is core WebGPU: the fallback when the float depth is missing.
    depthStencilFormat: capabilities.depth32Stencil8 ? "depth32float-stencil8" : "depth24plus-stencil8",
  };
}
