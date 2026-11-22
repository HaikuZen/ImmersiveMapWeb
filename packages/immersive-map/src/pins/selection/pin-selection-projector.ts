// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { GeoScreenProjectionFrameConstants, GeoScreenProjectionMath } from "../../geo/geo-screen-projection-math.ts";
import type { CameraUniform } from "../../camera/camera-uniform.ts";
import type { ResolvedPresentationState } from "../../presentation/resolved-presentation-state.ts";
import { ImmersiveMapSelectionKind } from "../../selection/immersive-map-selection.ts";
import type { SelectionPickData } from "../../selection/selectable-map-feature.ts";
import type { PinCollisionItem, ProjectedPin } from "../clustering/pin-collision-types.ts";
import type { PinStyle } from "../pin-types.ts";
import type { PresentedPin } from "../presentation/pin-presentation-state-store.ts";
import { PinVisibilityFadeStateStore } from "../presentation/pin-visibility-fade-state-store.ts";

/** A pin a tap can land on: its quad on the screen in drawable pixels (origin bottom left), its anchor and its draw order. */
export interface PinSelectionEntry {
  readonly pinID: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly drawOrder: number;
}

/** What the pins drew in one frame, in the order drawn: a tap is tested against it (the Swift `PinSelectionSnapshot`). */
export class PinSelectionSnapshot implements SelectionPickData {
  static readonly empty = new PinSelectionSnapshot(0, 0, 0, []);

  readonly kind = ImmersiveMapSelectionKind.pin;

  constructor(
    readonly frameIndex: number,
    readonly drawWidth: number,
    readonly drawHeight: number,
    readonly entries: readonly PinSelectionEntry[],
  ) {}

  withFrameIndex(frameIndex: number): PinSelectionSnapshot {
    return new PinSelectionSnapshot(frameIndex, this.drawWidth, this.drawHeight, this.entries);
  }

  /** The pin drawn last whose quad holds the point (drawable pixels, origin bottom left), null for none. */
  hitTest(x: number, y: number): number | null {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index]!;
      if (x >= entry.minX && x < entry.maxX && y >= entry.minY && y < entry.maxY) return entry.pinID;
    }
    return null;
  }
}

/**
 * Projects pins onto the screen with the shared projector
 * (`GeoScreenProjectionMath`, the same math as the tiles and the
 * annotations: the morph and the soft horizon), a port of the Swift
 * `PinSelectionProjector`. Everything outside the viewport by more than
 * `cullMarginPx`, and the far side of the globe, is dropped. A pin costs
 * linear algebra from its coordinate's cached basis.
 */
export class PinSelectionProjector {
  private readonly scratch = { positionX: 0, positionY: 0, depth: 0, visible: 0, visibilityAlpha: 0 };

  project(pins: readonly PresentedPin[], drawWidth: number, drawHeight: number, cameraUniform: CameraUniform, presentation: ResolvedPresentationState, cullMarginPx: number): ProjectedPin[] {
    if (pins.length === 0 || !(drawWidth > 0) || !(drawHeight > 0)) return [];
    const constants = new GeoScreenProjectionFrameConstants(drawWidth, drawHeight, cameraUniform, presentation);
    const projected: ProjectedPin[] = [];
    const point = this.scratch;
    for (const presented of pins) {
      GeoScreenProjectionMath.project(presented.projectionBasis, constants, point);
      // The far side of the globe and points behind the camera never reach the solver.
      if (point.visible === 0 || !(point.visibilityAlpha > 0)) continue;
      const margin = cullMarginPx * Math.max(1, presented.pin.screenSizeScale);
      if (point.positionX < -margin || point.positionX > drawWidth + margin || point.positionY < -margin || point.positionY > drawHeight + margin) continue;
      const basis = presented.projectionBasis;
      projected.push({
        pin: presented.pin,
        squashScaleX: presented.squashScaleX,
        squashScaleY: presented.squashScaleY,
        screenPoint: { positionX: Math.fround(point.positionX), positionY: Math.fround(point.positionY), depth: point.depth, visible: point.visible, visibilityAlpha: Math.fround(point.visibilityAlpha) },
        worldX: basis.normalizedWorldX,
        worldY: basis.mercatorYNormalized,
        drawOrder: presented.drawOrder,
      });
    }
    return projected;
  }

  /** The hit zones of the drawn pins: a pin shrunk by the layout takes less room, scaled as it is drawn. */
  makeSnapshot(pinItems: readonly PinCollisionItem[], drawWidth: number, drawHeight: number, pinStyle: PinStyle): PinSelectionSnapshot {
    if (!(drawWidth > 0) || !(drawHeight > 0)) return PinSelectionSnapshot.empty;
    const [width, height] = pinStyle.totalSizePx;
    const [originX, originY] = pinStyle.quadOriginPx;
    const entries: PinSelectionEntry[] = [];
    for (const item of pinItems) {
      const point = item.screenPoint;
      if (point.visible === 0 || !(point.visibilityAlpha > PinVisibilityFadeStateStore.activeAlphaThreshold)) continue;
      const scale = Math.max(item.displayScale, 0);
      const minX = point.positionX + originX * scale;
      const minY = point.positionY + originY * scale;
      entries.push({ pinID: item.pin.id, minX, minY, maxX: minX + width * scale, maxY: minY + height * scale, anchorX: point.positionX, anchorY: point.positionY, drawOrder: item.drawOrder });
    }
    return new PinSelectionSnapshot(0, drawWidth, drawHeight, entries);
  }
}
