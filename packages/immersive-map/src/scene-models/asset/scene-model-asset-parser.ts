// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type Mat4, mat4Identity, mat4Multiply, mat4TransformInto } from "../../math/matrix.ts";
import { quatToMat4 } from "../../math/quaternion.ts";
import type { Vec3 } from "../../math/vec.ts";
import type { SceneModelAssetFormat } from "../immersive-map-scene-model.ts";
import {
  type SceneModelAssetData,
  type SceneModelAssetIO,
  SceneModelAssetLoadError,
  type SceneModelAssetMaterial,
  type SceneModelAssetMesh,
  type SceneModelAssetSource,
  type SceneModelAssetSubmesh,
  type SceneModelImage,
  SceneModelVertexLayout,
} from "./scene-model-asset-data.ts";

/**
 * The asset loading of the scene models, the web counterpart of the Swift
 * `SceneModelAssetLoader`: Model I/O reads USDZ and OBJ there, and this
 * parser reads glTF 2.0 (`.gltf` with external or `data:` buffers and
 * images, and binary `.glb`) and OBJ with its MTL into CPU meshes in the
 * canonical vertex layout (`SceneModelVertexLayout`). The GPU side uploads
 * the result.
 *
 * What it takes from each format:
 *
 * - glTF: triangle primitives (triangle lists, and strips and fans turned
 *   into lists), indexed or not, every accessor component type with
 *   normalized integers, sparse accessors, interleaved buffer views,
 *   `KHR_mesh_quantization`, the default scene's node hierarchy (matrix or
 *   TRS), and `pbrMetallicRoughness` base color factor and texture. Points,
 *   lines, skins and morph targets are left out (the static pose is drawn).
 * - OBJ: `v`, `vt`, `vn` and `f` with negative (relative) indices, polygons
 *   fanned into triangles, `usemtl` runs grouped into one submesh per
 *   material, `mtllib` resolved relative to the OBJ's URL, and from the MTL
 *   `Kd`, `map_Kd` and `d` or `Tr`. As Model I/O does, a `map_Kd` picture
 *   stands for the color alone (`Kd` is not multiplied in).
 *
 * Normals the asset lacks are generated as Model I/O's `addNormals` with a
 * crease threshold of 0.5 does: a corner smooths across the faces around
 * its position whose normals agree with its own face's by a cosine of at
 * least 0.5 (60 degrees), and a sharper edge stays a crease. Missing UVs are
 * zero.
 *
 * UVs come out with the origin at the top left of the picture (glTF's
 * convention, so glTF UVs pass through and OBJ's bottom-left V is flipped to
 * 1 - v), so the shader samples without a flip. One asset unit is one meter
 * and +Y is up.
 */

/** The crease threshold Swift passes to Model I/O's `addNormals`. */
const normalCreaseThreshold = 0.5;

/** Reads the asset at `url` with `io` and parses it. A failed read is `unreadableAsset`. */
export async function loadSceneModelAsset<Image = SceneModelImage>(url: string, format: SceneModelAssetFormat, io: SceneModelAssetIO<Image>): Promise<SceneModelAssetData<Image>> {
  let bytes: ArrayBuffer;
  try {
    bytes = await io.fetchBytes(url);
  } catch (error) {
    throw new SceneModelAssetLoadError("unreadableAsset", url, errorMessage(error));
  }
  return parseSceneModelAsset({ bytes, url, format }, io);
}

/** Parses an asset's bytes. Rejects with a `SceneModelAssetLoadError`. */
export async function parseSceneModelAsset<Image = SceneModelImage>(source: SceneModelAssetSource, io: SceneModelAssetIO<Image>): Promise<SceneModelAssetData<Image>> {
  switch (source.format) {
    case "gltf":
    case "glb":
      return parseGltf(source, io);
    case "obj":
      return parseObj(source, io);
    default:
      throw new SceneModelAssetLoadError("unsupportedFormat", String(source.format));
  }
}

// MARK: - Shared geometry

/** A typed array that grows by doubling, so a mesh is built without a JS number per component. */
class GrowableFloat32 {
  private data = new Float32Array(1024);
  length = 0;

  push(value: number): void {
    if (this.length === this.data.length) this.grow(this.length + 1);
    this.data[this.length++] = value;
  }

  reserve(additional: number): void {
    if (this.length + additional > this.data.length) this.grow(this.length + additional);
  }

  at(index: number): number {
    return this.data[index]!;
  }

  toArray(): Float32Array {
    return this.data.slice(0, this.length);
  }

  private grow(minimum: number): void {
    let capacity = this.data.length * 2;
    while (capacity < minimum) capacity *= 2;
    const next = new Float32Array(capacity);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}

class GrowableUint32 {
  private data = new Uint32Array(1024);
  length = 0;

  push(value: number): void {
    if (this.length === this.data.length) {
      const next = new Uint32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = value;
  }

  toArray(): Uint32Array {
    return this.data.slice(0, this.length);
  }
}

/** One mesh under construction in the canonical layout, with the asset-local box of its vertices. */
class MeshBuilder<MaterialRef> {
  readonly vertices = new GrowableFloat32();
  readonly indices = new GrowableUint32();
  readonly submeshes: { firstIndex: number; indexCount: number; material: MaterialRef }[] = [];
  readonly minimum = [Infinity, Infinity, Infinity];
  readonly maximum = [-Infinity, -Infinity, -Infinity];

  get vertexCount(): number {
    return this.vertices.length / SceneModelVertexLayout.floatsPerVertex;
  }

  /** Appends a vertex and returns its index. */
  addVertex(px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    const index = this.vertexCount;
    const vertices = this.vertices;
    vertices.reserve(SceneModelVertexLayout.floatsPerVertex);
    vertices.push(px);
    vertices.push(py);
    vertices.push(pz);
    vertices.push(nx);
    vertices.push(ny);
    vertices.push(nz);
    vertices.push(u);
    vertices.push(v);
    // The box is of the values as stored, in f32.
    const stored = [vertices.at(index * 8), vertices.at(index * 8 + 1), vertices.at(index * 8 + 2)];
    for (let axis = 0; axis < 3; axis++) {
      const value = stored[axis]!;
      if (value < this.minimum[axis]!) this.minimum[axis] = value;
      if (value > this.maximum[axis]!) this.maximum[axis] = value;
    }
    return index;
  }

  normalAt(index: number): Vec3 {
    const base = index * SceneModelVertexLayout.floatsPerVertex + 3;
    return [this.vertices.at(base), this.vertices.at(base + 1), this.vertices.at(base + 2)];
  }

  /** Opens a submesh for the indices pushed from now on. */
  beginSubmesh(material: MaterialRef): void {
    this.submeshes.push({ firstIndex: this.indices.length, indexCount: 0, material });
  }

  endSubmesh(): void {
    const submesh = this.submeshes[this.submeshes.length - 1]!;
    submesh.indexCount = this.indices.length - submesh.firstIndex;
    if (submesh.indexCount === 0) this.submeshes.pop();
  }
}

/**
 * Hash of a position's f32 bits, for welding corners that share a position
 * under different vertex indices (a UV seam), so smoothing crosses seams.
 */
const hashFloat = new Float32Array(3);
const hashBits = new Uint32Array(hashFloat.buffer);
function positionHash(x: number, y: number, z: number): number {
  hashFloat[0] = x;
  hashFloat[1] = y;
  hashFloat[2] = z;
  return (Math.imul(hashBits[0]!, 73856093) ^ Math.imul(hashBits[1]!, 19349663) ^ Math.imul(hashBits[2]!, 83492791)) >>> 0;
}

/**
 * Per-corner normals of a triangle list, generated the way Model I/O's
 * `addNormals(creaseThreshold:)` does: each corner sums the area-weighted
 * normals of the faces around its position that agree with its own face by
 * a cosine of at least `creaseThreshold`. `positions` holds xyz per vertex,
 * `triangles` three vertex indices per triangle. Returns xyz per corner.
 */
export function generateCornerNormals(positions: ArrayLike<number>, triangles: ArrayLike<number>, creaseThreshold = normalCreaseThreshold): Float32Array {
  const cornerCount = triangles.length;
  const triangleCount = Math.floor(cornerCount / 3);
  const faceNormals = new Float64Array(triangleCount * 3);
  const faceUnits = new Float64Array(triangleCount * 3);
  for (let triangle = 0; triangle < triangleCount; triangle++) {
    const a = triangles[triangle * 3]! * 3;
    const b = triangles[triangle * 3 + 1]! * 3;
    const c = triangles[triangle * 3 + 2]! * 3;
    const e1x = positions[b]! - positions[a]!;
    const e1y = positions[b + 1]! - positions[a + 1]!;
    const e1z = positions[b + 2]! - positions[a + 2]!;
    const e2x = positions[c]! - positions[a]!;
    const e2y = positions[c + 1]! - positions[a + 1]!;
    const e2z = positions[c + 2]! - positions[a + 2]!;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    faceNormals[triangle * 3] = nx;
    faceNormals[triangle * 3 + 1] = ny;
    faceNormals[triangle * 3 + 2] = nz;
    const length = Math.hypot(nx, ny, nz);
    if (length > 0) {
      faceUnits[triangle * 3] = nx / length;
      faceUnits[triangle * 3 + 1] = ny / length;
      faceUnits[triangle * 3 + 2] = nz / length;
    }
  }

  // Weld the corners by position.
  const weldOfCorner = new Int32Array(cornerCount);
  const weldPositions: number[] = [];
  const buckets = new Map<number, number[]>();
  for (let corner = 0; corner < cornerCount; corner++) {
    const p = triangles[corner]! * 3;
    const x = Math.fround(positions[p]!);
    const y = Math.fround(positions[p + 1]!);
    const z = Math.fround(positions[p + 2]!);
    const hash = positionHash(x, y, z);
    let bucket = buckets.get(hash);
    if (bucket === undefined) {
      bucket = [];
      buckets.set(hash, bucket);
    }
    let weld = -1;
    for (const candidate of bucket) {
      if (weldPositions[candidate * 3] === x && weldPositions[candidate * 3 + 1] === y && weldPositions[candidate * 3 + 2] === z) {
        weld = candidate;
        break;
      }
    }
    if (weld < 0) {
      weld = weldPositions.length / 3;
      weldPositions.push(x, y, z);
      bucket.push(weld);
    }
    weldOfCorner[corner] = weld;
  }

  // The triangles around each welded position, as compressed rows.
  const weldCount = weldPositions.length / 3;
  const rowStart = new Int32Array(weldCount + 1);
  for (let corner = 0; corner < cornerCount; corner++) rowStart[weldOfCorner[corner]! + 1]! += 1;
  for (let weld = 0; weld < weldCount; weld++) rowStart[weld + 1]! += rowStart[weld]!;
  const fill = rowStart.slice(0, weldCount);
  const rowTriangles = new Int32Array(cornerCount);
  for (let corner = 0; corner < cornerCount; corner++) {
    const weld = weldOfCorner[corner]!;
    rowTriangles[fill[weld]!] = Math.floor(corner / 3);
    fill[weld]! += 1;
  }

  const normals = new Float32Array(cornerCount * 3);
  for (let corner = 0; corner < triangleCount * 3; corner++) {
    const triangle = Math.floor(corner / 3);
    const ux = faceUnits[triangle * 3]!;
    const uy = faceUnits[triangle * 3 + 1]!;
    const uz = faceUnits[triangle * 3 + 2]!;
    const weld = weldOfCorner[corner]!;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let allX = 0;
    let allY = 0;
    let allZ = 0;
    let previous = -1;
    for (let row = rowStart[weld]!; row < rowStart[weld + 1]!; row++) {
      const other = rowTriangles[row]!;
      // A triangle touching the position twice (degenerate) counts once.
      if (other === previous) continue;
      previous = other;
      const fx = faceNormals[other * 3]!;
      const fy = faceNormals[other * 3 + 1]!;
      const fz = faceNormals[other * 3 + 2]!;
      allX += fx;
      allY += fy;
      allZ += fz;
      const agreement = ux * faceUnits[other * 3]! + uy * faceUnits[other * 3 + 1]! + uz * faceUnits[other * 3 + 2]!;
      if (other === triangle || agreement >= creaseThreshold) {
        sx += fx;
        sy += fy;
        sz += fz;
      }
    }
    let length = Math.hypot(sx, sy, sz);
    if (!(length > 0)) {
      // A degenerate face takes the smooth normal of its neighbourhood.
      sx = allX;
      sy = allY;
      sz = allZ;
      length = Math.hypot(sx, sy, sz);
    }
    if (length > 0) {
      normals[corner * 3] = sx / length;
      normals[corner * 3 + 1] = sy / length;
      normals[corner * 3 + 2] = sz / length;
    } else {
      normals[corner * 3 + 1] = 1;
    }
  }
  return normals;
}

/** Two generated normals closer than this (cosine) share one vertex. */
const sameNormalCosine = 0.99999;

/**
 * Emits corners with generated normals into a builder, one vertex per
 * distinct (source vertex, normal): corners on a smooth surface share their
 * vertex, and a crease splits it.
 */
class GeneratedNormalEmitter<MaterialRef> {
  private readonly firstOutputByKey = new Map<number | string, number>();
  private readonly nextOutput: number[] = [];

  constructor(private readonly builder: MeshBuilder<MaterialRef>) {}

  emit(key: number | string, px: number, py: number, pz: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    const builder = this.builder;
    let candidate = this.firstOutputByKey.get(key) ?? -1;
    let last = -1;
    while (candidate >= 0) {
      const normal = builder.normalAt(candidate);
      if (normal[0] * nx + normal[1] * ny + normal[2] * nz >= sameNormalCosine) return candidate;
      last = candidate;
      candidate = this.nextOutput[candidate] ?? -1;
    }
    const index = builder.addVertex(px, py, pz, nx, ny, nz, u, v);
    this.nextOutput[index] = -1;
    if (last < 0) this.firstOutputByKey.set(key, index);
    else this.nextOutput[last] = index;
    return index;
  }
}

function normalizeInto(out: number[], x: number, y: number, z: number): void {
  const length = Math.hypot(x, y, z);
  if (length > 0) {
    out[0] = x / length;
    out[1] = y / length;
    out[2] = z / length;
  } else {
    out[0] = 0;
    out[1] = 1;
    out[2] = 0;
  }
}

/** The asset box: each mesh's own box carried through its node transform, as Model I/O bounds an asset. */
function assetBounds(meshes: readonly { localTransform: Mat4; minimum: readonly number[]; maximum: readonly number[] }[]): { minimum: Vec3; maximum: Vec3 } {
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  const corner = [0, 0, 0, 0];
  for (const mesh of meshes) {
    for (let index = 0; index < 8; index++) {
      mat4TransformInto(
        corner,
        mesh.localTransform,
        (index & 1) === 0 ? mesh.minimum[0]! : mesh.maximum[0]!,
        (index & 2) === 0 ? mesh.minimum[1]! : mesh.maximum[1]!,
        (index & 4) === 0 ? mesh.minimum[2]! : mesh.maximum[2]!,
        1,
      );
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis]!, corner[axis]!);
        maximum[axis] = Math.max(maximum[axis]!, corner[axis]!);
      }
    }
  }
  return { minimum: [minimum[0]!, minimum[1]!, minimum[2]!], maximum: [maximum[0]!, maximum[1]!, maximum[2]!] };
}

// MARK: - URIs

/** The bytes and media type of a `data:` URI, null for any other URI. */
function decodeDataURI(uri: string): { bytes: ArrayBuffer; mimeType: string | undefined } | null {
  if (!uri.startsWith("data:")) return null;
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  const header = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const parameters = header.split(";");
  const mimeType = parameters[0]!.trim() === "" ? undefined : parameters[0]!.trim().toLowerCase();
  if (parameters.slice(1).some((parameter) => parameter.trim().toLowerCase() === "base64")) {
    const binary = atob(payload.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return { bytes: bytes.buffer, mimeType };
  }
  const bytes = new TextEncoder().encode(decodeURIComponent(payload));
  return { bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), mimeType };
}

const imageMimeTypesByExtension: Readonly<Record<string, string>> = Object.freeze({
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
  bmp: "image/bmp",
  ktx2: "image/ktx2",
});

function imageMimeTypeOfURL(url: string): string | undefined {
  const path = url.split(/[?#]/, 1)[0]!;
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot < path.lastIndexOf("/")) return undefined;
  return imageMimeTypesByExtension[path.slice(dot + 1).toLowerCase()];
}

/** Reads a URI of the asset: a `data:` URI in place, anything else through `io` relative to `baseURL`. */
async function readURI<Image>(uri: string, baseURL: string, io: SceneModelAssetIO<Image>): Promise<{ bytes: ArrayBuffer; mimeType: string | undefined; url: string }> {
  const data = decodeDataURI(uri);
  if (data !== null) return { ...data, url: baseURL };
  const url = new URL(uri, baseURL).href;
  return { bytes: await io.fetchBytes(url), mimeType: imageMimeTypeOfURL(url), url };
}

async function decodeImageOrNull<Image>(io: SceneModelAssetIO<Image>, read: () => Promise<{ bytes: ArrayBuffer; mimeType: string | undefined }>): Promise<Image | null> {
  // A picture that does not read or decode leaves the material untextured,
  // as a texture Model I/O cannot load does in Swift.
  try {
    const { bytes, mimeType } = await read();
    return await io.decodeImage(bytes, mimeType);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const white = Object.freeze([1, 1, 1, 1] as const);

// MARK: - glTF

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}

interface GltfTextureInfo {
  index: number;
  texCoord?: number;
}

interface GltfMaterial {
  pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: GltfTextureInfo };
}

interface GltfNode {
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfImage {
  uri?: string;
  mimeType?: string;
  bufferView?: number;
}

interface GltfTexture {
  source?: number;
  extensions?: Record<string, { source?: number } | undefined>;
}

interface GltfDocument {
  asset?: { version?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives?: GltfPrimitive[] }[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: { uri?: string; byteLength: number }[];
  materials?: GltfMaterial[];
  textures?: GltfTexture[];
  images?: GltfImage[];
  extensionsRequired?: string[];
}

const glbMagic = 0x46546c67;
const glbJSONChunk = 0x4e4f534a;
const glbBinaryChunk = 0x004e4942;

/** Required extensions the parser can honor: they only add data it reads, or refine shading it approximates. */
function isSupportedRequiredExtension(name: string): boolean {
  return (
    name === "KHR_mesh_quantization" ||
    name === "KHR_lights_punctual" ||
    name === "EXT_texture_webp" ||
    name === "EXT_texture_avif" ||
    name.startsWith("KHR_materials_")
  );
}

const componentCounts: Readonly<Record<string, number>> = Object.freeze({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 });

const componentSizes: Readonly<Record<number, number>> = Object.freeze({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 });

type ComponentReader = (view: DataView, offset: number) => number;

function componentReader(componentType: number, normalized: boolean): ComponentReader | null {
  switch (componentType) {
    case 5120:
      return normalized ? (view, offset) => Math.max(view.getInt8(offset) / 127, -1) : (view, offset) => view.getInt8(offset);
    case 5121:
      return normalized ? (view, offset) => view.getUint8(offset) / 255 : (view, offset) => view.getUint8(offset);
    case 5122:
      return normalized ? (view, offset) => Math.max(view.getInt16(offset, true) / 32767, -1) : (view, offset) => view.getInt16(offset, true);
    case 5123:
      return normalized ? (view, offset) => view.getUint16(offset, true) / 65535 : (view, offset) => view.getUint16(offset, true);
    case 5125:
      return (view, offset) => view.getUint32(offset, true);
    case 5126:
      return (view, offset) => view.getFloat32(offset, true);
    default:
      return null;
  }
}

class GltfReader<Image> {
  private readonly accessorCache = new Map<number, Float32Array>();

  constructor(
    readonly document: GltfDocument,
    private readonly buffers: readonly ArrayBuffer[],
    private readonly url: string,
    private readonly io: SceneModelAssetIO<Image>,
  ) {}

  fail(message: string): never {
    throw new SceneModelAssetLoadError("meshConversionFailed", this.url, message);
  }

  /** The bytes of a buffer view, checked against its buffer. */
  bufferView(index: number): { view: DataView; stride: number | undefined } {
    const bufferView = this.document.bufferViews?.[index];
    if (bufferView === undefined) this.fail(`bufferView ${index} is missing`);
    const buffer = this.buffers[bufferView.buffer];
    if (buffer === undefined) this.fail(`buffer ${bufferView.buffer} is missing`);
    const byteOffset = bufferView.byteOffset ?? 0;
    if (!(byteOffset >= 0) || !(bufferView.byteLength >= 0) || byteOffset + bufferView.byteLength > buffer.byteLength) this.fail(`bufferView ${index} is out of its buffer`);
    return { view: new DataView(buffer, byteOffset, bufferView.byteLength), stride: bufferView.byteStride };
  }

  /** An accessor's elements as floats, components per element `componentCount` (normalized integers already scaled). */
  accessor(index: number): { data: Float32Array; count: number; componentCount: number } {
    const accessor = this.document.accessors?.[index];
    if (accessor === undefined) this.fail(`accessor ${index} is missing`);
    const componentCount = componentCounts[accessor.type];
    if (componentCount === undefined) this.fail(`accessor ${index} has type ${accessor.type}`);
    const cached = this.accessorCache.get(index);
    if (cached !== undefined) return { data: cached, count: accessor.count, componentCount };

    const count = accessor.count;
    const data = new Float32Array(count * componentCount);
    const normalized = accessor.normalized ?? false;
    const read = componentReader(accessor.componentType, normalized);
    const componentSize = componentSizes[accessor.componentType];
    if (read === null || componentSize === undefined) this.fail(`accessor ${index} has component type ${accessor.componentType}`);

    if (accessor.bufferView !== undefined) {
      const { view, stride } = this.bufferView(accessor.bufferView);
      const elementSize = componentSize * componentCount;
      const byteStride = stride ?? elementSize;
      const start = accessor.byteOffset ?? 0;
      if (count > 0 && start + byteStride * (count - 1) + elementSize > view.byteLength) this.fail(`accessor ${index} is out of its bufferView`);
      if (accessor.componentType === 5126 && byteStride === elementSize && (view.byteOffset + start) % 4 === 0) {
        data.set(new Float32Array(view.buffer, view.byteOffset + start, count * componentCount));
      } else {
        for (let element = 0; element < count; element++) {
          const base = start + element * byteStride;
          for (let component = 0; component < componentCount; component++) {
            data[element * componentCount + component] = read(view, base + component * componentSize);
          }
        }
      }
    }

    const sparse = accessor.sparse;
    if (sparse !== undefined) {
      const indices = this.readIntegers(sparse.indices.bufferView, sparse.indices.byteOffset ?? 0, sparse.indices.componentType, sparse.count);
      const { view } = this.bufferView(sparse.values.bufferView);
      const valuesStart = sparse.values.byteOffset ?? 0;
      const elementSize = componentSize * componentCount;
      if (valuesStart + elementSize * sparse.count > view.byteLength) this.fail(`accessor ${index} has sparse values out of range`);
      for (let entry = 0; entry < sparse.count; entry++) {
        const target = indices[entry]!;
        if (target >= count) this.fail(`accessor ${index} has a sparse index out of range`);
        for (let component = 0; component < componentCount; component++) {
          data[target * componentCount + component] = read(view, valuesStart + entry * elementSize + component * componentSize);
        }
      }
    }

    this.accessorCache.set(index, data);
    return { data, count, componentCount };
  }

  /** Unsigned integers of a tightly packed run (indices, sparse indices). */
  readIntegers(bufferViewIndex: number, byteOffset: number, componentType: number, count: number): Uint32Array {
    const { view } = this.bufferView(bufferViewIndex);
    const size = componentType === 5121 ? 1 : componentType === 5123 ? 2 : componentType === 5125 ? 4 : 0;
    if (size === 0) this.fail(`index component type ${componentType}`);
    if (byteOffset + size * count > view.byteLength) this.fail("indices out of their bufferView");
    const absolute = view.byteOffset + byteOffset;
    if (size === 1) return Uint32Array.from(new Uint8Array(view.buffer, absolute, count));
    if (size === 2 && absolute % 2 === 0) return Uint32Array.from(new Uint16Array(view.buffer, absolute, count));
    if (size === 4 && absolute % 4 === 0) return new Uint32Array(view.buffer.slice(absolute, absolute + count * 4));
    const result = new Uint32Array(count);
    for (let index = 0; index < count; index++) {
      result[index] = size === 2 ? view.getUint16(byteOffset + index * 2, true) : view.getUint32(byteOffset + index * 4, true);
    }
    return result;
  }

  /** A primitive's index accessor as a triangle list over its vertices. */
  triangleList(primitive: GltfPrimitive, vertexCount: number): Uint32Array {
    let indices: Uint32Array;
    if (primitive.indices === undefined) {
      indices = new Uint32Array(vertexCount);
      for (let index = 0; index < vertexCount; index++) indices[index] = index;
    } else {
      const accessor = this.document.accessors?.[primitive.indices];
      if (accessor === undefined) this.fail(`index accessor ${primitive.indices} is missing`);
      if (accessor.bufferView === undefined || accessor.sparse !== undefined) {
        indices = Uint32Array.from(this.accessor(primitive.indices).data);
      } else {
        indices = this.readIntegers(accessor.bufferView, accessor.byteOffset ?? 0, accessor.componentType, accessor.count);
      }
    }
    for (const index of indices) if (index >= vertexCount) this.fail("an index is out of the vertex range");

    const mode = primitive.mode ?? 4;
    if (mode === 4) return indices.length % 3 === 0 ? indices : indices.subarray(0, indices.length - (indices.length % 3));
    const triangleCount = Math.max(0, indices.length - 2);
    const list = new Uint32Array(triangleCount * 3);
    for (let triangle = 0; triangle < triangleCount; triangle++) {
      if (mode === 5) {
        // A strip alternates its winding: triangle i is {i, i + 1 + i % 2, i + 2 - i % 2}.
        const odd = triangle % 2;
        list[triangle * 3] = indices[triangle]!;
        list[triangle * 3 + 1] = indices[triangle + 1 + odd]!;
        list[triangle * 3 + 2] = indices[triangle + 2 - odd]!;
      } else {
        // A fan: triangle i is {i + 1, i + 2, 0}.
        list[triangle * 3] = indices[triangle + 1]!;
        list[triangle * 3 + 1] = indices[triangle + 2]!;
        list[triangle * 3 + 2] = indices[0]!;
      }
    }
    return list;
  }

  /** The texture coordinate set a material's base color reads. */
  baseColorTexCoord(materialIndex: number | undefined): number {
    if (materialIndex === undefined) return 0;
    return this.document.materials?.[materialIndex]?.pbrMetallicRoughness?.baseColorTexture?.texCoord ?? 0;
  }

  /** Converts a glTF mesh into the canonical layout, one submesh per triangle primitive. Null when it has no triangles. */
  convertMesh(meshIndex: number): MeshBuilder<number | undefined> | null {
    const mesh = this.document.meshes?.[meshIndex];
    if (mesh === undefined) this.fail(`mesh ${meshIndex} is missing`);
    const builder = new MeshBuilder<number | undefined>();
    const normal = [0, 0, 0];
    for (const primitive of mesh.primitives ?? []) {
      const mode = primitive.mode ?? 4;
      const positionAccessor = primitive.attributes.POSITION;
      if ((mode !== 4 && mode !== 5 && mode !== 6) || positionAccessor === undefined) continue;
      const positions = this.accessor(positionAccessor);
      if (positions.componentCount !== 3) this.fail("POSITION is not a VEC3");
      const vertexCount = positions.count;
      const triangles = this.triangleList(primitive, vertexCount);
      if (triangles.length === 0) continue;

      const normalAccessor = primitive.attributes.NORMAL;
      const normals = normalAccessor === undefined ? null : this.accessor(normalAccessor);
      if (normals !== null && (normals.componentCount !== 3 || normals.count < vertexCount)) this.fail("NORMAL does not match POSITION");
      const uvAccessor = primitive.attributes[`TEXCOORD_${this.baseColorTexCoord(primitive.material)}`];
      const uvs = uvAccessor === undefined ? null : this.accessor(uvAccessor);
      if (uvs !== null && (uvs.componentCount !== 2 || uvs.count < vertexCount)) this.fail("TEXCOORD does not match POSITION");

      const p = positions.data;
      builder.beginSubmesh(primitive.material);
      if (normals !== null) {
        const base = builder.vertexCount;
        for (let vertex = 0; vertex < vertexCount; vertex++) {
          normalizeInto(normal, normals.data[vertex * 3]!, normals.data[vertex * 3 + 1]!, normals.data[vertex * 3 + 2]!);
          builder.addVertex(
            p[vertex * 3]!,
            p[vertex * 3 + 1]!,
            p[vertex * 3 + 2]!,
            normal[0]!,
            normal[1]!,
            normal[2]!,
            uvs === null ? 0 : uvs.data[vertex * 2]!,
            uvs === null ? 0 : uvs.data[vertex * 2 + 1]!,
          );
        }
        for (const index of triangles) builder.indices.push(base + index);
      } else {
        const cornerNormals = generateCornerNormals(p, triangles);
        const emitter = new GeneratedNormalEmitter(builder);
        for (let corner = 0; corner < triangles.length; corner++) {
          const vertex = triangles[corner]!;
          builder.indices.push(
            emitter.emit(
              vertex,
              p[vertex * 3]!,
              p[vertex * 3 + 1]!,
              p[vertex * 3 + 2]!,
              cornerNormals[corner * 3]!,
              cornerNormals[corner * 3 + 1]!,
              cornerNormals[corner * 3 + 2]!,
              uvs === null ? 0 : uvs.data[vertex * 2]!,
              uvs === null ? 0 : uvs.data[vertex * 2 + 1]!,
            ),
          );
        }
      }
      builder.endSubmesh();
    }
    return builder.submeshes.length === 0 ? null : builder;
  }

  /** The image a texture shows: its own source, or a WebP or AVIF one of the extensions. */
  textureImageIndex(textureIndex: number): number | undefined {
    const texture = this.document.textures?.[textureIndex];
    if (texture === undefined) return undefined;
    return texture.source ?? texture.extensions?.EXT_texture_webp?.source ?? texture.extensions?.EXT_texture_avif?.source;
  }

  async decodeImage(imageIndex: number): Promise<Image | null> {
    const image = this.document.images?.[imageIndex];
    if (image === undefined) return null;
    return decodeImageOrNull(this.io, async () => {
      if (image.bufferView !== undefined) {
        const { view } = this.bufferView(image.bufferView);
        return { bytes: view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer, mimeType: image.mimeType };
      }
      if (image.uri === undefined) throw new Error(`image ${imageIndex} has no data`);
      const read = await readURI(image.uri, this.url, this.io);
      return { bytes: read.bytes, mimeType: image.mimeType ?? read.mimeType };
    });
  }
}

function parseGlbContainer(bytes: ArrayBuffer, url: string): { json: string; binary: ArrayBuffer | null } {
  const unreadable = (message: string): never => {
    throw new SceneModelAssetLoadError("unreadableAsset", url, message);
  };
  if (bytes.byteLength < 20) unreadable("too short for a GLB");
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== glbMagic) unreadable("not a GLB");
  if (view.getUint32(4, true) !== 2) unreadable(`GLB version ${view.getUint32(4, true)}`);
  const length = Math.min(view.getUint32(8, true), bytes.byteLength);
  let offset = 12;
  let json: string | null = null;
  let binary: ArrayBuffer | null = null;
  while (offset + 8 <= length) {
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + chunkLength > length) unreadable("a GLB chunk runs past the file");
    if (chunkType === glbJSONChunk && json === null) json = new TextDecoder().decode(new Uint8Array(bytes, start, chunkLength));
    else if (chunkType === glbBinaryChunk && binary === null) binary = bytes.slice(start, start + chunkLength);
    offset = start + chunkLength + ((4 - (chunkLength % 4)) % 4);
  }
  if (json === null) return unreadable("a GLB without a JSON chunk");
  return { json, binary };
}

function nodeMatrix(node: GltfNode): Mat4 {
  if (node.matrix !== undefined && node.matrix.length === 16) return Float64Array.from(node.matrix);
  const matrix = mat4Identity();
  const rotation = node.rotation;
  if (rotation !== undefined && rotation.length === 4) quatToMat4(matrix, [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!]);
  const scale = node.scale;
  if (scale !== undefined && scale.length === 3) {
    for (let column = 0; column < 3; column++) {
      for (let row = 0; row < 3; row++) matrix[column * 4 + row]! *= scale[column]!;
    }
  }
  const translation = node.translation;
  if (translation !== undefined && translation.length === 3) {
    matrix[12] = translation[0]!;
    matrix[13] = translation[1]!;
    matrix[14] = translation[2]!;
  }
  return matrix;
}

async function parseGltf<Image>(source: SceneModelAssetSource, io: SceneModelAssetIO<Image>): Promise<SceneModelAssetData<Image>> {
  const { url } = source;
  const isBinary = source.bytes.byteLength >= 4 && new DataView(source.bytes).getUint32(0, true) === glbMagic;
  if (source.format === "glb" && !isBinary) throw new SceneModelAssetLoadError("unreadableAsset", url, "not a GLB");
  const container = isBinary ? parseGlbContainer(source.bytes, url) : { json: new TextDecoder().decode(source.bytes), binary: null };

  let document: GltfDocument;
  try {
    document = JSON.parse(container.json.replace(/^﻿/, "")) as GltfDocument;
  } catch (error) {
    throw new SceneModelAssetLoadError("unreadableAsset", url, errorMessage(error));
  }
  if (typeof document !== "object" || document === null || !String(document.asset?.version ?? "").startsWith("2")) {
    throw new SceneModelAssetLoadError("unreadableAsset", url, `glTF version ${String(document?.asset?.version)}`);
  }
  for (const name of document.extensionsRequired ?? []) {
    if (!isSupportedRequiredExtension(name)) throw new SceneModelAssetLoadError("unsupportedFormat", `glTF extension ${name}`);
  }

  const buffers = await Promise.all(
    (document.buffers ?? []).map(async (buffer, index) => {
      if (buffer.uri === undefined) {
        if (index === 0 && container.binary !== null) return container.binary;
        throw new SceneModelAssetLoadError("unreadableAsset", url, `buffer ${index} has no data`);
      }
      try {
        return (await readURI(buffer.uri, url, io)).bytes;
      } catch (error) {
        throw new SceneModelAssetLoadError("unreadableAsset", url, `buffer ${index}: ${errorMessage(error)}`);
      }
    }),
  );
  const reader = new GltfReader(document, buffers, url, io);

  // The default scene, else the first, else every root node.
  const nodes = document.nodes ?? [];
  let roots: number[];
  const scene = document.scenes?.[document.scene ?? 0];
  if (scene !== undefined) {
    roots = scene.nodes ?? [];
  } else {
    const children = new Set(nodes.flatMap((node) => node.children ?? []));
    roots = nodes.map((_, index) => index).filter((index) => !children.has(index));
  }

  const converted = new Map<number, MeshBuilder<number | undefined> | null>();
  const instances: { builder: MeshBuilder<number | undefined>; localTransform: Mat4 }[] = [];
  const visit = (nodeIndex: number, parent: Mat4, path: Set<number>): void => {
    const node = nodes[nodeIndex];
    if (node === undefined || path.has(nodeIndex)) throw new SceneModelAssetLoadError("meshConversionFailed", url, `node ${nodeIndex} is missing or in a cycle`);
    const world = mat4Multiply(mat4Identity(), parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      if (!converted.has(node.mesh)) converted.set(node.mesh, reader.convertMesh(node.mesh));
      const builder = converted.get(node.mesh);
      if (builder !== null && builder !== undefined) instances.push({ builder, localTransform: world });
    }
    path.add(nodeIndex);
    for (const child of node.children ?? []) visit(child, world, path);
    path.delete(nodeIndex);
  };
  if (nodes.length === 0) {
    // Meshes without nodes: each at the origin.
    for (let meshIndex = 0; meshIndex < (document.meshes ?? []).length; meshIndex++) {
      const builder = reader.convertMesh(meshIndex);
      if (builder !== null) instances.push({ builder, localTransform: mat4Identity() });
    }
  } else {
    for (const root of roots) visit(root, mat4Identity(), new Set());
  }

  if (instances.length === 0) {
    const kind = (document.meshes ?? []).length === 0 ? "unreadableAsset" : "meshConversionFailed";
    throw new SceneModelAssetLoadError(kind, url, "no triangle geometry");
  }

  // Materials: each used one once, each picture decoded once.
  const imagePromises = new Map<number, Promise<Image | null>>();
  const materialPromises = new Map<number | undefined, Promise<SceneModelAssetMaterial<Image>>>();
  const resolveMaterial = async (materialIndex: number | undefined): Promise<SceneModelAssetMaterial<Image>> => {
    const material = materialIndex === undefined ? undefined : document.materials?.[materialIndex];
    const pbr = material?.pbrMetallicRoughness;
    const factor = pbr?.baseColorFactor;
    const baseColor: [number, number, number, number] =
      factor !== undefined && factor.length === 4 ? [factor[0]!, factor[1]!, factor[2]!, factor[3]!] : [white[0], white[1], white[2], white[3]];
    const textureIndex = pbr?.baseColorTexture?.index;
    const imageIndex = textureIndex === undefined ? undefined : reader.textureImageIndex(textureIndex);
    let baseColorImage: Image | null = null;
    if (imageIndex !== undefined) {
      let promise = imagePromises.get(imageIndex);
      if (promise === undefined) {
        promise = reader.decodeImage(imageIndex);
        imagePromises.set(imageIndex, promise);
      }
      baseColorImage = await promise;
    }
    return { baseColor, baseColorImage };
  };
  for (const { builder } of instances) {
    for (const submesh of builder.submeshes) {
      if (!materialPromises.has(submesh.material)) materialPromises.set(submesh.material, resolveMaterial(submesh.material));
    }
  }
  const materials = new Map<number | undefined, SceneModelAssetMaterial<Image>>();
  for (const [index, promise] of materialPromises) materials.set(index, await promise);

  const finished = new Map<MeshBuilder<number | undefined>, { vertices: Float32Array; indices: Uint32Array; submeshes: SceneModelAssetSubmesh<Image>[] }>();
  const meshes: SceneModelAssetMesh<Image>[] = instances.map(({ builder, localTransform }) => {
    let arrays = finished.get(builder);
    if (arrays === undefined) {
      arrays = {
        vertices: builder.vertices.toArray(),
        indices: builder.indices.toArray(),
        submeshes: builder.submeshes.map((submesh) => ({ firstIndex: submesh.firstIndex, indexCount: submesh.indexCount, material: materials.get(submesh.material)! })),
      };
      finished.set(builder, arrays);
    }
    return { vertices: arrays.vertices, indices: arrays.indices, localTransform, submeshes: arrays.submeshes };
  });

  return {
    meshes,
    bounds: assetBounds(instances.map(({ builder, localTransform }) => ({ localTransform, minimum: builder.minimum, maximum: builder.maximum }))),
  };
}

// MARK: - OBJ

interface ObjMaterialDefinition {
  diffuse: [number, number, number] | null;
  alpha: number;
  diffuseMap: string | null;
  /** The MTL's URL, what `diffuseMap` resolves against. */
  baseURL: string;
}

/** The argument counts of the MTL texture options before a map's file name. `-o`, `-s` and `-t` take one to three numbers. */
const mtlOptionArguments: Readonly<Record<string, number>> = Object.freeze({
  "-blendu": 1,
  "-blendv": 1,
  "-bm": 1,
  "-boost": 1,
  "-cc": 1,
  "-clamp": 1,
  "-imfchan": 1,
  "-texres": 1,
  "-type": 1,
  "-mm": 2,
  "-o": 3,
  "-s": 3,
  "-t": 3,
});

/** The file name of a map statement's arguments, past its options. */
function mtlMapFileName(tokens: readonly string[]): string | null {
  let index = 0;
  while (index < tokens.length && tokens[index]!.startsWith("-")) {
    const option = tokens[index]!.toLowerCase();
    const count = mtlOptionArguments[option] ?? 0;
    index += 1;
    const variable = option === "-o" || option === "-s" || option === "-t";
    for (let argument = 0; argument < count && index < tokens.length; argument++) {
      if (variable && !Number.isFinite(Number(tokens[index]))) break;
      index += 1;
    }
  }
  const name = tokens.slice(index).join(" ");
  return name === "" ? null : name;
}

/** The logical lines of an OBJ or MTL: comments dropped, `\` continuations joined, tokens split. */
function* statements(text: string): Generator<string[]> {
  let pending = "";
  for (const rawLine of text.split(/\r\n|\n|\r/)) {
    const line = pending + rawLine;
    if (line.endsWith("\\")) {
      pending = line.slice(0, -1) + " ";
      continue;
    }
    pending = "";
    const hash = line.indexOf("#");
    const content = (hash >= 0 ? line.slice(0, hash) : line).trim();
    if (content !== "") yield content.split(/\s+/);
  }
}

function parseMtl(text: string, baseURL: string, into: Map<string, ObjMaterialDefinition>): void {
  let current: ObjMaterialDefinition | null = null;
  for (const tokens of statements(text)) {
    const keyword = tokens[0]!;
    if (keyword === "newmtl") {
      current = { diffuse: null, alpha: 1, diffuseMap: null, baseURL };
      into.set(tokens.slice(1).join(" "), current);
      continue;
    }
    if (current === null) continue;
    switch (keyword) {
      case "Kd":
        if (tokens.length >= 4) current.diffuse = [Number(tokens[1]), Number(tokens[2]), Number(tokens[3])];
        break;
      case "d":
        current.alpha = Number(tokens[tokens.length - 1]);
        break;
      case "Tr":
        current.alpha = 1 - Number(tokens[tokens.length - 1]);
        break;
      case "map_Kd":
        current.diffuseMap = mtlMapFileName(tokens.slice(1));
        break;
      default:
        break;
    }
  }
}

async function parseObj<Image>(source: SceneModelAssetSource, io: SceneModelAssetIO<Image>): Promise<SceneModelAssetData<Image>> {
  const { url } = source;
  const fail = (message: string): never => {
    throw new SceneModelAssetLoadError("meshConversionFailed", url, message);
  };
  const text = new TextDecoder().decode(source.bytes);

  const positions: number[] = [];
  const texCoords: number[] = [];
  const normals: number[] = [];
  const materialLibraries: string[] = [];
  const materialNames: (string | null)[] = [];
  const materialIdByName = new Map<string | null, number>();
  let currentMaterial = 0;
  materialNames.push(null);
  materialIdByName.set(null, 0);

  // Triangles as flat corner lists: position, texture and normal indices (-1 when absent).
  const cornerPositions: number[] = [];
  const cornerTexCoords: number[] = [];
  const cornerNormals: number[] = [];
  const triangleMaterials: number[] = [];

  const resolveIndex = (token: string | undefined, count: number, what: string): number => {
    if (token === undefined || token === "") return -1;
    const value = Number.parseInt(token, 10);
    if (!Number.isFinite(value) || value === 0) fail(`a face has ${what} index ${token}`);
    const index = value < 0 ? count + value : value - 1;
    if (index < 0 || index >= count) fail(`a face's ${what} index ${token} is out of range`);
    return index;
  };

  for (const tokens of statements(text)) {
    switch (tokens[0]) {
      case "v":
        positions.push(Number(tokens[1] ?? 0), Number(tokens[2] ?? 0), Number(tokens[3] ?? 0));
        break;
      case "vt":
        texCoords.push(Number(tokens[1] ?? 0), Number(tokens[2] ?? 0));
        break;
      case "vn":
        normals.push(Number(tokens[1] ?? 0), Number(tokens[2] ?? 0), Number(tokens[3] ?? 0));
        break;
      case "f": {
        const corners = tokens.slice(1).map((corner) => {
          const parts = corner.split("/");
          return [
            resolveIndex(parts[0], positions.length / 3, "position"),
            resolveIndex(parts[1], texCoords.length / 2, "texture"),
            resolveIndex(parts[2], normals.length / 3, "normal"),
          ] as const;
        });
        if (corners.some((corner) => corner[0] < 0)) fail("a face corner has no position");
        const hasNormals = corners.every((corner) => corner[2] >= 0);
        // Polygons fan from their first corner.
        for (let index = 1; index + 1 < corners.length; index++) {
          for (const corner of [corners[0]!, corners[index]!, corners[index + 1]!]) {
            cornerPositions.push(corner[0]);
            cornerTexCoords.push(corner[1]);
            cornerNormals.push(hasNormals ? corner[2] : -1);
          }
          triangleMaterials.push(currentMaterial);
        }
        break;
      }
      case "usemtl": {
        const name = tokens.slice(1).join(" ");
        let id = materialIdByName.get(name);
        if (id === undefined) {
          id = materialNames.length;
          materialNames.push(name);
          materialIdByName.set(name, id);
        }
        currentMaterial = id;
        break;
      }
      case "mtllib":
        materialLibraries.push(...tokens.slice(1));
        break;
      default:
        break;
    }
  }

  if (triangleMaterials.length === 0) throw new SceneModelAssetLoadError("unreadableAsset", url, "no faces");

  // Generated normals for the triangles without their own, over all of them at once so smoothing crosses materials.
  const generatedTriangles: number[] = [];
  for (let triangle = 0; triangle < triangleMaterials.length; triangle++) {
    if (cornerNormals[triangle * 3]! < 0) generatedTriangles.push(triangle);
  }
  const generatedCorners = new Uint32Array(generatedTriangles.length * 3);
  generatedTriangles.forEach((triangle, slot) => {
    for (let corner = 0; corner < 3; corner++) generatedCorners[slot * 3 + corner] = cornerPositions[triangle * 3 + corner]!;
  });
  const generated = generateCornerNormals(positions, generatedCorners);
  const generatedSlotOfTriangle = new Int32Array(triangleMaterials.length).fill(-1);
  generatedTriangles.forEach((triangle, slot) => (generatedSlotOfTriangle[triangle] = slot));

  // One submesh per material, in the order of first use.
  const builder = new MeshBuilder<number>();
  const authoredVertexIds = new Map<string, number>();
  const emitter = new GeneratedNormalEmitter(builder);
  const normal = [0, 0, 0];
  const usedMaterials = [...new Set(triangleMaterials)];
  for (const material of usedMaterials) {
    builder.beginSubmesh(material);
    for (let triangle = 0; triangle < triangleMaterials.length; triangle++) {
      if (triangleMaterials[triangle] !== material) continue;
      const slot = generatedSlotOfTriangle[triangle]!;
      for (let corner = 0; corner < 3; corner++) {
        const cornerIndex = triangle * 3 + corner;
        const p = cornerPositions[cornerIndex]!;
        const t = cornerTexCoords[cornerIndex]!;
        const n = cornerNormals[cornerIndex]!;
        const px = positions[p * 3]!;
        const py = positions[p * 3 + 1]!;
        const pz = positions[p * 3 + 2]!;
        // OBJ puts the V origin at the bottom of the picture: flipped to the top-left origin.
        const u = t < 0 ? 0 : texCoords[t * 2]!;
        const v = t < 0 ? 0 : 1 - texCoords[t * 2 + 1]!;
        if (slot < 0) {
          const key = `${p}/${t}/${n}`;
          let id = authoredVertexIds.get(key);
          if (id === undefined) {
            normalizeInto(normal, normals[n * 3]!, normals[n * 3 + 1]!, normals[n * 3 + 2]!);
            id = builder.addVertex(px, py, pz, normal[0]!, normal[1]!, normal[2]!, u, v);
            authoredVertexIds.set(key, id);
          }
          builder.indices.push(id);
        } else {
          const g = (slot * 3 + corner) * 3;
          builder.indices.push(emitter.emit(`${p}/${t}`, px, py, pz, generated[g]!, generated[g + 1]!, generated[g + 2]!, u, v));
        }
      }
    }
    builder.endSubmesh();
  }

  // The material libraries: one that does not read leaves its materials white, as Model I/O loads the geometry alone.
  const definitions = new Map<string, ObjMaterialDefinition>();
  const libraries = await Promise.all(
    materialLibraries.map(async (library) => {
      try {
        const read = await readURI(library, url, io);
        return { text: new TextDecoder().decode(read.bytes), url: read.url };
      } catch {
        return null;
      }
    }),
  );
  for (const library of libraries) if (library !== null) parseMtl(library.text, library.url, definitions);

  const imagePromises = new Map<string, Promise<Image | null>>();
  const materials = await Promise.all(
    usedMaterials.map(async (materialId): Promise<SceneModelAssetMaterial<Image>> => {
      const name = materialNames[materialId] ?? null;
      const definition = name === null ? undefined : definitions.get(name);
      if (definition === undefined) return { baseColor: [white[0], white[1], white[2], white[3]], baseColorImage: null };
      const alpha = Number.isFinite(definition.alpha) ? Math.min(Math.max(definition.alpha, 0), 1) : 1;
      let image: Image | null = null;
      if (definition.diffuseMap !== null) {
        const imageURL = new URL(definition.diffuseMap.replace(/\\/g, "/"), definition.baseURL).href;
        let promise = imagePromises.get(imageURL);
        if (promise === undefined) {
          promise = decodeImageOrNull(io, async () => ({ bytes: await io.fetchBytes(imageURL), mimeType: imageMimeTypeOfURL(imageURL) }));
          imagePromises.set(imageURL, promise);
        }
        image = await promise;
      }
      // As Model I/O reads an MTL: a map stands for the diffuse color, which
      // is not multiplied in, and a map that does not load leaves white.
      const diffuse = definition.diffuseMap === null && definition.diffuse !== null ? definition.diffuse : [1, 1, 1];
      return { baseColor: [diffuse[0]!, diffuse[1]!, diffuse[2]!, alpha], baseColorImage: image };
    }),
  );
  const materialById = new Map(usedMaterials.map((materialId, index) => [materialId, materials[index]!]));

  const localTransform = mat4Identity();
  return {
    meshes: [
      {
        vertices: builder.vertices.toArray(),
        indices: builder.indices.toArray(),
        localTransform,
        submeshes: builder.submeshes.map((submesh) => ({ firstIndex: submesh.firstIndex, indexCount: submesh.indexCount, material: materialById.get(submesh.material)! })),
      },
    ],
    bounds: assetBounds([{ localTransform, minimum: builder.minimum, maximum: builder.maximum }]),
  };
}
