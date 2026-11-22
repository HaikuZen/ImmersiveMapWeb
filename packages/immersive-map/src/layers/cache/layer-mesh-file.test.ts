// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { geoCoordinate } from "../../geo/geo-coordinate.ts";
import { ImmersiveMapLayer, layerStyleValues } from "../immersive-map-layer.ts";
import { LayerSourceContent } from "../sources/layer-source-content.ts";
import { testLayerWasm } from "../testing/layer-test-jobs.ts";
import { buildLayerMesh } from "../worker/layer-jobs.ts";
import { LayerMeshFile, LayerMeshLayout } from "./layer-mesh-file.ts";

/** A zone in Moscow and a point in Sydney, built by the Rust module: two chunks. */
function meshFile(): ArrayBuffer {
  const ring = [geoCoordinate(55.7, 37.5), geoCoordinate(55.7, 37.7), geoCoordinate(55.8, 37.7), geoCoordinate(55.8, 37.5)];
  const content = LayerSourceContent.fromShapes([{ exterior: ring }], [], [{ coordinate: geoCoordinate(-33.9, 151.2) }]);
  return buildLayerMesh(testLayerWasm, content.buffers, layerStyleValues(ImmersiveMapLayer.make({ source: "shapes" })));
}

describe("LayerMeshFile", () => {
  test("the file the worker builds is read here as the GPU takes it", () => {
    const file = meshFile();
    const contents = LayerMeshFile.decode(file)!;
    expect(contents.chunks.length).toBe(2);
    expect(contents.chunks.every((chunk) => chunk.z === 6)).toBe(true);
    for (const block of [contents.fillVertices, contents.fillIndices, contents.lineSegments, contents.discs]) expect(block.offset % 16).toBe(0);
    expect(contents.fillVertices.size % LayerMeshLayout.fillVertexStride).toBe(0);
    expect(contents.lineSegments.size).toBeGreaterThan(0);
    expect(contents.discs.size / LayerMeshLayout.discStride).toBe(1);
    // The zone's chunk draws its fill and its outline, the point's its disc.
    const zone = contents.chunks.find((chunk) => chunk.fillIndexCount > 0)!;
    expect(zone.lineCount).toBe(contents.lineSegments.size / LayerMeshLayout.lineSegmentStride);
    const point = contents.chunks.find((chunk) => chunk.pointCount > 0)!;
    expect(point.pointCount).toBe(1);
    expect(point.boundsMinimum[0]).toBeLessThanOrEqual(point.boundsMaximum[0]);
    // The disc's position lies in its chunk's square.
    const disc = new DataView(file, contents.discs.offset, contents.discs.size);
    expect(disc.getFloat32(0, true)).toBeGreaterThanOrEqual(0);
    expect(disc.getFloat32(0, true)).toBeLessThanOrEqual(4096);
  });

  test("an empty mesh is a file of its header alone", () => {
    const file = buildLayerMesh(testLayerWasm, LayerSourceContent.fromShapes([], [], []).buffers, layerStyleValues(ImmersiveMapLayer.make({ source: "none" })));
    const contents = LayerMeshFile.decode(file)!;
    expect(contents.chunks).toEqual([]);
    for (const block of [contents.fillVertices, contents.fillIndices, contents.lineSegments, contents.discs]) expect(block.size).toBe(0);
  });

  test("a damaged file is not a mesh", () => {
    const file = meshFile();
    const otherVersion = file.slice(0);
    new Uint8Array(otherVersion)[4] = 0xff;
    expect(LayerMeshFile.decode(otherVersion)).toBeUndefined();
    // A file cut short, its header alone, and bytes that are no mesh at all.
    expect(LayerMeshFile.decode(file.slice(0, file.byteLength - 8))).toBeUndefined();
    expect(LayerMeshFile.decode(file.slice(0, 20))).toBeUndefined();
    expect(LayerMeshFile.decode(new TextEncoder().encode("not a mesh at all").buffer)).toBeUndefined();
  });

  test("the file's version is the Rust module's", () => {
    expect((testLayerWasm as unknown as { meshFileVersion(): number }).meshFileVersion()).toBe(LayerMeshFile.version);
  });
});
