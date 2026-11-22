// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { JSONLinesTrace, type TraceEvent, type TraceFieldValue, type TraceRecorderOptions, type TraceRecorderSnapshot } from "./json-lines-trace.ts";

/** Whether the base label trace records and the file name of the current or last one (the Swift `BaseLabelTraceRecorderSnapshot`). */
export type BaseLabelTraceRecorderSnapshot = TraceRecorderSnapshot;

/** One base label trace line (the Swift `BaseLabelTraceEvent`). */
export type BaseLabelTraceEvent = TraceEvent;

/** How much of the labels a trace frame writes (the Swift `BaseLabelTraceOptions`). */
export interface BaseLabelTraceOptions {
  /** Every this many frames a frame writes its full label list, 0 for never by the count. */
  readonly fullLabelFrameInterval: number;
  /** A frame whose fullest collision bucket holds this many labels writes its full list. */
  readonly fullLabelHotBucketThreshold: number;
  /** Whether a change of the tracked tiles or the projection writes the full list. */
  readonly includesFullLabelsOnTopologyChange: boolean;
  /** How many of the fullest collision buckets a frame names. */
  readonly maxHotBuckets: number;
}

export const BaseLabelTraceOptions = {
  default: Object.freeze({
    fullLabelFrameInterval: 30,
    fullLabelHotBucketThreshold: 12,
    includesFullLabelsOnTopologyChange: false,
    maxHotBuckets: 16,
  }) as BaseLabelTraceOptions,

  /** Whether the frame writes its full label list: a hot bucket, the interval, or a topology change when asked for. */
  shouldIncludeFullLabels(
    options: BaseLabelTraceOptions,
    frameIndex: number,
    baseTrackedTilesChanged: boolean,
    projectionChanged: boolean,
    maxHotBucketCount: number,
  ): boolean {
    if (maxHotBucketCount >= options.fullLabelHotBucketThreshold) return true;
    if (options.fullLabelFrameInterval > 0 && frameIndex % options.fullLabelFrameInterval === 0) return true;
    return options.includesFullLabelsOnTopologyChange && (baseTrackedTilesChanged || projectionChanged);
  },
} as const;

/** One frame of the base labels as the trace writes it (the arguments of the Swift `BaseLabelTraceEvent.baseLabelFrame`). */
export interface BaseLabelTraceFrame {
  readonly frameIndex: number;
  readonly zoom: number;
  readonly pitchDegrees: number;
  readonly bearingDegrees: number;
  readonly sourceTileCount: number;
  readonly baseTrackedTilesChanged: boolean;
  readonly roadTrackedTilesChanged: boolean;
  readonly projectionChanged: boolean;
  readonly activeLabelSpanCount: number;
  readonly labelInputsCount: number;
  readonly validLabelCount: number;
  readonly duplicateLabelCount: number;
  readonly collisionVisibleCount: number;
  readonly collisionHiddenCount: number;
  readonly collisionUnknownCount: number;
  readonly targetVisibleCount: number;
  readonly horizonVisibleCount: number;
  readonly fadeVisibleCount: number;
  readonly fadeAnimatingCount: number;
  /** The full label list, undefined for a lightweight frame. */
  readonly labels: string | undefined;
  readonly hotBuckets: string;
  readonly maxHotBucketCount?: number;
  readonly droppedEventCount?: number;
}

export const BaseLabelTraceEvent = {
  event(name: string, frameIndex?: number, fields: Record<string, TraceFieldValue> = {}): BaseLabelTraceEvent {
    return { name, frameIndex, fields };
  },

  baseLabelFrame(frame: BaseLabelTraceFrame): BaseLabelTraceEvent {
    const fields: Record<string, TraceFieldValue> = {
      activeLabelSpanCount: frame.activeLabelSpanCount,
      baseTrackedTilesChanged: frame.baseTrackedTilesChanged,
      bearingDegrees: frame.bearingDegrees,
      collisionHiddenCount: frame.collisionHiddenCount,
      collisionUnknownCount: frame.collisionUnknownCount,
      collisionVisibleCount: frame.collisionVisibleCount,
      droppedEventCount: frame.droppedEventCount ?? 0,
      duplicateLabelCount: frame.duplicateLabelCount,
      fadeAnimatingCount: frame.fadeAnimatingCount,
      fadeVisibleCount: frame.fadeVisibleCount,
      horizonVisibleCount: frame.horizonVisibleCount,
      hotBuckets: frame.hotBuckets,
      labelInputsCount: frame.labelInputsCount,
      labelsIncluded: frame.labels !== undefined,
      maxHotBucketCount: frame.maxHotBucketCount ?? 0,
      pitchDegrees: frame.pitchDegrees,
      projectionChanged: frame.projectionChanged,
      roadTrackedTilesChanged: frame.roadTrackedTilesChanged,
      sourceTileCount: frame.sourceTileCount,
      targetVisibleCount: frame.targetVisibleCount,
      validLabelCount: frame.validLabelCount,
      zoom: frame.zoom,
    };
    if (frame.labels !== undefined) fields["labels"] = frame.labels;
    return { name: "base_label_frame", frameIndex: frame.frameIndex, fields };
  },
} as const;

/**
 * What the base label prepare hands the trace for one frame: its working
 * set's columns as they stand after the frame's fades, index-aligned with
 * the set. The recorder counts, buckets and writes them, so the prepare pays
 * nothing for the trace's shape and a map without a recording pays nothing.
 */
export interface BaseLabelTraceFrameSource {
  readonly frameIndex: number;
  readonly zoom: number;
  /** Radians. */
  readonly pitch: number;
  /** Radians. */
  readonly bearing: number;
  readonly sourceTileCount: number;
  readonly trackedTilesChanged: boolean;
  readonly projectionChanged: boolean;
  readonly labelCount: number;
  /** Each label's feature key. */
  readonly keys: BigUint64Array;
  /** For each label the kept copy of its feature, -1 for a label the set keeps itself. */
  readonly copyOf: Int32Array;
  readonly collisionVisible: Uint8Array;
  readonly targetVisible: Uint8Array;
  readonly horizonVisible: Uint8Array;
  readonly fadeAlphas: Float32Array;
  /** The overview's fade over every label's alpha this frame. */
  readonly overviewFadeAlpha: number;
  /** Per label `stride` floats, of which the anchor on screen in device pixels (`screenX`, `screenY`) and whether it is drawable (`visible`). */
  readonly screenRecords: Float32Array;
  readonly screenLayout: { readonly floats: number; readonly screenX: number; readonly screenY: number; readonly visible: number };
  /** Collision box half sizes in layout points, two per label. */
  readonly halfSizes: Float32Array;
  readonly pixelsPerPoint: number;
  readonly priorities: Int32Array;
}

const activeAlphaThreshold = 0.0001;
const hotBucketCellSize = 64;

function traceFloat(value: number): string {
  return value.toFixed(2);
}

function hotBuckets(source: BaseLabelTraceFrameSource, maxBucketCount: number): { description: string; maxBucketCount: number } {
  const L = source.screenLayout;
  const buckets = new Map<string, { total: number; targetVisible: number; collisionVisible: number }>();
  for (let index = 0; index < source.labelCount; index++) {
    const o = index * L.floats;
    if (o + L.floats > source.screenRecords.length) break;
    if (source.screenRecords[o + L.visible] === 0) continue;
    const key = `${Math.floor(source.screenRecords[o + L.screenX]! / hotBucketCellSize)}/${Math.floor(source.screenRecords[o + L.screenY]! / hotBucketCellSize)}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { total: 0, targetVisible: 0, collisionVisible: 0 };
      buckets.set(key, bucket);
    }
    bucket.total += 1;
    if (source.targetVisible[index] === 1) bucket.targetVisible += 1;
    if (source.collisionVisible[index] === 1) bucket.collisionVisible += 1;
  }
  let largest = 0;
  const description = [...buckets]
    .sort(([lhsKey, lhs], [rhsKey, rhs]) => (lhs.total !== rhs.total ? rhs.total - lhs.total : lhsKey < rhsKey ? -1 : lhsKey > rhsKey ? 1 : 0))
    .slice(0, Math.max(0, maxBucketCount))
    .map(([key, bucket]) => {
      largest = Math.max(largest, bucket.total);
      return `${key}:${bucket.total}/${bucket.targetVisible}/${bucket.collisionVisible}`;
    })
    .join(";");
  return { description, maxBucketCount: largest };
}

/**
 * The full label list: per label its index, key, copy flag, collision and
 * target and horizon decisions, fade, anchor, drawability, priority and box.
 * The boxes are converted from layout points to device pixels, the space
 * of the anchors beside them.
 */
function fullLabels(source: BaseLabelTraceFrameSource): string {
  const L = source.screenLayout;
  const labels: string[] = [];
  for (let index = 0; index < source.labelCount; index++) {
    const o = index * L.floats;
    const hasPoint = o + L.floats <= source.screenRecords.length;
    const x = hasPoint ? source.screenRecords[o + L.screenX]! : 0;
    const y = hasPoint ? source.screenRecords[o + L.screenY]! : 0;
    const screenVisible = hasPoint && source.screenRecords[o + L.visible] !== 0;
    const duplicate = index < source.copyOf.length && source.copyOf[index]! >= 0 ? 1 : 0;
    const visibility = source.collisionVisible[index] === 1 ? "visible" : "hidden";
    const target = source.targetVisible[index] === 1 ? 1 : 0;
    const horizon = source.horizonVisible[index] === 1 ? 1 : 0;
    const alpha = index < source.fadeAlphas.length ? source.fadeAlphas[index]! * source.overviewFadeAlpha : 0;
    const halfWidth = (source.halfSizes[index * 2] ?? 0) * source.pixelsPerPoint;
    const halfHeight = (source.halfSizes[index * 2 + 1] ?? 0) * source.pixelsPerPoint;
    const priority = index < source.priorities.length ? source.priorities[index]! : Number.MAX_SAFE_INTEGER;
    const key = index < source.keys.length ? source.keys[index]!.toString() : "0";
    labels.push(
      `${index}|${key}|v=1|d=${duplicate}|cv=${visibility}|t=${target}|hz=${horizon}|a=${traceFloat(alpha)}|x=${traceFloat(x)}|y=${traceFloat(y)}|sv=${screenVisible ? 1 : 0}|p=${priority}|hw=${traceFloat(halfWidth)}|hh=${traceFloat(halfHeight)}`,
    );
  }
  return labels.join(";");
}

/**
 * The base label trace (the Swift `BaseLabelTraceRecorder`): one JSON line
 * a frame of the base labels' decisions while the debug panel records. A
 * recording lives in memory, `takeBlob` hands the finished one to the panel
 * to download under the snapshot's file name.
 */
export class BaseLabelTraceRecorder {
  readonly options: BaseLabelTraceOptions;
  readonly #trace: JSONLinesTrace;

  constructor(options: BaseLabelTraceOptions = BaseLabelTraceOptions.default, recorderOptions: TraceRecorderOptions = {}) {
    this.options = options;
    this.#trace = new JSONLinesTrace("immersive-map-base-label-trace-", recorderOptions);
  }

  /** Whether a recording runs, for the frame to skip building its trace (the Swift `isRecordingActive`). */
  get isRecordingActive(): boolean {
    return this.#trace.isRecording;
  }

  /** Events dropped past the recording's size bound, written into the next frames (the Swift `currentDroppedEventCount`). */
  get currentDroppedEventCount(): number {
    return this.#trace.droppedEventCount;
  }

  /** Starts a recording and returns its file name (`immersive-map-base-label-trace-<UTC time>.jsonl`). */
  startRecording(): string {
    return this.#trace.startRecording();
  }

  stopRecording(): void {
    this.#trace.stopRecording();
  }

  snapshot(): BaseLabelTraceRecorderSnapshot {
    return this.#trace.snapshot();
  }

  record(event: BaseLabelTraceEvent): void {
    this.#trace.record(event);
  }

  /**
   * Writes one frame of the base labels (the Swift
   * `BaseLabelPrepareSubsystem.recordBaseLabelTraceFrame`): the counts, the
   * fullest screen buckets, and the full label list on the frames the
   * options pick. Nothing while not recording.
   */
  recordBaseLabelFrame(source: BaseLabelTraceFrameSource): void {
    if (!this.#trace.isRecording) return;
    let duplicateLabelCount = 0;
    let collisionVisibleCount = 0;
    let collisionHiddenCount = 0;
    let targetVisibleCount = 0;
    let horizonVisibleCount = 0;
    let fadeVisibleCount = 0;
    let fadeAnimatingCount = 0;
    for (let index = 0; index < source.labelCount; index++) {
      if (index < source.copyOf.length && source.copyOf[index]! >= 0) duplicateLabelCount += 1;
      if (source.collisionVisible[index] === 1) collisionVisibleCount += 1;
      else collisionHiddenCount += 1;
      if (source.targetVisible[index] === 1) targetVisibleCount += 1;
      if (source.horizonVisible[index] === 1) horizonVisibleCount += 1;
      const alpha = index < source.fadeAlphas.length ? source.fadeAlphas[index]! * source.overviewFadeAlpha : 0;
      if (alpha > activeAlphaThreshold) {
        fadeVisibleCount += 1;
        if (alpha < 0.9999) fadeAnimatingCount += 1;
      }
    }
    const buckets = hotBuckets(source, this.options.maxHotBuckets);
    const includeFullLabels = BaseLabelTraceOptions.shouldIncludeFullLabels(
      this.options,
      source.frameIndex,
      source.trackedTilesChanged,
      source.projectionChanged,
      buckets.maxBucketCount,
    );
    this.#trace.record(
      BaseLabelTraceEvent.baseLabelFrame({
        frameIndex: source.frameIndex,
        zoom: source.zoom,
        pitchDegrees: (source.pitch * 180) / Math.PI,
        bearingDegrees: (source.bearing * 180) / Math.PI,
        sourceTileCount: source.sourceTileCount,
        baseTrackedTilesChanged: source.trackedTilesChanged,
        roadTrackedTilesChanged: source.trackedTilesChanged,
        projectionChanged: source.projectionChanged,
        activeLabelSpanCount: source.labelCount,
        labelInputsCount: source.labelCount,
        validLabelCount: source.labelCount,
        duplicateLabelCount,
        collisionVisibleCount,
        collisionHiddenCount,
        collisionUnknownCount: 0,
        targetVisibleCount,
        horizonVisibleCount,
        fadeVisibleCount,
        fadeAnimatingCount,
        labels: includeFullLabels ? fullLabels(source) : undefined,
        hotBuckets: buckets.description,
        maxHotBucketCount: buckets.maxBucketCount,
        droppedEventCount: this.#trace.droppedEventCount,
      }),
    );
  }

  /** The finished recording as JSON Lines, once. */
  takeBlob(): Blob | undefined {
    return this.#trace.takeBlob();
  }
}
