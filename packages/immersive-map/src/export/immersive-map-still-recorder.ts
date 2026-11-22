// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type ImmersiveMapStillConfiguration, type ImmersiveMapStillOptions, immersiveMapStillConfiguration, validateStillConfiguration } from "../configuration/export-configuration.ts";
import { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import type { ImmersiveMapLayersController } from "../layers/immersive-map-layers-controller.ts";
import type { ImmersiveMapPin } from "../pins/immersive-map-pin.ts";
import type { ImmersiveMapSceneModel } from "../scene-models/immersive-map-scene-model.ts";
import { ImmersiveMapSceneModelsController } from "../scene-models/immersive-map-scene-models-controller.ts";
import { ImmersiveMapPinsController } from "../pins/immersive-map-pins-controller.ts";
import type { ImmersiveMapCameraOption } from "../ui/immersive-map-view.ts";
import { ImmersiveMapStillCaptureError } from "./immersive-map-export-errors.ts";
import { OffscreenExportSession, yieldToEventLoop } from "./offscreen-export-session.ts";

/** What one still is made of. */
export interface ImmersiveMapStillCaptureOptions {
  /** The map to draw, the tile source and the style included. `ImmersiveMapSettings.default` when left out. */
  readonly settings?: ImmersiveMapSettings | undefined;
  /** Where to look from, the start an untouched map opens at when left out. */
  readonly camera?: ImmersiveMapCameraOption | undefined;
  /** The pins to draw: values, or a controller whose pins and groups are copied as they are now. */
  readonly pins?: readonly ImmersiveMapPin[] | ImmersiveMapPinsController | undefined;
  /**
   * The controller whose layers of the app's data to draw, as they are when
   * the capture starts. The capture waits for their sources to be read and
   * their meshes to be built.
   */
  readonly layers?: ImmersiveMapLayersController | null | undefined;
  /** The scene models to draw. The capture waits for their meshes. */
  readonly sceneModels?: readonly ImmersiveMapSceneModel[] | undefined;
  /** The output's size, scale and timing: a configuration, or the fields to change from the default. */
  readonly configuration?: ImmersiveMapStillConfiguration | ImmersiveMapStillOptions | undefined;
  /** Aborts the capture, which then rejects with `cancelled`. */
  readonly signal?: AbortSignal | undefined;
}

/** How `ImmersiveMapStillRecorder.capture` encodes the still. */
export interface ImmersiveMapStillEncoding {
  /** `image/png` when left out, or `image/webp`, `image/jpeg`. The alpha is kept where the format has one. */
  readonly type?: string | undefined;
  /** Between 0 and 1 for the lossy formats. */
  readonly quality?: number | undefined;
}

/**
 * Renders one frame of the map offscreen and hands it back as a picture, a
 * port of the Swift `ImmersiveMapStillRecorder`.
 *
 * Standalone by design: it takes the settings, the camera and the content it
 * should draw rather than attaching to a live map, so it works with no map
 * on the page at all (thumbnails, share images, a batch of reference
 * renders). `ImmersiveMap.captureStill` hands it a live map's own.
 *
 * The frame is drawn by a second, headless map with its own GPU device and
 * workers, so a map on screen keeps its state and stays interactive. The
 * capture settles the scene first: it waits for the tiles, the terrain and
 * the layers its camera needs and lets the label fades, the pins' animations
 * and the buildings' rise run out, because a still has no later frame to
 * correct itself in.
 *
 * ```ts
 * const png = await new ImmersiveMapStillRecorder().capture({
 *   camera: { center: [37.61, 55.75], zoom: 14 },
 *   configuration: { width: 1280, height: 720 },
 * });
 * ```
 *
 * The annotations are DOM elements over the canvas and the attribution
 * badge is the page's, so neither is in a still: add attribution before
 * publishing captured imagery.
 *
 * Repeatability: settling takes as many passes as the scene needs, but the
 * frame returned is always drawn at one fixed scene time, so nothing the
 * scene clock animates (the stars' twinkle, a fade) lands on another phase
 * between runs. Rasterization is not bit-identical on every GPU, so compare
 * captures with a tolerance.
 */
export class ImmersiveMapStillRecorder {
  /** How much scene time a settle pass covers: larger than a frame, the fades converge in a handful of renders. */
  static readonly sceneTimeStep = 0.25;
  /** Settle passes that run whatever the timeout says: two seconds of scene time, past any fade the style can set. */
  static readonly minimumSettlePasses = 8;
  /** Settle passes at most, so the scene time cannot outrun `finalSceneTime`. */
  static readonly maximumSettlePasses = 200;
  /** The scene time the returned frame is always drawn at, past `maximumSettlePasses * sceneTimeStep`. */
  static readonly finalSceneTime = 60;

  private capturing = false;

  get isCapturing(): boolean {
    return this.capturing;
  }

  /**
   * Renders one frame and returns it encoded, a PNG unless `encoding` says
   * otherwise (the canvas encodes it, decision B20). Rejects with an
   * `ImmersiveMapStillCaptureError`.
   */
  capture(options: ImmersiveMapStillCaptureOptions & ImmersiveMapStillEncoding = {}): Promise<Blob> {
    return this.run(options, (canvas) => {
      const { type = "image/png", quality } = options;
      return new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((blob) => (blob === null ? reject(new ImmersiveMapStillCaptureError("imageCreationFailure", "the canvas gave no image")) : resolve(blob)), type, quality);
      });
    });
  }

  /** Renders one frame and returns it as a picture to draw (the Swift `CGImage`). Rejects with an `ImmersiveMapStillCaptureError`. */
  captureImageBitmap(options: ImmersiveMapStillCaptureOptions = {}): Promise<ImageBitmap> {
    return this.run(options, (canvas) => createImageBitmap(canvas));
  }

  private async run<Output>(options: ImmersiveMapStillCaptureOptions, read: (canvas: HTMLCanvasElement) => Promise<Output>): Promise<Output> {
    if (this.capturing) throw new ImmersiveMapStillCaptureError("captureAlreadyInProgress");
    const configuration = immersiveMapStillConfiguration(options.configuration ?? {});
    try {
      validateStillConfiguration(configuration);
    } catch (error) {
      throw new ImmersiveMapStillCaptureError("invalidConfiguration", (error as Error).message, { cause: error });
    }
    const signal = options.signal;
    if (signal?.aborted === true) throw new ImmersiveMapStillCaptureError("cancelled");
    this.capturing = true;
    try {
      return await captureSettledStill(options, configuration, signal, read);
    } finally {
      this.capturing = false;
    }
  }
}

async function captureSettledStill<Output>(
  options: ImmersiveMapStillCaptureOptions,
  configuration: ImmersiveMapStillConfiguration,
  signal: AbortSignal | undefined,
  read: (canvas: HTMLCanvasElement) => Promise<Output>,
): Promise<Output> {
  if (typeof navigator === "undefined" || navigator.gpu === undefined) throw new ImmersiveMapStillCaptureError("webGPUUnavailable");
  // The capture's own pins: a controller's snapshots are one-shot diffs, and
  // one shared with a live map would take the state that map had not read yet.
  const pins = options.pins instanceof ImmersiveMapPinsController ? options.pins.makeDetachedCopyForExport() : pinsControllerOf(options.pins ?? []);
  let session: OffscreenExportSession;
  try {
    session = await OffscreenExportSession.open({
      settings: options.settings ?? ImmersiveMapSettings.default,
      camera: options.camera,
      pins,
      layers: options.layers ?? undefined,
      sceneModels: sceneModelsControllerOf(options.sceneModels ?? []),
      width: configuration.width,
      height: configuration.height,
      pixelsPerPoint: configuration.pixelsPerPoint,
    });
  } catch (error) {
    throw new ImmersiveMapStillCaptureError("resourcesUnavailable", (error as Error).message, { cause: error });
  }
  try {
    await settle(session, configuration, signal);
    // The frame read back, drawn at a time that does not depend on how long
    // settling took, and once more so what the last pass staged is in it.
    session.sceneTime = ImmersiveMapStillRecorder.finalSceneTime;
    renderOrThrow(session);
    renderOrThrow(session);
    // Read in the task of the frame's submit, while the canvas holds it.
    try {
      return await read(session.map.canvas);
    } catch (error) {
      if (error instanceof ImmersiveMapStillCaptureError) throw error;
      throw new ImmersiveMapStillCaptureError("imageCreationFailure", (error as Error).message, { cause: error });
    }
  } finally {
    session.destroy();
    pins?.dispose();
  }
}

/**
 * Renders until the scene stopped changing. Scene time advances every pass,
 * which a still needs and the video's per-frame path does not: there the
 * clock is held so the fades do not run ahead between frames, and here a
 * held clock would mean the fades never start. Settled means nothing on its
 * way (map tiles, terrain, layer and scene model meshes) and nothing running (a fade, a
 * pin's animation, a rise, the animated zoom or the relief's own rise), the
 * condition the video's pre-roll uses too.
 */
async function settle(session: OffscreenExportSession, configuration: ImmersiveMapStillConfiguration, signal: AbortSignal | undefined): Promise<void> {
  const deadline = performance.now() + configuration.settleTimeout * 1000;
  for (let passes = 1; ; passes++) {
    checkCancelled(signal);
    session.sceneTime += ImmersiveMapStillRecorder.sceneTimeStep;
    const report = renderOrThrow(session);
    // The meshes load in a worker and raise no activity: without them here a
    // still would come back without the models it was asked to draw.
    const hasPendingWork = report.requestedTiles > 0 || report.pendingTerrainTiles > 0 || report.pendingLayerMeshes > 0 || report.pendingSceneModelMeshes > 0;
    const isSettled = !hasPendingWork && !report.labelFadeActive && !report.pinAnimationActive && !report.extrusionRiseActive && !report.animatedZoomActive;
    if (isSettled) return;
    if (passes >= ImmersiveMapStillRecorder.minimumSettlePasses && performance.now() >= deadline) return;
    if (passes >= ImmersiveMapStillRecorder.maximumSettlePasses) return;
    // Whatever arrives (a tile, a mesh, a picture) asks for a frame: the
    // loop waits for that, not for a timer, and gives the workers a turn.
    if (hasPendingWork && !session.consumeInvalidation()) await session.waitForInvalidation(50, signal);
    else await yieldToEventLoop();
  }
}

function renderOrThrow(session: OffscreenExportSession): NonNullable<ReturnType<OffscreenExportSession["render"]>> {
  const report = session.render();
  if (report === undefined) throw new ImmersiveMapStillCaptureError("renderFrameFailure");
  return report;
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ImmersiveMapStillCaptureError("cancelled");
}

function sceneModelsControllerOf(models: readonly ImmersiveMapSceneModel[]): ImmersiveMapSceneModelsController | undefined {
  if (models.length === 0) return undefined;
  const controller = new ImmersiveMapSceneModelsController();
  controller.add(models);
  return controller;
}

function pinsControllerOf(pins: readonly ImmersiveMapPin[]): ImmersiveMapPinsController | undefined {
  if (pins.length === 0) return undefined;
  const controller = new ImmersiveMapPinsController();
  controller.add(pins);
  return controller;
}
