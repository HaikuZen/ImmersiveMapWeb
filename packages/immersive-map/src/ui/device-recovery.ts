// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * When the map builds its renderer again after the browser took its WebGPU
 * device away. A browser loses a page's devices when its GPU process resets
 * (a driver fault, a submission the watchdog found too long, from this page
 * or another), when a hidden tab's memory is reclaimed, or when a laptop
 * switches its GPU: the map then draws nothing until it has a new device.
 * The map builds its renderer again on a new one (`ImmersiveMap`), the
 * camera, the controllers and the listeners kept, as for new settings. A
 * GPU that keeps failing is given up on rather than tried in a loop: at
 * most `maximumAttempts` within `windowMilliseconds`, each after a wait
 * that grows.
 */
export class DeviceRecovery {
  private readonly attempts: number[] = [];

  constructor(
    private readonly maximumAttempts = 3,
    private readonly windowMilliseconds = 60_000,
    private readonly firstWaitMilliseconds = 250,
  ) {}

  /**
   * The wait before the next attempt to build the renderer again, in
   * milliseconds, or `null` when the attempts within the window are spent.
   * Each call counts as an attempt.
   */
  nextAttempt(now: number): number | null {
    while (this.attempts.length > 0 && now - this.attempts[0]! >= this.windowMilliseconds) this.attempts.shift();
    if (this.attempts.length >= this.maximumAttempts) return null;
    const wait = this.firstWaitMilliseconds * 2 ** this.attempts.length;
    this.attempts.push(now);
    return wait;
  }
}

/** A loss the map tells the app of (`ImmersiveMap.onDeviceLost`). */
export interface ImmersiveMapDeviceLostEvent {
  /** The browser's reason, `"unknown"` for anything but a device destroyed on purpose. */
  readonly reason: string;
  /** The browser's message. */
  readonly message: string;
  /** Whether the map builds its renderer again; false once it gave up, and it then draws nothing. */
  readonly restoring: boolean;
}
