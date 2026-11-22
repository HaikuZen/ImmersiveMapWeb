// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type ImmersiveMapScreenPoint, type ImmersiveMapSelection, ImmersiveMapSelectionKind } from "../../selection/immersive-map-selection.ts";
import { type SelectableMapFeature, type SelectionHit, type SelectionPickData, selectionPixelPoint } from "../../selection/selectable-map-feature.ts";
import type { ImmersiveMapPin } from "../immersive-map-pin.ts";
import { PinSelectionSnapshot } from "./pin-selection-projector.ts";

/** A tap on a pin, with or without a selection controller. */
export interface ImmersiveMapPinTapEvent {
  /** The pin at the moment of the tap. */
  readonly pin: ImmersiveMapPin;
  /** Where the tap landed, in CSS pixels of the map's element. */
  readonly screenPoint: ImmersiveMapScreenPoint;
}

/** The pins a selection can name, and the one drawn as selected: the app's pins as the map holds them. */
export interface PinSelectionSource {
  pin(id: number): ImmersiveMapPin | null;
  updatePinSelection(id: number, isSelected: boolean): void;
}

/**
 * The pins' side of the selection (`SelectableMapFeature`), a port of the
 * Swift `PinSelection`: a tap is tested against the pins the last frame
 * drew (`PinSelectionSnapshot`), and a selected pin is drawn as selected.
 */
export class PinSelection implements SelectableMapFeature {
  /** The app's action for a tap on a pin. */
  tapAction: ((event: ImmersiveMapPinTapEvent) => void) | null = null;
  private snapshot = PinSelectionSnapshot.empty;

  constructor(private readonly source: PinSelectionSource) {}

  owns(kind: string): boolean {
    return kind === ImmersiveMapSelectionKind.pin;
  }

  updatePickData(pickData: SelectionPickData): void {
    if (pickData instanceof PinSelectionSnapshot && pickData.frameIndex >= this.snapshot.frameIndex) this.snapshot = pickData;
  }

  resetPickData(): void {
    this.snapshot = PinSelectionSnapshot.empty;
  }

  hitTest(point: ImmersiveMapScreenPoint, contentsScale: number): SelectionHit | null {
    const snapshot = this.snapshot;
    if (snapshot.entries.length === 0 || !(snapshot.drawHeight > 0)) return null;
    const pixel = selectionPixelPoint(point, snapshot.drawHeight, contentsScale);
    const pinID = snapshot.hitTest(pixel.x, pixel.y);
    return pinID === null ? null : { selection: { kind: ImmersiveMapSelectionKind.pin, objectID: pinID }, coordinate: null };
  }

  contains(selection: ImmersiveMapSelection): boolean {
    return this.source.pin(selection.objectID) !== null;
  }

  setSelected(isSelected: boolean, selection: ImmersiveMapSelection): void {
    this.source.updatePinSelection(selection.objectID, isSelected);
  }

  deliverTap(hit: SelectionHit, point: ImmersiveMapScreenPoint): boolean {
    const action = this.tapAction;
    if (action === null) return false;
    const pin = this.source.pin(hit.selection.objectID);
    if (pin === null) return false;
    action({ pin, screenPoint: point });
    return true;
  }
}
