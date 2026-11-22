// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// A port of the Swift `RenderFrameOutputPlannerTests`.

import { describe, expect, test } from "vitest";
import { planRenderFrameOutput } from "./render-frame-output-plan.ts";

describe("planRenderFrameOutput", () => {
  test("without FXAA the world renders straight into the drawable, with no post-processing pass", () => {
    expect(planRenderFrameOutput(false, 1)).toEqual({ worldColorDestination: "drawable", usesMultisampleResolve: false, includesPostProcessingPass: false });
  });

  test("without FXAA the MSAA resolves straight into the drawable", () => {
    expect(planRenderFrameOutput(false, 4)).toEqual({ worldColorDestination: "drawable", usesMultisampleResolve: true, includesPostProcessingPass: false });
  });

  test("with FXAA the world renders into the post-processing input and the pass is added", () => {
    expect(planRenderFrameOutput(true, 1)).toEqual({ worldColorDestination: "postProcessingInput", usesMultisampleResolve: false, includesPostProcessingPass: true });
  });

  test("with FXAA the MSAA resolves into the post-processing input", () => {
    expect(planRenderFrameOutput(true, 4)).toEqual({ worldColorDestination: "postProcessingInput", usesMultisampleResolve: true, includesPostProcessingPass: true });
  });

  test("a live FXAA toggle keeps nothing of the previous plan", () => {
    const enabled = planRenderFrameOutput(true, 4);
    const disabled = planRenderFrameOutput(false, 4);
    expect(enabled.worldColorDestination).toBe("postProcessingInput");
    expect(enabled.includesPostProcessingPass).toBe(true);
    expect(disabled.worldColorDestination).toBe("drawable");
    expect(disabled.includesPostProcessingPass).toBe(false);
  });
});
