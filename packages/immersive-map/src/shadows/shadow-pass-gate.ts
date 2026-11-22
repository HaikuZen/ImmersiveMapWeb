// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ShadowFrameState } from "./shadow-frame-state.ts";

/**
 * The single per-frame decision "does the shadow pass run", a port of the
 * Swift `ShadowPassGateResolver`: the resolved shadow state must exist and
 * at least one caster must be present. Asked the same way by the pass plan
 * and by every receiver's bind site, so the pass and the samplers never
 * disagree within a frame. The buildings cast only where they draw, the
 * models wherever they stand, the mountains wherever the relief stands.
 */
export const ShadowPassGateResolver = {
  resolve(
    state: ShadowFrameState | undefined,
    casters: { readonly hasBuildingCasters: boolean; readonly hasModelCasters: boolean; readonly hasTerrainCasters?: boolean },
  ): ShadowFrameState | undefined {
    if (state === undefined) return undefined;
    if (!casters.hasBuildingCasters && !casters.hasModelCasters && casters.hasTerrainCasters !== true) return undefined;
    return state;
  },
} as const;
