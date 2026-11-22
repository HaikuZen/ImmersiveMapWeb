// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The common body of the debug traces (`TileTraceRecorder`,
 * `BaseLabelTraceRecorder`): a recording kept as JSON Lines in memory, since
 * the browser gives a page no file system. The Swift recorders write a file
 * under the app's documents. Here a recording is named like that file, and
 * the panel downloads it as a Blob once it is finished.
 */

/** A field of a trace line: tiles are written as `z/x/y` and URLs redacted by the events' factories. */
export type TraceFieldValue = boolean | number | string;

/** One line of a trace before it is written: its name, the frame it belongs to, its fields. */
export interface TraceEvent {
  readonly name: string;
  readonly frameIndex: number | undefined;
  readonly fields: Readonly<Record<string, TraceFieldValue>>;
}

/** Whether a recording is running and the file name of the current or the last one. */
export interface TraceRecorderSnapshot {
  readonly isRecording: boolean;
  readonly fileName: string | undefined;
}

export interface TraceRecorderOptions {
  /** The wall clock in milliseconds since 1970, `Date.now` by default. */
  readonly now?: () => number;
  /**
   * How many characters of JSON Lines one recording keeps at most, 64 Mi by
   * default. Past it every event is dropped and counted
   * (`droppedEventCount`), so a recording left running cannot take the
   * page's memory.
   */
  readonly maxRecordedCharacters?: number;
}

export const defaultMaxRecordedCharacters = 64 * 1024 * 1024;

function twoDigits(value: number): string {
  return value.toString().padStart(2, "0");
}

/** `<prefix>yyyyMMdd-HHmmss-SSS.jsonl` in UTC, the Swift recorders' file name. */
export function traceFileName(prefix: string, milliseconds: number): string {
  const date = new Date(milliseconds);
  const day = `${date.getUTCFullYear()}${twoDigits(date.getUTCMonth() + 1)}${twoDigits(date.getUTCDate())}`;
  const time = `${twoDigits(date.getUTCHours())}${twoDigits(date.getUTCMinutes())}${twoDigits(date.getUTCSeconds())}`;
  return `${prefix}${day}-${time}-${date.getUTCMilliseconds().toString().padStart(3, "0")}.jsonl`;
}

/**
 * One event as a JSON line: `t` (seconds since 1970), `event`, `frame` when
 * the event has one, and its fields, every key sorted, as the Swift
 * recorders write them. Undefined for a line JSON cannot carry (a number
 * that is not finite), which the Swift recorders drop as well.
 */
export function traceJSONLine(event: TraceEvent, milliseconds: number): string | undefined {
  const entries: [string, TraceFieldValue][] = [
    ["t", milliseconds / 1000],
    ["event", event.name],
  ];
  if (event.frameIndex !== undefined) entries.push(["frame", event.frameIndex]);
  for (const key of Object.keys(event.fields)) {
    if (key === "t" || key === "event" || key === "frame") continue;
    entries.push([key, event.fields[key]!]);
  }
  entries.sort(([lhs], [rhs]) => (lhs < rhs ? -1 : lhs > rhs ? 1 : 0));
  const object: Record<string, TraceFieldValue> = {};
  for (const [key, value] of entries) {
    if (typeof value === "number" && !Number.isFinite(value)) return undefined;
    object[key] = value;
  }
  return `${JSON.stringify(object)}\n`;
}

/** The in-memory recording both trace recorders share. Main thread only. */
export class JSONLinesTrace {
  readonly #prefix: string;
  readonly #now: () => number;
  readonly #maxCharacters: number;
  #lines: string[] = [];
  #characters = 0;
  #recording = false;
  #fileName: string | undefined;
  #finished: Blob | undefined;
  #droppedEventCount = 0;

  constructor(prefix: string, options: TraceRecorderOptions = {}) {
    this.#prefix = prefix;
    this.#now = options.now ?? Date.now;
    this.#maxCharacters = Math.max(0, options.maxRecordedCharacters ?? defaultMaxRecordedCharacters);
  }

  get isRecording(): boolean {
    return this.#recording;
  }

  get droppedEventCount(): number {
    return this.#droppedEventCount;
  }

  /** Starts a recording and returns its file name, the running one's when one is already running. */
  startRecording(): string {
    if (this.#recording && this.#fileName !== undefined) return this.#fileName;
    this.#fileName = traceFileName(this.#prefix, this.#now());
    this.#lines = [];
    this.#characters = 0;
    this.#finished = undefined;
    this.#droppedEventCount = 0;
    this.#recording = true;
    return this.#fileName;
  }

  /** Finishes the recording: its lines become the Blob `takeBlob` hands out. */
  stopRecording(): void {
    if (!this.#recording) return;
    this.#recording = false;
    this.#finished = new Blob(this.#lines, { type: "application/x-ndjson" });
    this.#lines = [];
    this.#characters = 0;
  }

  snapshot(): TraceRecorderSnapshot {
    return { isRecording: this.#recording, fileName: this.#fileName };
  }

  record(event: TraceEvent): void {
    if (!this.#recording) return;
    const line = traceJSONLine(event, this.#now());
    if (line === undefined) return;
    if (this.#characters + line.length > this.#maxCharacters) {
      this.#droppedEventCount += 1;
      return;
    }
    this.#lines.push(line);
    this.#characters += line.length;
  }

  /**
   * The finished recording's JSON Lines, once: the recorder lets go of them,
   * so a second call (or a call while recording) gives undefined. The file
   * name stays in the snapshot.
   */
  takeBlob(): Blob | undefined {
    const blob = this.#finished;
    this.#finished = undefined;
    return blob;
  }
}
