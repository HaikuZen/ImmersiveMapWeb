// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type ImmersiveMapScreenPoint, type ImmersiveMapSelection, ImmersiveMapSelectionKind } from "../../selection/immersive-map-selection.ts";
import { type SelectableMapFeature, type SelectionHit, type SelectionPickData, selectionPixelPoint } from "../../selection/selectable-map-feature.ts";
import type { ImmersiveMapLayer } from "../immersive-map-layer.ts";
import type { ImmersiveMapLayerTapEvent } from "../immersive-map-layer-tap-event.ts";
import { LayerSelectionSnapshot } from "./layer-selection-snapshot.ts";

/** The layers a selection can name a shape of: the app's layers as the map holds them. */
export interface LayerSelectionSource {
  /** The layer with `id`, `undefined` when the map holds none. */
  layer(id: string): ImmersiveMapLayer | undefined;
}

/**
 * The layers' side of the selection (`SelectableMapFeature`), the Swift
 * `LayerSelection`: a tap is tested against the shapes of the layers the
 * last frame on screen drew (`LayerSelectionSnapshot`). A selection stands
 * while the map holds the shape's layer. A shape carries no selected
 * appearance: an app that wants one draws it, as a layer over the selected
 * shape.
 */
export class LayerSelection implements SelectableMapFeature {
  /** The app's action for a tap on a shape, with or without a selection. */
  tapAction: ((event: ImmersiveMapLayerTapEvent) => void) | null = null;
  private snapshot: LayerSelectionSnapshot = LayerSelectionSnapshot.empty;

  constructor(private readonly source: LayerSelectionSource) {}

  owns(kind: ImmersiveMapSelectionKind): boolean {
    return kind === ImmersiveMapSelectionKind.layers || ImmersiveMapSelectionKind.layerID(kind) !== null;
  }

  updatePickData(pickData: SelectionPickData): void {
    if (!(pickData instanceof LayerSelectionSnapshot) || pickData.frameIndex < this.snapshot.frameIndex) return;
    this.snapshot = pickData;
  }

  resetPickData(): void {
    this.snapshot = LayerSelectionSnapshot.empty;
  }

  hitTest(point: ImmersiveMapScreenPoint, contentsScale: number): SelectionHit | null {
    const snapshot = this.snapshot;
    if (snapshot.entries.length === 0 || snapshot.drawHeight <= 0) return null;
    const hit = snapshot.hitTest(selectionPixelPoint(point, snapshot.drawHeight, contentsScale), contentsScale);
    if (hit === undefined) return null;
    return { selection: { kind: ImmersiveMapSelectionKind.layer(hit.layerID), objectID: hit.shapeID }, coordinate: hit.coordinate };
  }

  contains(selection: ImmersiveMapSelection): boolean {
    const layerID = ImmersiveMapSelectionKind.layerID(selection.kind);
    return layerID !== null && this.source.layer(layerID) !== undefined;
  }

  setSelected(): void {}

  deliverTap(hit: SelectionHit, point: ImmersiveMapScreenPoint): boolean {
    const tapAction = this.tapAction;
    const layerID = ImmersiveMapSelectionKind.layerID(hit.selection.kind);
    if (tapAction === null || hit.coordinate === null || layerID === null) return false;
    const layer = this.source.layer(layerID);
    if (layer === undefined) return false;
    tapAction({ layer, shapeID: hit.selection.objectID, coordinate: hit.coordinate, screenPoint: point });
    return true;
  }
}
