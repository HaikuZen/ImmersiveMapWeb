// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { CameraBearingFollowMath } from "../math/camera-bearing-follow-math.ts";
import { CameraBearingFollow, CameraBearingFollowConfiguration } from "./camera-bearing-follow.ts";

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

describe("CameraBearingFollow", () => {
  const enabledConfiguration = (halfLife = 0.06): CameraBearingFollowConfiguration => new CameraBearingFollowConfiguration(true, halfLife);

  /** Runs the follow at 60 fps until it stops, at most 600 frames. */
  function run(
    follow: CameraBearingFollow,
    start: number,
    onStep: (bearing: number) => number = (bearing) => bearing,
    maximumAbsoluteBearing = Math.PI,
  ): { bearing: number; didFinish: boolean; maximum: number } {
    let bearing = start;
    let maximum = start;
    let time = 0;
    for (let frame = 0; frame < 600; frame++) {
      time += 1.0 / 60.0;
      const step = follow.advance(bearing, time, maximumAbsoluteBearing);
      bearing = onStep(step.bearing);
      maximum = Math.max(maximum, bearing);
      if (!step.isActive) {
        return { bearing, didFinish: true, maximum };
      }
    }
    return { bearing, didFinish: false, maximum };
  }

  test("the shortest delta takes the short path across the wrap", () => {
    // 170 -> -170 is +20 through 180, not -340 the long way around.
    expectClose(CameraBearingFollowMath.shortestDelta(radians(170), radians(-170)), radians(20), 0.001);
  });

  test("the follow converges to the target and deactivates", () => {
    const follow = new CameraBearingFollow(enabledConfiguration());
    expect(follow.retarget(radians(90), 0)).toBe(true);
    const result = run(follow, 0);
    expect(result.didFinish, "follow must finish instead of spinning forever").toBe(true);
    expect(follow.active).toBe(false);
    expectClose(result.bearing, radians(90), 0.001);
  });

  test("the follow crosses the wrap boundary the short way", () => {
    // From 170 to -170 the follow must go UP through 180 (bearing grows), not down through 0.
    const follow = new CameraBearingFollow(enabledConfiguration());
    const start = radians(170);
    const target = radians(-170);
    follow.retarget(target, 0);
    const result = run(follow, start);
    expect(result.didFinish).toBe(true);
    expect(result.maximum, "it had to pass upwards through 180 degrees").toBeGreaterThan(start);
    expectClose(CameraBearingFollowMath.shortestDelta(result.bearing, target), 0, 0.001);
  });

  test("the follow step is frame-rate independent", () => {
    function bearing(seconds: number, stepsPerSecond: number): number {
      const follow = new CameraBearingFollow(enabledConfiguration());
      follow.retarget(radians(90), 0);
      let value = 0;
      const dt = 1.0 / stepsPerSecond;
      const stepCount = Math.round(seconds / dt);
      let time = 0;
      for (let step = 0; step < stepCount; step++) {
        time += dt;
        value = follow.advance(value, time).bearing;
      }
      return value;
    }
    expectClose(bearing(0.1, 60), bearing(0.1, 240), 0.001);
  });

  test("the follow stops when the bearing is saturated at a limit", () => {
    // If the bearing hit a constraint (the value stops changing) while the
    // target is beyond it, follow must stop, otherwise the frames keep coming
    // forever.
    const follow = new CameraBearingFollow(enabledConfiguration());
    follow.retarget(radians(90), 0);
    const saturatedBearing = radians(30);
    let time = 0;
    let becameInactive = false;
    for (let frame = 0; frame < 10; frame++) {
      time += 1.0 / 60.0;
      if (!follow.advance(saturatedBearing, time).isActive) {
        becameInactive = true;
        break;
      }
    }
    expect(becameInactive, "follow must stop once it runs into the limit").toBe(true);
    expect(follow.active).toBe(false);
  });

  test("a disabled follow applies instantly", () => {
    const follow = new CameraBearingFollow(new CameraBearingFollowConfiguration(false, 0.06));
    expect(follow.retarget(radians(90), 0)).toBe(false);
    expect(follow.active).toBe(false);
  });

  // Bearing cap

  test("the follow delta takes the in-window path under a wide cap", () => {
    // With a 170 degree cap, 168 -> -168 the short way runs behind the
    // compass through the forbidden arc. The legal path goes down through
    // north.
    expectClose(CameraBearingFollowMath.followDelta(radians(168), radians(-168), radians(170)), radians(-336), 0.001);
  });

  test("the follow delta keeps the shortest path when unbounded", () => {
    expectClose(CameraBearingFollowMath.followDelta(radians(168), radians(-168), Math.PI), radians(24), 0.001);
  });

  /**
   * The stall scenario the shortest path produces under a wide cap: each
   * eased step toward the forbidden arc is clamped back to the cap edge and
   * the follow gives up at the wrong side of the compass. Along the in-window
   * path every step is legal, so the follow must arrive.
   */
  test("the follow reaches the opposite cap edge without crossing the forbidden arc", () => {
    const cap = radians(170);
    const follow = new CameraBearingFollow(enabledConfiguration());
    const target = radians(-168);
    follow.retarget(target, 0);
    const result = run(
      follow,
      radians(168),
      (stepped) => {
        // The constraint clamp that runs after every eased step.
        const clamped = Math.min(Math.max(stepped, -cap), cap);
        expect(Math.abs(clamped)).toBeLessThanOrEqual(cap + 0.001);
        return clamped;
      },
      cap,
    );
    expect(result.didFinish, "the follow must arrive instead of stalling at a cap edge").toBe(true);
    expectClose(result.bearing, target, 0.001);
  });
});
