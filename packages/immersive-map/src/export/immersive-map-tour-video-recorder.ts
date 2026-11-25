// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapCameraPosition } from "../camera/immersive-map-camera-position.ts";
import {
  type ImmersiveMapVideoCodec,
  type ImmersiveMapVideoExportConfiguration,
  type ImmersiveMapVideoExportOptions,
  immersiveMapVideoExportConfiguration,
  validateVideoExportConfiguration,
} from "../configuration/export-configuration.ts";
import type { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import type { ImmersiveMapLayersController } from "../layers/immersive-map-layers-controller.ts";
import type { ImmersiveMapPinsController } from "../pins/immersive-map-pins-controller.ts";
import type { ImmersiveMapCameraTourShot } from "../ui/camera/immersive-map-camera-tour-controller.ts";
import type { OffscreenFrameReport } from "../ui/immersive-map.ts";
import { ExportScreenScaleMath } from "./export-screen-scale-math.ts";
import { ImmersiveMapVideoExportError } from "./immersive-map-export-errors.ts";
import { OffscreenExportSession, yieldToEventLoop } from "./offscreen-export-session.ts";
import { TourVideoTimelineDriver } from "./tour-video-timeline-driver.ts";
import { type ImmersiveMapAnnotationExportContent, VideoExportAnnotationOverlay } from "./video-export-annotation-overlay.ts";
import { Mp4Muxer } from "./video/mp4-muxer.ts";
import { mp4CodecOf, videoCodecString, videoEncoderConfig } from "./video/video-encoder-configuration.ts";

/**
 * Everything the recorder needs from its map at an export's start, the Swift
 * `ImmersiveMapVideoExportAttachContext`: read once an export, so a later
 * change to the live map does not reach a running export.
 */
export interface ImmersiveMapVideoExportAttachContext {
  readonly currentSettings: () => ImmersiveMapSettings;
  readonly currentCameraPosition: () => ImmersiveMapCameraPosition | null;
  readonly currentPinsController: () => ImmersiveMapPinsController | null;
  readonly currentLayersController: () => ImmersiveMapLayersController | null;
  readonly currentAnnotationContent: () => ImmersiveMapAnnotationExportContent | null;
}

/**
 * The phase of an export: `preparing` builds the offscreen map and settles
 * the first frame, `rendering` draws and encodes the tour's frames,
 * `finishing` flushes the encoder and writes the file.
 */
export type ImmersiveMapVideoExportPhase = "preparing" | "rendering" | "finishing";

/** The progress of an export, the Swift `ImmersiveMapVideoExportProgress`. */
export interface ImmersiveMapVideoExportProgress {
  readonly phase: ImmersiveMapVideoExportPhase;
  readonly framesCompleted: number;
  readonly totalFrames: number;
  /** The share done, 0 to 1. */
  readonly fractionCompleted: number;
}

export function videoExportProgress(phase: ImmersiveMapVideoExportPhase, framesCompleted: number, totalFrames: number): ImmersiveMapVideoExportProgress {
  return { phase, framesCompleted, totalFrames, fractionCompleted: totalFrames > 0 ? Math.min(1, framesCompleted / totalFrames) : 0 };
}

/** What `ImmersiveMapTourVideoRecorder.export` takes beside the shots. */
export interface ImmersiveMapTourVideoExportOptions {
  /** An instant jump before the first shot, the map's camera when left out. */
  readonly establish?: ImmersiveMapCameraPosition | undefined;
  /** The output: a configuration, or the fields to change from the default. */
  readonly configuration?: ImmersiveMapVideoExportConfiguration | ImmersiveMapVideoExportOptions | undefined;
  /** Aborts the export as `cancel()` does. */
  readonly signal?: AbortSignal | undefined;
}

/** Encoded frames waiting in the encoder before the next one is drawn: keeps the GPU and the encoder both busy. */
const maximumEncodeQueueSize = 3;

/**
 * Exports a camera tour to an MP4 video by rendering it offline, a port of
 * the Swift `ImmersiveMapTourVideoRecorder`.
 *
 * Attach the recorder to a map (`map.tourVideoRecorder = recorder`, or the
 * `tourVideoRecorder` option), which picks up the map's settings, pins,
 * layers and annotations, then call `export` with the same shots an
 * `ImmersiveMapCameraTourController` takes.
 *
 * The export renders frame by frame at a fixed step into a second, headless
 * map: every frame waits for its tiles, the frame rate is exact, the export
 * runs as fast as the GPU and the encoder allow rather than in real time,
 * and the map on screen stays interactive. The frames go to WebCodecs'
 * `VideoEncoder` straight from the offscreen canvas and into
 * an MP4 file of the library's own muxer. The pins are drawn from a copy of
 * their state at the start, the annotations are rasterized once and drawn
 * over each frame at their projected points, and both can be left out by the
 * configuration. The layers are drawn as they are at the start. The
 * attribution badge is the page's and is not in the video: add attribution
 * before publishing exported footage.
 *
 * ```ts
 * const recorder = new ImmersiveMapTourVideoRecorder();
 * map.tourVideoRecorder = recorder;
 * recorder.onProgress = (progress) => console.log(progress.fractionCompleted);
 * const video = await recorder.export(shots, { configuration: { codec: "h264", framesPerSecond: 30 } });
 * ```
 */
export class ImmersiveMapTourVideoRecorder {
  /** The export's progress. */
  onProgress: ((progress: ImmersiveMapVideoExportProgress) => void) | null = null;

  private exporting = false;
  private runtimeOwner: object | null = null;
  private attachContext: ImmersiveMapVideoExportAttachContext | null = null;
  private activeCancel: AbortController | null = null;

  get isExporting(): boolean {
    return this.exporting;
  }

  /** The codecs this browser encodes at the configuration's size and rate, of `h264`, `hevc` and `av1`. */
  static async supportedCodecs(configuration: ImmersiveMapVideoExportConfiguration | ImmersiveMapVideoExportOptions = {}): Promise<ImmersiveMapVideoCodec[]> {
    if (typeof VideoEncoder === "undefined") return [];
    const base = immersiveMapVideoExportConfiguration(configuration);
    const codecs: ImmersiveMapVideoCodec[] = ["h264", "hevc", "av1"];
    const supported = await Promise.all(
      codecs.map(async (codec) => {
        try {
          return (await VideoEncoder.isConfigSupported(videoEncoderConfig({ ...base, codec }))).supported === true;
        } catch {
          return false;
        }
      }),
    );
    return codecs.filter((_, index) => supported[index]);
  }

  /**
   * Renders the tour into an MP4 video. The tour runs as
   * `ImmersiveMapCameraTourController.start` runs it: an instant jump to
   * `establish` when given, then one flight and its hold a shot. An export is
   * one finite pass, with no loop. Rejects with an `ImmersiveMapVideoExportError`.
   */
  async export(shots: readonly ImmersiveMapCameraTourShot[], options: ImmersiveMapTourVideoExportOptions = {}): Promise<Blob> {
    if (this.exporting) throw new ImmersiveMapVideoExportError("exportAlreadyInProgress");
    const attachContext = this.attachContext;
    if (attachContext === null) throw new ImmersiveMapVideoExportError("notAttached");
    if (shots.length === 0) throw new ImmersiveMapVideoExportError("emptyShots");
    const configuration = immersiveMapVideoExportConfiguration(options.configuration ?? {});
    try {
      validateVideoExportConfiguration(configuration);
    } catch (error) {
      throw new ImmersiveMapVideoExportError("invalidConfiguration", (error as Error).message, { cause: error });
    }
    if (typeof navigator === "undefined" || navigator.gpu === undefined) throw new ImmersiveMapVideoExportError("webGPUUnavailable");
    if (typeof VideoEncoder === "undefined") throw new ImmersiveMapVideoExportError("webCodecsUnavailable");

    // The map as it is now: later changes do not reach the export. The pins
    // are a copy, so the live map and the export never take snapshot diffs
    // of one controller.
    const settings = attachContext.currentSettings();
    const initialPosition = options.establish ?? attachContext.currentCameraPosition();
    const pins = configuration.includesPins ? (attachContext.currentPinsController()?.makeDetachedCopyForExport() ?? null) : null;
    const annotations = configuration.includesAnnotations ? attachContext.currentAnnotationContent() : null;
    const layers = attachContext.currentLayersController();

    this.exporting = true;
    const cancel = new AbortController();
    this.activeCancel = cancel;
    const signal = options.signal === undefined ? cancel.signal : AbortSignal.any([cancel.signal, options.signal]);
    try {
      return await runExport({ shots, settings, initialPosition, pins, layers, annotations, configuration, signal, progress: (progress) => this.onProgress?.(progress) });
    } finally {
      pins?.dispose();
      this.exporting = false;
      this.activeCancel = null;
    }
  }

  /** Cancels the running export, which then rejects with `cancelled`. Nothing happens without one. */
  cancel(): void {
    this.activeCancel?.abort();
  }

  /** @internal The map attaches its context (`ImmersiveMap.tourVideoRecorder`). */
  attachRuntime(owner: object, context: ImmersiveMapVideoExportAttachContext): void {
    this.runtimeOwner = owner;
    this.attachContext = context;
  }

  /**
   * @internal Owner-scoped: a map torn down after another took the recorder
   * must not clear the new attachment. A running export only depends on what
   * it read at its start.
   */
  detachRuntime(owner: object): void {
    if (this.runtimeOwner !== owner) return;
    this.runtimeOwner = null;
    this.attachContext = null;
  }
}

interface ExportRun {
  readonly shots: readonly ImmersiveMapCameraTourShot[];
  readonly settings: ImmersiveMapSettings;
  readonly initialPosition: ImmersiveMapCameraPosition | null;
  readonly pins: ImmersiveMapPinsController | null;
  readonly layers: ImmersiveMapLayersController | null;
  readonly annotations: ImmersiveMapAnnotationExportContent | null;
  readonly configuration: ImmersiveMapVideoExportConfiguration;
  readonly signal: AbortSignal;
  readonly progress: (progress: ImmersiveMapVideoExportProgress) => void;
}

/**
 * One export, the Swift `ImmersiveMapVideoExportRuntime`: the headless map
 * and its scripted clock, the timeline, the encoder and the muxer, for
 * exactly one export and let go afterwards.
 */
async function runExport(run: ExportRun): Promise<Blob> {
  const { configuration, signal } = run;
  const { width, height, framesPerSecond } = configuration;
  const encoderConfig = videoEncoderConfig(configuration);
  const support = await VideoEncoder.isConfigSupported(encoderConfig).catch(() => ({ supported: false }));
  if (support.supported !== true) throw new ImmersiveMapVideoExportError("codecUnsupported", `${configuration.codec} (${encoderConfig.codec}) at ${width}×${height}, ${framesPerSecond} fps`);
  checkCancelled(signal);

  // The export composes for a fixed point canvas and spends the rest of its
  // resolution on detail: a 4K export is a sharper 1080p one, not a wider one.
  const pixelsPerPoint = ExportScreenScaleMath.pixelsPerPoint(width, height);
  let session: OffscreenExportSession;
  try {
    session = await OffscreenExportSession.open({
      settings: run.settings,
      camera: run.initialPosition ?? undefined,
      pins: run.pins ?? undefined,
      layers: run.layers ?? undefined,
      width,
      height,
      pixelsPerPoint,
    });
  } catch (error) {
    throw new ImmersiveMapVideoExportError("resourcesUnavailable", (error as Error).message, { cause: error });
  }
  const overlay = run.annotations === null ? null : await VideoExportAnnotationOverlay.make(run.annotations, ExportScreenScaleMath.annotationRasterizationScale(configuration.annotationScale, width, height));
  const composite = overlay === null ? null : new OffscreenCanvas(width, height).getContext("2d");
  const muxer = new Mp4Muxer({ codec: mp4CodecOf(configuration.codec), codecString: encoderConfig.codec, width, height, framesPerSecond });
  let encoderError: unknown;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      try {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        muxer.addChunk({ data, timestampMicroseconds: chunk.timestamp, durationMicroseconds: chunk.duration, isKeyFrame: chunk.type === "key" }, metadata?.decoderConfig?.description as BufferSource | undefined);
      } catch (error) {
        encoderError ??= error;
      }
    },
    error: (error) => {
      encoderError ??= error;
    },
  });
  try {
    encoder.configure(encoderConfig);
    const renderCamera = session.map.exportCamera.renderCamera;
    if (renderCamera === null) throw new ImmersiveMapVideoExportError("renderFrameFailure", "the offscreen map has no camera");
    const initialPosition = run.initialPosition ?? renderCamera.currentCameraPosition();
    const driver = new TourVideoTimelineDriver(run.shots, initialPosition, run.settings, renderCamera, session.map.exportCamera.presentationStateResolver);
    const plan = TourVideoTimelineDriver.makePlan(run.shots, initialPosition, run.settings, framesPerSecond);
    const frameStep = 1 / framesPerSecond;
    const frameMicroseconds = 1_000_000 / framesPerSecond;
    run.progress(videoExportProgress("preparing", 0, plan.frameCount));
    await preroll(session, driver, configuration, frameStep, signal);

    for (let frameIndex = 0; frameIndex < plan.frameCount; frameIndex++) {
      checkCancelled(signal);
      if (encoderError !== undefined) throw encoderError;
      driver.advance(frameIndex * frameStep);
      session.sceneTime += frameStep;
      const report = await renderSettledFrame(session, configuration, signal);
      // In the task of the frame's submit, while the canvas holds the frame.
      let source: HTMLCanvasElement | OffscreenCanvas = session.map.canvas;
      if (overlay !== null && composite !== null && report.projection !== undefined) {
        composite.clearRect(0, 0, width, height);
        composite.drawImage(session.map.canvas, 0, 0);
        overlay.composite(composite, report.projection, frameIndex);
        source = composite.canvas;
      }
      const frame = new VideoFrame(source, { timestamp: Math.round(frameIndex * frameMicroseconds), duration: Math.round(frameMicroseconds) });
      // A key frame every two seconds, as the Swift writer's interval.
      encoder.encode(frame, { keyFrame: frameIndex % (framesPerSecond * 2) === 0 });
      frame.close();
      await encodeQueueRoom(encoder, signal);
      run.progress(videoExportProgress("rendering", frameIndex + 1, plan.frameCount));
    }

    run.progress(videoExportProgress("finishing", plan.frameCount, plan.frameCount));
    await encoder.flush();
    if (encoderError !== undefined) throw encoderError;
    return muxer.finishBlob();
  } catch (error) {
    if (error instanceof ImmersiveMapVideoExportError) throw error;
    if (signal.aborted) throw new ImmersiveMapVideoExportError("cancelled");
    throw new ImmersiveMapVideoExportError("videoEncoderFailure", (error as Error)?.message ?? String(error), { cause: error });
  } finally {
    if (encoder.state !== "closed") encoder.close();
    overlay?.close();
    session.destroy();
  }
}

/**
 * Settles the scene before the first frame: discarded frames with the scene
 * time advancing (the label fades and the pins' appear fades need time)
 * until the tiles, the layers, the fades, the pins and the rise are quiet,
 * or the readiness timeout ran out. The pins are a detached copy, so their
 * animations are finite and cannot hold the pre-roll.
 */
async function preroll(session: OffscreenExportSession, driver: TourVideoTimelineDriver, configuration: ImmersiveMapVideoExportConfiguration, frameStep: number, signal: AbortSignal): Promise<void> {
  driver.advance(0);
  const deadline = performance.now() + configuration.tileReadinessTimeout * 1000;
  while (performance.now() < deadline) {
    checkCancelled(signal);
    session.sceneTime += frameStep;
    const report = renderOrThrow(session);
    // The layers are built before the first frame, so none appears partway
    // through the video. The model tiles too: the map's buildings under a
    // model tile on its way wait for it, so a frame drawn before it lands
    // has neither. Swift's video waits for the tiles and the layers alone,
    // and only its still waits for the model meshes.
    const hasPendingTiles = report.requestedTiles > 0 || report.pendingLayerMeshes > 0 || report.pendingSceneModelMeshes > 0;
    if (!hasPendingTiles && !report.labelFadeActive && !report.pinAnimationActive && !report.extrusionRiseActive) break;
    if (hasPendingTiles && !session.consumeInvalidation()) await session.waitForInvalidation(100, signal);
    else await yieldToEventLoop();
  }
  // One more frame, so what the last one staged is in place before the capture starts.
  session.sceneTime += frameStep;
  renderOrThrow(session);
}

/**
 * Renders the frame, then, with the scene time held so the fades do not run
 * on, again whenever new tiles landed, until none is outstanding (map
 * tiles and model tiles) or the frame's readiness timeout ran out. Returns with the last render just
 * submitted, in the caller's task, so what the last render staged is in it.
 */
async function renderSettledFrame(session: OffscreenExportSession, configuration: ImmersiveMapVideoExportConfiguration, signal: AbortSignal): Promise<OffscreenFrameReport> {
  let report = renderOrThrow(session);
  // A model tile is waited for as a map tile is (the buildings under it wait for it too).
  const isOutstanding = (r: OffscreenFrameReport): boolean => r.requestedTiles > 0 || r.pendingSceneModelMeshes > 0;
  if (!isOutstanding(report)) return report;
  const deadline = performance.now() + configuration.tileReadinessTimeout * 1000;
  do {
    checkCancelled(signal);
    // Until a tile lands, a tenth of a second at most: the frame drawn again
    // also hands the loader its next requests, which a frame's update makes.
    await session.waitForInvalidation(100, signal);
    session.consumeInvalidation();
    report = renderOrThrow(session);
  } while (isOutstanding(report) && performance.now() < deadline);
  return report;
}

/** Waits while the encoder holds more than a few frames: the encoder's own backpressure. */
async function encodeQueueRoom(encoder: VideoEncoder, signal: AbortSignal): Promise<void> {
  while (encoder.encodeQueueSize > maximumEncodeQueueSize) {
    checkCancelled(signal);
    await new Promise<void>((resolve) => {
      const done = (): void => {
        encoder.removeEventListener("dequeue", done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      encoder.addEventListener("dequeue", done);
      signal.addEventListener("abort", done);
    });
  }
}

function renderOrThrow(session: OffscreenExportSession): OffscreenFrameReport {
  const report = session.render();
  if (report === undefined) throw new ImmersiveMapVideoExportError("renderFrameFailure");
  return report;
}

function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ImmersiveMapVideoExportError("cancelled");
}

/** The codec string an export runs its encoder with, for a configuration (`ImmersiveMapVideoExportConfiguration.codec` at its size and rate). */
export function videoExportCodecString(configuration: ImmersiveMapVideoExportConfiguration): string {
  return videoCodecString(configuration.codec, configuration.width, configuration.height, configuration.framesPerSecond);
}
