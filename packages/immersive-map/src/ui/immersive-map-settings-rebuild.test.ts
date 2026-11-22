// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import { planSettingsApplication } from "../configuration/settings-application-planner.ts";
import { resolveSettingsRebuild } from "./immersive-map-settings-rebuild.ts";

const base = ImmersiveMapSettings.default;
const rebuild = (next: ImmersiveMapSettings) => resolveSettingsRebuild(base, next, planSettingsApplication(base, next));

describe("resolveSettingsRebuild", () => {
  it("does nothing for equal settings", () => {
    expect(rebuild(ImmersiveMapSettings.default)).toBe("none");
  });

  it("applies the scene's per-frame groups live", () => {
    expect(rebuild(base.edit((s) => void (s.scene.shadows.isEnabled = !base.scene.shadows.isEnabled)))).toBe("live");
    expect(rebuild(base.edit((s) => void (s.scene.fog.isEnabled = !base.scene.fog.isEnabled)))).toBe("live");
    expect(rebuild(base.edit((s) => void (s.scene.groundFog.isEnabled = !base.scene.groundFog.isEnabled)))).toBe("live");
  });

  it("applies the debug panel's switch live, where Swift recreates its renderer", () => {
    const next = base.debugPanel(true);
    expect(planSettingsApplication(base, next).requiresRendererRecreation).toBe(true);
    expect(rebuild(next)).toBe("live");
  });

  it("rebuilds the tiles for what the workers alone read", () => {
    expect(rebuild(base.edit((s) => void (s.tiles.overview.isEnabled = !base.tiles.overview.isEnabled)))).toBe("tiles");
    expect(rebuild(base.edit((s) => void (s.tiles.parsing.maximumConcurrentParses = base.tiles.parsing.maximumConcurrentParses + 1)))).toBe("tiles");
  });

  it("rebuilds the GPU side for what it is built with", () => {
    expect(rebuild(base.msaa())).toBe("renderer");
    expect(rebuild(base.edit((s) => void (s.labels.isEnabled = !base.data.labels.isEnabled)))).toBe("renderer");
    expect(rebuild(base.edit((s) => void (s.tiles.network.maxConcurrentFetches = base.tiles.network.maxConcurrentFetches + 1)))).toBe("renderer");
  });

  it("rebuilds the GPU side for the groups the web subsystems take when made", () => {
    const next = base.edit((s) => void (s.scene.extrusion.riseSeconds = base.scene.extrusion.riseSeconds + 1));
    expect(planSettingsApplication(base, next).requiresRendererRecreation).toBe(false);
    expect(rebuild(next)).toBe("renderer");
  });

  it("keeps the relief's surroundings and shadows live", () => {
    const shadows = base.edit((s) => void (s.tiles.groundRelief.castsShadows = !base.tiles.groundRelief.castsShadows));
    expect(rebuild(shadows)).toBe("live");
    const surroundings = base.edit((s) => void (s.tiles.groundRelief.surroundings.sampleRadiusMetres = base.tiles.groundRelief.surroundings.sampleRadiusMetres + 100));
    expect(rebuild(surroundings)).toBe("live");
  });
});
