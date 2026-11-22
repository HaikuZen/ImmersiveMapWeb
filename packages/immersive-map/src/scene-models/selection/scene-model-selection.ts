// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type ImmersiveMapScreenPoint, type ImmersiveMapSelection, ImmersiveMapSelectionKind } from "../../selection/immersive-map-selection.ts";
import { type SelectableMapFeature, type SelectionHit, type SelectionPickData, selectionPixelPoint } from "../../selection/selectable-map-feature.ts";
import type { ImmersiveMapSceneModel } from "../immersive-map-scene-model.ts";
import type { ImmersiveMapSceneModelTapEvent } from "../immersive-map-scene-model-tap-event.ts";
import { SceneModelSelectionSnapshot } from "./scene-model-selection-snapshot.ts";

/** The scene models a selection can name: the app's models as the map holds them. */
export interface SceneModelSelectionSource {
  /** The scene model with `id`, null when the map holds none. */
  model(id: number): ImmersiveMapSceneModel | null;
}

/**
 * The scene models' side of the selection (`SelectableMapFeature`), a port
 * of the Swift `SceneModelSelection`: a tap is tested against the models of
 * the last frame on screen (`SceneModelSelectionSnapshot`). A model carries
 * no selected appearance: the engine draws the asset as authored, and
 * highlighting is the app's to do.
 */
export class SceneModelSelection implements SelectableMapFeature {
  /** The app's action for a tap on a model, with or without a selection. */
  tapAction: ((event: ImmersiveMapSceneModelTapEvent) => void) | null = null;
  private snapshot = SceneModelSelectionSnapshot.empty;

  constructor(private readonly source: SceneModelSelectionSource) {}

  owns(kind: string): boolean {
    return kind === ImmersiveMapSelectionKind.sceneModel;
  }

  updatePickData(pickData: SelectionPickData): void {
    if (pickData instanceof SceneModelSelectionSnapshot && pickData.frameIndex >= this.snapshot.frameIndex) this.snapshot = pickData;
  }

  resetPickData(): void {
    this.snapshot = SceneModelSelectionSnapshot.empty;
  }

  hitTest(point: ImmersiveMapScreenPoint, contentsScale: number): SelectionHit | null {
    const snapshot = this.snapshot;
    if (snapshot.entries.length === 0 || !(snapshot.drawHeight > 0)) return null;
    const pixel = selectionPixelPoint(point, snapshot.drawHeight, contentsScale);
    const entry = snapshot.hitTest(pixel.x, pixel.y, SceneModelSelectionSnapshot.minimumTouchSizePoints * contentsScale);
    if (entry === null) return null;
    return { selection: { kind: ImmersiveMapSelectionKind.sceneModel, objectID: entry.id }, coordinate: entry.coordinate };
  }

  contains(selection: ImmersiveMapSelection): boolean {
    return this.source.model(selection.objectID) !== null;
  }

  /** A model has no selected appearance. */
  setSelected(): void {}

  deliverTap(hit: SelectionHit, point: ImmersiveMapScreenPoint): boolean {
    const action = this.tapAction;
    const coordinate = hit.coordinate;
    if (action === null || coordinate === null) return false;
    const model = this.source.model(hit.selection.objectID);
    if (model === null) return false;
    action({ model, coordinate, screenPoint: point });
    return true;
  }
}
