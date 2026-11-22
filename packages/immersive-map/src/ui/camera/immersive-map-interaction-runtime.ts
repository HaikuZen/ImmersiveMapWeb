// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { CameraRenderRequests } from "../render-loop-pacing.ts";

/**
 * A source of user interaction. `mapTilt` is the tilt on the map canvas (the
 * two-finger vertical drag on a touch screen, the right-button or Alt drag
 * with a mouse), kept apart from `pitchControl` because the sources are a
 * plain set: the zone and a canvas tilt can run at once on separate
 * pointers, and a shared value would let whichever ends first deactivate
 * both.
 */
export type InteractionSource = "mapPan" | "mapPinch" | "mapRotation" | "mapTilt" | "pitchControl" | "zoomControl" | "scrollZoom";

/** The host the runtime reports to: the start of a user gesture, which stops tours and follows. */
export interface UserInteractionSink {
  notifyUserInteractionBegan(): void;
}

/**
 * Tracks which interactions are under way (Swift `ImmersiveMapInteractionRuntime`,
 * `UI/Runtime`): the render loop runs at the interaction rate while any is,
 * the camera animations yield to it, and the first one to begin reports the
 * user interaction.
 */
export class ImmersiveMapInteractionRuntime {
  private readonly activeSources = new Set<InteractionSource>();
  private readonly sink: UserInteractionSink;
  private readonly render: CameraRenderRequests;

  constructor(sink: UserInteractionSink, render: CameraRenderRequests) {
    this.sink = sink;
    this.render = render;
  }

  get hasActiveUserInteraction(): boolean {
    return this.activeSources.size > 0;
  }

  isActive(source: InteractionSource): boolean {
    return this.activeSources.has(source);
  }

  setActive(isActive: boolean, source: InteractionSource, notifiesUserInteractionBegan: boolean, requestsFrameOnStart = false): void {
    const wasInteracting = this.hasActiveUserInteraction;
    if (isActive) {
      this.activeSources.add(source);
    } else {
      this.activeSources.delete(source);
    }

    if (isActive && !wasInteracting && notifiesUserInteractionBegan) {
      this.sink.notifyUserInteractionBegan();
    }

    this.render.setInteractionRenderingActive(this.hasActiveUserInteraction);

    if (isActive && requestsFrameOnStart) {
      this.render.requestFrame();
    }

    // One more frame after the last gesture lets go: the animations that
    // carry on after the user, the elastic bounds' pull among them, keep the
    // loop running only from a frame, which would otherwise stop right here.
    if (wasInteracting && !this.hasActiveUserInteraction) {
      this.render.requestFrame();
    }
  }

  /**
   * Clears every active source when the map parks or loses its pointer
   * stream: an interrupted gesture never delivers its end, and a source stuck
   * active would keep the render loop hot and cancel the next camera flight.
   */
  resetForParking(): void {
    if (this.activeSources.size === 0) {
      return;
    }
    this.activeSources.clear();
    this.render.setInteractionRenderingActive(false);
  }
}
