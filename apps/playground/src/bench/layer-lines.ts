// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// B18b: the lines of the app's layers drawn three ways, by the layers' own
// shader (layers.wgsl, imported raw, so the instance variant is what ships):
// - an instance per segment, as the layers draw (and as Swift does): the
//   segment's 24 bytes in the instance, its ten corners and eight triangles
//   placed by the vertex stage, the template's 24 indices shared;
// - a ribbon the worker triangulates (crates/bench-wasm, layer_ribbons.rs):
//   each corner a vertex of 24 bytes with both ends of its segment, u32
//   indices, no cap at a flat end;
// - the segments pulled from a storage buffer by the vertex index, a draw
//   of 24 vertices per segment and no instancing, the same 24 bytes a segment.
// The same look in all three: the width in points widened on screen, round
// ends as half octagons, the join the disc two round ends share. Measured
// on the flat map and on the resting sphere, for layers of 1k, 10k and 100k
// segments in polylines of 50 vertices (random walks over a 20 km view south of
// Moscow, about 15 pixels a segment) at widths of 2 and 8 points, 2 pixels
// a point: the GPU time of the pass (timestamp-query), the bytes of the
// lines' buffers, the worker's mesh build (the full Wasm call) and the main
// thread's upload, the two parts of an update of a layer's data.

import groundFog from "../../../../packages/immersive-map/src/ground-fog/shaders/ground-fog.wgsl?raw";
import { globeModuleSource } from "../../../../packages/immersive-map/src/globe/globe-shader-source.ts";
import { GlobeSurfaceTile } from "../../../../packages/immersive-map/src/globe/globe-frame-constants.ts";
import { LayerMeshFile, LayerMeshLayout } from "../../../../packages/immersive-map/src/layers/cache/layer-mesh-file.ts";
import { NO_STYLE } from "../../../../packages/immersive-map/src/layers/geojson/immersive-map-geojson.ts";
import { LAYER_LINE_TEMPLATE } from "../../../../packages/immersive-map/src/layers/layer-pipeline.ts";
import layersSource from "../../../../packages/immersive-map/src/layers/shaders/layers.wgsl?raw";
import initLayers, { buildMesh } from "../../../../packages/immersive-map/src/wasm/layer_wasm/layer_wasm.js";
import initBench, { buildLayerRibbonMesh } from "../../../../packages/immersive-map/src/wasm/bench_wasm/bench_wasm.js";
import { done, fail, publish, stat } from "./harness.ts";

const WIDTH = 2000;
const HEIGHT = 1250;
const PIXELS_PER_POINT = 2;
// South of Moscow, inside one chunk tile (the city centre lies on a chunk edge).
const CENTER = [37.62, 55.55] as const;
const HALF_LON = 0.1596;
const HALF_LAT = 0.0562;

/** The bench's two vertex stages, appended to layers.wgsl: they mirror layerLineVertex with the corner and the segment read another way. */
const BENCH_WGSL = /* wgsl */ `
struct BenchSegment { start: vec2f, end: vec2f, widthPoints: f32, color: u32 }
@group(1) @binding(1) var<storage, read> benchSegments: array<BenchSegment>;

const kBenchTemplate = array<u32, 24>(${LAYER_LINE_TEMPLATE.join(", ")});

fn benchLineCorner(startLocal: vec2f, endLocal: vec2f, widthPoints: f32, rgb: vec3f, cornerIndex: u32, roundFlags: u32, draw: LayerDraw) -> LayerLineOut {
    let start = layerProject(startLocal, draw);
    let end = layerProject(endLocal, draw);
    var startClip = start.position;
    var endClip = end.position;
    if (startClip.w < kLayerNearW && endClip.w > kLayerNearW) {
        startClip = mix(startClip, endClip, (kLayerNearW - startClip.w) / (endClip.w - startClip.w));
    } else if (endClip.w < kLayerNearW && startClip.w > kLayerNearW) {
        endClip = mix(endClip, startClip, (kLayerNearW - endClip.w) / (startClip.w - endClip.w));
    }
    let halfViewport = draw.screen.xy * 0.5;
    let startScreen = startClip.xy / max(startClip.w, kLayerNearW) * halfViewport;
    let endScreen = endClip.xy / max(endClip.w, kLayerNearW) * halfViewport;
    var direction = endScreen - startScreen;
    let length2 = dot(direction, direction);
    direction = select(vec2f(1.0, 0.0), direction * inverseSqrt(max(length2, 1.0e-30)), length2 > 1.0e-8);
    let normal = vec2f(-direction.y, direction.x);
    var corners = array<vec3f, 10>(
        vec3f(0.0, 0.0, -1.0), vec3f(0.0, 0.0, 1.0),
        vec3f(0.0, 0.70710678, -0.70710678), vec3f(0.0, 0.70710678, 0.70710678), vec3f(0.0, 1.0, 0.0),
        vec3f(1.0, 0.0, -1.0), vec3f(1.0, 0.0, 1.0),
        vec3f(1.0, 0.70710678, -0.70710678), vec3f(1.0, 0.70710678, 0.70710678), vec3f(1.0, 1.0, 0.0),
    );
    let corner = corners[min(cornerIndex, 9u)];
    let atEnd = corner.x > 0.5;
    let isRound = (roundFlags & select(1u, 2u, atEnd)) != 0u;
    let outward = select(0.0, corner.y, isRound);
    let halfWidthPx = widthPoints * draw.screen.z * 0.5;
    let offsetPx = (normal * corner.z + direction * select(-outward, outward, atEnd)) * halfWidthPx;
    var position = select(startClip, endClip, atEnd);
    position = vec4f(position.xy + offsetPx / halfViewport * position.w, position.zw);
    let behind = startClip.w < kLayerNearW && endClip.w < kLayerNearW;
    let clearance = select(select(start.clearance, end.clearance, atEnd), -1.0, behind);
    var out: LayerLineOut;
    out.position = position;
    out.cut[0] = clearance; // clip-distances
    out.cutClearance = clearance; // no-clip-distances
    out.worldPosition = select(start.worldPosition, end.worldPosition, atEnd);
    out.sphereNormal = select(start.sphereNormal, end.sphereNormal, atEnd);
    out.color = rgb;
    return out;
}

/// The ribbon's vertex: its corner in the colour's fourth byte. A cap
/// vertex exists only at a round end, so every corner is taken as round.
@vertex
fn benchRibbonVertex(in: LayerLineIn, @builtin(instance_index) record: u32) -> LayerLineOut {
    return benchLineCorner(in.start, in.end, in.widthPoints, vec3f(in.color.rgb) / 255.0, in.color.a, 3u, draws[record]);
}

/// The pulled segment's corner: the segment by the vertex index over 24, the corner by the template.
@vertex
fn benchPulledVertex(@builtin(vertex_index) vertexIndex: u32, @builtin(instance_index) record: u32) -> LayerLineOut {
    let segment = benchSegments[vertexIndex / 24u];
    let color = unpack4xU8(segment.color);
    return benchLineCorner(segment.start, segment.end, segment.widthPoints, vec3f(color.rgb) / 255.0, kBenchTemplate[vertexIndex % 24u], color.a, draws[record]);
}
`;

const lineAttributes: GPUVertexAttribute[] = [
  { shaderLocation: 0, offset: 0, format: "float32x2" },
  { shaderLocation: 1, offset: 8, format: "float32x2" },
  { shaderLocation: 2, offset: 16, format: "float32" },
  { shaderLocation: 3, offset: 20, format: "uint8x4" },
];

/** A layer's polylines: `segments` segments in random walks of 50 vertices over the view, as the flat arrays of a source. */
function layerSource(segments: number): { coordinates: Float64Array; polylines: Uint32Array } {
  let seed = 23;
  const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
  const coordinates: number[] = [];
  const polylines: number[] = [];
  const stepLon = 0.0024;
  const stepLat = stepLon * Math.cos((CENTER[1] * Math.PI) / 180);
  for (let left = segments; left > 0; ) {
    const count = Math.min(49, left);
    left -= count;
    polylines.push(coordinates.length / 2, count + 1, NO_STYLE);
    let lon = CENTER[0] + (rand() * 2 - 1) * HALF_LON;
    let lat = CENTER[1] + (rand() * 2 - 1) * HALF_LAT;
    let heading = rand() * Math.PI * 2;
    coordinates.push(lon, lat);
    for (let s = 0; s < count; s++) {
      heading += (rand() - 0.5) * 1.2;
      lon += Math.cos(heading) * stepLon;
      lat += Math.sin(heading) * stepLat;
      if (Math.abs(lon - CENTER[0]) > HALF_LON) heading = Math.PI - heading;
      if (Math.abs(lat - CENTER[1]) > HALF_LAT) heading = -heading;
      coordinates.push(lon, lat);
    }
  }
  return { coordinates: new Float64Array(coordinates), polylines: new Uint32Array(polylines) };
}

function layerStyles(widthPoints: number): Float32Array {
  const styles = new Float32Array(24);
  styles.set([0.1, 0.45, 0.95, 1], 9);
  styles[13] = widthPoints;
  return styles;
}

/** The Mercator world (x east, y south, 0 to 1) of a coordinate. */
function world(lon: number, lat: number): [number, number] {
  const phi = (lat * Math.PI) / 180;
  return [(lon + 180) / 360, (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2];
}

/** The unit earth direction of a world uv, globeWorldUVUnitDirection. */
function unitDirection(u: number, v: number): [number, number, number] {
  const x = Math.PI * (1 - 2 * v);
  const latitude = Math.atan(Math.sinh(x));
  const longitude = u * 2 * Math.PI - Math.PI;
  return [Math.cos(latitude) * Math.sin(longitude), Math.sin(latitude), Math.cos(latitude) * Math.cos(longitude)];
}

const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;

async function run() {
  await Promise.all([initLayers(), initBench()]);
  const adapter = (await navigator.gpu.requestAdapter())!;
  if (!adapter.features.has("timestamp-query")) throw new Error("B18b needs timestamp-query");
  const clipDistances = adapter.features.has("clip-distances");
  const device = await adapter.requestDevice({ requiredFeatures: clipDistances ? ["timestamp-query", "clip-distances"] : ["timestamp-query"] });
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  canvas.style.width = "50%";
  document.body.append(canvas);
  const context = canvas.getContext("webgpu")!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "opaque" });
  const depth = device.createTexture({ size: [WIDTH, HEIGHT], format: "depth24plus-stencil8", usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const querySet = device.createQuerySet({ type: "timestamp", count: 2 });
  const resolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

  const uniform = (size: number) => device.createBuffer({ size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const cameraBuffer = uniform(80);
  const fogBuffer = uniform(80);
  const globeBuffer = uniform(192);
  const drawBuffer = device.createBuffer({ size: 80, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const visibility = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const frameLayout = device.createBindGroupLayout({
    entries: [0, 2, 3].map((binding) => ({ binding, visibility, buffer: { type: "uniform" as const } })),
  });
  const drawLayout = device.createBindGroupLayout({
    entries: [0, 1].map((binding) => ({ binding, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" as const } })),
  });
  const frameGroup = device.createBindGroup({
    layout: frameLayout,
    entries: [
      { binding: 0, resource: { buffer: cameraBuffer } },
      { binding: 2, resource: { buffer: fogBuffer } },
      { binding: 3, resource: { buffer: globeBuffer } },
    ],
  });
  const module = device.createShaderModule({ code: globeModuleSource(clipDistances, [groundFog], layersSource + BENCH_WGSL) });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [frameLayout, drawLayout] });
  // The layers' line state: no blending, the stencil's surface mask test, no depth written.
  const stencil: GPUStencilFaceState = { compare: "equal", failOp: "keep", depthFailOp: "keep", passOp: "keep" };
  const pipeline = (surface: number, entryPoint: string, buffers: GPUVertexBufferLayout[]) =>
    device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint, constants: { kLayerSurface: surface }, buffers },
      fragment: { module, entryPoint: "layerLineFragment", constants: { kLayerSurface: surface }, targets: [{ format }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: { format: "depth24plus-stencil8", depthWriteEnabled: false, depthCompare: "always", stencilFront: stencil, stencilBack: stencil, stencilReadMask: 0x80, stencilWriteMask: 0 },
    });
  const pipelines = [0, 1].map((surface) => ({
    instanced: pipeline(surface, "layerLineVertex", [{ arrayStride: LayerMeshLayout.lineSegmentStride, stepMode: "instance", attributes: lineAttributes }]),
    ribbon: pipeline(surface, "benchRibbonVertex", [{ arrayStride: 24, stepMode: "vertex", attributes: lineAttributes }]),
    pulled: pipeline(surface, "benchPulledVertex", []),
  }));
  const template = new Uint16Array(LAYER_LINE_TEMPLATE);
  const templateBuffer = device.createBuffer({ size: template.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(templateBuffer, 0, template);
  const emptyStorage = device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE });

  const query = new URLSearchParams(location.search);
  const frames = Number(query.get("frames") ?? 120);
  const builds = Number(query.get("builds") ?? 30);
  const gpuRows: (string | number)[][] = [];
  const updateRows: (string | number)[][] = [];
  const raw: unknown[] = [];

  const upload = (bytes: Uint8Array, usage: number) => {
    const buffer = device.createBuffer({ size: Math.ceil(bytes.byteLength / 4) * 4, usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange()).set(bytes);
    buffer.unmap();
    return buffer;
  };

  /** The pass's GPU time over `frames` frames after ten of warm-up, a frame each. */
  const gpuTime = async (encode: (pass: GPURenderPassEncoder) => void) => {
    const gpu: number[] = [];
    for (let f = 0; f < frames + 10; f++) {
      await new Promise((r) => requestAnimationFrame(r));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0.95, g: 0.94, b: 0.92, a: 1 } }],
        depthStencilAttachment: { view: depth.createView(), depthLoadOp: "clear", depthStoreOp: "discard", depthClearValue: 1, stencilLoadOp: "clear", stencilStoreOp: "discard", stencilClearValue: 0 },
        timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
      });
      pass.setBindGroup(0, frameGroup);
      pass.setStencilReference(0);
      encode(pass);
      pass.end();
      encoder.resolveQuerySet(querySet, 0, 2, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, readback, 0, 16);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const [a, b] = new BigInt64Array(readback.getMappedRange());
      readback.unmap();
      if (f >= 10) gpu.push(Number(b! - a!) / 1e6);
    }
    return stat(gpu);
  };
  // The pass with nothing drawn: its clear of the target is in every row below.
  const empty = await gpuTime(() => {});
  gpuRows.push(["any", 0, 0, "empty pass", empty.median, empty.p95, "0"]);
  raw.push({ kind: "gpu", surface: "any", segments: 0, widthPoints: 0, variant: "empty pass", gpu: empty, bytes: 0 });

  for (const segments of [1_000, 10_000, 100_000]) {
    const source = layerSource(segments);
    const empty32 = new Uint32Array(0);
    const noStyles = new Float32Array(0);
    const build = (widthPoints: number) => buildMesh(source.coordinates, empty32, empty32, source.polylines, empty32, noStyles, layerStyles(widthPoints));
    const buildRibbon = (widthPoints: number) => buildLayerRibbonMesh(source.coordinates, empty32, empty32, source.polylines, empty32, noStyles, layerStyles(widthPoints));

    // The update of a layer's data: the worker's build, then the main thread's upload.
    const time = (body: () => unknown) => {
      const samples: number[] = [];
      for (let i = 0; i < builds + 3; i++) {
        const start = performance.now();
        body();
        if (i >= 3) samples.push(performance.now() - start);
      }
      return stat(samples);
    };
    const fileOf = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const instancedFile = fileOf(build(2));
    const contents = LayerMeshFile.decode(instancedFile)!;
    if (contents.chunks.length !== 1) throw new Error(`the layer spans ${contents.chunks.length} chunks, the bench draws one`);
    const chunk = contents.chunks[0]!;
    const segmentBytes = new Uint8Array(instancedFile, contents.lineSegments.offset, contents.lineSegments.size);
    const ribbonOut = buildRibbon(2);
    const header = new DataView(ribbonOut.buffer, ribbonOut.byteOffset, 12);
    const [fileSize, vertexBytes, indexCount] = [header.getUint32(0, true), header.getUint32(4, true), header.getUint32(8, true)];
    const ribbonVertices = ribbonOut.slice(12 + fileSize, 12 + fileSize + vertexBytes);
    const ribbonIndices = ribbonOut.slice(12 + fileSize + vertexBytes, 12 + fileSize + vertexBytes + indexCount * 4);
    if (contents.chunks[0]!.lineCount !== segments) throw new Error(`built ${contents.chunks[0]!.lineCount} segments of ${segments}`);

    const buildInstanced = time(() => build(2));
    const buildRibbons = time(() => buildRibbon(2));
    const uploadInstanced = time(() => upload(segmentBytes, GPUBufferUsage.VERTEX).destroy());
    const uploadRibbons = time(() => {
      upload(ribbonVertices, GPUBufferUsage.VERTEX).destroy();
      upload(ribbonIndices, GPUBufferUsage.INDEX).destroy();
    });
    const uploadPulled = time(() => upload(segmentBytes, GPUBufferUsage.STORAGE).destroy());
    const ribbonBytes = ribbonVertices.byteLength + ribbonIndices.byteLength;
    for (const [variant, bytes, worker, main] of [
      ["instance per segment", segmentBytes.byteLength, buildInstanced, uploadInstanced],
      ["triangulated ribbon", ribbonBytes, buildRibbons, uploadRibbons],
      ["pulled from storage", segmentBytes.byteLength, buildInstanced, uploadPulled],
    ] as const) {
      updateRows.push([segments, variant, (bytes / 1e6).toFixed(3), worker.median, worker.p95, main.median, main.p95, worker.median + main.median]);
      raw.push({ kind: "update", segments, variant, bytes, build: worker, upload: main });
    }

    const segmentVertex = upload(segmentBytes, GPUBufferUsage.VERTEX);
    const segmentStorage = upload(segmentBytes, GPUBufferUsage.STORAGE);
    const ribbonVertex = upload(ribbonVertices, GPUBufferUsage.VERTEX);
    const ribbonIndex = upload(ribbonIndices, GPUBufferUsage.INDEX);
    const drawGroup = (pulled: boolean) =>
      device.createBindGroup({
        layout: drawLayout,
        entries: [
          { binding: 0, resource: { buffer: drawBuffer } },
          { binding: 1, resource: { buffer: pulled ? segmentStorage : emptyStorage } },
        ],
      });
    const plainGroup = drawGroup(false);
    const pulledGroup = drawGroup(true);

    for (const surface of [0, 1]) {
      // The view: the chunk's box on the flat map, the same region's directions on the sphere.
      const camera = new Float32Array(20);
      const globe = new Float32Array(48);
      const draw = new Float32Array(20);
      const [minX, minY] = chunk.boundsMinimum;
      const [maxX, maxY] = chunk.boundsMaximum;
      if (surface === 0) {
        camera.set([2 / (maxX - minX), 0, 0, 0, 0, 2 / (maxY - minY), 0, 0, 0, 0, 0, 0, -(maxX + minX) / (maxX - minX), -(maxY + minY) / (maxY - minY), 0, 1]);
        camera.set([0, 0, 1000], 16);
        draw.set([0, 0, 1, 0]);
      } else {
        const [cu, cv] = world(CENTER[0], CENTER[1]);
        const c = unitDirection(cu, cv);
        const lambda = cu * 2 * Math.PI - Math.PI;
        const phi = Math.asin(c[1]);
        const e = [Math.cos(lambda), 0, -Math.sin(lambda)];
        const n = [-Math.sin(phi) * Math.sin(lambda), Math.cos(phi), -Math.sin(phi) * Math.cos(lambda)];
        const [eu, ev] = world(CENTER[0] + HALF_LON, CENTER[1] + HALF_LAT);
        const corner = unitDirection(eu, ev);
        const kx = 1 / Math.abs(dot(e, corner) - dot(e, c));
        const ky = 1 / Math.abs(dot(n, corner) - dot(n, c));
        // sphereClip, column-major: the region's directions across the view.
        globe.set([kx * e[0]!, ky * n[0]!, 0, 0, kx * e[1]!, ky * n[1]!, 0, 0, kx * e[2]!, ky * n[2]!, 0, 0, -kx * dot(e, c), -ky * dot(n, c), 0.5, 1]);
        globe.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 16);
        globe.set([0, 0, 1, 0, 1, 0, 0, 0], 32);
        // The sun over the region, the globe's light on.
        globe.set([c[0], c[1], c[2], 1, 0.05, 0.07, 0.15, 0.2], 40);
        camera.set([c[0] * 3, c[1] * 3, c[2] * 3], 16);
        GlobeSurfaceTile.write(draw, 0, chunk);
      }
      draw.set([WIDTH, HEIGHT, PIXELS_PER_POINT, 0.999], 4);
      device.queue.writeBuffer(cameraBuffer, 0, camera);
      device.queue.writeBuffer(globeBuffer, 0, globe);
      device.queue.writeBuffer(fogBuffer, 0, new Float32Array(20));

      for (const widthPoints of [2, 8]) {
        // The width rides in each segment and each ribbon vertex: rebuilt per width.
        const segmentsOfWidth = new Uint8Array(fileOf(build(widthPoints)), contents.lineSegments.offset, contents.lineSegments.size);
        const ribbonOfWidth = buildRibbon(widthPoints).slice(12 + fileSize, 12 + fileSize + vertexBytes);
        device.queue.writeBuffer(segmentVertex, 0, segmentsOfWidth);
        device.queue.writeBuffer(segmentStorage, 0, segmentsOfWidth);
        device.queue.writeBuffer(ribbonVertex, 0, ribbonOfWidth);
        device.queue.writeBuffer(drawBuffer, 0, draw);
        const states = pipelines[surface]!;
        const variants: [string, number, (pass: GPURenderPassEncoder) => void][] = [
          [
            "instance per segment",
            segmentBytes.byteLength,
            (pass) => {
              pass.setPipeline(states.instanced);
              pass.setBindGroup(1, plainGroup);
              pass.setVertexBuffer(0, segmentVertex);
              pass.setIndexBuffer(templateBuffer, "uint16");
              pass.drawIndexed(LAYER_LINE_TEMPLATE.length, segments, 0, 0, 0);
            },
          ],
          [
            "triangulated ribbon",
            ribbonBytes,
            (pass) => {
              pass.setPipeline(states.ribbon);
              pass.setBindGroup(1, plainGroup);
              pass.setVertexBuffer(0, ribbonVertex);
              pass.setIndexBuffer(ribbonIndex, "uint32");
              pass.drawIndexed(indexCount, 1, 0, 0, 0);
            },
          ],
          [
            "pulled from storage",
            segmentBytes.byteLength,
            (pass) => {
              pass.setPipeline(states.pulled);
              pass.setBindGroup(1, pulledGroup);
              pass.draw(segments * 24, 1, 0, 0);
            },
          ],
        ];
        for (const [variant, bytes, encode] of variants) {
          const s = await gpuTime(encode);
          const surfaceName = surface === 0 ? "flat" : "sphere";
          gpuRows.push([surfaceName, segments, widthPoints, variant, s.median, s.p95, (bytes / 1e6).toFixed(3)]);
          raw.push({ kind: "gpu", surface: surfaceName, segments, widthPoints, variant, gpu: s, bytes });
        }
      }
    }
    for (const b of [segmentVertex, segmentStorage, ribbonVertex, ribbonIndex]) b.destroy();
  }
  publish(
    "B18b: GPU ms per frame of a layer's lines",
    ["surface", "segments", "width pt", "variant", "GPU median ms", "GPU p95 ms", "line buffers MB"],
    gpuRows,
    raw.filter((r) => (r as { kind: string }).kind === "gpu"),
  );
  publish(
    "B18b: an update of a layer's data, ms",
    ["segments", "variant", "line buffers MB", "build median", "build p95", "upload median", "upload p95", "total median"],
    updateRows,
    raw.filter((r) => (r as { kind: string }).kind === "update"),
  );
  done();
}

run().catch(fail);
