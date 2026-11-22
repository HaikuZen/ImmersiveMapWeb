// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Mat4 } from "../math/matrix.ts";
import type { ShadowCasterPassPlan } from "./shadow-map-reuse-controller.ts";
import type { ShadowCascadeSlot } from "./shadow-cascade-atlas.ts";
import type { ShadowUniform } from "./shadow-uniform.ts";

/**
 * The frame's shadow state, a port of the Swift `ShadowFrameState`: the
 * light cameras of the caster passes, one per window of the map, and the
 * sampling uniform every receiver reads. `undefined` in its place means no
 * shadows this frame (the globe, shadows off, or a degenerate light).
 */
export interface ShadowFrameState {
  /** World to clip of the directional light's orthographic camera for the near window. */
  readonly lightProjectionView: Mat4;
  /** The same for the far window, `undefined` when the frame has none. */
  readonly farLightProjectionView: Mat4 | undefined;
  readonly shadowUniform: ShadowUniform;
  /** Square side of every slice of the shadow map in pixels. */
  readonly mapResolution: number;
  /**
   * How the frame's caster passes run, by window, set once the passes are
   * planned (`ShadowFrameRuntime.plan`): which casters a pass adds over its
   * kept slice and the hole whose casters it leaves out. A window without
   * an entry draws every caster.
   */
  readonly casterPasses?: ReadonlyMap<ShadowCascadeSlot, ShadowCasterPassPlan>;
}

export const ShadowFrameState = {
  /** The windows the frame renders, the near one always. */
  slots(state: ShadowFrameState): ShadowCascadeSlot[] {
    return state.farLightProjectionView === undefined ? ["near"] : ["near", "far"];
  },
  /** The light camera a window's casters draw with, `undefined` for a window the frame has not got. */
  lightProjectionView(state: ShadowFrameState, slot: ShadowCascadeSlot): Mat4 | undefined {
    return slot === "near" ? state.lightProjectionView : state.farLightProjectionView;
  },
  /** How a window's caster pass runs this frame, `undefined` for a pass that clears its slice and draws every caster. */
  casterPass(state: ShadowFrameState, slot: ShadowCascadeSlot): ShadowCasterPassPlan | undefined {
    return state.casterPasses?.get(slot);
  },
  /** The light camera to cull casters by: the far window's, which holds the near one. */
  casterCullingProjectionView(state: ShadowFrameState): Mat4 {
    return state.farLightProjectionView ?? state.lightProjectionView;
  },
} as const;
