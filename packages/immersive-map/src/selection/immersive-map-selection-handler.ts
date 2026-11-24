// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The `selection` folder: what the map has selected and how a tap or the app
 * changes it, a port of the Swift `Selection/` folder. The public handle
 * (`ImmersiveMapSelectionController` with its values), this handler, which
 * holds the state, the interface a selectable feature implements
 * (`SelectableMapFeature`), and the seam to the map it serves
 * (`SelectionHost`). It names no feature: what can be picked, whether an
 * object is still there, how a selected one looks and which tap event the
 * app gets are each feature's own.
 */

import type { ImmersiveMapScreenPoint, ImmersiveMapSelection, ImmersiveMapSelectionCommand, ImmersiveMapSelectionController, ImmersiveMapSelectionKind, ImmersiveMapSelectionSource } from "./immersive-map-selection.ts";
import { selectionsEqual } from "./immersive-map-selection.ts";
import type { MapTapKind, SelectableMapFeature, SelectionHit, SelectionPickData } from "./selectable-map-feature.ts";

/** What the selection needs of the map it serves: the drawable's scale, and a frame when the selection changed what the map shows. */
export interface SelectionHost {
  /** The drawable's pixels to a CSS pixel of the map's element. */
  readonly contentsScale: number;
  requestFrame(): void;
}

export type MapTapResult = "consumed" | "background";

export class ImmersiveMapSelectionHandler {
  private controller: ImmersiveMapSelectionController | null = null;
  private current: ImmersiveMapSelection | null = null;

  /** `features` are asked for the object under a tap in the order given, so a feature drawn over the others comes first. */
  constructor(
    private readonly host: SelectionHost,
    private readonly features: readonly SelectableMapFeature[],
  ) {}

  /** The controller the app attached, or null. */
  get selectionController(): ImmersiveMapSelectionController | null {
    return this.controller;
  }

  syncController(next: ImmersiveMapSelectionController | null): void {
    if (this.controller === next) return;
    this.controller?.detachHandler(this);
    this.controller = next;
    next?.attachHandler(this, (command) => this.handle(command));
    next?.updateCurrentSelection(this.current);
  }

  currentMapSelection(): ImmersiveMapSelection | null {
    return this.current;
  }

  handle(command: ImmersiveMapSelectionCommand): boolean {
    return command.kind === "select" ? this.select(command.selection, "programmatic", null) : this.clear("programmatic", null);
  }

  select(selection: ImmersiveMapSelection, source: ImmersiveMapSelectionSource, screenPoint: ImmersiveMapScreenPoint | null): boolean {
    if (!this.isSelectionAvailable(selection)) return false;
    if (selectionsEqual(this.current, selection)) return true;
    if (this.current !== null) this.setSelected(false, this.current);
    this.setSelected(true, selection);
    this.current = selection;
    this.controller?.notifySelectionChanged({ selection, source, screenPoint });
    return true;
  }

  clear(source: ImmersiveMapSelectionSource, screenPoint: ImmersiveMapScreenPoint | null): boolean {
    const previous = this.current;
    if (previous === null) return false;
    this.setSelected(false, previous);
    this.current = null;
    this.controller?.notifySelectionCleared({ previousSelection: previous, source, screenPoint });
    return true;
  }

  /** Hands each feature what it drew in a frame. */
  updatePickData(pickData: readonly SelectionPickData[]): void {
    for (const data of pickData) this.feature(data.kind)?.updatePickData(data);
  }

  resetPickData(): void {
    for (const feature of this.features) feature.resetPickData();
  }

  /** A feature's objects changed: the selected one may be gone. */
  handleFeatureDidChange(): void {
    this.syncSelectionWithAvailableObjects();
    this.host.requestFrame();
  }

  syncSelectionWithAvailableObjects(): void {
    if (this.current !== null && !this.isSelectionAvailable(this.current)) this.clear("system", null);
  }

  /**
   * The features are asked in their order, the ones drawn over the world
   * first. A hit nothing consumes (no tap action, no selection controller)
   * is not interactive at all, and the feature underneath still gets its
   * chance.
   *
   * `kind`: the gesture. Only the features picked by it are asked. A
   * gesture other than the single tap that lands on nothing is not a tap on
   * the bare map: it ends no selection and reports nothing.
   */
  handleMapTap(point: ImmersiveMapScreenPoint, kind: MapTapKind = "single"): MapTapResult {
    const contentsScale = this.host.contentsScale;
    for (const feature of this.features) {
      if ((feature.tapKind ?? "single") !== kind) continue;
      const hit = feature.hitTest(point, contentsScale);
      if (hit !== null && this.consumeTap(hit, feature, point)) {
        if (feature.clearsSelectionOnTap === true) this.clear("tap", point);
        return "consumed";
      }
    }
    if (kind !== "single") return "background";
    this.controller?.notifyMapBackgroundTap(point);
    this.clear("tap", point);
    return "background";
  }

  /** Whether a feature takes the gesture `kind` as its own now. */
  isClaimed(kind: MapTapKind): boolean {
    return this.features.some((feature) => (feature.tapKind ?? "single") === kind && feature.claimsItsTapKind === true);
  }

  /** The feature's tap event first, then the selection: a tap on an already selected object still delivers its event. */
  private consumeTap(hit: SelectionHit, feature: SelectableMapFeature, point: ImmersiveMapScreenPoint): boolean {
    let consumed = feature.deliverTap(hit, point);
    if (this.controller !== null && feature.contains(hit.selection)) {
      this.select(hit.selection, "tap", point);
      consumed = true;
    }
    return consumed;
  }

  private feature(kind: ImmersiveMapSelectionKind): SelectableMapFeature | undefined {
    return this.features.find((feature) => feature.owns(kind));
  }

  private isSelectionAvailable(selection: ImmersiveMapSelection): boolean {
    return this.feature(selection.kind)?.contains(selection) ?? false;
  }

  private setSelected(isSelected: boolean, selection: ImmersiveMapSelection): void {
    this.feature(selection.kind)?.setSelected(isSelected, selection);
  }
}
