// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The shadow map's shape, a port of the Swift `ShadowCascadeAtlas` and
 * `ShadowCascadeSlot`: one square depth texture array with a slice per
 * window, each slice written by its own caster pass and compared against by
 * every receiver. Shared by the caster pipelines, the attachment and the
 * resolver's UV math so they never disagree.
 *
 * Two windows, not a cascade set and not one: the near window is fitted to
 * a disc of `ShadowSettings.nearCoverageMeters` at the camera zoom for the
 * shadows the camera looks at, sharp, and the far window to a disc of
 * `farCoverageMeters` for the ground beyond it, at the same map size and so
 * coarser. A receiver reads the near window where it reaches and the far
 * one past it, blended over the near window's fade band. Each slice is
 * rendered again only when its own window went stale
 * (`ShadowMapReuseController`).
 */

/** The two windows of the shadow map, each a slice of the texture array. */
export type ShadowCascadeSlot = "near" | "far";

/** Every window, the near one first: the order the passes run in. */
export const shadowCascadeSlots: readonly ShadowCascadeSlot[] = Object.freeze(["near", "far"] as const);

export const ShadowCascadeAtlas = {
  /**
   * 16 bits are enough: the projection is refit to a tight caster range with
   * the depth clamped, so a 32-bit depth would double the map's memory and
   * the bandwidth of every comparison for nothing.
   */
  depthFormat: "depth16unorm" as GPUTextureFormat,
  /** Slices of the map: one per window. */
  sliceCount: 2,
  /** The slice a window renders into and the receivers read (`kShadowNearSlice`, `kShadowFarSlice`). */
  slice(slot: ShadowCascadeSlot): number {
    return slot === "near" ? 0 : 1;
  },
  /** The layer the casters of a window draw in. */
  casterLayer(slot: ShadowCascadeSlot): "shadowCasters" | "farShadowCasters" {
    return slot === "near" ? "shadowCasters" : "farShadowCasters";
  },
  /** The window a caster layer draws into, `undefined` for any other layer. */
  slotOfCasterLayer(layer: string): ShadowCascadeSlot | undefined {
    if (layer === "shadowCasters") return "near";
    if (layer === "farShadowCasters") return "far";
    return undefined;
  },
} as const;
