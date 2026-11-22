// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import type { ImmersiveMapLayersController } from "../layers/immersive-map-layers-controller.ts";
import type { ImmersiveMapPinsController } from "../pins/immersive-map-pins-controller.ts";
import type { ImmersiveMapSceneModelsController } from "../scene-models/immersive-map-scene-models-controller.ts";
import type { ImmersiveMapCameraOption } from "../ui/immersive-map-view.ts";
import type { ImmersiveMapRenderer, OffscreenFrameReport } from "../ui/immersive-map.ts";

/** What an export's offscreen map is made of. */
export interface OffscreenExportSessionOptions {
  readonly settings: ImmersiveMapSettings;
  readonly camera?: ImmersiveMapCameraOption | undefined;
  /** The export's own pins (a copy the live map never reads), none when left out. */
  readonly pins?: ImmersiveMapPinsController | undefined;
  /** The layers drawn as they are when the session opens. */
  readonly layers?: ImmersiveMapLayersController | undefined;
  /** The export's own scene models, none when left out. */
  readonly sceneModels?: ImmersiveMapSceneModelsController | undefined;
  readonly width: number;
  readonly height: number;
  readonly pixelsPerPoint: number;
}

/**
 * One export's headless map and its scripted clock (the Swift
 * `RenderFrameScriptedClock` with the export's `VideoExportRenderEventSink`):
 * scene time moves only when the export moves it, a frame drawn again at the
 * held time advances nothing, and every frame request of the map (a tile, the
 * terrain, a layer, a picture landed) is kept as an invalidation the export
 * waits on instead of a timer.
 */
export class OffscreenExportSession {
  private time = 0;
  private invalidated = false;
  private waiter: (() => void) | undefined;

  private constructor(readonly map: ImmersiveMapRenderer) {}

  static async open(options: OffscreenExportSessionOptions): Promise<OffscreenExportSession> {
    let session: OffscreenExportSession | undefined;
    const rendering = {
      width: options.width,
      height: options.height,
      pixelsPerPoint: options.pixelsPerPoint,
      now: (): number => session?.time ?? 0,
      onFrameRequested: (): void => session?.invalidate(),
    };
    // Loaded when an export opens: the map module imports the recorders, which reach it only here.
    const { ImmersiveMapRenderer } = await import("../ui/immersive-map.ts");
    const map = await ImmersiveMapRenderer.createOffscreen(
      {
        settings: options.settings,
        ...(options.camera === undefined ? {} : { camera: options.camera }),
        ...(options.pins === undefined ? {} : { pins: options.pins }),
        ...(options.layers === undefined ? {} : { layers: options.layers }),
        ...(options.sceneModels === undefined ? {} : { sceneModels: options.sceneModels }),
      },
      rendering,
    );
    session = new OffscreenExportSession(map);
    return session;
  }

  /** The scene time the next frame is drawn at, in seconds. Only moves forward. */
  get sceneTime(): number {
    return this.time;
  }

  set sceneTime(time: number) {
    this.time = Math.max(this.time, time);
  }

  /** Draws one frame at the scene time: `undefined` when the map could not draw. */
  render(): OffscreenFrameReport | undefined {
    return this.map.renderOffscreenFrame(this.time);
  }

  /** Whether something asked for a frame since the last call, clearing the flag. */
  consumeInvalidation(): boolean {
    const invalidated = this.invalidated;
    this.invalidated = false;
    return invalidated;
  }

  /**
   * Waits until something asks for a frame, `milliseconds` at most, or the
   * signal aborts. Resolves at once when a request is already pending.
   */
  waitForInvalidation(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (this.invalidated || signal?.aborted === true) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        if (this.waiter === done) this.waiter = undefined;
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, milliseconds));
      signal?.addEventListener("abort", done, { once: true });
      this.waiter = done;
    });
  }

  /** Tears the map down: its device, its workers and its tiles. */
  destroy(): void {
    this.waiter?.();
    this.map.destroy();
  }

  private invalidate(): void {
    this.invalidated = true;
    this.waiter?.();
  }
}

/** A turn of the event loop: the workers' messages and the GPU's callbacks get theirs. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
