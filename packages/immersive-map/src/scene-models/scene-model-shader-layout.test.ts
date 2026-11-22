// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The CPU side of the models' GPU contracts, Swift `SceneModelGPUStructLayoutTests`
// and `SceneModelGroundCutContractTests`: the per-draw records the TS code
// writes against the WGSL structs that read them, the vertex layouts, and
// the ground hole's stencil bit. A field added on one side fails here and not
// as a silently misplaced model.

import { describe, expect, test } from "vitest";
import { DRAW_RECORD_BYTES } from "../render/core/draw-parameters.ts";
import { TileSourceStencilPriority } from "../tile/drawers/depth-rank.ts";
import { SceneModelVertexLayout as AssetVertexLayout } from "./asset/scene-model-asset-data.ts";
import { MODEL_TILE_VERTEX_STRIDE, SCENE_MODEL_DRAW_BYTES, SceneModelVertexLayout } from "./pipelines/model-pipelines.ts";
import modelTileSource from "./shaders/model-tile.wgsl?raw";
import sceneModelSource from "./shaders/scene-model.wgsl?raw";

/** The fields of a WGSL struct, `name: type` each, in order. */
function structFields(source: string, name: string): string[] {
  const start = source.indexOf(`struct ${name} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const body = source.slice(source.indexOf("{", start) + 1, source.indexOf("}", start));
  return body
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/,$/, ""));
}

describe("the models' GPU contracts", () => {
  test("a model tile draw is the shared record: the matrix, the depth bias and padding", () => {
    expect(structFields(modelTileSource, "ModelTileDraw")).toEqual(["model: mat4x4f", "depthBias: f32", "padding0: f32", "padding1: f32", "padding2: f32"]);
    expect(64 + 4 * 4).toBe(DRAW_RECORD_BYTES);
  });

  test("a scene model draw is a matrix, the ground plane, the base colour and padding", () => {
    expect(structFields(sceneModelSource, "SceneModelDraw")).toEqual(["model: mat4x4f", "groundSurface: vec4f", "groundUp: vec4f", "baseColor: vec4f", "padding: vec4f"]);
    expect(64 + 4 * 16).toBe(SCENE_MODEL_DRAW_BYTES);
  });

  test("the canonical scene model vertex is pinned, on both sides", () => {
    expect(SceneModelVertexLayout).toEqual({ stride: 32, normalOffset: 12, uvOffset: 24 });
    expect(AssetVertexLayout.stride).toBe(SceneModelVertexLayout.stride);
    expect(AssetVertexLayout.normalOffset).toBe(SceneModelVertexLayout.normalOffset);
    expect(AssetVertexLayout.uvOffset).toBe(SceneModelVertexLayout.uvOffset);
  });

  test("a model tile vertex is the format's 16 bytes", () => {
    expect(MODEL_TILE_VERTEX_STRIDE).toBe(16);
  });

  test("the ground hole bit sits outside every other stencil use", () => {
    const bit = TileSourceStencilPriority.groundHoleBit;
    expect(bit & TileSourceStencilPriority.priorityMask).toBe(0);
    expect(bit & TileSourceStencilPriority.surfaceMaskBit).toBe(0);
    expect(bit.toString(2).replace(/0/g, "").length).toBe(1);
    // The stencil is eight bits.
    expect(bit).toBeLessThanOrEqual(0xff);
  });
});
