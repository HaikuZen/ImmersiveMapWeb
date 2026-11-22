// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { CameraFlightOptions, type ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import type { ImmersiveMapCameraController } from "./immersive-map-camera-controller.ts";

/** One camera-tour shot: where to fly, with which flight options, and how long to hold the shot after arrival, in seconds. */
export interface ImmersiveMapCameraTourShot {
  readonly position: ImmersiveMapCameraPosition;
  readonly options: CameraFlightOptions;
  readonly holdAfter: number;
}

export const ImmersiveMapCameraTourShot = {
  make(position: ImmersiveMapCameraPosition, options: CameraFlightOptions = CameraFlightOptions.default, holdAfter = 0): ImmersiveMapCameraTourShot {
    return { position, options, holdAfter };
  },
} as const;

export interface CameraTourStartOptions {
  /** Starting position, applied with an instant `jump`. */
  readonly establish?: ImmersiveMapCameraPosition;
  /** Repeat the sequence until explicitly stopped. False by default. */
  readonly loop?: boolean;
  /** Stop the tour when a user gesture begins. True by default. */
  readonly stopOnUserInteraction?: boolean;
  /** Called exactly once on any tour completion. */
  readonly onFinished?: () => void;
}

/** Waits `seconds`, or less when `signal` aborts. Injectable for tests. */
export type TourSleep = (seconds: number, signal: AbortSignal) => Promise<void>;

const timerSleep: TourSleep = (seconds, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const handle = setTimeout(resolve, seconds * 1000);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(handle);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Drives the camera through a predefined sequence of shots, chaining flights
 * via the `fly` completion: cinematic tours, demo flyovers, onboarding.
 * Stops on `stop()` and, by default, when the user takes over control, so
 * flights do not fight with gestures.
 */
export class ImmersiveMapCameraTourController {
  private readonly camera: ImmersiveMapCameraController;
  private readonly sleep: TourSleep;
  private run: AbortController | null = null;
  private interactionObserverToken: symbol | null = null;
  private onFinished: (() => void) | null = null;
  /** Incremented on every `start` so the tail of a cancelled run cannot finish a tour started after it. */
  private generation = 0;

  constructor(camera: ImmersiveMapCameraController, sleep: TourSleep = timerSleep) {
    this.camera = camera;
    this.sleep = sleep;
  }

  get isRunning(): boolean {
    return this.run !== null;
  }

  /** Starts the tour, stopping the previous one first. */
  start(shots: readonly ImmersiveMapCameraTourShot[], options: CameraTourStartOptions = {}): void {
    this.stop();
    if (shots.length === 0) {
      options.onFinished?.();
      return;
    }

    this.onFinished = options.onFinished ?? null;
    if (options.stopOnUserInteraction ?? true) {
      this.interactionObserverToken = this.camera.addUserInteractionObserver(() => this.stop());
    }
    if (options.establish !== undefined) {
      this.camera.jump(options.establish);
    }

    this.generation += 1;
    const startedGeneration = this.generation;
    const run = new AbortController();
    this.run = run;
    const loop = options.loop ?? false;
    void (async (): Promise<void> => {
      do {
        for (const shot of shots) {
          if (run.signal.aborted) {
            break;
          }
          await this.fly(shot.position, shot.options);
          if (run.signal.aborted) {
            break;
          }
          if (shot.holdAfter > 0) {
            await this.sleep(shot.holdAfter, run.signal);
          }
        }
      } while (loop && !run.signal.aborted);
      if (this.generation !== startedGeneration) {
        return;
      }
      this.run = null;
      this.finish();
    })();
  }

  stop(): void {
    const run = this.run;
    if (run === null) {
      return;
    }
    run.abort();
    this.run = null;
    this.camera.cancelFlight();
    this.finish();
  }

  private finish(): void {
    if (this.interactionObserverToken !== null) {
      this.camera.removeUserInteractionObserver(this.interactionObserverToken);
      this.interactionObserverToken = null;
    }
    const onFinished = this.onFinished;
    this.onFinished = null;
    onFinished?.();
  }

  /**
   * The callback-based `fly` as a promise. No separate cancellation is
   * needed: the only way a run is aborted is `stop()`, which kills the flight
   * via `cancelFlight()`, firing the completion and settling the promise.
   */
  private fly(position: ImmersiveMapCameraPosition, options: CameraFlightOptions): Promise<void> {
    return new Promise((resolve) => {
      this.camera.fly(position, options, () => resolve());
    });
  }
}
