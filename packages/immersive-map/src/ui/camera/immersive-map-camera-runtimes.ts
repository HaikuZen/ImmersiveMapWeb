// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import type { Vec2 } from "../../math/vec.ts";
import type { CameraPresentationSettings } from "../../presentation/camera-presentation-settings.ts";
import type { CameraRenderRequests } from "../render-loop-pacing.ts";
import { ImmersiveMapCameraAnimationRuntime } from "./immersive-map-camera-animation-runtime.ts";
import { ImmersiveMapCameraCommandHandler } from "./immersive-map-camera-command-handler.ts";
import type { ImmersiveMapCameraController } from "./immersive-map-camera-controller.ts";
import { type CameraControlsSink, ImmersiveMapCameraRuntime } from "./immersive-map-camera-runtime.ts";
import { ImmersiveMapInteractionRuntime } from "./immersive-map-interaction-runtime.ts";

export interface ImmersiveMapCameraRuntimesOptions {
  readonly settings: CameraPresentationSettings;
  /** Where the camera opens. Null or omitted keeps the renderer's own start. */
  readonly initialCameraPosition?: ImmersiveMapCameraPosition | null;
  /** The app's camera controller, attached at once (its queued commands replay). */
  readonly cameraController?: ImmersiveMapCameraController | null;
  /** The render loop (`RenderLoopDriver`), or anything that takes the same requests. */
  readonly render: CameraRenderRequests;
  readonly controls?: CameraControlsSink;
  /** The map's size in CSS pixels. */
  readonly viewportSize: () => Vec2;
  /** Seconds on the render loop's clock, `performance.now() / 1000` by default. */
  readonly now?: () => number;
}

/** The camera side of one map, wired the way the Swift runtime graph wires it. */
export interface ImmersiveMapCameraRuntimes {
  readonly cameraRuntime: ImmersiveMapCameraRuntime;
  readonly cameraAnimationRuntime: ImmersiveMapCameraAnimationRuntime;
  readonly interactionRuntime: ImmersiveMapInteractionRuntime;
  readonly commandHandler: ImmersiveMapCameraCommandHandler;
}

/**
 * Builds the camera runtime, its frame camera, the animation and interaction
 * runtimes and the command handler, and attaches the controller. The map
 * then:
 *
 * - each frame, calls `cameraAnimationRuntime.advanceAnimationsIfNeeded(now)`
 *   and then `cameraRuntime.renderCamera.makeFrameState(width, height,
 *   transition)` for the frame's camera;
 * - hands `cameraRuntime`, `cameraAnimationRuntime` and `interactionRuntime`
 *   to the `MapGestureController`;
 * - on teardown, calls `cameraRuntime.detachController()`.
 */
export function createImmersiveMapCameraRuntimes(options: ImmersiveMapCameraRuntimesOptions): ImmersiveMapCameraRuntimes {
  const now = options.now ?? ((): number => performance.now() / 1000);
  const cameraRuntime = new ImmersiveMapCameraRuntime({
    settings: options.settings,
    initialCameraPosition: options.initialCameraPosition ?? null,
    render: options.render,
    viewportSize: options.viewportSize,
    ...(options.controls === undefined ? {} : { controls: options.controls }),
  });
  const interactionRuntime = new ImmersiveMapInteractionRuntime(cameraRuntime, options.render);
  const cameraAnimationRuntime = new ImmersiveMapCameraAnimationRuntime(cameraRuntime, interactionRuntime, options.render, now);
  const commandHandler = new ImmersiveMapCameraCommandHandler(cameraRuntime, cameraAnimationRuntime, interactionRuntime);
  cameraRuntime.makeRenderCamera(options.settings, options.initialCameraPosition ?? null);
  if (options.cameraController !== undefined && options.cameraController !== null) {
    cameraRuntime.attachController(options.cameraController, (command) => commandHandler.handle(command));
  }
  return { cameraRuntime, cameraAnimationRuntime, interactionRuntime, commandHandler };
}
