// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Why a still capture could not produce an image, the Swift
 * `ImmersiveMapStillCaptureError`.
 *
 * - `captureAlreadyInProgress`: another capture on this recorder has not finished yet.
 * - `invalidConfiguration`: the configured geometry is out of range, the message names the field.
 * - `webGPUUnavailable`: no WebGPU adapter or device for the offscreen map.
 * - `resourcesUnavailable`: the map's resources (atlases, workers, pipelines) could not be loaded.
 * - `renderFrameFailure`: the offscreen map could not draw a frame.
 * - `imageCreationFailure`: the drawn frame could not be turned into an image.
 * - `cancelled`: the capture's signal aborted it before the frame was taken.
 */
export type ImmersiveMapStillCaptureErrorCode =
  | "captureAlreadyInProgress"
  | "invalidConfiguration"
  | "webGPUUnavailable"
  | "resourcesUnavailable"
  | "renderFrameFailure"
  | "imageCreationFailure"
  | "cancelled";

const stillMessages: Record<ImmersiveMapStillCaptureErrorCode, string> = {
  captureAlreadyInProgress: "A capture is already running on this recorder",
  invalidConfiguration: "Invalid still capture configuration",
  webGPUUnavailable: "WebGPU is unavailable in this browser",
  resourcesUnavailable: "The map's resources could not be loaded",
  renderFrameFailure: "The map frame could not be rendered",
  imageCreationFailure: "The rendered frame could not be converted into an image",
  cancelled: "The still capture was cancelled",
};

/**
 * A still capture's failure. Kept apart from `ImmersiveMapVideoExportError`
 * as Swift keeps them: half of the video's cases describe an encoder and a
 * file, and neither exists here.
 */
export class ImmersiveMapStillCaptureError extends Error {
  constructor(
    readonly code: ImmersiveMapStillCaptureErrorCode,
    detail?: string,
    options?: { readonly cause?: unknown },
  ) {
    super(detail === undefined ? stillMessages[code] : `${stillMessages[code]}: ${detail}`, options);
    this.name = "ImmersiveMapStillCaptureError";
  }
}

/**
 * Why a tour video export failed, the Swift `ImmersiveMapVideoExportError`.
 *
 * - `notAttached`: the recorder is not attached to a map (`ImmersiveMap.tourVideoRecorder`).
 * - `exportAlreadyInProgress`: another export on this recorder is still running.
 * - `invalidConfiguration`: the configuration failed validation, the message names the field.
 * - `emptyShots`: the tour has no shots.
 * - `webGPUUnavailable`: no WebGPU adapter or device for the offscreen map.
 * - `webCodecsUnavailable`: the browser has no `VideoEncoder`.
 * - `codecUnsupported`: the browser cannot encode the configured codec at the configured size.
 * - `resourcesUnavailable`: the map's resources could not be loaded.
 * - `videoEncoderFailure`: the encoder or the muxer failed, the cause is attached.
 * - `renderFrameFailure`: the offscreen map could not draw a frame.
 * - `cancelled`: the export was cancelled (`cancel()` or the signal).
 */
export type ImmersiveMapVideoExportErrorCode =
  | "notAttached"
  | "exportAlreadyInProgress"
  | "invalidConfiguration"
  | "emptyShots"
  | "webGPUUnavailable"
  | "webCodecsUnavailable"
  | "codecUnsupported"
  | "resourcesUnavailable"
  | "videoEncoderFailure"
  | "renderFrameFailure"
  | "cancelled";

const videoMessages: Record<ImmersiveMapVideoExportErrorCode, string> = {
  notAttached: "The tour video recorder is not attached to a map",
  exportAlreadyInProgress: "An export is already running on this recorder",
  invalidConfiguration: "Invalid video export configuration",
  emptyShots: "The tour has no shots",
  webGPUUnavailable: "WebGPU is unavailable in this browser",
  webCodecsUnavailable: "WebCodecs (VideoEncoder) is unavailable in this browser",
  codecUnsupported: "The browser cannot encode this codec at this size",
  resourcesUnavailable: "The map's resources could not be loaded",
  videoEncoderFailure: "The video encoder failed",
  renderFrameFailure: "The map frame could not be rendered",
  cancelled: "The video export was cancelled",
};

/** A tour video export's failure. */
export class ImmersiveMapVideoExportError extends Error {
  constructor(
    readonly code: ImmersiveMapVideoExportErrorCode,
    detail?: string,
    options?: { readonly cause?: unknown },
  ) {
    super(detail === undefined ? videoMessages[code] : `${videoMessages[code]}: ${detail}`, options);
    this.name = "ImmersiveMapVideoExportError";
  }
}
