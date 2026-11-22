// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The globe's per-frame shader inputs (Swift `GlobeUniform`): the pan as the
 * globe reads it (`ImmersiveMapProjection.globePan`), the render radius, and
 * the geometry phase of the unroll (`PresentationStateResolver.geometryTransition`).
 */
export interface GlobeUniform {
  readonly panX: number;
  readonly panY: number;
  readonly radius: number;
  readonly transition: number;
}

/** The pan as rotations: about x by the pan latitude, about y by the pan longitude. */
export function globeUniformRotation(globe: GlobeUniform): readonly [xRotation: number, yRotation: number] {
  const maxLatitude = 2.0 * Math.atan(Math.exp(Math.PI)) - Math.PI / 2.0;
  return [globe.panY * maxLatitude, globe.panX * Math.PI];
}
