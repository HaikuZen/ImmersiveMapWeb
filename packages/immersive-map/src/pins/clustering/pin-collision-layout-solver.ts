// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The pin collision layout (the Swift `PinCollisionLayoutSolver`): pins push
 * each other apart as circles in screen space, only a pin standing exactly
 * on its geo point keeps the pin shape, a displaced pin is a shrunken circle
 * with a beam to it, and dense piles are laid out as flowers of petals.
 * Inter-frame state gives smooth, fps independent transitions.
 *
 * The solve runs in Rust/Wasm on the main thread (crates/frame-wasm,
 * `pins.rs`): it beat the same solver in TypeScript by 1.25 to 1.45 times
 * with the copies across the boundary counted (docs/benchmarks/B04-pins.md).
 * The TypeScript solver is kept for the benchmark only
 * (apps/playground/src/bench/ts-pin-collision-layout-solver.ts).
 *
 * The pins cross into Wasm as one flat
 * `Float64Array`, ten doubles per pin in their given order, and the result
 * comes back as one: the items already in draw order with the index of their
 * pin, and the flowers with their members as indices. The adapter maps the
 * indices back to the `ImmersiveMapPin` objects.
 */

import type { PinSettings } from "../../configuration/pin-settings.ts";
import type { ScreenPointOutput } from "../../geo/geo-screen-projection-math.ts";
import { assertFrameWasm } from "../../frame/frame-wasm.ts";
import { PinCollisionSolver as WasmPinCollisionSolver } from "../../wasm/frame_wasm/frame_wasm.js";
import { PinCollisionLayout } from "./pin-collision-types.ts";
import type { PinCollisionGeometry, PinCollisionItem, PinFlowerGroup, ProjectedPin } from "./pin-collision-types.ts";

export type { PinCollisionGeometry, PinCollisionItem, PinFlowerGroup, ProjectedPin } from "./pin-collision-types.ts";
export { PinCollisionLayout } from "./pin-collision-types.ts";

/** Doubles per pin, the order `pins.rs` reads them in. */
const PIN_INPUT_STRIDE = 10;
/** Doubles per item in the result. */
const PIN_ITEM_STRIDE = 7;
const OUTPUT_HEADER = 3;
const FLAG_SELECTED = 1;
const FLAG_EVENT = 2;

/** The settings the solver reads. */
export type PinCollisionSettings = Pick<PinSettings, "compressedScale" | "collisionPaddingPx" | "groupingThreshold" | "maxOffsetPx" | "collisionIterations" | "springK" | "smoothing">;

export class PinCollisionLayoutSolver {
  private readonly wasm: WasmPinCollisionSolver;
  private input = new Float64Array(64 * PIN_INPUT_STRIDE);

  constructor() {
    assertFrameWasm();
    this.wasm = new WasmPinCollisionSolver();
  }

  /** Forgets the inter-frame state, as if the solver were new. */
  reset(): void {
    this.wasm.reset();
  }

  solve(projectedPins: readonly ProjectedPin[], geometry: PinCollisionGeometry, config: PinCollisionSettings, time: number): PinCollisionLayout {
    const count = projectedPins.length;
    if (this.input.length < count * PIN_INPUT_STRIDE) {
      let length = this.input.length;
      while (length < count * PIN_INPUT_STRIDE) length *= 2;
      this.input = new Float64Array(length);
    }
    const input = this.input;
    for (let i = 0; i < count; i++) {
      const projected = projectedPins[i]!;
      const pin = projected.pin;
      const point = projected.screenPoint;
      const o = i * PIN_INPUT_STRIDE;
      input[o] = pin.id;
      input[o + 1] = point.positionX;
      input[o + 2] = point.positionY;
      input[o + 3] = point.visibilityAlpha;
      input[o + 4] = projected.worldX;
      input[o + 5] = projected.worldY;
      input[o + 6] = pin.screenSizeScale;
      input[o + 7] = pin.drawPriority;
      input[o + 8] = projected.drawOrder;
      input[o + 9] = (pin.isSelected ? FLAG_SELECTED : 0) | (pin.clusterPolicy === "event" ? FLAG_EVENT : 0);
    }
    const out = this.wasm.solve(
      input.subarray(0, count * PIN_INPUT_STRIDE),
      geometry.pinSizePx,
      geometry.bodyRadiusPx,
      geometry.circleBodyRadiusPx,
      geometry.bodyCenterOffsetX,
      geometry.bodyCenterOffsetY,
      config.compressedScale,
      config.collisionPaddingPx,
      config.groupingThreshold,
      config.maxOffsetPx,
      config.collisionIterations,
      config.springK,
      config.smoothing,
      time,
    );
    if (count === 0) return PinCollisionLayout.empty;
    const itemCount = out[0]!;
    const flowerCount = out[1]!;
    const items: PinCollisionItem[] = new Array(itemCount);
    let o = OUTPUT_HEADER;
    for (let k = 0; k < itemCount; k++, o += PIN_ITEM_STRIDE) {
      const projected = projectedPins[out[o]!]!;
      const anchor = projected.screenPoint;
      const screenPoint: ScreenPointOutput = { positionX: out[o + 1]!, positionY: out[o + 2]!, depth: anchor.depth, visible: anchor.visible, visibilityAlpha: out[o + 3]! };
      items[k] = {
        pin: projected.pin,
        squashScaleX: projected.squashScaleX,
        squashScaleY: projected.squashScaleY,
        screenPoint,
        anchorScreenPoint: anchor,
        displayScale: out[o + 4]!,
        morph: out[o + 5]!,
        isFlowerPetal: out[o + 6] === 1,
        drawOrder: projected.drawOrder,
      };
    }
    const flowerGroups: PinFlowerGroup[] = new Array(flowerCount);
    for (let f = 0; f < flowerCount; f++) {
      const centerX = out[o]!;
      const centerY = out[o + 1]!;
      const members = out[o + 2]!;
      const visible = out[o + 3]!;
      o += 4;
      const memberIDs: number[] = new Array(members);
      for (let m = 0; m < members; m++) memberIDs[m] = projectedPins[out[o + m]!]!.pin.id;
      o += members;
      const visibleMemberIDs: number[] = new Array(visible);
      for (let m = 0; m < visible; m++) visibleMemberIDs[m] = projectedPins[out[o + m]!]!.pin.id;
      o += visible;
      flowerGroups[f] = { memberIDs, visibleMemberIDs, centerX, centerY };
    }
    return { pinItems: items, flowerGroups, hasActiveAnimations: out[2] === 1 };
  }
}
