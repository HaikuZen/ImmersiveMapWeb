// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoProjectionBasis } from "../geo/geo-projection-basis.ts";
import { type GeoScreenProjectionFrameConstants, GeoScreenProjectionMath, makeScreenPointOutput } from "../geo/geo-screen-projection-math.ts";

/**
 * Projection input of one annotation: an internal id (assigned by the
 * annotation runtime, the app's keys never cross this layer) and a cached
 * coordinate basis, so the frame does no trigonometry per annotation.
 */
export interface AnnotationProjectionEntry {
  readonly id: number;
  readonly basis: GeoProjectionBasis;
}

export interface AnnotationProjectionInput {
  readonly entries: readonly AnnotationProjectionEntry[];
}

/**
 * Screen position of one annotation in drawable pixels (origin at bottom
 * left, y up). `visibilityAlpha` carries the soft globe-horizon fade.
 */
export interface AnnotationProjectedEntry {
  readonly id: number;
  readonly positionX: number;
  readonly positionY: number;
  readonly visibilityAlpha: number;
}

/**
 * Per-frame snapshot of the annotation projection. `entries` holds only the
 * visible annotations: an absent id means "hide the element".
 */
export interface AnnotationProjectionSnapshot {
  readonly frameIndex: number;
  readonly drawWidth: number;
  readonly drawHeight: number;
  readonly entries: readonly AnnotationProjectedEntry[];
}

export const emptyAnnotationProjectionInput: AnnotationProjectionInput = Object.freeze({ entries: Object.freeze([]) });

const pointScratch = makeScreenPointOutput();

/**
 * Projects annotation coordinates into the frame's drawable pixels with the
 * same formulas as the render's vertex path (Swift
 * `AnnotationRenderSubsystem.update`). Does no GPU work. A point behind the
 * camera or past the globe's horizon is left out.
 */
export function projectAnnotations(input: AnnotationProjectionInput, constants: GeoScreenProjectionFrameConstants, frameIndex: number): AnnotationProjectionSnapshot {
  const entries: AnnotationProjectedEntry[] = [];
  for (const entry of input.entries) {
    const point = GeoScreenProjectionMath.project(entry.basis, constants, pointScratch);
    if (point.visible === 0 || !(point.visibilityAlpha > 0.0)) continue;
    entries.push({ id: entry.id, positionX: point.positionX, positionY: point.positionY, visibilityAlpha: point.visibilityAlpha });
  }
  return { frameIndex, drawWidth: constants.viewport[0], drawHeight: constants.viewport[1], entries };
}
