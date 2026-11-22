// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { CameraPitchFollowMath } from "../math/camera-pitch-follow-math.ts";
import { CameraPitchFollow, CameraPitchFollowConfiguration } from "./camera-pitch-follow.ts";

describe("CameraPitchFollow", () => {
  const enabledConfiguration = (halfLife = 0.06): CameraPitchFollowConfiguration => new CameraPitchFollowConfiguration(true, halfLife);

  test("the stepped pitch halves the gap after one half-life", () => {
    // After one half-life the gap to the target must shrink exactly by half.
    expect(Math.abs(CameraPitchFollowMath.steppedPitch(0, 1, 0.06, 0.06) - 0.5)).toBeLessThanOrEqual(0.0005);
  });

  test("the follow converges to the target and deactivates", () => {
    const follow = new CameraPitchFollow(enabledConfiguration());
    expect(follow.retarget(1.0, 0)).toBe(true);

    let pitch = 0;
    let time = 0;
    let didFinish = false;
    for (let frame = 0; frame < 600; frame++) {
      // Up to 10 s at 60 fps, with headroom.
      time += 1.0 / 60.0;
      const step = follow.advance(pitch, time);
      pitch = step.pitch;
      if (!step.isActive) {
        didFinish = true;
        break;
      }
    }

    expect(didFinish, "follow must finish instead of spinning forever").toBe(true);
    expect(follow.active).toBe(false);
    expect(Math.abs(pitch - 1.0)).toBeLessThanOrEqual(0.001);
  });

  test("the follow step is frame-rate independent", () => {
    // The exponential model is multiplicative: the remaining gap depends only
    // on the total elapsed time, not on the number of frames. Hence 60 fps
    // and 240 fps yield the same pitch at the same point in time, which is
    // exactly the removal of event-rate dependence.
    function pitch(seconds: number, stepsPerSecond: number): number {
      const follow = new CameraPitchFollow(enabledConfiguration());
      follow.retarget(1.0, 0);
      let value = 0;
      const dt = 1.0 / stepsPerSecond;
      const stepCount = Math.round(seconds / dt);
      let time = 0;
      for (let step = 0; step < stepCount; step++) {
        time += dt;
        value = follow.advance(value, time).pitch;
      }
      return value;
    }

    const slow = pitch(0.1, 60);
    const fast = pitch(0.1, 240);
    const expected = 1.0 - 0.5 ** (0.1 / 0.06);
    expect(Math.abs(slow - fast)).toBeLessThanOrEqual(0.0005);
    expect(Math.abs(slow - expected)).toBeLessThanOrEqual(0.0005);
  });

  test("the follow stops when the pitch is saturated at the ceiling", () => {
    // If the actual pitch hits the ceiling (the clamp holds the value) while
    // the target is higher, follow must stop, otherwise the frames keep
    // coming forever.
    const follow = new CameraPitchFollow(enabledConfiguration());
    follow.retarget(2.0, 0);

    const saturatedPitch = 1.0;
    let time = 0;
    let becameInactive = false;
    for (let frame = 0; frame < 10; frame++) {
      time += 1.0 / 60.0;
      if (!follow.advance(saturatedPitch, time).isActive) {
        becameInactive = true;
        break;
      }
    }

    expect(becameInactive, "follow must stop once it runs into the ceiling").toBe(true);
    expect(follow.active).toBe(false);
  });

  test("a retarget moments before a frame is not taken for a stall", () => {
    // A browser delivers a pointer move a fraction of a millisecond before
    // the frame it belongs to, so the first step after a retarget is tiny.
    // After a real stall at the ceiling, every later move restarted the
    // follow with such a step, and the next frame cancelled it as stalled.
    const follow = new CameraPitchFollow(enabledConfiguration());
    const ceiling = 1.4;
    let pitch = ceiling;
    let time = 10;
    // The drag pushes at the ceiling: the follow stalls there and stops.
    follow.retarget(1.48, time);
    for (let frame = 0; frame < 6; frame++) {
      time += 1 / 60;
      const step = follow.advance(pitch, time);
      pitch = Math.min(step.pitch, ceiling);
    }
    expect(follow.active).toBe(false);
    // The drag turns back: a step per frame, each 0.03 ms before its frame,
    // added to the follow's pending target as the tilt gesture adds it, or to
    // the camera's pitch when the follow is at rest.
    for (let frame = 0; frame < 30; frame++) {
      time += 1 / 60;
      follow.retarget((follow.pendingTarget ?? pitch) - 0.01, time - 0.00003);
      pitch = Math.min(follow.advance(pitch, time).pitch, ceiling);
    }
    for (let frame = 0; frame < 120; frame++) {
      time += 1 / 60;
      pitch = follow.advance(pitch, time).pitch;
    }
    expect(pitch).toBeCloseTo(ceiling - 0.3, 3);
  });

  test("a disabled follow applies instantly", () => {
    // With the setting disabled, retarget returns false and the caller applies pitch instantly.
    const follow = new CameraPitchFollow(new CameraPitchFollowConfiguration(false, 0.06));
    expect(follow.retarget(1.0, 0)).toBe(false);
    expect(follow.active).toBe(false);
  });

  test("a retarget while active keeps following the new target", () => {
    const follow = new CameraPitchFollow(enabledConfiguration());
    follow.retarget(1.0, 0);
    let pitch = 0;
    let time = 0;
    for (let frame = 0; frame < 3; frame++) {
      time += 1.0 / 60.0;
      pitch = follow.advance(pitch, time).pitch;
    }
    // Changing the target mid-flight must neither break the follow nor teleport the pitch.
    follow.retarget(0.2, time);
    expect(follow.active).toBe(true);

    let didFinish = false;
    for (let frame = 0; frame < 600; frame++) {
      time += 1.0 / 60.0;
      const step = follow.advance(pitch, time);
      pitch = step.pitch;
      if (!step.isActive) {
        didFinish = true;
        break;
      }
    }

    expect(didFinish).toBe(true);
    expect(Math.abs(pitch - 0.2)).toBeLessThanOrEqual(0.001);
  });
});
