// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The value types of an export: a still of the map and an offline tour
// video, their sizes taken from a frame format, and the validation of the
// values before any GPU work. The rendering and the encoding are the
// export's own code. No WebGPU, no encoder, no map state here.

import { ImmersiveMapFrameFormat } from "./frame-format.ts";

/** A field of an export's configuration out of its range: the message names the field. */
export class ImmersiveMapInvalidConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImmersiveMapInvalidConfigurationError";
  }
}

// MARK: Video

/**
 * The video codec. `hevc` (H.265): smaller files at equal quality, slightly
 * less universal. `h264`: maximum compatibility, larger files. `av1`: the
 * smallest files, where the browser can encode it (the web port's addition:
 * WebCodecs offers it beside the two Swift codecs). Which of them a browser
 * encodes is `ImmersiveMapTourVideoRecorder.supportedCodecs`.
 */
export type ImmersiveMapVideoCodec = "hevc" | "h264" | "av1";

/**
 * Configuration of an offline tour video export: output dimensions, frame
 * rate, codec, and readiness policy.
 */
export interface ImmersiveMapVideoExportConfiguration {
  /** Output width in pixels. Must be even, within 64...8192. */
  readonly width: number;
  /** Output height in pixels. Must be even, within 64...8192. */
  readonly height: number;
  /** Output frame rate. Must be within 1...120. */
  readonly framesPerSecond: number;
  readonly codec: ImmersiveMapVideoCodec;
  /**
   * Target average bit rate in bits per second. Null picks a default from the
   * frame geometry: 0.10 bits per pixel for HEVC and AV1, 0.20 for H.264
   * (about 12 and 25 Mbit/s at 1080p60).
   */
  readonly averageBitRate: number | null;
  /**
   * How long a single frame may wait for outstanding tiles before it is
   * captured with whatever has loaded, in seconds. Also caps the pre-roll
   * that settles the scene before the first frame.
   */
  readonly tileReadinessTimeout: number;
  /**
   * Wall date used for the earth scene (sun position) across the whole
   * export, in milliseconds since the Unix epoch (`Date.getTime()`). Null
   * fixes it to the moment the export starts.
   */
  readonly sceneDate: number | null;
  /**
   * Whether pins are rendered into the exported video. The export uses a
   * detached copy of the pin state taken at export start, so live pin
   * updates during the export are not captured.
   */
  readonly includesPins: boolean;
  /**
   * Whether the annotations are composited into the exported video. Marker
   * views are rasterized once at export start and follow the same per-frame
   * projection (including the globe-horizon fade) as on screen.
   */
  readonly includesAnnotations: boolean;
  /**
   * Rasterization scale of the annotations, in pixels per point, against the
   * export's own reference canvas rather than against its pixel dimensions.
   *
   * A marker view is laid out in points, exactly like a label, so it has to
   * grow with the export the way the map does: the runtime multiplies this
   * by the ratio between the export's pixels-per-point and the 2x reference.
   * At the default `2` a marker therefore rasterizes at the same scale the
   * map renders at, and keeps its size relative to the labels beside it in a
   * 1080p and a 4K export alike. Raise it to oversample a marker whose
   * artwork needs more resolution than the map. Allowed range 0.5...8.
   */
  readonly annotationScale: number;
}

/** The fields of a video export, each at its default unless given. */
export interface ImmersiveMapVideoExportOptions {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /**
   * A video of the format's size, `ImmersiveMapFrameFormat.instagramReels`
   * for 1080 × 1920, in place of `width` and `height`. The encoder takes even
   * sides only, so an odd side is one pixel smaller:
   * `ImmersiveMapFrameFormat.linkedInLink`, 1200 × 627, is exported at
   * 1200 × 626.
   */
  readonly format?: ImmersiveMapFrameFormat | undefined;
  readonly framesPerSecond?: number | undefined;
  readonly codec?: ImmersiveMapVideoCodec | undefined;
  readonly averageBitRate?: number | null | undefined;
  readonly tileReadinessTimeout?: number | undefined;
  readonly sceneDate?: number | null | undefined;
  readonly includesPins?: boolean | undefined;
  readonly includesAnnotations?: boolean | undefined;
  readonly annotationScale?: number | undefined;
}

/** A side the encoder takes: even, one pixel smaller when odd. */
function evenSide(side: number): number {
  return side % 2 === 0 ? side : side - 1;
}

/** A video export: 1920 × 1080 at 60 frames per second in HEVC unless given. */
export function immersiveMapVideoExportConfiguration(options: ImmersiveMapVideoExportOptions = {}): ImmersiveMapVideoExportConfiguration {
  return Object.freeze({
    width: options.format === undefined ? (options.width ?? 1920) : evenSide(options.format.pixelWidth),
    height: options.format === undefined ? (options.height ?? 1080) : evenSide(options.format.pixelHeight),
    framesPerSecond: options.framesPerSecond ?? 60,
    codec: options.codec ?? "hevc",
    averageBitRate: options.averageBitRate ?? null,
    tileReadinessTimeout: options.tileReadinessTimeout ?? 10,
    sceneDate: options.sceneDate ?? null,
    includesPins: options.includesPins ?? true,
    includesAnnotations: options.includesAnnotations ?? true,
    annotationScale: options.annotationScale ?? 2,
  });
}

/** The video exports' default, the factory's value without options. */
export const defaultVideoExportConfiguration: ImmersiveMapVideoExportConfiguration = immersiveMapVideoExportConfiguration();

/** The output size as a frame format. */
export function videoExportFormat(configuration: ImmersiveMapVideoExportConfiguration): ImmersiveMapFrameFormat {
  return ImmersiveMapFrameFormat.make(configuration.width, configuration.height);
}

/** The configuration with its size set from a format, an odd side one pixel smaller. */
export function withVideoExportFormat(
  configuration: ImmersiveMapVideoExportConfiguration,
  format: ImmersiveMapFrameFormat,
): ImmersiveMapVideoExportConfiguration {
  return Object.freeze({ ...configuration, width: evenSide(format.pixelWidth), height: evenSide(format.pixelHeight) });
}

/** The bit rate the encoder is given: the stated one, or the default of the frame geometry. */
export function resolvedAverageBitRate(configuration: ImmersiveMapVideoExportConfiguration): number {
  if (configuration.averageBitRate !== null) {
    return configuration.averageBitRate;
  }
  const bitsPerPixel = configuration.codec === "h264" ? 0.2 : 0.1;
  return Math.trunc(configuration.width * configuration.height * configuration.framesPerSecond * bitsPerPixel);
}

const within = (value: number, lower: number, upper: number): boolean => value >= lower && value <= upper;

/** Throws an `ImmersiveMapInvalidConfigurationError` naming the first field out of its range. */
export function validateVideoExportConfiguration(configuration: ImmersiveMapVideoExportConfiguration): void {
  const { width, height, framesPerSecond, averageBitRate, tileReadinessTimeout, annotationScale } = configuration;
  if (!within(width, 64, 8192) || !within(height, 64, 8192)) {
    throw new ImmersiveMapInvalidConfigurationError(`width and height must be within 64...8192, got ${width}×${height}`);
  }
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new ImmersiveMapInvalidConfigurationError(`width and height must be even, got ${width}×${height}`);
  }
  if (!within(framesPerSecond, 1, 120)) {
    throw new ImmersiveMapInvalidConfigurationError(`framesPerSecond must be within 1...120, got ${framesPerSecond}`);
  }
  if (averageBitRate !== null && averageBitRate <= 0) {
    throw new ImmersiveMapInvalidConfigurationError(`averageBitRate must be positive, got ${averageBitRate}`);
  }
  if (!(tileReadinessTimeout > 0)) {
    throw new ImmersiveMapInvalidConfigurationError(`tileReadinessTimeout must be positive, got ${tileReadinessTimeout}`);
  }
  if (!within(annotationScale, 0.5, 8)) {
    throw new ImmersiveMapInvalidConfigurationError(`annotationScale must be within 0.5...8, got ${annotationScale}`);
  }
}

// MARK: Still

/** How one still of the map is rendered. */
export interface ImmersiveMapStillConfiguration {
  /** Output width in pixels. Within 1...16384. */
  readonly width: number;
  /** Output height in pixels. Within 1...16384. */
  readonly height: number;
  /**
   * Drawable pixels per layout point, the same number a screen reports as
   * its `devicePixelRatio`.
   *
   * It is not a size multiplier: `width` and `height` are already the pixel
   * dimensions. It tells the renderer how big a point is, which is what
   * style values expressed in points (label sizes, marker halos) are
   * measured against. Capturing at 1 renders a 1024 pixel image with labels
   * sized for a 1024 point canvas. Capturing at 2 renders the same image
   * with labels sized for a 512 point canvas, which is what a high-density
   * screen of that width would show.
   */
  readonly pixelsPerPoint: number;
  /**
   * How long the capture may wait for the scene to finish arriving before
   * the frame is taken with whatever is there, in seconds.
   *
   * Covers everything that reaches the renderer late: tiles over the
   * network, scene model meshes off a worker, and label fades converging. A
   * still has no next frame to correct itself, so this matters more than
   * the equivalent does for video: at zero the capture takes what a handful
   * of frames produced, which on a cold cache is an empty map and for a
   * scene model is usually no model at all.
   */
  readonly settleTimeout: number;
  /**
   * Wall date used for the earth scene, meaning the sun position and the
   * night side, in milliseconds since the Unix epoch. Null uses the moment
   * the capture starts, which makes the image depend on when it was taken.
   * Pin it for reproducible output.
   */
  readonly sceneDate: number | null;
}

/** The fields of a still, each at its default unless given. */
export interface ImmersiveMapStillOptions {
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  /** A still of the format's size, `ImmersiveMapFrameFormat.threadsPost` for 1080 × 1350, in place of `width` and `height`. */
  readonly format?: ImmersiveMapFrameFormat | undefined;
  readonly pixelsPerPoint?: number | undefined;
  readonly settleTimeout?: number | undefined;
  readonly sceneDate?: number | null | undefined;
}

/** A still: 1920 × 1080 at 2 pixels per point unless given. */
export function immersiveMapStillConfiguration(options: ImmersiveMapStillOptions = {}): ImmersiveMapStillConfiguration {
  return Object.freeze({
    width: options.format === undefined ? (options.width ?? 1920) : options.format.pixelWidth,
    height: options.format === undefined ? (options.height ?? 1080) : options.format.pixelHeight,
    pixelsPerPoint: options.pixelsPerPoint ?? 2,
    settleTimeout: options.settleTimeout ?? 10,
    sceneDate: options.sceneDate ?? null,
  });
}

export const defaultStillConfiguration: ImmersiveMapStillConfiguration = immersiveMapStillConfiguration();

/** The output size as a frame format. */
export function stillFormat(configuration: ImmersiveMapStillConfiguration): ImmersiveMapFrameFormat {
  return ImmersiveMapFrameFormat.make(configuration.width, configuration.height);
}

/** Throws an `ImmersiveMapInvalidConfigurationError` naming the first field that is out of range. */
export function validateStillConfiguration(configuration: ImmersiveMapStillConfiguration): void {
  if (!within(configuration.width, 1, 16384)) {
    throw new ImmersiveMapInvalidConfigurationError("width must be within 1...16384");
  }
  if (!within(configuration.height, 1, 16384)) {
    throw new ImmersiveMapInvalidConfigurationError("height must be within 1...16384");
  }
  if (!(configuration.pixelsPerPoint > 0 && configuration.pixelsPerPoint <= 8)) {
    throw new ImmersiveMapInvalidConfigurationError("pixelsPerPoint must be greater than 0 and at most 8");
  }
  if (!(configuration.settleTimeout >= 0)) {
    throw new ImmersiveMapInvalidConfigurationError("settleTimeout must not be negative");
  }
}
