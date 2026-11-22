// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraPosition } from "../camera/immersive-map-camera-position.ts";
import { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import { ImmersiveMapCameraTourShot } from "../ui/camera/immersive-map-camera-tour-controller.ts";
import { ImmersiveMapVideoExportError, type ImmersiveMapVideoExportErrorCode } from "./immersive-map-export-errors.ts";
import { type ImmersiveMapVideoExportAttachContext, ImmersiveMapTourVideoRecorder, videoExportProgress } from "./immersive-map-tour-video-recorder.ts";

/**
 * Ported from the Swift `ImmersiveMapTourVideoRecorderAttachTests`: the
 * guard chain that runs before any GPU or encoder work (exporting, attached,
 * shots, configuration, then WebGPU), safe in every test environment.
 */
describe("ImmersiveMapTourVideoRecorder attach", () => {
  const context: ImmersiveMapVideoExportAttachContext = {
    currentSettings: () => ImmersiveMapSettings.default,
    currentCameraPosition: () => null,
    currentPinsController: () => null,
    currentLayersController: () => null,
    currentAnnotationContent: () => null,
  };
  const shot = ImmersiveMapCameraTourShot.make(ImmersiveMapCameraPosition.make(0, 0, 3));

  async function exportError(recorder: ImmersiveMapTourVideoRecorder, shots: ImmersiveMapCameraTourShot[] = [], width = 1920): Promise<ImmersiveMapVideoExportErrorCode | null> {
    try {
      await recorder.export(shots, { configuration: { width } });
      return null;
    } catch (error) {
      expect(error).toBeInstanceOf(ImmersiveMapVideoExportError);
      return (error as ImmersiveMapVideoExportError).code;
    }
  }

  test("an export without a map is not attached", async () => {
    const recorder = new ImmersiveMapTourVideoRecorder();
    expect(await exportError(recorder)).toBe("notAttached");
    expect(recorder.isExporting).toBe(false);
  });

  test("an attached recorder refuses a tour without shots", async () => {
    const recorder = new ImmersiveMapTourVideoRecorder();
    recorder.attachRuntime({}, context);
    expect(await exportError(recorder)).toBe("emptyShots");
  });

  test("a stale owner's detach keeps the new attachment", async () => {
    const recorder = new ImmersiveMapTourVideoRecorder();
    recorder.attachRuntime({}, context);
    recorder.detachRuntime({});
    // Still attached: the guards reach the shots.
    expect(await exportError(recorder)).toBe("emptyShots");
  });

  test("the owner's detach clears the attachment", async () => {
    const recorder = new ImmersiveMapTourVideoRecorder();
    const owner = {};
    recorder.attachRuntime(owner, context);
    recorder.detachRuntime(owner);
    expect(await exportError(recorder)).toBe("notAttached");
  });

  test("an invalid configuration is refused before any rendering", async () => {
    const recorder = new ImmersiveMapTourVideoRecorder();
    recorder.attachRuntime({}, context);
    expect(await exportError(recorder, [shot], 1919)).toBe("invalidConfiguration");
    expect(recorder.isExporting).toBe(false);
  });

  test("a valid export without WebGPU is refused before any rendering", async () => {
    // Vitest runs in Node, which has no `navigator.gpu`.
    const recorder = new ImmersiveMapTourVideoRecorder();
    recorder.attachRuntime({}, context);
    expect(await exportError(recorder, [shot])).toBe("webGPUUnavailable");
    expect(recorder.isExporting).toBe(false);
  });

  test("a cancel without an export does nothing", () => {
    const recorder = new ImmersiveMapTourVideoRecorder();
    recorder.cancel();
    expect(recorder.isExporting).toBe(false);
  });

  test("the progress' share stays within the frames", () => {
    expect(videoExportProgress("rendering", 30, 120).fractionCompleted).toBeCloseTo(0.25, 9);
    expect(videoExportProgress("finishing", 130, 120).fractionCompleted).toBe(1);
    expect(videoExportProgress("preparing", 0, 0).fractionCompleted).toBe(0);
  });
});
