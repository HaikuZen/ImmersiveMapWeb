// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** The zoom a pinch asks for: the scale's change, boosted by the pinch's speed in the same direction. */
export const PinchZoomMath = {
  zoomDelta(scale: number, velocity: number, pinchZoomFactor: number, pinchZoomVelocityFactor: number, pinchZoomVelocityLimit: number): number {
    const scaleDelta = scale - 1.0;
    if (
      !Number.isFinite(scaleDelta) ||
      !Number.isFinite(velocity) ||
      !Number.isFinite(pinchZoomFactor) ||
      !Number.isFinite(pinchZoomVelocityFactor) ||
      !Number.isFinite(pinchZoomVelocityLimit)
    ) {
      return 0;
    }

    let alignedVelocityMagnitude: number;
    if (scaleDelta === 0 || scaleDelta * velocity <= 0) {
      alignedVelocityMagnitude = 0;
    } else {
      alignedVelocityMagnitude = Math.min(Math.abs(velocity), Math.max(0, pinchZoomVelocityLimit));
    }

    const boost = 1.0 + alignedVelocityMagnitude * Math.max(0, pinchZoomVelocityFactor);
    return scaleDelta * pinchZoomFactor * boost;
  },
} as const;
