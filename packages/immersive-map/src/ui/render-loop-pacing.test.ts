// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { defaultRenderLoopSettings, renderLoopSettings } from "../configuration/view-settings.ts";
import { PowerConstraintState, RenderLoopDriver, RenderLoopPacing } from "./render-loop-pacing.ts";

/**
 * Swift `RenderLoopPacingParkedTests`. A parked map has nothing to present
 * into: pacing must gate off every rendering reason (pending one-shot
 * requests, activities, even forceContinuousRendering) and hand them back
 * when the map is shown again.
 */
describe("RenderLoopPacing parked", () => {
  test("parked pacing pauses despite pending work", () => {
    const pacing = new RenderLoopPacing(defaultRenderLoopSettings);
    pacing.requestOneFrame("tileAvailable");
    pacing.setRenderingActivity("labelFade", true);
    expect(pacing.needsFrameRendering).toBe(true);
    pacing.setParked(true);
    expect(pacing.needsFrameRendering).toBe(false);
    expect(pacing.shouldPauseDisplayLink).toBe(true);
  });

  test("parked pacing overrides forced continuous rendering", () => {
    const pacing = new RenderLoopPacing(renderLoopSettings({ forceContinuousRendering: true }));
    expect(pacing.needsFrameRendering).toBe(true);
    pacing.setParked(true);
    expect(pacing.needsFrameRendering).toBe(false);
  });

  test("accumulated work resumes when shown again", () => {
    const pacing = new RenderLoopPacing(defaultRenderLoopSettings);
    pacing.setParked(true);
    pacing.requestOneFrame("tileAvailable");
    pacing.setRenderingActivity("labelFade", true);
    expect(pacing.needsFrameRendering).toBe(false);
    pacing.setParked(false);
    expect(pacing.needsFrameRendering).toBe(true);
  });
});

/**
 * Swift `RenderLoopPacingExternalCameraDriveTests`. A camera position set
 * from outside keeps the loop awake for a grace period at the interaction
 * rate, so an app driving the camera once per frame never stops and starts
 * the loop between two frames, while a lone jump still lets it stop once the
 * grace has passed.
 */
describe("RenderLoopPacing external camera drive", () => {
  const grace = RenderLoopPacing.externalCameraDriveGraceSeconds;

  test("a jump keeps the loop awake at the interaction rate", () => {
    const pacing = new RenderLoopPacing(defaultRenderLoopSettings);
    expect(pacing.shouldPauseDisplayLink).toBe(true);
    pacing.noteExternalCameraDrive(10);
    expect(pacing.needsFrameRendering).toBe(true);
    expect(pacing.shouldPauseDisplayLink).toBe(false);
    expect(pacing.targetFramesPerSecond).toBe(defaultRenderLoopSettings.interactionFramesPerSecond);
    expect(pacing.allowsFrameRateHeadroom).toBe(true);
  });

  test("the drive expires once its grace has passed", () => {
    const pacing = new RenderLoopPacing(defaultRenderLoopSettings);
    pacing.noteExternalCameraDrive(10);
    pacing.expireExternalCameraDrive(10 + grace / 2);
    expect(pacing.needsFrameRendering, "still inside the grace").toBe(true);
    pacing.expireExternalCameraDrive(10 + grace);
    expect(pacing.needsFrameRendering).toBe(false);
    expect(pacing.shouldPauseDisplayLink).toBe(true);
  });

  test("consecutive jumps push the deadline", () => {
    const pacing = new RenderLoopPacing(defaultRenderLoopSettings);
    pacing.noteExternalCameraDrive(10);
    pacing.expireExternalCameraDrive(10 + grace * 0.8);
    pacing.noteExternalCameraDrive(10 + grace * 0.8);
    pacing.expireExternalCameraDrive(10 + grace * 1.5);
    expect(pacing.needsFrameRendering, "the second jump extended the grace").toBe(true);
    pacing.expireExternalCameraDrive(10 + grace * 1.8);
    expect(pacing.needsFrameRendering).toBe(false);
  });

  test("the expiry leaves other activities alone", () => {
    const pacing = new RenderLoopPacing(defaultRenderLoopSettings);
    pacing.setRenderingActivity("labelFade", true);
    pacing.noteExternalCameraDrive(10);
    pacing.expireExternalCameraDrive(10 + grace);
    expect(pacing.needsFrameRendering).toBe(true);
    expect(pacing.targetFramesPerSecond).toBe(defaultRenderLoopSettings.labelFadeFramesPerSecond);
  });
});

/** Swift `RenderLoopPacingPowerConstraintStateTests`. */
describe("RenderLoopPacing power constraints", () => {
  const makePacing = (): RenderLoopPacing =>
    new RenderLoopPacing({ forceContinuousRendering: false, interactionFramesPerSecond: 120, labelFadeFramesPerSecond: 30 });

  test("resolve maps thermal states to ceilings", () => {
    expect(PowerConstraintState.resolve("nominal", false)).toEqual(PowerConstraintState.unconstrained);
    expect(PowerConstraintState.resolve("fair", false)).toEqual(PowerConstraintState.unconstrained);
    expect(PowerConstraintState.resolve("serious", false)).toEqual({ maximumFramesPerSecond: 60, allowsProMotionHeadroom: false });
    expect(PowerConstraintState.resolve("critical", false)).toEqual({ maximumFramesPerSecond: 30, allowsProMotionHeadroom: false });
  });

  test("resolve with low power mode only revokes the headroom", () => {
    expect(PowerConstraintState.resolve("nominal", true)).toEqual({ maximumFramesPerSecond: null, allowsProMotionHeadroom: false });
  });

  test("a ceiling caps the interaction and label fade rates", () => {
    const pacing = makePacing();
    pacing.setRenderingActivity("interaction", true);
    expect(pacing.targetFramesPerSecond).toBe(120);
    pacing.applyPowerConstraintState({ maximumFramesPerSecond: 60, allowsProMotionHeadroom: false });
    expect(pacing.targetFramesPerSecond).toBe(60);
    pacing.setRenderingActivity("interaction", false);
    pacing.setRenderingActivity("labelFade", true);
    pacing.applyPowerConstraintState({ maximumFramesPerSecond: 15, allowsProMotionHeadroom: false });
    expect(pacing.targetFramesPerSecond).toBe(15);
  });

  test("constraints revoke the headroom and unconstrained restores it", () => {
    const pacing = makePacing();
    pacing.setRenderingActivity("interaction", true);
    expect(pacing.allowsFrameRateHeadroom).toBe(true);
    pacing.applyPowerConstraintState({ maximumFramesPerSecond: null, allowsProMotionHeadroom: false });
    expect(pacing.allowsFrameRateHeadroom).toBe(false);
    pacing.applyPowerConstraintState(PowerConstraintState.unconstrained);
    expect(pacing.allowsFrameRateHeadroom).toBe(true);
  });

  test("a ceiling leaves the idle target at zero", () => {
    const pacing = makePacing();
    pacing.applyPowerConstraintState({ maximumFramesPerSecond: 30, allowsProMotionHeadroom: false });
    expect(pacing.targetFramesPerSecond).toBe(0);
  });

  test("the reason description lists what keeps the loop running", () => {
    const pacing = makePacing();
    expect(pacing.renderingReasonDescription).toBeNull();
    pacing.requestOneFrame("tileAvailable");
    pacing.setRenderingActivity("cameraAnimation", true);
    pacing.setRenderingActivity("interaction", true);
    expect(pacing.renderingReasonDescription).toBe("pending frame: tile available, interaction, camera animation");
  });
});

/** The loop on `requestAnimationFrame`, driven by a fake scheduler and clock. */
describe("RenderLoopDriver", () => {
  function makeDriver(rendered: number[], configuration = defaultRenderLoopSettings) {
    const callbacks: ((time: number) => void)[] = [];
    let time = 0;
    const driver = new RenderLoopDriver({
      configuration,
      renderFrame: (now) => {
        rendered.push(now);
        return true;
      },
      scheduler: {
        requestAnimationFrame: (callback) => callbacks.push(callback),
        cancelAnimationFrame: () => undefined,
      },
      now: () => time,
    });
    const refresh = (seconds: number): void => {
      time += seconds;
      const due = callbacks.splice(0);
      for (const callback of due) {
        callback(time * 1000);
      }
    };
    return { driver, refresh, pending: () => callbacks.length };
  }

  test("a one-shot request draws one frame and the loop stops", () => {
    const rendered: number[] = [];
    const { driver, refresh, pending } = makeDriver(rendered);
    expect(pending()).toBe(0);
    driver.requestFrame();
    driver.requestFrame();
    expect(pending(), "one callback for any number of requests").toBe(1);
    refresh(1 / 60);
    expect(rendered.length).toBe(1);
    refresh(1 / 60);
    expect(rendered.length).toBe(1);
    expect(driver.isRunning).toBe(false);
  });

  test("an activity keeps the loop running until it ends", () => {
    const rendered: number[] = [];
    const { driver, refresh } = makeDriver(rendered);
    driver.setInteractionRenderingActive(true);
    for (let frame = 0; frame < 5; frame++) {
      refresh(1 / 60);
    }
    expect(rendered.length).toBe(5);
    driver.setInteractionRenderingActive(false);
    refresh(1 / 60);
    expect(driver.isRunning).toBe(false);
  });

  test("the label fade runs at its own cadence on a faster display", () => {
    const rendered: number[] = [];
    const { driver, refresh } = makeDriver(rendered);
    driver.setRenderingActivity("labelFade", true);
    for (let frame = 0; frame < 120; frame++) {
      refresh(1 / 120);
    }
    expect(rendered.length).toBeGreaterThanOrEqual(29);
    expect(rendered.length).toBeLessThanOrEqual(31);
  });

  test("an external camera drive expires after its grace", () => {
    const rendered: number[] = [];
    const { driver, refresh } = makeDriver(rendered);
    driver.noteExternalCameraDrive();
    for (let frame = 0; frame < 20; frame++) {
      refresh(1 / 60);
    }
    expect(driver.isRunning).toBe(false);
    expect(rendered.length).toBeGreaterThan(3);
    expect(rendered.length).toBeLessThan(10);
  });

  test("parking stops the loop and showing resumes it", () => {
    const rendered: number[] = [];
    const { driver, refresh, pending } = makeDriver(rendered);
    driver.setParked(true);
    driver.requestFrame();
    expect(pending()).toBe(0);
    driver.setParked(false);
    refresh(1 / 60);
    expect(rendered.length).toBe(1);
  });
});
