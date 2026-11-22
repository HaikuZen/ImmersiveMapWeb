// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** The zoom a one-thumb drag in the zoom zone asks for: up zooms in, the drag's speed boosts it. */
export const ZoomControlMath = {
  zoomDelta(
    translationY: number,
    velocityY: number,
    interactionHeight: number,
    zoomFactor: number,
    velocityFactor: number,
    velocityLimit: number,
  ): number {
    if (!(interactionHeight > 0) || !Number.isFinite(zoomFactor) || !Number.isFinite(velocityFactor) || !Number.isFinite(velocityLimit)) {
      return 0;
    }

    const normalizedTranslation = -(translationY / interactionHeight);
    const baseDelta = normalizedTranslation * zoomFactor;
    if (!Number.isFinite(baseDelta) || baseDelta === 0) {
      return 0;
    }

    const normalizedVelocity = -(velocityY / interactionHeight);
    let alignedVelocityMagnitude: number;
    if (Number.isFinite(normalizedVelocity) && baseDelta * normalizedVelocity > 0) {
      alignedVelocityMagnitude = Math.min(Math.abs(normalizedVelocity), Math.max(0, velocityLimit));
    } else {
      alignedVelocityMagnitude = 0;
    }

    const boost = 1.0 + alignedVelocityMagnitude * Math.max(0, velocityFactor);
    return baseDelta * boost;
  },
} as const;
