// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The phases of a scroll gesture, as bit flags combined with `|` (Swift
 * `NSEvent.Phase`). Zero is no phase at all: a discrete wheel event, or the
 * half of the gesture that does not apply.
 */
export const ScrollPhase = {
  none: 0,
  began: 1 << 0,
  stationary: 1 << 1,
  changed: 1 << 2,
  ended: 1 << 3,
  cancelled: 1 << 4,
  mayBegin: 1 << 5,
} as const;

export type ScrollZoomTransition = "begin" | "end";

/**
 * Decides when a scroll zoom counts as an interaction in progress.
 *
 * A scroll gesture on a trackpad has two halves. While the fingers are down
 * the events carry `phase`. After they lift, the system keeps sending
 * decelerating events that carry `momentumPhase` instead, and those move the
 * camera exactly like the first half did. Ending the interaction when the
 * fingers lift therefore ends it in the middle of the movement: the render
 * loop drops back to on demand and the rest of the zoom is drawn one
 * requested frame at a time, which is the judder a fast flick shows and a
 * slow zoom does not.
 *
 * The browser's `wheel` event carries neither phase, so the gesture
 * controller synthesizes them: the first event of a burst is `began`, the
 * rest `changed`, and a pause in the stream `ended`. Where a platform hands
 * the momentum half over as such, it maps onto `momentumPhase`.
 */
export const ScrollZoomInteractionPhaseResolver = {
  /** Null means no change: the middle of either half of the gesture. */
  transition(phase: number, momentumPhase: number): ScrollZoomTransition | null {
    if ((momentumPhase & (ScrollPhase.ended | ScrollPhase.cancelled)) !== 0) {
      return "end";
    }
    if ((momentumPhase & ScrollPhase.began) !== 0) {
      // The deceleration is the same gesture continuing, so rendering stays
      // continuous through it.
      return "begin";
    }
    if ((phase & ScrollPhase.began) !== 0) {
      return "begin";
    }
    if ((phase & (ScrollPhase.ended | ScrollPhase.cancelled)) !== 0) {
      // Fingers up. Momentum, if the system decides to send any, opens with
      // its own `began` and takes over from here.
      return "end";
    }
    return null;
  },
} as const;
