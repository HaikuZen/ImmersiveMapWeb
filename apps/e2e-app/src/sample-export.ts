// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import {
  CameraFlightOptions,
  type ImmersiveMap,
  ImmersiveMapCameraPosition,
  ImmersiveMapCameraTourShot,
  type ImmersiveMapVideoExportProgress,
  ImmersiveMapTourVideoRecorder,
} from "@artembobkin/immersive-map";

/** What the last export made, for the e2e test (`window.exportDemo`). */
interface ExportDemoResult {
  readonly kind: "still" | "video";
  readonly type: string;
  readonly bytes: number;
  /** The first bytes of the file: the PNG signature or the MP4's `ftyp`. */
  readonly head: number[];
  readonly milliseconds: number;
  readonly frames?: number;
}

/** A short tour over central Moscow from where the camera is: three shots and their holds. */
function sampleTour(map: ImmersiveMap): ImmersiveMapCameraTourShot[] {
  const [longitude, latitude] = map.view.center;
  const degrees = Math.PI / 180;
  return [
    ImmersiveMapCameraTourShot.make(ImmersiveMapCameraPosition.make(latitude + 0.004, longitude + 0.006, 15.5, 30 * degrees, 55 * degrees), CameraFlightOptions.make(2), 0.5),
    ImmersiveMapCameraTourShot.make(ImmersiveMapCameraPosition.make(latitude - 0.003, longitude + 0.01, 16, -20 * degrees, 60 * degrees), CameraFlightOptions.make(2), 0.5),
    ImmersiveMapCameraTourShot.make(ImmersiveMapCameraPosition.make(latitude, longitude, 15, 0, 30 * degrees), CameraFlightOptions.make(1.5)),
  ];
}

async function describeBlob(kind: "still" | "video", blob: Blob, started: number, frames?: number): Promise<ExportDemoResult> {
  const head = [...new Uint8Array(await blob.slice(0, 12).arrayBuffer())];
  return { kind, type: blob.type, bytes: blob.size, head, milliseconds: performance.now() - started, ...(frames === undefined ? {} : { frames }) };
}

/**
 * The e2e app's `export=1`: a panel with "Capture still" (a 1280 × 720
 * PNG of the view at 2 pixels per point) and "Record tour" (a 3 second
 * MP4 tour at 1280 × 720, 30 frames per second, in the first codec the
 * browser encodes), each shown below the buttons with a download link. The
 * same actions are `window.exportDemo.captureStill()` and
 * `window.exportDemo.recordTour()` for the e2e test.
 */
export function addSampleExport(map: ImmersiveMap): void {
  const recorder = new ImmersiveMapTourVideoRecorder();
  map.tourVideoRecorder = recorder;

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;left:12px;bottom:12px;display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:10px;" +
    "font:12px system-ui,sans-serif;color:#f2f2f2;background:rgb(20 22 28 / 0.82);max-width:340px";
  const buttons = document.createElement("div");
  buttons.style.cssText = "display:flex;gap:8px";
  const status = document.createElement("div");
  status.textContent = "Export: idle";
  const preview = document.createElement("div");
  const button = (text: string): HTMLButtonElement => {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = text;
    element.style.cssText = "padding:6px 10px;border:0;border-radius:6px;font:600 12px system-ui;cursor:pointer;color:#14161c;background:#ffd479";
    buttons.append(element);
    return element;
  };
  const stillButton = button("Capture still");
  const tourButton = button("Record tour");
  const cancelButton = button("Cancel");
  panel.append(buttons, status, preview);
  document.body.append(panel);

  const show = (blob: Blob, name: string): void => {
    preview.replaceChildren();
    const url = URL.createObjectURL(blob);
    const media = blob.type.startsWith("video/") ? Object.assign(document.createElement("video"), { controls: true, loop: true, muted: true }) : document.createElement("img");
    media.src = url;
    media.style.cssText = "display:block;width:100%;border-radius:6px";
    const link = Object.assign(document.createElement("a"), { href: url, download: name, textContent: `Download ${name}` });
    link.style.color = "#ffd479";
    preview.append(media, link);
  };

  const demo = {
    last: null as ExportDemoResult | null,
    progress: [] as ImmersiveMapVideoExportProgress[],
    async captureStill(): Promise<ExportDemoResult> {
      status.textContent = "Still: settling the scene…";
      const started = performance.now();
      const blob = await map.captureStill({ configuration: { width: 1280, height: 720, pixelsPerPoint: 2, settleTimeout: 20 } });
      demo.last = await describeBlob("still", blob, started);
      status.textContent = `Still: ${blob.size} bytes in ${demo.last.milliseconds.toFixed(0)} ms`;
      show(blob, "immersive-map.png");
      return demo.last;
    },
    async recordTour(options: { framesPerSecond?: number; width?: number; height?: number; tileReadinessTimeout?: number } = {}): Promise<ExportDemoResult> {
      const configuration = { width: options.width ?? 1280, height: options.height ?? 720, framesPerSecond: options.framesPerSecond ?? 30, tileReadinessTimeout: options.tileReadinessTimeout ?? 10 };
      const codecs = await ImmersiveMapTourVideoRecorder.supportedCodecs(configuration);
      const codec = codecs[0];
      if (codec === undefined) throw new Error("This browser encodes none of H.264, HEVC and AV1.");
      const started = performance.now();
      demo.progress = [];
      recorder.onProgress = (progress) => {
        demo.progress.push(progress);
        status.textContent = `Tour (${codec}): ${progress.phase} ${progress.framesCompleted}/${progress.totalFrames}`;
      };
      const blob = await recorder.export(sampleTour(map), { configuration: { ...configuration, codec } });
      const frames = demo.progress.at(-1)?.totalFrames ?? 0;
      demo.last = await describeBlob("video", blob, started, frames);
      status.textContent = `Tour (${codec}): ${frames} frames, ${blob.size} bytes in ${demo.last.milliseconds.toFixed(0)} ms`;
      show(blob, "immersive-map-tour.mp4");
      return demo.last;
    },
  };
  const run = (action: () => Promise<unknown>) => () => {
    action().catch((error: unknown) => {
      status.textContent = `Export failed: ${(error as Error).message}`;
    });
  };
  stillButton.addEventListener("click", run(() => demo.captureStill()));
  tourButton.addEventListener("click", run(() => demo.recordTour()));
  cancelButton.addEventListener("click", () => recorder.cancel());
  Object.assign(window, { exportDemo: demo });
}
