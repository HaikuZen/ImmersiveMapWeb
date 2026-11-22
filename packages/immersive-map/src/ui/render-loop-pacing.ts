// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { RenderLoopSettings } from "../configuration/view-settings.ts";

/**
 * Why a one-shot frame was asked for (Swift `RenderInvalidationReason`):
 * something changed that the next frame must show, with nothing that keeps
 * the loop running after it.
 */
export type RenderInvalidationReason = "tileAvailable" | "tileRetryDue" | "sceneModelAssetLoaded" | "layerDataLoaded" | "externalStateChanged";

const invalidationReasonDescriptions: Readonly<Record<RenderInvalidationReason, string>> = {
  tileAvailable: "tile available",
  tileRetryDue: "tile retry due",
  sceneModelAssetLoaded: "scene model asset loaded",
  layerDataLoaded: "layer data loaded",
  externalStateChanged: "external state changed",
};

/**
 * A reason the render loop keeps running from frame to frame, as long as it
 * is set.
 *
 * - `interaction`: a gesture on the map or a control zone.
 * - `labelFade`: the labels fading in and out.
 * - `cameraAnimation`: a flight, a path follow, the pan inertia, an angle
 *   follow, the bounds or upright pull.
 * - `pinAnimation`, `sceneModelAnimation`: the pins and the models moving.
 * - `extrusionRise`: the buildings or the models rising out of the ground.
 * - `animatedZoom`: the animated zoom settling on the camera's (`AnimatedZoom`).
 * - `externalCameraDrive`: a camera position set from outside through
 *   `ImmersiveMapCameraController.jump`, by an app driving the camera once
 *   per frame (its own animation, a follow camera fed by a location stream).
 *   Held for a short grace period after every jump so a series of jumps
 *   keeps the loop running the way a gesture does, instead of stopping it
 *   after each one-shot frame and starting it again on the next jump, which
 *   loses refreshes.
 */
export type RenderLoopActivity =
  | "interaction"
  | "labelFade"
  | "cameraAnimation"
  | "pinAnimation"
  | "sceneModelAnimation"
  | "extrusionRise"
  | "animatedZoom"
  | "externalCameraDrive";

/** Every activity, in the order the reason description lists them. */
export const renderLoopActivities: readonly RenderLoopActivity[] = Object.freeze([
  "interaction",
  "labelFade",
  "cameraAnimation",
  "pinAnimation",
  "sceneModelAnimation",
  "extrusionRise",
  "animatedZoom",
  "externalCameraDrive",
]);

const activityDescriptions: Readonly<Record<RenderLoopActivity, string>> = {
  interaction: "interaction",
  labelFade: "label fade",
  cameraAnimation: "camera animation",
  pinAnimation: "pin animation",
  sceneModelAnimation: "scene model animation",
  extrusionRise: "extrusion rise",
  animatedZoom: "animated zoom",
  externalCameraDrive: "external camera drive",
};

/** Whether an activity runs at the interaction frame rate (all but the label fade). */
export function usesInteractionFrameRate(activity: RenderLoopActivity): boolean {
  return activity !== "labelFade";
}

/** How hot the device runs, as Swift's `ProcessInfo.ThermalState` names it. */
export type ThermalState = "nominal" | "fair" | "serious" | "critical";

/**
 * Ceilings imposed by the device's power situation, applied on top of the
 * configured rates regardless of which activities are running.
 */
export interface PowerConstraintState {
  /** Hard frame-rate ceiling. Null leaves the configured rates untouched. */
  readonly maximumFramesPerSecond: number | null;
  /**
   * Whether interaction-class activities may still ride above the configured
   * floor to the display's high refresh rates.
   */
  readonly allowsProMotionHeadroom: boolean;
}

export const PowerConstraintState = {
  unconstrained: Object.freeze({ maximumFramesPerSecond: null, allowsProMotionHeadroom: true }) as PowerConstraintState,

  /**
   * Serious thermal pressure caps rendering at 60, critical at 30, and both
   * revoke the high-refresh headroom. A power saver only revokes the
   * headroom: the configured floor stays, so interactions remain smooth while
   * the display stops being driven above what was asked for.
   *
   * The browser exposes no thermal state today. The map can feed what it
   * knows (a battery saver, a measured slow frame) through this.
   */
  resolve(thermalState: ThermalState, isLowPowerModeEnabled: boolean): PowerConstraintState {
    let maximumFramesPerSecond: number | null = null;
    if (thermalState === "serious") {
      maximumFramesPerSecond = 60;
    } else if (thermalState === "critical") {
      maximumFramesPerSecond = 30;
    }
    return {
      maximumFramesPerSecond,
      allowsProMotionHeadroom: !(isLowPowerModeEnabled || maximumFramesPerSecond !== null),
    };
  },
} as const;

/**
 * Keeps the reasons why the render loop must keep running, and picks the
 * frame rate and the pause state of the loop from them. Rendering is on
 * demand: with no one-shot request pending and no activity set, the loop
 * stops.
 */
export class RenderLoopPacing {
  /**
   * How long the loop stays awake after a camera position set from outside,
   * in seconds. Long enough that a driver at 30 Hz with jitter never lets
   * the loop pause between two sets, short enough that a lone jump costs
   * about a dozen identical frames at 120 Hz before the loop sleeps again.
   */
  static readonly externalCameraDriveGraceSeconds = 0.1;

  private configuration: RenderLoopSettings;
  private powerConstraints: PowerConstraintState = PowerConstraintState.unconstrained;
  private requestedFrameReason: RenderInvalidationReason | null = null;
  private readonly activeRenderingActivities = new Set<RenderLoopActivity>();
  private externalCameraDriveDeadline: number | null = null;
  /**
   * A parked map has nothing to present into: rendering is fully gated off
   * regardless of pending requests or activities, which stops the loop.
   * Requests and activities keep accumulating and take effect again when the
   * map is shown.
   */
  private isParked = false;

  constructor(configuration: RenderLoopSettings) {
    this.configuration = configuration;
  }

  applyConfiguration(configuration: RenderLoopSettings): void {
    this.configuration = configuration;
  }

  applyPowerConstraintState(constraints: PowerConstraintState): void {
    this.powerConstraints = constraints;
  }

  get needsFrameRendering(): boolean {
    if (this.isParked) {
      return false;
    }
    return this.configuration.forceContinuousRendering || this.requestedFrameReason !== null || this.activeRenderingActivities.size > 0;
  }

  setParked(parked: boolean): void {
    this.isParked = parked;
  }

  get isCameraAnimationRenderingActive(): boolean {
    return this.activeRenderingActivities.has("cameraAnimation");
  }

  get shouldPauseDisplayLink(): boolean {
    return !this.needsFrameRendering;
  }

  /** The frame rate the loop runs at now, 0 when only one-shot frames are due. */
  get targetFramesPerSecond(): number {
    if (this.configuration.forceContinuousRendering || this.hasInteractionClassActivity()) {
      return this.powerConstrained(this.configuration.interactionFramesPerSecond);
    }
    if (this.activeRenderingActivities.has("labelFade")) {
      return this.powerConstrained(this.configuration.labelFadeFramesPerSecond);
    }
    return 0;
  }

  /**
   * True when the current target rate comes from an interaction-class
   * activity (or forced continuous rendering): the configured rate is a floor
   * there and the loop may ride up to the display's maximum on a
   * high-refresh display. The label fade keeps its deliberately low cadence
   * and gets no headroom, and power constraints revoke it globally.
   */
  get allowsFrameRateHeadroom(): boolean {
    if (!this.powerConstraints.allowsProMotionHeadroom) {
      return false;
    }
    return this.configuration.forceContinuousRendering || this.hasInteractionClassActivity();
  }

  requestOneFrame(reason: RenderInvalidationReason): void {
    this.requestedFrameReason = reason;
  }

  setRenderingActivity(activity: RenderLoopActivity, isActive: boolean): void {
    if (isActive) {
      this.activeRenderingActivities.add(activity);
    } else {
      this.activeRenderingActivities.delete(activity);
    }
  }

  consumeOneFrameRequest(): void {
    this.requestedFrameReason = null;
  }

  /**
   * A camera position was set from outside at `now` (seconds): holds the
   * `externalCameraDrive` activity for the grace period from `now`. Every
   * further set restarts the period.
   */
  noteExternalCameraDrive(now: number): void {
    this.externalCameraDriveDeadline = now + RenderLoopPacing.externalCameraDriveGraceSeconds;
    this.activeRenderingActivities.add("externalCameraDrive");
  }

  /**
   * Called once per loop tick: drops the external camera drive activity once
   * its grace period has passed, so the loop can stop again.
   */
  expireExternalCameraDrive(now: number): void {
    const deadline = this.externalCameraDriveDeadline;
    if (deadline === null || !(now >= deadline)) {
      return;
    }
    this.externalCameraDriveDeadline = null;
    this.activeRenderingActivities.delete("externalCameraDrive");
  }

  /** What keeps the loop running, for the debug panel. Null when nothing does. */
  get renderingReasonDescription(): string | null {
    const reasons: string[] = [];
    if (this.configuration.forceContinuousRendering) {
      reasons.push("force continuous rendering");
    }
    if (this.requestedFrameReason !== null) {
      reasons.push(`pending frame: ${invalidationReasonDescriptions[this.requestedFrameReason]}`);
    }
    for (const activity of renderLoopActivities) {
      if (this.activeRenderingActivities.has(activity)) {
        reasons.push(activityDescriptions[activity]);
      }
    }
    return reasons.length === 0 ? null : reasons.join(", ");
  }

  private hasInteractionClassActivity(): boolean {
    for (const activity of this.activeRenderingActivities) {
      if (usesInteractionFrameRate(activity)) {
        return true;
      }
    }
    return false;
  }

  private powerConstrained(framesPerSecond: number): number {
    const ceiling = this.powerConstraints.maximumFramesPerSecond;
    return ceiling === null ? framesPerSecond : Math.min(framesPerSecond, ceiling);
  }
}

/**
 * The render requests the camera and the gestures make (Swift
 * `ImmersiveMapRenderRuntime`, the part of it they reach): a one-shot frame,
 * and the activities that keep the loop running.
 */
export interface CameraRenderRequests {
  requestFrame(reason?: RenderInvalidationReason): void;
  setCameraAnimationRenderingActive(isActive: boolean): void;
  setInteractionRenderingActive(isActive: boolean): void;
  /** A camera position set from outside: keeps the loop awake for the grace period. */
  noteExternalCameraDrive(): void;
}

/** The browser's frame callback, injectable for tests. */
export interface AnimationFrameScheduler {
  requestAnimationFrame(callback: (time: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

export interface RenderLoopDriverOptions {
  readonly configuration: RenderLoopSettings;
  /**
   * Draws one frame at `now` seconds (the map advances its camera animations,
   * resolves the frame's camera and records the GPU work). Returns whether a
   * frame was actually submitted: only then is the pending one-shot request
   * consumed, as the Swift driver consumes it once the renderer scheduled
   * the drawable.
   */
  readonly renderFrame: (now: number) => boolean;
  /** `requestAnimationFrame` by default. */
  readonly scheduler?: AnimationFrameScheduler;
  /** Seconds on a monotonic clock, `performance.now() / 1000` by default. */
  readonly now?: () => number;
  /**
   * Told of every frame request (a tile, the terrain, a layer or a picture
   * landed), for a driver that draws the frames itself, as an export does
   * with a scheduler that never fires (the Swift export's event sink).
   */
  readonly onFrameRequested?: (reason: RenderInvalidationReason) => void;
}

/** Below this share of a frame's interval a callback counts as the frame being due (refresh jitter). */
const frameIntervalTolerance = 0.9;

/**
 * The on-demand render loop on `requestAnimationFrame` (Swift
 * `ImmersiveMapRenderDriver` with its display link): it runs while
 * `RenderLoopPacing.needsFrameRendering` says so and stops otherwise, and
 * any request or activity wakes it.
 *
 * Each callback: the external camera drive expires, the loop stops if
 * nothing needs a frame, and otherwise the frame is drawn when it is due. A
 * browser cannot be asked for a refresh rate, so the rate is met by skipping
 * callbacks: with the headroom allowed (interaction-class activities) every
 * refresh draws, and without it (the label fade at its low cadence, a power
 * ceiling) a callback earlier than `1 / targetFramesPerSecond` after the
 * last frame waits for the next refresh.
 */
export class RenderLoopDriver implements CameraRenderRequests {
  readonly pacing: RenderLoopPacing;
  private readonly renderFrame: (now: number) => boolean;
  private readonly scheduler: AnimationFrameScheduler;
  private readonly clock: () => number;
  /** With the default clock, a frame's time is the browser's frame timestamp (see `tick`). */
  private readonly usesFrameTimestamps: boolean;
  private readonly onFrameRequested: ((reason: RenderInvalidationReason) => void) | undefined;
  private scheduledHandle: number | null = null;
  private lastFrameTime: number | null = null;
  private isStopped = false;

  constructor(options: RenderLoopDriverOptions) {
    this.pacing = new RenderLoopPacing(options.configuration);
    this.renderFrame = options.renderFrame;
    this.scheduler = options.scheduler ?? {
      requestAnimationFrame: (callback) => globalThis.requestAnimationFrame(callback),
      cancelAnimationFrame: (handle) => globalThis.cancelAnimationFrame(handle),
    };
    this.clock = options.now ?? ((): number => performance.now() / 1000);
    this.usesFrameTimestamps = options.now === undefined;
    this.onFrameRequested = options.onFrameRequested;
  }

  /** Whether a frame callback is scheduled: the loop is running. */
  get isRunning(): boolean {
    return this.scheduledHandle !== null;
  }

  requestFrame(reason: RenderInvalidationReason = "externalStateChanged"): void {
    this.pacing.requestOneFrame(reason);
    this.onFrameRequested?.(reason);
    this.wake();
  }

  setRenderingActivity(activity: RenderLoopActivity, isActive: boolean): void {
    this.pacing.setRenderingActivity(activity, isActive);
    this.wake();
  }

  setCameraAnimationRenderingActive(isActive: boolean): void {
    this.setRenderingActivity("cameraAnimation", isActive);
  }

  setInteractionRenderingActive(isActive: boolean): void {
    this.setRenderingActivity("interaction", isActive);
  }

  noteExternalCameraDrive(): void {
    this.pacing.noteExternalCameraDrive(this.clock());
    this.wake();
  }

  applyConfiguration(configuration: RenderLoopSettings): void {
    this.pacing.applyConfiguration(configuration);
    this.wake();
  }

  applyPowerConstraintState(constraints: PowerConstraintState): void {
    this.pacing.applyPowerConstraintState(constraints);
  }

  /** A hidden map (a background tab, a detached canvas) parks the loop. Showing it again resumes what accumulated. */
  setParked(parked: boolean): void {
    this.pacing.setParked(parked);
    this.wake();
  }

  /** Starts the loop again after `stop`. */
  start(): void {
    this.isStopped = false;
    this.wake();
  }

  /** Stops the loop for good until `start`: the map is being destroyed. */
  stop(): void {
    this.isStopped = true;
    if (this.scheduledHandle !== null) {
      this.scheduler.cancelAnimationFrame(this.scheduledHandle);
      this.scheduledHandle = null;
    }
  }

  private wake(): void {
    if (this.isStopped || this.scheduledHandle !== null || !this.pacing.needsFrameRendering) {
      return;
    }
    this.scheduledHandle = this.scheduler.requestAnimationFrame((timestamp) => this.tick(timestamp));
  }

  /**
   * `timestamp` is the browser's time of the frame in milliseconds, the same
   * for every callback of one refresh and on the timeline of
   * `performance.now()`. It is the frame's time, as the display link's
   * timestamp is in the Swift engine: the moment the callback happens to run
   * wanders by a millisecond or two inside the frame, and animations stepped
   * by it (the pitch and bearing follows, the flights) move unevenly from
   * frame to frame although every frame is on time.
   */
  private tick(timestamp?: number): void {
    this.scheduledHandle = null;
    const now = this.usesFrameTimestamps && timestamp !== undefined && Number.isFinite(timestamp) ? timestamp / 1000 : this.clock();
    this.pacing.expireExternalCameraDrive(now);
    if (!this.pacing.needsFrameRendering) {
      this.lastFrameTime = null;
      return;
    }
    if (this.isFrameDue(now)) {
      this.lastFrameTime = now;
      if (this.renderFrame(now)) {
        this.pacing.consumeOneFrameRequest();
      }
    }
    this.wake();
  }

  private isFrameDue(now: number): boolean {
    const target = this.pacing.targetFramesPerSecond;
    if (this.lastFrameTime === null || target <= 0 || this.pacing.allowsFrameRateHeadroom) {
      return true;
    }
    return now - this.lastFrameTime >= frameIntervalTolerance / target;
  }
}
