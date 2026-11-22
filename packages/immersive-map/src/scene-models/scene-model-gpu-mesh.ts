// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A loaded scene model asset on the GPU, the Swift `SceneModelMesh` and the
 * GPU half of `SceneModelAssetLoader`: each mesh's interleaved vertices and
 * its indices in buffers of their own (shared by every node that instances
 * the mesh), each submesh's material (its base colour and its texture, a
 * white texel for an untextured one), and the asset-space bounds that size,
 * cull and hit-test the model. Shared by every scene model of the source.
 *
 * The asset is fetched and parsed on the main thread
 * (`loadSceneModelAsset`, glTF 2.0, GLB and OBJ), its pictures decoded by
 * `createImageBitmap` with no colour conversion (the engine's colours are
 * not colour-managed, so textures pass through raw, as in Swift), and each
 * texture gets its mip chain drawn level by level (WebGPU has no generated
 * mipmaps).
 */

import type { Mat4 } from "../math/matrix.ts";
import { loadSceneModelAsset } from "./asset/scene-model-asset-parser.ts";
import { type SceneModelAssetData, sceneModelAssetGeometryBytes, type SceneModelImage } from "./asset/scene-model-asset-data.ts";
import type { ResolvedSceneModelSource } from "./immersive-map-scene-model.ts";
import type { ModelPipelines } from "./pipelines/model-pipelines.ts";
import { makeSceneModelBounds, type SceneModelBounds } from "./scene-model-bounds.ts";
import mipSource from "./shaders/scene-model-mip.wgsl?raw";
import type { SceneModelStoreMesh } from "./scene-model-mesh-store.ts";

export interface SceneModelGpuSubmesh {
  readonly firstIndex: number;
  readonly indexCount: number;
  readonly baseColor: readonly [number, number, number, number];
  /** The base colour texture and the sampler (`ModelPipelines.sceneModelTextureLayout`). */
  readonly textureGroup: GPUBindGroup;
}

export interface SceneModelGpuMeshPart {
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  /** The node transform of the mesh inside the asset. */
  readonly localTransform: Mat4;
  readonly submeshes: readonly SceneModelGpuSubmesh[];
}

export class SceneModelGpuMesh implements SceneModelStoreMesh {
  constructor(
    readonly meshes: readonly SceneModelGpuMeshPart[],
    readonly localBounds: SceneModelBounds,
    readonly costInBytes: number,
    private readonly resources: readonly (GPUBuffer | GPUTexture)[],
  ) {}

  destroy(): void {
    for (const resource of this.resources) resource.destroy();
  }
}

const mipLevelCount = (width: number, height: number) => Math.floor(Math.log2(Math.max(1, width, height))) + 1;

/** Makes the GPU meshes of the scene models' sources: one per device, with the white texel and the mip pipeline it shares. */
export class SceneModelGpuMeshFactory {
  private readonly white: GPUTexture;
  private readonly whiteGroup: GPUBindGroup;
  private mip: { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout; sampler: GPUSampler } | undefined;

  constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: ModelPipelines,
  ) {
    this.white = device.createTexture({ label: "scene model white", size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    this.whiteGroup = this.textureGroup(this.white);
  }

  /** Fetches, parses and uploads one source. Rejects with a `SceneModelAssetLoadError` (or the fetch's error). */
  async load(source: ResolvedSceneModelSource): Promise<SceneModelGpuMesh> {
    if (source.format === null) throw new Error(`the format of ${source.url} is unknown: give the source a format`);
    const data = await loadSceneModelAsset<SceneModelImage>(source.url, source.format, {
      fetchBytes: async (url) => {
        const response = await fetch(url, { credentials: "same-origin" });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
        return response.arrayBuffer();
      },
      decodeImage: async (bytes, mimeType) => {
        const bitmap = await createImageBitmap(new Blob([bytes], mimeType === undefined ? {} : { type: mimeType }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
        return { width: bitmap.width, height: bitmap.height, image: bitmap };
      },
    });
    return this.upload(data, source.url);
  }

  /** The asset's meshes and textures on the GPU. */
  upload(data: SceneModelAssetData, label: string): SceneModelGpuMesh {
    const { device } = this;
    const resources: (GPUBuffer | GPUTexture)[] = [];
    const buffers = new Map<ArrayBufferView, GPUBuffer>();
    const textures = new Map<unknown, { group: GPUBindGroup; bytes: number }>();
    let cost = sceneModelAssetGeometryBytes(data);
    const bufferOf = (array: Float32Array | Uint32Array, usage: number): GPUBuffer => {
      let buffer = buffers.get(array);
      if (buffer === undefined) {
        buffer = device.createBuffer({ label: `scene model ${label}`, size: Math.max(16, Math.ceil(array.byteLength / 4) * 4), usage: usage | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(buffer, 0, array as Float32Array<ArrayBuffer>);
        buffers.set(array, buffer);
        resources.push(buffer);
      }
      return buffer;
    };
    const encoder = device.createCommandEncoder({ label: "scene model mips" });
    const meshes = data.meshes.map((mesh) => ({
      vertexBuffer: bufferOf(mesh.vertices, GPUBufferUsage.VERTEX),
      indexBuffer: bufferOf(mesh.indices, GPUBufferUsage.INDEX),
      localTransform: mesh.localTransform,
      submeshes: mesh.submeshes.map((submesh) => {
        const image = submesh.material.baseColorImage;
        let textureGroup = this.whiteGroup;
        if (image !== null) {
          let entry = textures.get(image.image);
          if (entry === undefined) {
            const made = this.texture(image, encoder, label);
            resources.push(made.texture);
            entry = { group: this.textureGroup(made.texture), bytes: made.bytes };
            textures.set(image.image, entry);
            cost += made.bytes;
          }
          textureGroup = entry.group;
        }
        return { firstIndex: submesh.firstIndex, indexCount: submesh.indexCount, baseColor: submesh.material.baseColor, textureGroup };
      }),
    }));
    device.queue.submit([encoder.finish()]);
    return new SceneModelGpuMesh(meshes, makeSceneModelBounds(data.bounds.minimum, data.bounds.maximum), cost, resources);
  }

  destroy(): void {
    this.white.destroy();
  }

  private textureGroup(texture: GPUTexture): GPUBindGroup {
    return this.device.createBindGroup({
      label: "scene model texture",
      layout: this.pipelines.sceneModelTextureLayout,
      entries: [
        { binding: 0, resource: texture.createView() },
        { binding: 1, resource: this.pipelines.sceneModelSampler },
      ],
    });
  }

  /** A picture as a texture with its mip chain, the levels below 0 drawn into `encoder`. */
  private texture(image: SceneModelImage, encoder: GPUCommandEncoder, label: string): { texture: GPUTexture; bytes: number } {
    const { device } = this;
    const width = Math.max(1, image.width);
    const height = Math.max(1, image.height);
    const levels = mipLevelCount(width, height);
    const texture = device.createTexture({
      label: `scene model ${label}`,
      size: [width, height],
      format: "rgba8unorm",
      mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({ source: image.image as ImageBitmap }, { texture, premultipliedAlpha: false }, [width, height]);
    const mip = this.mipPipeline();
    let bytes = 0;
    for (let level = 0; level < levels; level++) bytes += Math.max(1, width >> level) * Math.max(1, height >> level) * 4;
    for (let level = 1; level < levels; level++) {
      const group = device.createBindGroup({
        label: "scene model mip",
        layout: mip.layout,
        entries: [
          { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: mip.sampler },
        ],
      });
      const pass = encoder.beginRenderPass({
        label: "scene model mip",
        colorAttachments: [{ view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }), loadOp: "clear", clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: "store" }],
      });
      pass.setPipeline(mip.pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
    }
    return { texture, bytes };
  }

  private mipPipeline(): { pipeline: GPURenderPipeline; layout: GPUBindGroupLayout; sampler: GPUSampler } {
    if (this.mip) return this.mip;
    const { device } = this;
    const layout = device.createBindGroupLayout({
      label: "scene model mip",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    const module = device.createShaderModule({ label: "scene model mip", code: mipSource });
    const pipeline = device.createRenderPipeline({
      label: "scene model mip",
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module, entryPoint: "sceneModelMipVertex" },
      fragment: { module, entryPoint: "sceneModelMipFragment", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });
    const sampler = device.createSampler({ label: "scene model mip", minFilter: "linear", magFilter: "linear" });
    this.mip = { pipeline, layout, sampler };
    return this.mip;
  }
}
