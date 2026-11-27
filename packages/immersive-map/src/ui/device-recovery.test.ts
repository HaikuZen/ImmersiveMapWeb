// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { DeviceRecovery } from "./device-recovery.ts";

describe("DeviceRecovery", () => {
  it("waits longer at each attempt and gives up past the attempts of the window", () => {
    const recovery = new DeviceRecovery(3, 60_000, 250);
    expect(recovery.nextAttempt(0)).toBe(250);
    expect(recovery.nextAttempt(1_000)).toBe(500);
    expect(recovery.nextAttempt(2_000)).toBe(1_000);
    expect(recovery.nextAttempt(3_000)).toBeNull();
  });

  it("tries again once the earlier attempts left the window", () => {
    const recovery = new DeviceRecovery(2, 60_000, 250);
    expect(recovery.nextAttempt(0)).toBe(250);
    expect(recovery.nextAttempt(10_000)).toBe(500);
    expect(recovery.nextAttempt(20_000)).toBeNull();
    expect(recovery.nextAttempt(60_000)).toBe(500);
    expect(recovery.nextAttempt(70_000)).toBe(500);
  });
});
