// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapStillCaptureError, type ImmersiveMapStillCaptureErrorCode } from "./immersive-map-export-errors.ts";
import { ImmersiveMapStillRecorder } from "./immersive-map-still-recorder.ts";

/**
 * The CPU cases of the Swift `ImmersiveMapStillRecorderTests`: a capture
 * refuses what it cannot do before touching the GPU and leaves the recorder
 * free. The rendering cases run in the browser smoke (`tests/e2e/export.spec.ts`).
 */
describe("ImmersiveMapStillRecorder", () => {
  async function captureError(recorder: ImmersiveMapStillRecorder, options: Parameters<ImmersiveMapStillRecorder["capture"]>[0]): Promise<ImmersiveMapStillCaptureErrorCode | null> {
    try {
      await recorder.capture(options);
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(ImmersiveMapStillCaptureError);
      return (error as ImmersiveMapStillCaptureError).code;
    }
  }

  test("a capture refuses an invalid configuration before touching the GPU", async () => {
    const recorder = new ImmersiveMapStillRecorder();
    expect(await captureError(recorder, { configuration: { width: 0 } })).toBe("invalidConfiguration");
    expect(recorder.isCapturing).toBe(false);
  });

  test("the refusal names the field out of range", async () => {
    const recorder = new ImmersiveMapStillRecorder();
    await expect(recorder.capture({ configuration: { pixelsPerPoint: 9 } })).rejects.toThrow(/pixelsPerPoint/);
  });

  test("an aborted signal cancels the capture before it starts", async () => {
    const recorder = new ImmersiveMapStillRecorder();
    expect(await captureError(recorder, { signal: AbortSignal.abort() })).toBe("cancelled");
    expect(recorder.isCapturing).toBe(false);
  });

  test("a capture without WebGPU is refused and leaves the recorder free", async () => {
    // Vitest runs in Node, which has no `navigator.gpu`.
    const recorder = new ImmersiveMapStillRecorder();
    expect(await captureError(recorder, { configuration: { width: 375, height: 667 } })).toBe("webGPUUnavailable");
    expect(recorder.isCapturing).toBe(false);
  });

  test("the final frame is drawn past every settle pass", () => {
    expect(ImmersiveMapStillRecorder.finalSceneTime).toBeGreaterThan(ImmersiveMapStillRecorder.maximumSettlePasses * ImmersiveMapStillRecorder.sceneTimeStep);
  });
});
