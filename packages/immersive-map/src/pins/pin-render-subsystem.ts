// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { CameraUniform } from "../camera/camera-uniform.ts";
import type { Mat4 } from "../math/matrix.ts";
import type { ResolvedPresentationState } from "../presentation/resolved-presentation-state.ts";
import type { FrameContext, RenderSubsystem } from "../render/frame-engine.ts";
import type { RenderLayer, RenderPassAvailability } from "../render/core/render-layer.ts";
import type { ImmersiveMapPinsController } from "./immersive-map-pins-controller.ts";
import type { PinsRenderer } from "./pins-renderer.ts";

/** What the pins read of the frame being drawn. */
export interface PinFrameInput {
  readonly cameraUniform: CameraUniform;
  readonly presentation: ResolvedPresentationState;
  /** Drawable pixels (origin bottom left) to clip space. */
  readonly screenMatrix: Mat4;
  /** The render loop's clock, in seconds. */
  readonly timeSeconds: number;
}

/**
 * The pins' render subsystem, a port of the Swift `PinRenderSubsystem`: the
 * controller's changes and the frame's layout on update (which also decides
 * whether the overlay's pin layer has anything to draw), the draws in the
 * overlay pass, over the labels and without depth.
 */
export class PinRenderSubsystem implements RenderSubsystem {
  readonly name = "Pins";
  readonly layers: readonly RenderLayer[] = ["pins"];

  constructor(
    private readonly renderer: PinsRenderer,
    private readonly controller: () => ImmersiveMapPinsController | null,
    private readonly frame: () => PinFrameInput | undefined,
  ) {}

  update(context: FrameContext): void {
    const input = this.frame();
    if (input === undefined) return;
    this.renderer.update(this.controller(), input.timeSeconds);
    this.renderer.compute(context.drawWidth, context.drawHeight, input.cameraUniform, input.presentation, input.screenMatrix, input.timeSeconds);
  }

  contributeAvailability(availability: RenderPassAvailability): void {
    availability.pinsEnabled = availability.pinsEnabled || this.renderer.hasRenderablePins;
  }

  encode(layer: RenderLayer, pass: GPURenderPassEncoder): void {
    if (layer === "pins") this.renderer.encode(pass);
  }
}
