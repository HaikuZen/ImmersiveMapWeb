// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ScrollPhase, ScrollZoomInteractionPhaseResolver, type ScrollZoomTransition } from "./scroll-zoom-interaction-phase-resolver.ts";

const transition = (phase: number, momentum: number = ScrollPhase.none): ScrollZoomTransition | null =>
  ScrollZoomInteractionPhaseResolver.transition(phase, momentum);

/**
 * A trackpad zoom keeps moving the camera after the fingers lift, through the
 * momentum events. These pin that the interaction spans both halves, because
 * ending it at the lift drops the render loop back to on demand for the rest
 * of the movement.
 */
describe("ScrollZoomInteractionPhaseResolver", () => {
  test("fingers down begin and keep the interaction", () => {
    expect(transition(ScrollPhase.began)).toBe("begin");
    expect(transition(ScrollPhase.changed), "The middle of the gesture changes nothing").toBeNull();
  });

  test("momentum carries the interaction past the lift", () => {
    expect(transition(ScrollPhase.none, ScrollPhase.began), "Deceleration is the same gesture continuing").toBe("begin");
    expect(transition(ScrollPhase.none, ScrollPhase.changed), "The middle of the deceleration changes nothing").toBeNull();
    expect(transition(ScrollPhase.none, ScrollPhase.ended), "The interaction ends when the movement does").toBe("end");
    expect(transition(ScrollPhase.none, ScrollPhase.cancelled)).toBe("end");
  });

  test("a lift without momentum ends the interaction", () => {
    expect(transition(ScrollPhase.ended), "A gesture the system sends no momentum for ends at the lift").toBe("end");
    expect(transition(ScrollPhase.cancelled)).toBe("end");
  });

  /** A lift followed by momentum must not leave the loop on demand for the deceleration. */
  test("a lift followed by momentum restores the interaction", () => {
    expect(transition(ScrollPhase.ended)).toBe("end");
    expect(transition(ScrollPhase.none, ScrollPhase.began)).toBe("begin");
    expect(transition(ScrollPhase.none, ScrollPhase.changed)).toBeNull();
    expect(transition(ScrollPhase.none, ScrollPhase.ended)).toBe("end");
  });

  /** A momentum end must win if both ever arrive together, since it is the later half. */
  test("a momentum end wins over a concurrent began phase", () => {
    expect(transition(ScrollPhase.began, ScrollPhase.ended)).toBe("end");
  });
});
