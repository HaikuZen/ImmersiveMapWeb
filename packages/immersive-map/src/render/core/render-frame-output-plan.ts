// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Where the world pass writes its colour, a port of the Swift
 * `RenderFrameOutputPlan` and `RenderFrameOutputPlanner`: straight into the
 * drawable, or into the post-processing input that the FXAA pass then reads
 * into the drawable. Multisampling resolves into whichever it is.
 */
export interface RenderFrameOutputPlan {
  readonly worldColorDestination: "drawable" | "postProcessingInput";
  readonly usesMultisampleResolve: boolean;
  readonly includesPostProcessingPass: boolean;
}

/** The frame's output for the settings as they are this frame: nothing of an earlier plan is kept. */
export function planRenderFrameOutput(fxaaEnabled: boolean, renderSampleCount: number): RenderFrameOutputPlan {
  return {
    worldColorDestination: fxaaEnabled ? "postProcessingInput" : "drawable",
    usesMultisampleResolve: renderSampleCount > 1,
    includesPostProcessingPass: fxaaEnabled,
  };
}
