// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Mat4 } from "../../math/matrix.ts";
import type { Vec3 } from "../../math/vec.ts";
import type { SceneModelAssetFormat } from "../immersive-map-scene-model.ts";

/**
 * A decoded picture, as the injected `decodeImage` makes it. On the web the
 * engine passes an `ImageBitmap` from `createImageBitmap` as `image`. The
 * parser never looks inside it.
 */
export interface SceneModelImage {
  readonly width: number;
  readonly height: number;
  readonly image: unknown;
}

/** A submesh's look: the constant color and the optional picture it multiplies. */
export interface SceneModelAssetMaterial<Image = SceneModelImage> {
  /**
   * Linear multiplier of the picture (or the color itself without one), as
   * glTF's `baseColorFactor`. Components 0...1, alpha last.
   */
  readonly baseColor: readonly [r: number, g: number, b: number, a: number];
  /**
   * The base color picture, null for untextured. Sampled with the UV origin
   * at the top left of the image (no V flip in the shader). The picture's
   * values pass through raw (no sRGB decode), as in Swift.
   */
  readonly baseColorImage: Image | null;
}

/** A range of a mesh's index buffer drawn with one material. */
export interface SceneModelAssetSubmesh<Image = SceneModelImage> {
  readonly firstIndex: number;
  readonly indexCount: number;
  readonly material: SceneModelAssetMaterial<Image>;
}

/**
 * One mesh of the asset, in the canonical vertex layout the Swift engine
 * pins (`SceneModelAssetLoader.makeVertexDescriptor`): position xyz,
 * normal xyz, uv, interleaved, 8 floats and 32 bytes per vertex.
 */
export interface SceneModelAssetMesh<Image = SceneModelImage> {
  readonly vertices: Float32Array;
  /** Triangle list. */
  readonly indices: Uint32Array;
  /**
   * The node transform flattened up the asset hierarchy: vertices stay
   * mesh-local, and a mesh placed by node transforms carries them into the
   * draw. A glTF mesh several nodes instance appears once per node, with the
   * same `vertices` and `indices` arrays (a GPU store can share their
   * buffers by identity).
   */
  readonly localTransform: Mat4;
  readonly submeshes: readonly SceneModelAssetSubmesh<Image>[];
}

/** A parsed asset: what the GPU side uploads, and the bounds that size and cull the model. */
export interface SceneModelAssetData<Image = SceneModelImage> {
  readonly meshes: readonly SceneModelAssetMesh<Image>[];
  /**
   * The asset's bounding box in asset space, after the node transforms (each
   * mesh's own box carried through its transform), as Model I/O's asset
   * bounding box. One unit is one meter, +Y is up.
   */
  readonly bounds: { readonly minimum: Vec3; readonly maximum: Vec3 };
}

/** The canonical vertex layout, the Swift `SceneModelAssetLoader` constants. */
export const SceneModelVertexLayout = Object.freeze({
  floatsPerVertex: 8,
  stride: 32,
  positionOffset: 0,
  normalOffset: 12,
  uvOffset: 24,
});

export type SceneModelAssetLoadErrorKind = "unsupportedFormat" | "unreadableAsset" | "meshConversionFailed";

/**
 * Why an asset did not load, the Swift `SceneModelAssetLoadError`:
 * `unsupportedFormat` (an unknown format, or a glTF that requires an
 * extension the engine cannot honor), `unreadableAsset` (the bytes or a
 * file they reference could not be read or are not the format), and
 * `meshConversionFailed` (the asset reads but its geometry does not convert:
 * no triangles, data out of range).
 */
export class SceneModelAssetLoadError extends Error {
  constructor(
    readonly kind: SceneModelAssetLoadErrorKind,
    /** The format or extension for `unsupportedFormat`, the URL otherwise. */
    readonly detail: string,
    message?: string,
  ) {
    super(message === undefined ? `${kind}: ${detail}` : `${kind}: ${detail}: ${message}`);
    this.name = "SceneModelAssetLoadError";
  }
}

/** The source the parser reads: the asset's bytes, its absolute URL (what relative references resolve against) and its format. */
export interface SceneModelAssetSource {
  readonly bytes: ArrayBuffer;
  readonly url: string;
  readonly format: SceneModelAssetFormat;
}

/** The I/O the parser runs on, injected so it runs without a DOM (and without a network in tests). */
export interface SceneModelAssetIO<Image = SceneModelImage> {
  /** The bytes at an absolute URL. Rejects when they cannot be read. */
  fetchBytes(url: string): Promise<ArrayBuffer>;
  /** Decodes an encoded picture. `mimeType` is the asset's own, undefined when it names none. */
  decodeImage(bytes: ArrayBuffer, mimeType: string | undefined): Promise<Image>;
}

/**
 * Bytes of the geometry on the GPU: every distinct vertex and index buffer
 * once (instanced meshes share theirs). The pictures' bytes depend on the
 * GPU format and mipmaps, so the GPU side adds them.
 */
export function sceneModelAssetGeometryBytes(data: SceneModelAssetData<unknown>): number {
  const counted = new Set<ArrayBufferView>();
  let bytes = 0;
  for (const mesh of data.meshes) {
    for (const buffer of [mesh.vertices, mesh.indices]) {
      if (counted.has(buffer)) continue;
      counted.add(buffer);
      bytes += buffer.byteLength;
    }
  }
  return bytes;
}
