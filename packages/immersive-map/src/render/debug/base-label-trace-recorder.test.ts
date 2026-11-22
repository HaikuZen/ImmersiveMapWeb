// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `BaseLabelTraceRecorderTests`: what a recording
// keeps, the frame event's fields, the sparse full label lists and the file
// name. A finished recording is read back from its Blob.

import { describe, expect, test } from "vitest";
import { BaseLabelTraceEvent, type BaseLabelTraceFrame, BaseLabelTraceOptions, BaseLabelTraceRecorder } from "./base-label-trace-recorder.ts";

async function readJSONLines(recorder: BaseLabelTraceRecorder): Promise<Record<string, unknown>[]> {
  const text = await recorder.takeBlob()!.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const at1000 = { now: () => 1_000_000 };

const frame: BaseLabelTraceFrame = {
  frameIndex: 42,
  zoom: 11.5,
  pitchDegrees: 75,
  bearingDegrees: 18,
  sourceTileCount: 12,
  baseTrackedTilesChanged: true,
  roadTrackedTilesChanged: false,
  projectionChanged: true,
  activeLabelSpanCount: 30,
  labelInputsCount: 28,
  validLabelCount: 24,
  duplicateLabelCount: 2,
  collisionVisibleCount: 9,
  collisionHiddenCount: 10,
  collisionUnknownCount: 9,
  targetVisibleCount: 8,
  horizonVisibleCount: 18,
  fadeVisibleCount: 7,
  fadeAnimatingCount: 3,
  labels: "0|42|cv=visible|a=1.00",
  hotBuckets: "4/2:8/3/2",
  maxHotBucketCount: 8,
  droppedEventCount: 3,
};

describe("BaseLabelTraceRecorder", () => {
  test("records JSON lines only while recording", async () => {
    const recorder = new BaseLabelTraceRecorder(undefined, at1000);
    recorder.record(BaseLabelTraceEvent.event("before_start", 1));
    recorder.startRecording();
    recorder.record(BaseLabelTraceEvent.event("base_label_frame", 2, { activeLabelSpanCount: 12, cycleActive: true, cameraPitch: 75.5, labels: "1:visible:1.00" }));
    recorder.stopRecording();
    recorder.record(BaseLabelTraceEvent.event("after_stop", 3));

    const lines = await readJSONLines(recorder);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "base_label_frame", frame: 2, activeLabelSpanCount: 12, cycleActive: true, cameraPitch: 75.5, labels: "1:visible:1.00" });
  });

  test("the snapshot reflects the recording state and its file name", () => {
    const recorder = new BaseLabelTraceRecorder(undefined, at1000);
    expect(recorder.isRecordingActive).toBe(false);
    expect(recorder.snapshot().isRecording).toBe(false);
    const fileName = recorder.startRecording();
    expect(recorder.isRecordingActive).toBe(true);
    expect(recorder.snapshot()).toEqual({ isRecording: true, fileName });
    recorder.stopRecording();
    expect(recorder.isRecordingActive).toBe(false);
    expect(recorder.snapshot()).toEqual({ isRecording: false, fileName });
  });

  test("the frame event carries the frame's diagnostics", async () => {
    const recorder = new BaseLabelTraceRecorder(undefined, at1000);
    recorder.startRecording();
    recorder.record(BaseLabelTraceEvent.baseLabelFrame(frame));
    recorder.stopRecording();
    const lines = await readJSONLines(recorder);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      event: "base_label_frame",
      frame: 42,
      zoom: 11.5,
      pitchDegrees: 75,
      baseTrackedTilesChanged: true,
      collisionUnknownCount: 9,
      labelsIncluded: true,
      labels: "0|42|cv=visible|a=1.00",
      hotBuckets: "4/2:8/3/2",
      maxHotBucketCount: 8,
      droppedEventCount: 3,
    });
  });

  test("a lightweight frame leaves its full labels out", async () => {
    const recorder = new BaseLabelTraceRecorder(undefined, at1000);
    recorder.startRecording();
    recorder.record(BaseLabelTraceEvent.baseLabelFrame({ ...frame, frameIndex: 43, labels: undefined, droppedEventCount: 0 }));
    recorder.stopRecording();
    const lines = await readJSONLines(recorder);
    expect(lines[0]!["labelsIncluded"]).toBe(false);
    expect(lines[0]).not.toHaveProperty("labels");
    expect(lines[0]!["hotBuckets"]).toBe("4/2:8/3/2");
  });

  test("the default options sample the full labels sparsely", () => {
    const options = BaseLabelTraceOptions.default;
    expect(BaseLabelTraceOptions.shouldIncludeFullLabels(options, 41, true, true, 8)).toBe(false);
    expect(BaseLabelTraceOptions.shouldIncludeFullLabels(options, 60, false, false, 8)).toBe(true);
    expect(BaseLabelTraceOptions.shouldIncludeFullLabels(options, 41, false, false, options.fullLabelHotBucketThreshold)).toBe(true);
    expect(BaseLabelTraceOptions.shouldIncludeFullLabels({ ...options, includesFullLabelsOnTopologyChange: true }, 41, true, false, 0)).toBe(true);
  });

  test("the file name has the base label trace's prefix", () => {
    const fileName = new BaseLabelTraceRecorder(undefined, at1000).startRecording();
    expect(fileName.startsWith("immersive-map-base-label-trace-")).toBe(true);
    expect(fileName.endsWith(".jsonl")).toBe(true);
  });
});
