// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The tree model file's reader (the Swift `TreeModelContents.read`): the
// package's own model reads, and every malformed file is told apart.

import { describe, expect, test } from "vitest";
import modelDataURL from "../../../assets/tree_broadleaf.immtree?url&inline";
import { TreeModelContents, TreeModelError } from "./tree-model.ts";

/** The package's model file, inlined by the bundler as a data URL: read from disk, never the network. */
const packageModel = (): ArrayBuffer => {
  const binary = atob(modelDataURL.slice(modelDataURL.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

/** A one-level model of one triangle, for the malformed cases. */
function makeModel(change: (view: DataView) => void = () => {}): ArrayBuffer {
  const bytes = new ArrayBuffer(768);
  const view = new DataView(bytes);
  [0x49, 0x4d, 0x54, 0x52].forEach((b, i) => view.setUint8(i, b));
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  view.setFloat32(12, 9, true);
  view.setFloat32(16, 3, true);
  view.setUint32(24, 256, true);
  view.setUint32(28, 3, true);
  view.setUint32(32, 512, true);
  view.setUint32(36, 3, true);
  [0, 1, 2].forEach((v, i) => view.setUint16(512 + i * 2, v, true));
  change(view);
  return bytes;
}

describe("TreeModelContents", () => {
  test("the package's model reads", () => {
    const bytes = packageModel();
    const contents = TreeModelContents.read(bytes);
    expect(contents.levels.length).toBeGreaterThanOrEqual(1);
    expect(contents.heightMetres).toBeGreaterThan(0);
    expect(contents.radiusMetres).toBeGreaterThanOrEqual(0);
    expect(contents.byteCount).toBe(bytes.byteLength);
    for (const level of contents.levels) {
      expect(level.vertexOffset % TreeModelContents.blockAlignment).toBe(0);
      expect(level.indexOffset % TreeModelContents.blockAlignment).toBe(0);
      expect(level.indexCount % 3).toBe(0);
    }
  });

  test("a well-formed file reads its tables", () => {
    const contents = TreeModelContents.read(makeModel());
    expect(contents.levels).toEqual([{ vertexOffset: 256, vertexCount: 3, indexOffset: 512, indexCount: 3 }]);
    expect(contents.heightMetres).toBe(9);
    expect(contents.radiusMetres).toBe(3);
  });

  test("every malformed file is refused", () => {
    expect(() => TreeModelContents.read(new ArrayBuffer(8))).toThrow(TreeModelError);
    expect(() => TreeModelContents.read(makeModel((v) => v.setUint8(0, 0)))).toThrow(/magic/);
    expect(() => TreeModelContents.read(makeModel((v) => v.setUint32(4, 2, true)))).toThrow(/version 2/);
    expect(() => TreeModelContents.read(makeModel((v) => v.setUint32(8, 0, true)))).toThrow(/levels/);
    expect(() => TreeModelContents.read(makeModel((v) => v.setFloat32(12, 0, true)))).toThrow(/size/);
    expect(() => TreeModelContents.read(makeModel((v) => v.setUint32(24, 300, true)))).toThrow(/outside/);
    expect(() => TreeModelContents.read(makeModel((v) => v.setUint32(36, 4, true)))).toThrow(/outside/);
    expect(() => TreeModelContents.read(makeModel((v) => v.setUint32(28, 100, true)))).toThrow(/outside/);
    expect(() => TreeModelContents.read(makeModel((v) => v.setUint16(514, 7, true)))).toThrow(/names vertex 7/);
  });
});
