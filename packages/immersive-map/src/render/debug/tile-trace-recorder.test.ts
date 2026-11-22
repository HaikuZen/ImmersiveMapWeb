// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `TileTraceRecorderTests`: what a recording keeps,
// the redacted URLs, the snapshot, and the events' fields. The browser has
// no file system: a finished recording is read back from its Blob.

import { describe, expect, test } from "vitest";
import { TileLoader, type TileLoadPipeline } from "../../tile/loading/tile-loader.ts";
import { TileLoadingStatusReporter } from "./tile-loading-status-reporter.ts";
import { TileTraceEvent, TileTraceLoaderObserver, TileTraceRecorder } from "./tile-trace-recorder.ts";

async function readJSONLines(recorder: TileTraceRecorder): Promise<Record<string, unknown>[]> {
  const blob = recorder.takeBlob();
  expect(blob).toBeDefined();
  const text = await blob!.text();
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const at1000 = { now: () => 1_000_000 };

describe("TileTraceRecorder", () => {
  test("records JSON lines only while recording", async () => {
    const recorder = new TileTraceRecorder(at1000);
    recorder.record(TileTraceEvent.event("before_start", 1));
    recorder.startRecording();
    recorder.record(TileTraceEvent.event("tile_request", 2, { tile: "1/0/0", requested: 4, ready: 1 }));
    recorder.stopRecording();
    recorder.record(TileTraceEvent.event("after_stop", 3));

    const lines = await readJSONLines(recorder);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ event: "tile_request", frame: 2, ready: 1, requested: 4, t: 1000, tile: "1/0/0" });
    expect(Object.keys(lines[0]!), "every key sorted").toEqual(["event", "frame", "ready", "requested", "t", "tile"]);
    expect(recorder.takeBlob(), "a finished recording is handed out once").toBeUndefined();
  });

  test("redacts sensitive URL query values", async () => {
    const recorder = new TileTraceRecorder(at1000);
    recorder.startRecording();
    recorder.record(TileTraceEvent.event("download", undefined, { url: TileTraceEvent.url("https://example.com/tiles/1/0/0.mvt?access_token=secret-token&style=dark&token=other-secret") }));
    recorder.stopRecording();
    const [line] = await readJSONLines(recorder);
    expect(line!["url"]).toBe("https://example.com/tiles/1/0/0.mvt?access_token=REDACTED&style=dark&token=REDACTED");
    expect(TileTraceEvent.url("https://example.com/a.pmtiles#key=1"), "no query, nothing to redact").toBe("https://example.com/a.pmtiles#key=1");
  });

  test("the snapshot reflects the recording state and its file name", () => {
    const recorder = new TileTraceRecorder(at1000);
    expect(recorder.snapshot()).toEqual({ isRecording: false, fileName: undefined });
    const fileName = recorder.startRecording();
    expect(fileName).toBe("immersive-map-tile-trace-19700101-001640-000.jsonl");
    expect(recorder.startRecording(), "a running recording keeps its name").toBe(fileName);
    expect(recorder.snapshot()).toEqual({ isRecording: true, fileName });
    expect(recorder.takeBlob(), "nothing to hand out while recording").toBeUndefined();
    recorder.stopRecording();
    expect(recorder.snapshot()).toEqual({ isRecording: false, fileName });
  });

  test("records the working set's diagnostic events only while recording", async () => {
    const recorder = new TileTraceRecorder(at1000);
    const tile = { x: 2, y: 3, z: 4 };
    recorder.record(TileTraceEvent.tileStoreLookup(tile, false, 0, 0));
    recorder.startRecording();
    recorder.record(TileTraceEvent.tileStoreInsert(tile, false, 2, 76));
    recorder.record(TileTraceEvent.tileStoreLookup(tile, true, 2, 76));
    recorder.record(TileTraceEvent.tileStoreRelease(tile, "retention_full", 1, 12));
    recorder.record(TileTraceEvent.tileStoreRemoveAll(1, 12));
    recorder.stopRecording();

    const lines = await readJSONLines(recorder);
    expect(lines.map((line) => line["event"])).toEqual(["tile_store_insert", "tile_store_lookup", "tile_store_release", "tile_store_remove_all"]);
    expect(lines[0]!["tile"]).toBe("4/2/3");
    expect(lines[0]!["replaced"]).toBe(false);
    expect(lines[0]!["residentBytes"]).toBe(76);
    expect(lines[1]!["hit"]).toBe(true);
    expect(lines[2]!["reason"]).toBe("retention_full");
    expect(lines[2]!["residentCount"]).toBe(1);
    expect(lines[3]!["removedCount"]).toBe(1);
  });

  test("a prepare success carries its layer timings", async () => {
    const recorder = new TileTraceRecorder(at1000);
    recorder.startRecording();
    recorder.record(
      TileTraceEvent.tilePrepareSuccess({ x: 8, y: 6, z: 4 }, [
        { layerName: "water", duration: 0.053 },
        { layerName: "landcover", duration: 0.027 },
      ]),
    );
    recorder.stopRecording();
    const [line] = await readJSONLines(recorder);
    expect(line!["event"]).toBe("tile_prepare_success");
    expect(line!["tile"]).toBe("4/8/6");
    expect(line!["parseLayerTimings"]).toBe("water:53ms,landcover:27ms");
  });

  test("a loading status snapshot event records the preparation state", async () => {
    const recorder = new TileTraceRecorder(at1000);
    recorder.startRecording();
    recorder.record(
      TileTraceEvent.tileLoadingStatusSnapshot(12, {
        requested: 29,
        deduplicated: 29,
        activeLoads: 4,
        scheduled: 21,
        disk: { inFlight: 1, completed: 20, failed: 4 },
        network: { inFlight: 0, completed: 21, failed: 0 },
        parsing: { inFlight: 3, completed: 18, failed: 0 },
        totalCompleted: 17,
        totalFailed: 0,
        networkBytes: 1_490_922,
        latestDiskTile: undefined,
        latestNetworkTile: undefined,
        latestParsingTile: { x: 8, y: 6, z: 4 },
        latestFailure: undefined,
        latestParseLayerTimingTile: { x: 8, y: 6, z: 4 },
        latestParseLayerTimings: [{ layerName: "water", duration: 0.053 }],
        tiles: [{ tile: { x: 8, y: 6, z: 4 }, status: "parsing", progress: 0.9, detail: "materialize", preparationStages: [], stageAgeSeconds: 0 }],
      }),
    );
    recorder.stopRecording();
    const [line] = await readJSONLines(recorder);
    expect(line).toMatchObject({
      event: "tile_loading_status_snapshot",
      frame: 12,
      activeLoads: 4,
      scheduled: 21,
      diskCompleted: 20,
      parseInFlight: 3,
      latestParsingTile: "4/8/6",
      tiles: "4/8/6:parsing:materialize",
    });
    expect(line, "an absent tile is left out").not.toHaveProperty("latestDiskTile");
  });

  test("a recording past its size bound drops and counts the rest", async () => {
    const recorder = new TileTraceRecorder({ ...at1000, maxRecordedCharacters: 120 });
    recorder.startRecording();
    for (let i = 0; i < 5; i++) recorder.record(TileTraceEvent.tileLoadStart({ x: i, y: 0, z: 3 }));
    recorder.stopRecording();
    const lines = await readJSONLines(recorder);
    expect(lines.length).toBeLessThan(5);
    expect(recorder.droppedEventCount).toBe(5 - lines.length);
  });

  test("the loader's trace observer writes the loader's events and hands every call on", async () => {
    const recorder = new TileTraceRecorder(at1000);
    const reporter = new TileLoadingStatusReporter();
    const pipeline: TileLoadPipeline<string> = {
      hasPreparedDiskCache: true,
      isPreparedOnDisk: () => false,
      readDisk: () => Promise.resolve(undefined),
      removeDiskEntry: () => {},
      download: () => Promise.resolve({ ok: false, failure: { kind: "notFound" } }),
      prepare: () => Promise.reject(new Error("never reached")),
      releaseDownload: () => {},
    };
    const loader = new TileLoader(pipeline, {
      maxConcurrentFetches: 1,
      pendingRequestQueueCapacity: 4,
      maxConcurrentPrepares: 1,
      maxConcurrentDiskLoads: 1,
      now: () => 0,
      scheduleWake: () => () => {},
    });
    loader.statusObserver = new TileTraceLoaderObserver(recorder, reporter);
    recorder.startRecording();
    loader.request([{ x: 1, y: 2, z: 3 }]);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    recorder.stopRecording();

    const lines = await readJSONLines(recorder);
    expect(lines.map((line) => line["event"])).toEqual([
      "tile_scheduler_request",
      "tile_load_scheduled",
      "tile_load_start",
      "tile_disk_lookup_start",
      "tile_disk_miss",
      "tile_download_failed",
      "tile_load_failed",
    ]);
    expect(lines[4]!["reason"]).toBe("no_entry");
    expect(lines[6]!["reason"]).toBe("not_found");
    expect(reporter.snapshot().totalFailed, "the reporter heard every call too").toBe(1);
    expect(reporter.snapshot().network.failed).toBe(1);
  });
});
