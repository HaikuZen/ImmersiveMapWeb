// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/Export.md.

import {
  CameraFlightOptions,
  ImmersiveMap,
  ImmersiveMapCameraPosition,
  ImmersiveMapCameraTourShot,
  ImmersiveMapFrameFormat,
  ImmersiveMapSettings,
  ImmersiveMapStillCaptureError,
  ImmersiveMapStillRecorder,
  ImmersiveMapTourVideoRecorder,
} from "@immersive-map/web";

/** A picture with no map on the page. */
export async function picture(): Promise<Blob> {
  const recorder = new ImmersiveMapStillRecorder();
  const png = await recorder.capture({
    settings: ImmersiveMapSettings.default,
    camera: ImmersiveMapCameraPosition.make(55.75, 37.61, 14),
    configuration: { width: 1280, height: 720 },
  });
  return png;
}

/** A platform's size, encoded as WebP, the same sun on every run. */
export async function presetPicture(): Promise<Blob> {
  const recorder = new ImmersiveMapStillRecorder();
  const webp = await recorder.capture({
    camera: { city: "paris", zoom: 15 },
    configuration: { format: ImmersiveMapFrameFormat.threadsPost, sceneDate: Date.UTC(2026, 5, 21, 12) },
    type: "image/webp",
    quality: 0.9,
  });
  return webp;
}

/** A picture of a map on the page: its settings, camera, pins and layers. */
export async function pictureOfTheMap(map: ImmersiveMap): Promise<Blob | null> {
  try {
    return await map.captureStill({ configuration: { width: 1280, height: 720, pixelsPerPoint: 2, settleTimeout: 20 } });
  } catch (error) {
    if (error instanceof ImmersiveMapStillCaptureError) console.error(error.code);
    return null;
  }
}

/** A tour recorded into an MP4 file. */
export async function video(map: ImmersiveMap, start: ImmersiveMapCameraPosition, end: ImmersiveMapCameraPosition): Promise<Blob> {
  const recorder = new ImmersiveMapTourVideoRecorder();
  map.tourVideoRecorder = recorder;

  // Later:
  const mp4 = await recorder.export(
    [ImmersiveMapCameraTourShot.make(start), ImmersiveMapCameraTourShot.make(end, CameraFlightOptions.make(6))],
    { configuration: { width: 1920, height: 1080, framesPerSecond: 60 } },
  );
  return mp4;
}

/** The first frame from a position of the app's own, a codec the browser encodes, and the progress. */
export async function videoOptions(
  recorder: ImmersiveMapTourVideoRecorder,
  shots: readonly ImmersiveMapCameraTourShot[],
  overview: ImmersiveMapCameraPosition,
  status: HTMLElement,
): Promise<Blob> {
  const format = ImmersiveMapFrameFormat.instagramReels;
  const [codec] = await ImmersiveMapTourVideoRecorder.supportedCodecs({ format });
  if (codec === undefined) throw new Error("This browser encodes none of H.264, HEVC and AV1 at this size.");

  recorder.onProgress = (progress) => {
    status.textContent = `${progress.phase} ${Math.round(progress.fractionCompleted * 100)}%`;
  };
  return recorder.export(shots, { establish: overview, configuration: { format, codec, includesAnnotations: false } });
}

/** The file handed to the user. */
export function download(file: Blob, name: string): void {
  const url = URL.createObjectURL(file);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** An export stopped. */
export function cancel(recorder: ImmersiveMapTourVideoRecorder): void {
  recorder.cancel();
}
