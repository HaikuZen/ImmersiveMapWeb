// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { PresentationStateResolver } from "../presentation/presentation-state-resolver.ts";

/**
 * Local scale of the render surface at the view centre relative to
 * normalized Mercator: the sphere compresses the world by `cos(latitude)`,
 * the plane does not, and through the globe-to-plane transition the
 * unroll's chart blend (`GlobeUnrollMath`) with the flat target inflating
 * from `cos` to 1 (`globeTransitionMapSize`) gives `cos + g^2 (1 - cos)` for
 * the geometry phase `g`, which reaches 1 at
 * `PresentationStateResolver.geometryCompletionPhase` of the transition.
 * The camera proximity, the pan compensation and the zoom anchor all read
 * this one curve, so they agree with the geometry on screen.
 */
export const SurfaceScaleMath = {
  /** @param transition globe-to-plane phase: 0 is globe, 1 is plane. */
  surfaceScale(latitude: number, transition: number): number {
    const geometryPhase = PresentationStateResolver.geometryTransition(transition);
    const compression = Math.max(Math.cos(latitude), 1e-6);
    return compression + geometryPhase * geometryPhase * (1.0 - compression);
  },
} as const;
