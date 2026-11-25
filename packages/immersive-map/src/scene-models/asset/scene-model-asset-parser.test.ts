// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The Swift `SceneModelAssetLoaderTests` load an OBJ through Model I/O. Here
// the same checks, and the glTF and GLB reading Model I/O has no counterpart
// for, run on in-memory assets through an injected I/O: no DOM, no network.

import { describe, expect, test } from "vitest";
import towerSource from "../../../../../apps/e2e-app/public/models/test-tower.gltf?raw";
import { mat4TransformVec4 } from "../../math/matrix.ts";
import { makeSceneModelBounds } from "../scene-model-bounds.ts";
import { type SceneModelAssetData, type SceneModelAssetIO, SceneModelAssetLoadError, type SceneModelAssetMesh, sceneModelAssetGeometryBytes, SceneModelVertexLayout } from "./scene-model-asset-data.ts";
import { generateCornerNormals, loadSceneModelAsset, parseSceneModelAsset } from "./scene-model-asset-parser.ts";

// MARK: - Test I/O

interface TestImage {
  readonly width: number;
  readonly height: number;
  readonly image: { readonly label: string; readonly mimeType: string | undefined };
}

const encoder = new TextEncoder();

function bytesOf(text: string): ArrayBuffer {
  const bytes = encoder.encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

/** Pictures are "decoded" to the text they hold, so a test can tell which one a material got. A PNG reports its header's size. */
function makeIO(files: Record<string, ArrayBuffer | string> = {}): SceneModelAssetIO<TestImage> & { readonly fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    async fetchBytes(url) {
      fetched.push(url);
      const file = files[url];
      if (file === undefined) throw new Error(`404 ${url}`);
      return typeof file === "string" ? bytesOf(file) : file;
    },
    async decodeImage(bytes, mimeType) {
      const view = new Uint8Array(bytes);
      if (view.length >= 24 && view[0] === 0x89 && view[1] === 0x50) {
        const data = new DataView(bytes);
        return { width: data.getUint32(16), height: data.getUint32(20), image: { label: "png", mimeType } };
      }
      const label = new TextDecoder().decode(view);
      if (label === "broken") throw new Error("undecodable");
      return { width: 1, height: 1, image: { label, mimeType } };
    },
  };
}

// MARK: - Assertions

function expectClose(actual: number, expected: number, accuracy = 1e-6): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

function vertex(mesh: SceneModelAssetMesh<unknown>, index: number): { position: number[]; normal: number[]; uv: number[] } {
  const base = index * SceneModelVertexLayout.floatsPerVertex;
  const v = mesh.vertices;
  return { position: [v[base]!, v[base + 1]!, v[base + 2]!], normal: [v[base + 3]!, v[base + 4]!, v[base + 5]!], uv: [v[base + 6]!, v[base + 7]!] };
}

function vertexCount(mesh: SceneModelAssetMesh<unknown>): number {
  return mesh.vertices.length / SceneModelVertexLayout.floatsPerVertex;
}

/** Every triangle's winding agrees with its vertices' normals (counter-clockwise front faces). */
function expectWindingMatchesNormals(mesh: SceneModelAssetMesh<unknown>): void {
  for (let triangle = 0; triangle < mesh.indices.length / 3; triangle++) {
    const [a, b, c] = [0, 1, 2].map((corner) => vertex(mesh, mesh.indices[triangle * 3 + corner]!));
    const e1 = [0, 1, 2].map((axis) => b!.position[axis]! - a!.position[axis]!);
    const e2 = [0, 1, 2].map((axis) => c!.position[axis]! - a!.position[axis]!);
    const face = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
    const agreement = face[0]! * a!.normal[0]! + face[1]! * a!.normal[1]! + face[2]! * a!.normal[2]!;
    expect(agreement, `triangle ${triangle}`).toBeGreaterThan(0);
  }
}

async function expectLoadError(promise: Promise<unknown>, kind: SceneModelAssetLoadError["kind"]): Promise<SceneModelAssetLoadError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(SceneModelAssetLoadError);
  expect((error as SceneModelAssetLoadError).kind).toBe(kind);
  return error as SceneModelAssetLoadError;
}

// MARK: - glTF builder

type TypedArray = Float32Array | Uint32Array | Uint16Array | Uint8Array | Int16Array | Int8Array;

const componentTypes = new Map<Function, number>([
  [Int8Array, 5120],
  [Uint8Array, 5121],
  [Int16Array, 5122],
  [Uint16Array, 5123],
  [Uint32Array, 5125],
  [Float32Array, 5126],
]);

/** Builds a glTF document and its one binary buffer, written out as `.gltf` with a `data:` URI or as `.glb`. */
class TestGltf {
  readonly json: {
    asset: { version: string };
    buffers: unknown[];
    bufferViews: unknown[];
    accessors: unknown[];
    meshes: unknown[];
    nodes: unknown[];
    scenes: unknown[];
    materials: unknown[];
    textures: unknown[];
    images: unknown[];
    [key: string]: unknown;
  } = {
    asset: { version: "2.0" },
    buffers: [],
    bufferViews: [],
    accessors: [],
    meshes: [],
    nodes: [],
    scenes: [],
    materials: [],
    textures: [],
    images: [],
  };
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  view(bytes: Uint8Array, byteStride?: number): number {
    const padding = (4 - (this.length % 4)) % 4;
    if (padding > 0) {
      this.chunks.push(new Uint8Array(padding));
      this.length += padding;
    }
    const index = this.json.bufferViews.length;
    this.json.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength, ...(byteStride === undefined ? {} : { byteStride }) });
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    return index;
  }

  accessor(array: TypedArray, type: string, extra: Record<string, unknown> = {}): number {
    const bufferView = this.view(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type]!;
    const index = this.json.accessors.length;
    this.json.accessors.push({ bufferView, componentType: componentTypes.get(array.constructor)!, count: array.length / components, type, ...extra });
    return index;
  }

  mesh(primitives: Record<string, unknown>[]): number {
    this.json.meshes.push({ primitives });
    return this.json.meshes.length - 1;
  }

  node(node: Record<string, unknown>): number {
    this.json.nodes.push(node);
    return this.json.nodes.length - 1;
  }

  binary(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  toGltf(bufferURI?: string): ArrayBuffer {
    const bin = this.binary();
    const uri = bufferURI ?? `data:application/octet-stream;base64,${btoa(String.fromCharCode(...bin))}`;
    return bytesOf(JSON.stringify({ ...this.json, buffers: [{ byteLength: bin.byteLength, uri }] }));
  }

  toGlb(): ArrayBuffer {
    const bin = this.binary();
    const json = encoder.encode(JSON.stringify({ ...this.json, buffers: [{ byteLength: bin.byteLength }] }));
    const jsonLength = Math.ceil(json.byteLength / 4) * 4;
    const binLength = Math.ceil(bin.byteLength / 4) * 4;
    const total = 12 + 8 + jsonLength + 8 + binLength;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x46546c67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, 0x4e4f534a, true);
    out.fill(0x20, 20, 20 + jsonLength);
    out.set(json, 20);
    view.setUint32(20 + jsonLength, binLength, true);
    view.setUint32(24 + jsonLength, 0x004e4942, true);
    out.set(bin, 28 + jsonLength);
    return out.buffer;
  }
}

/** A unit quad in the XY plane facing +Z: two triangles, four vertices. */
function addQuad(gltf: TestGltf, options: { normals?: boolean; uvs?: boolean; material?: number } = {}): Record<string, unknown> {
  const attributes: Record<string, number> = { POSITION: gltf.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), "VEC3") };
  if (options.normals ?? true) attributes.NORMAL = gltf.accessor(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), "VEC3");
  if (options.uvs ?? true) attributes.TEXCOORD_0 = gltf.accessor(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), "VEC2");
  return { attributes, indices: gltf.accessor(new Uint16Array([0, 1, 2, 0, 2, 3]), "SCALAR"), ...(options.material === undefined ? {} : { material: options.material }) };
}

const assetURL = "https://example.test/assets/model.gltf";

// MARK: - OBJ

/** A 2x2x2 cube around the origin without normals: exercises the generated normals and gives exact bounds (the Swift test's cube). */
const cubeOBJ = `
v -1 -1 -1
v 1 -1 -1
v 1 1 -1
v -1 1 -1
v -1 -1 1
v 1 -1 1
v 1 1 1
v -1 1 1
f 1 3 2
f 1 4 3
f 5 6 7
f 5 7 8
f 1 2 6
f 1 6 5
f 2 3 7
f 2 7 6
f 3 4 8
f 3 8 7
f 4 1 5
f 4 5 8
`;

describe("OBJ", () => {
  test("a cube loads with bounds, a material and the canonical layout", async () => {
    const data = await parseSceneModelAsset({ bytes: bytesOf(cubeOBJ), url: "https://example.test/cube.obj", format: "obj" }, makeIO());
    expect(data.meshes).toHaveLength(1);
    const mesh = data.meshes[0]!;
    expect([...mesh.localTransform]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(mesh.submeshes).toHaveLength(1);
    expect(mesh.submeshes[0]).toMatchObject({ firstIndex: 0, indexCount: 36, material: { baseColor: [1, 1, 1, 1], baseColorImage: null } });
    expect(mesh.vertices.length % SceneModelVertexLayout.floatsPerVertex).toBe(0);

    const bounds = makeSceneModelBounds(data.bounds.minimum, data.bounds.maximum);
    expectClose(bounds.maxExtent, 2, 1e-4);
    expectClose(bounds.radius, Math.sqrt(3), 1e-3);
    expectClose(bounds.center[0], 0, 1e-4);
    expect(sceneModelAssetGeometryBytes(data)).toBeGreaterThan(0);
  });

  test("the cube's generated normals are faceted: its edges are creases", async () => {
    const data = await parseSceneModelAsset({ bytes: bytesOf(cubeOBJ), url: "https://example.test/cube.obj", format: "obj" }, makeIO());
    const mesh = data.meshes[0]!;
    // 90 degree edges are sharper than the 0.5 cosine threshold: each corner splits in three.
    expect(vertexCount(mesh)).toBe(24);
    for (let index = 0; index < vertexCount(mesh); index++) {
      const { normal } = vertex(mesh, index);
      expect(normal.map((component) => Math.abs(Math.round(component))).reduce((a, b) => a + b)).toBe(1);
    }
    expectWindingMatchesNormals(mesh);
  });

  test("relative indices, fanned polygons, authored normals and flipped V", async () => {
    const obj = `
v 0 0 0
v 2 0 0
v 2 2 0
v 0 2 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
vn 0 0 3
f -4/-4/-1 -3/-3/-1 -2/-2/-1 -1/-1/-1
`;
    const data = await parseSceneModelAsset({ bytes: bytesOf(obj), url: "https://example.test/quad.obj", format: "obj" }, makeIO());
    const mesh = data.meshes[0]!;
    expect([...mesh.indices]).toEqual([0, 1, 2, 0, 2, 3]);
    expect(vertex(mesh, 0)).toEqual({ position: [0, 0, 0], normal: [0, 0, 1], uv: [0, 1] });
    expect(vertex(mesh, 2).uv).toEqual([1, 0]);
    expect(data.bounds).toEqual({ minimum: [0, 0, 0], maximum: [2, 2, 0] });
  });

  test("usemtl runs group into one submesh per material, with the MTL's colors, alpha and maps", async () => {
    const obj = `
mtllib ../materials/look.mtl
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vt 0 0
vt 1 0
vt 1 1
usemtl red
f 1/1 2/2 3/3
usemtl textured
f 1/1 3/3 4/1
usemtl red
f 2/2 3/3 4/1
usemtl missing
f 1 2 4
`;
    const mtl = `
newmtl red
Kd 1 0 0
d 0.5
newmtl textured
Kd 0.2 0.2 0.2
Tr 0.25
map_Kd -s 1 1 1 -o 0.5 textures/brick wall.png
`;
    const io = makeIO({ "https://example.test/materials/look.mtl": mtl, "https://example.test/materials/textures/brick%20wall.png": "brick" });
    const data = await parseSceneModelAsset({ bytes: bytesOf(obj), url: "https://example.test/models/scene.obj", format: "obj" }, io);
    const submeshes = data.meshes[0]!.submeshes;
    expect(submeshes.map((submesh) => [submesh.firstIndex, submesh.indexCount])).toEqual([
      [0, 6],
      [6, 3],
      [9, 3],
    ]);
    expect(submeshes[0]!.material).toEqual({ baseColor: [1, 0, 0, 0.5], baseColorImage: null });
    // A map stands for the diffuse color, as Model I/O reads an MTL.
    expect(submeshes[1]!.material.baseColor).toEqual([1, 1, 1, 0.75]);
    expect(submeshes[1]!.material.baseColorImage?.image).toEqual({ label: "brick", mimeType: "image/png" });
    expect(submeshes[2]!.material).toEqual({ baseColor: [1, 1, 1, 1], baseColorImage: null });
  });

  test("a missing MTL or map leaves the materials white", async () => {
    const obj = "mtllib gone.mtl\nusemtl a\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n";
    const data = await parseSceneModelAsset({ bytes: bytesOf(obj), url: "https://example.test/a.obj", format: "obj" }, makeIO());
    expect(data.meshes[0]!.submeshes[0]!.material).toEqual({ baseColor: [1, 1, 1, 1], baseColorImage: null });

    const withBrokenMap = makeIO({ "https://example.test/gone.mtl": "newmtl a\nKd 0 1 0\nmap_Kd broken.png\n", "https://example.test/broken.png": "broken" });
    const broken = await parseSceneModelAsset({ bytes: bytesOf(obj), url: "https://example.test/a.obj", format: "obj" }, withBrokenMap);
    expect(broken.meshes[0]!.submeshes[0]!.material).toEqual({ baseColor: [1, 1, 1, 1], baseColorImage: null });
  });

  test("faces with and without normals mix in one mesh", async () => {
    const obj = "v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nvn 0 0 1\nf 1//1 2//1 3//1\nf 1 4 2\n";
    const data = await parseSceneModelAsset({ bytes: bytesOf(obj), url: "https://example.test/a.obj", format: "obj" }, makeIO());
    const mesh = data.meshes[0]!;
    expect(vertexCount(mesh)).toBe(6);
    expect(vertex(mesh, 0).normal).toEqual([0, 0, 1]);
    // The generated face 1 4 2 lies in the XZ plane, wound to face +Y.
    expect(vertex(mesh, 3).normal.map((component) => Math.round(component))).toEqual([0, 1, 0]);
  });

  test("an OBJ without faces is unreadable, and an index out of range does not convert", async () => {
    await expectLoadError(parseSceneModelAsset({ bytes: bytesOf("v 0 0 0\n"), url: "https://example.test/a.obj", format: "obj" }, makeIO()), "unreadableAsset");
    await expectLoadError(parseSceneModelAsset({ bytes: bytesOf("v 0 0 0\nf 1 2 3\n"), url: "https://example.test/a.obj", format: "obj" }, makeIO()), "meshConversionFailed");
  });
});

// MARK: - Errors and loading

describe("asset loading", () => {
  test("an unsupported format is a typed error", async () => {
    const error = await expectLoadError(
      parseSceneModelAsset({ bytes: new ArrayBuffer(0), url: "https://example.test/model.usdz", format: "usdz" as unknown as "obj" }, makeIO()),
      "unsupportedFormat",
    );
    expect(error.detail).toBe("usdz");
  });

  test("a file that does not read is unreadable", async () => {
    const error = await expectLoadError(loadSceneModelAsset("https://example.test/missing.obj", "obj", makeIO()), "unreadableAsset");
    expect(error.detail).toBe("https://example.test/missing.obj");
  });

  test("load fetches through the I/O and parses", async () => {
    const io = makeIO({ "https://example.test/cube.obj": cubeOBJ });
    const data = await loadSceneModelAsset("https://example.test/cube.obj", "obj", io);
    expect(data.meshes).toHaveLength(1);
    expect(io.fetched).toEqual(["https://example.test/cube.obj"]);
  });

  test("bytes that are not the format are unreadable", async () => {
    await expectLoadError(parseSceneModelAsset({ bytes: bytesOf("not json"), url: assetURL, format: "gltf" }, makeIO()), "unreadableAsset");
    await expectLoadError(parseSceneModelAsset({ bytes: bytesOf("glTF but not binary"), url: assetURL, format: "glb" }, makeIO()), "unreadableAsset");
    await expectLoadError(parseSceneModelAsset({ bytes: bytesOf('{"asset":{"version":"1.0"}}'), url: assetURL, format: "gltf" }, makeIO()), "unreadableAsset");
    await expectLoadError(parseSceneModelAsset({ bytes: bytesOf('{"asset":{"version":"2.0"}}'), url: assetURL, format: "gltf" }, makeIO()), "unreadableAsset");
  });

  test("the geometry cost counts shared buffers once", () => {
    const vertices = new Float32Array(16);
    const indices = new Uint32Array(6);
    const mesh = { vertices, indices, localTransform: new Float64Array(16), submeshes: [] };
    const data: SceneModelAssetData<null> = { meshes: [mesh, { ...mesh }], bounds: { minimum: [0, 0, 0], maximum: [1, 1, 1] } };
    expect(sceneModelAssetGeometryBytes(data)).toBe(16 * 4 + 6 * 4);
  });
});

// MARK: - glTF

describe("glTF", () => {
  test("a quad with data URIs passes its UVs through and reads its material", async () => {
    const gltf = new TestGltf();
    const pixel = "pixel";
    gltf.json.images.push({ uri: `data:image/png;base64,${btoa(pixel)}` });
    gltf.json.textures.push({ source: 0 });
    gltf.json.materials.push({ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 1, 0.8], baseColorTexture: { index: 0 } } });
    gltf.node({ mesh: gltf.mesh([addQuad(gltf, { material: 0 })]) });
    gltf.json.scenes.push({ nodes: [0] });

    const data = await parseSceneModelAsset({ bytes: gltf.toGltf(), url: assetURL, format: "gltf" }, makeIO());
    expect(data.meshes).toHaveLength(1);
    const mesh = data.meshes[0]!;
    expect(vertexCount(mesh)).toBe(4);
    expect([...mesh.indices]).toEqual([0, 1, 2, 0, 2, 3]);
    expect(vertex(mesh, 0)).toEqual({ position: [0, 0, 0], normal: [0, 0, 1], uv: [0, 1] });
    expect(mesh.submeshes).toEqual([{ firstIndex: 0, indexCount: 6, material: { baseColor: [0.5, 0.25, 1, 0.8], baseColorImage: { width: 1, height: 1, image: { label: "pixel", mimeType: "image/png" } } } }]);
    expect(data.bounds).toEqual({ minimum: [0, 0, 0], maximum: [1, 1, 0] });
  });

  test("the node hierarchy flattens TRS and matrices into each mesh's transform and the bounds", async () => {
    const gltf = new TestGltf();
    const quad = gltf.mesh([addQuad(gltf)]);
    // Child: turned 90 degrees about +Y and scaled by 2, under a parent moved by (10, 0, 0).
    const half = Math.SQRT1_2;
    const child = gltf.node({ mesh: quad, rotation: [0, half, 0, half], scale: [2, 2, 2] });
    gltf.node({ translation: [10, 0, 0], children: [child] });
    // A second instance placed by a matrix (translation 0, 5, 0).
    gltf.node({ mesh: quad, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1] });
    gltf.json.scenes.push({ nodes: [1, 2] });

    const data = await parseSceneModelAsset({ bytes: gltf.toGltf(), url: assetURL, format: "gltf" }, makeIO());
    expect(data.meshes).toHaveLength(2);
    const [first, second] = data.meshes as [SceneModelAssetMesh, SceneModelAssetMesh];
    // One mesh, two instances: the arrays are shared.
    expect(second.vertices).toBe(first.vertices);
    expect(second.indices).toBe(first.indices);

    const moved = mat4TransformVec4(first.localTransform, [1, 0, 0, 1]);
    // +X turned about +Y goes to -Z, scaled by 2, then moved by 10 on X.
    expectClose(moved[0], 10, 1e-9);
    expectClose(moved[2], -2, 1e-9);
    expect(second.localTransform[13]).toBe(5);

    expectClose(data.bounds.minimum[0], 0, 1e-9);
    expectClose(data.bounds.maximum[0], 10, 1e-9);
    expectClose(data.bounds.minimum[2], -2, 1e-9);
    expectClose(data.bounds.maximum[1], 6, 1e-9);
  });

  test("the default scene is the one the document names", async () => {
    const gltf = new TestGltf();
    const quad = gltf.mesh([addQuad(gltf)]);
    gltf.node({ mesh: quad, translation: [100, 0, 0] });
    gltf.node({ mesh: quad });
    gltf.json.scenes.push({ nodes: [0] }, { nodes: [1] });
    gltf.json.scene = 1;
    const data = await parseSceneModelAsset({ bytes: gltf.toGltf(), url: assetURL, format: "gltf" }, makeIO());
    expect(data.meshes).toHaveLength(1);
    expect(data.bounds.maximum[0]).toBe(1);
  });

  test("strips and fans become triangle lists, non-indexed geometry is indexed, and points are left out", async () => {
    const gltf = new TestGltf();
    const positions = gltf.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), "VEC3");
    const normals = gltf.accessor(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), "VEC3");
    const fanPositions = gltf.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), "VEC3");
    gltf.node({
      mesh: gltf.mesh([
        { attributes: { POSITION: positions, NORMAL: normals }, mode: 5 },
        { attributes: { POSITION: fanPositions, NORMAL: normals }, mode: 6 },
        { attributes: { POSITION: positions }, mode: 0 },
      ]),
    });
    gltf.json.scenes.push({ nodes: [0] });
    const data = await parseSceneModelAsset({ bytes: gltf.toGltf(), url: assetURL, format: "gltf" }, makeIO());
    const mesh = data.meshes[0]!;
    expect(mesh.submeshes.map((submesh) => [submesh.firstIndex, submesh.indexCount])).toEqual([
      [0, 6],
      [6, 6],
    ]);
    // The strip's triangle i is {i, i + 1 + i % 2, i + 2 - i % 2}: the odd one swaps to keep the winding.
    expect([...mesh.indices.subarray(0, 6)]).toEqual([0, 1, 2, 1, 3, 2]);
    // The fan's triangles are {1, 2, 0} and {2, 3, 0}, offset past the strip's 4 vertices.
    expect([...mesh.indices.subarray(6)]).toEqual([5, 6, 4, 6, 7, 4]);
    expectWindingMatchesNormals(mesh);
  });

  test("quantized and normalized attributes, an interleaved view and the right texture coordinate set", async () => {
    const gltf = new TestGltf();
    gltf.json.extensionsRequired = ["KHR_mesh_quantization"];
    gltf.json.extensionsUsed = ["KHR_mesh_quantization"];
    // Positions as plain i16 (quantized), normals as normalized i8.
    const positions = gltf.accessor(new Int16Array([0, 0, 0, 4, 0, 0, 4, 4, 0]), "VEC3");
    const normals = gltf.accessor(new Int8Array([0, 0, 127, 0, 0, 127, 0, 0, 127]), "VEC3", { normalized: true });
    // TEXCOORD_0 as floats and TEXCOORD_1 as normalized u8, interleaved with a stride of 4.
    const interleaved = new Uint8Array([0, 0, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0]);
    const view = gltf.view(interleaved, 4);
    gltf.json.accessors.push({ bufferView: view, byteOffset: 0, componentType: 5121, normalized: true, count: 3, type: "VEC2" });
    const uv1 = gltf.json.accessors.length - 1;
    const uv0 = gltf.accessor(new Float32Array([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]), "VEC2");
    gltf.json.materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1 } } });
    gltf.json.textures.push({ source: 0 });
    gltf.json.images.push({ uri: "textures/a.png" });
    gltf.node({ mesh: gltf.mesh([{ attributes: { POSITION: positions, NORMAL: normals, TEXCOORD_0: uv0, TEXCOORD_1: uv1 }, material: 0 }]) });
    gltf.json.scenes.push({ nodes: [0] });

    const io = makeIO({ "https://example.test/assets/textures/a.png": "a" });
    const data = await parseSceneModelAsset({ bytes: gltf.toGltf(), url: assetURL, format: "gltf" }, io);
    const mesh = data.meshes[0]!;
    expect(vertex(mesh, 1).position).toEqual([4, 0, 0]);
    expect(vertex(mesh, 1).normal).toEqual([0, 0, 1]);
    expect(vertex(mesh, 0).uv).toEqual([0, 0]);
    // The bytes between the elements are skipped by the stride.
    expect(vertex(mesh, 1).uv).toEqual([1, 0]);
    expect(vertex(mesh, 2).uv).toEqual([1, 1]);
    // The external image resolves against the asset's URL, with the media type of its extension.
    expect(mesh.submeshes[0]!.material.baseColorImage?.image).toEqual({ label: "a", mimeType: "image/png" });
    expect(mesh.submeshes[0]!.material.baseColor).toEqual([1, 1, 1, 1]);
  });

  test("sparse accessors override their base, with or without a buffer view", async () => {
    const gltf = new TestGltf();
    const base = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const sparseIndices = gltf.view(new Uint8Array(new Uint16Array([2, 0]).buffer));
    const sparseValues = gltf.view(new Uint8Array(new Float32Array([0, 7, 0, -1, 0, 0]).buffer));
    const sparse = { count: 2, indices: { bufferView: sparseIndices, componentType: 5123 }, values: { bufferView: sparseValues } };
    const withBase = gltf.accessor(base, "VEC3", { sparse });
    gltf.json.accessors.push({ componentType: 5126, count: 3, type: "VEC3", sparse });
    const withoutBase = gltf.json.accessors.length - 1;
    gltf.node({ mesh: gltf.mesh([{ attributes: { POSITION: withBase } }]) });
    gltf.node({ mesh: gltf.mesh([{ attributes: { POSITION: withoutBase } }]), translation: [0, 0, 5] });
    gltf.json.scenes.push({ nodes: [0, 1] });
    const data = await parseSceneModelAsset({ bytes: gltf.toGltf(), url: assetURL, format: "gltf" }, makeIO());
    const positions = (mesh: SceneModelAssetMesh<unknown>) => [0, 1, 2].map((index) => vertex(mesh, mesh.indices[index]!).position);
    expect(positions(data.meshes[0]!)).toEqual([
      [-1, 0, 0],
      [1, 0, 0],
      [0, 7, 0],
    ]);
    expect(positions(data.meshes[1]!)).toEqual([
      [-1, 0, 0],
      [0, 0, 0],
      [0, 7, 0],
    ]);
  });

  test("missing normals are generated and missing UVs are zero", async () => {
    const gltf = new TestGltf();
    gltf.node({ mesh: gltf.mesh([addQuad(gltf, { normals: false, uvs: false })]) });
    gltf.json.scenes.push({ nodes: [0] });
    const data = await parseSceneModelAsset({ bytes: gltf.toGltf(), url: assetURL, format: "gltf" }, makeIO());
    const mesh = data.meshes[0]!;
    // A flat quad stays one smooth surface: its four vertices are shared.
    expect(vertexCount(mesh)).toBe(4);
    for (let index = 0; index < 4; index++) {
      expect(vertex(mesh, index).normal).toEqual([0, 0, 1]);
      expect(vertex(mesh, index).uv).toEqual([0, 0]);
    }
  });

  test("a GLB reads its binary chunk and an image from a buffer view", async () => {
    const gltf = new TestGltf();
    const image = gltf.view(encoder.encode("embedded"));
    gltf.json.images.push({ bufferView: image, mimeType: "image/jpeg" });
    gltf.json.textures.push({ source: 0 });
    gltf.json.materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } });
    gltf.node({ mesh: gltf.mesh([addQuad(gltf, { material: 0 })]) });
    gltf.json.scenes.push({ nodes: [0] });
    const data = await parseSceneModelAsset({ bytes: gltf.toGlb(), url: "https://example.test/model.glb", format: "glb" }, makeIO());
    expect(vertexCount(data.meshes[0]!)).toBe(4);
    expect(data.meshes[0]!.submeshes[0]!.material.baseColorImage?.image).toEqual({ label: "embedded", mimeType: "image/jpeg" });
  });

  test("external buffers resolve against the asset's URL, and one that does not read is unreadable", async () => {
    const gltf = new TestGltf();
    gltf.node({ mesh: gltf.mesh([addQuad(gltf)]) });
    gltf.json.scenes.push({ nodes: [0] });
    const bin = gltf.binary();
    const io = makeIO({ "https://example.test/assets/bin/model.bin": bin.buffer.slice(0) as ArrayBuffer });
    const data = await parseSceneModelAsset({ bytes: gltf.toGltf("bin/model.bin"), url: assetURL, format: "gltf" }, io);
    expect(vertexCount(data.meshes[0]!)).toBe(4);
    expect(io.fetched).toEqual(["https://example.test/assets/bin/model.bin"]);
    await expectLoadError(parseSceneModelAsset({ bytes: gltf.toGltf("gone.bin"), url: assetURL, format: "gltf" }, makeIO()), "unreadableAsset");
  });

  test("a picture that does not decode leaves the material untextured", async () => {
    const gltf = new TestGltf();
    gltf.json.images.push({ uri: `data:image/png;base64,${btoa("broken")}` });
    gltf.json.textures.push({ source: 0 });
    gltf.json.materials.push({ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], baseColorTexture: { index: 0 } } });
    gltf.node({ mesh: gltf.mesh([addQuad(gltf, { material: 0 })]) });
    gltf.json.scenes.push({ nodes: [0] });
    const data = await parseSceneModelAsset({ bytes: gltf.toGltf(), url: assetURL, format: "gltf" }, makeIO());
    expect(data.meshes[0]!.submeshes[0]!.material).toEqual({ baseColor: [1, 0, 0, 1], baseColorImage: null });
  });

  test("a required extension the parser cannot honor is an unsupported format", async () => {
    const gltf = new TestGltf();
    gltf.json.extensionsRequired = ["KHR_draco_mesh_compression"];
    gltf.node({ mesh: gltf.mesh([addQuad(gltf)]) });
    gltf.json.scenes.push({ nodes: [0] });
    const error = await expectLoadError(parseSceneModelAsset({ bytes: gltf.toGltf(), url: assetURL, format: "gltf" }, makeIO()), "unsupportedFormat");
    expect(error.detail).toContain("KHR_draco_mesh_compression");
  });

  test("geometry without triangles or with indices out of range does not convert", async () => {
    const points = new TestGltf();
    points.node({ mesh: points.mesh([{ attributes: { POSITION: points.accessor(new Float32Array([0, 0, 0]), "VEC3") }, mode: 0 }]) });
    points.json.scenes.push({ nodes: [0] });
    await expectLoadError(parseSceneModelAsset({ bytes: points.toGltf(), url: assetURL, format: "gltf" }, makeIO()), "meshConversionFailed");

    const outOfRange = new TestGltf();
    const positions = outOfRange.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), "VEC3");
    outOfRange.node({ mesh: outOfRange.mesh([{ attributes: { POSITION: positions }, indices: outOfRange.accessor(new Uint16Array([0, 1, 9]), "SCALAR") }]) });
    outOfRange.json.scenes.push({ nodes: [0] });
    await expectLoadError(parseSceneModelAsset({ bytes: outOfRange.toGltf(), url: assetURL, format: "gltf" }, makeIO()), "meshConversionFailed");
  });

  test("the e2e app's test tower reads as a textured box standing on its origin", async () => {
    const url = "https://example.test/models/test-tower.gltf";
    const data = await parseSceneModelAsset({ bytes: bytesOf(towerSource), url, format: "gltf" }, makeIO());
    expect(data.meshes).toHaveLength(1);
    const mesh = data.meshes[0]!;
    expect(vertexCount(mesh)).toBe(24);
    expect(mesh.indices.length).toBe(36);
    expect(data.bounds).toEqual({ minimum: [-2, 0, -2], maximum: [2, 12, 2] });
    const material = mesh.submeshes[0]!.material;
    expect(material.baseColor).toEqual([1, 1, 1, 1]);
    expect(material.baseColorImage).toMatchObject({ width: 16, height: 16, image: { label: "png", mimeType: "image/png" } });
    expectWindingMatchesNormals(mesh);
  });
});

// MARK: - Generated normals

describe("generated normals", () => {
  /** Two triangles sharing the edge (0,0,0)-(1,0,0), the second folded up by `degrees` about it. */
  function fold(degrees: number): { positions: Float32Array; triangles: Uint32Array } {
    const radians = (degrees * Math.PI) / 180;
    return {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, -1, 0, 0, Math.cos(radians), Math.sin(radians)]),
      triangles: new Uint32Array([0, 2, 1, 0, 1, 3]),
    };
  }

  test("faces meeting at a gentle fold share a smooth normal", () => {
    const { positions, triangles } = fold(20);
    const normals = generateCornerNormals(positions, triangles);
    // The shared corners (0 of each triangle) agree, and lean between the two faces.
    expectClose(normals[0]!, normals[9]!, 1e-6);
    expectClose(normals[1]!, normals[10]!, 1e-6);
    expectClose(normals[2]!, normals[11]!, 1e-6);
    expect(Math.abs(normals[1]!)).toBeGreaterThan(0.05);
  });

  test("faces meeting at a sharp fold keep their own normals", () => {
    const { positions, triangles } = fold(90);
    const normals = generateCornerNormals(positions, triangles);
    expect([...normals.subarray(0, 3)].map(Math.round)).toEqual([0, 0, 1]);
    expect([...normals.subarray(9, 12)].map(Math.round)).toEqual([0, -1, 0]);
  });

  test("corners sharing a position under different indices smooth across the seam", () => {
    // The same gentle fold, with the shared edge duplicated (a UV seam).
    const radians = (20 * Math.PI) / 180;
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, Math.cos(radians), Math.sin(radians)]);
    const normals = generateCornerNormals(positions, new Uint32Array([0, 2, 1, 3, 4, 5]));
    expectClose(normals[0]!, normals[9]!, 1e-6);
    expectClose(normals[1]!, normals[10]!, 1e-6);
  });
});
