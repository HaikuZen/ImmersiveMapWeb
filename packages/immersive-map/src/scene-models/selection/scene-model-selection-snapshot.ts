// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../../geo/geo-coordinate.ts";
import { type Mat4, mat4Identity } from "../../math/matrix.ts";
import { mat4Invert } from "../../math/mat4-invert.ts";
import type { Vec3 } from "../../math/vec.ts";
import { ImmersiveMapSelectionKind } from "../../selection/immersive-map-selection.ts";
import type { SelectionPickData } from "../../selection/selectable-map-feature.ts";
import { SceneModelPickMath } from "./scene-model-pick-math.ts";

/** One drawn model's hit volume: the model matrix the GPU drew it with, and the asset-space box that matrix maps. */
export interface SceneModelSelectionEntry {
  readonly id: number;
  /**
   * Where the model was drawn, carried through so a tap can report the
   * position on screen rather than the descriptor's (mid-flight, different)
   * destination.
   */
  readonly coordinate: GeoCoordinate;
  readonly modelMatrix: Mat4;
  readonly boundsMin: Vec3;
  readonly boundsMax: Vec3;
}

const inverseScratch = new Float64Array(16);

/**
 * Hit-test state of one rendered frame, the Swift
 * `SceneModelSelectionSnapshot`: every model that survived frustum culling
 * and the globe horizon gate, with the camera that drew them. What is on
 * screen is what can be tapped, and a model the frame skipped is not
 * tappable by construction.
 */
export class SceneModelSelectionSnapshot implements SelectionPickData {
  /**
   * A model smaller than a fingertip cannot be aimed at. Below this size its
   * hit area grows to a touch target, the platform minimum (44 pt).
   */
  static readonly minimumTouchSizePoints = 44;

  static readonly empty = new SceneModelSelectionSnapshot(0, 0, 0, mat4Identity(), [0, 0, 0], []);

  readonly kind = ImmersiveMapSelectionKind.sceneModel;

  constructor(
    readonly frameIndex: number,
    /** The drawable's size in device pixels. */
    readonly drawWidth: number,
    readonly drawHeight: number,
    /** World to clip of this frame, the matrix the scene model vertex shader was handed. */
    readonly projectionView: Mat4,
    readonly cameraEye: Vec3,
    readonly entries: readonly SceneModelSelectionEntry[],
  ) {}

  /**
   * The model under the point (drawable pixels, origin bottom left), the one
   * nearest to the camera first. `minimumTouchSizePixels` <= 0 tests the
   * geometry alone.
   */
  hitTest(x: number, y: number, minimumTouchSizePixels: number): SceneModelSelectionEntry | null {
    if (this.entries.length === 0) return null;
    const ray = SceneModelPickMath.makeRay(x, y, this.drawWidth, this.drawHeight, this.projectionView, this.cameraEye);
    if (ray === null) return null;

    let nearest: SceneModelSelectionEntry | null = null;
    let nearestDistance = Number.MAX_VALUE;
    for (const entry of this.entries) {
      // A collapsed model (zero scale) has no inverse and cannot be hit.
      if (!mat4Invert(inverseScratch, entry.modelMatrix)) continue;
      const distance = SceneModelPickMath.intersectionDistance(ray, entry.boundsMin, entry.boundsMax, inverseScratch);
      if (distance === null || !(distance < nearestDistance)) continue;
      nearest = entry;
      nearestDistance = distance;
    }

    return nearest ?? this.touchTargetHit(x, y, minimumTouchSizePixels);
  }

  /**
   * Fallback for models the geometry test missed: a model whose whole
   * on-screen footprint is smaller than a touch target grows to one around
   * its center. A model big enough to aim at never takes part, so this can
   * only fill a gap and never steal a tap from geometry that was actually
   * hit.
   */
  private touchTargetHit(x: number, y: number, minimumTouchSizePixels: number): SceneModelSelectionEntry | null {
    if (!(minimumTouchSizePixels > 0)) return null;

    let nearest: SceneModelSelectionEntry | null = null;
    let nearestDistance = Number.MAX_VALUE;
    const half = minimumTouchSizePixels * 0.5;
    for (const entry of this.entries) {
      const bounds = SceneModelPickMath.screenBounds(entry.boundsMin, entry.boundsMax, entry.modelMatrix, this.projectionView, this.drawWidth, this.drawHeight);
      if (bounds === null || bounds.maxX - bounds.minX > minimumTouchSizePixels || bounds.maxY - bounds.minY > minimumTouchSizePixels) continue;

      const centerX = (bounds.minX + bounds.maxX) * 0.5;
      const centerY = (bounds.minY + bounds.maxY) * 0.5;
      // Half-open like a CGRect: the far edges are outside.
      if (!(x >= centerX - half && x < centerX + half && y >= centerY - half && y < centerY + half)) continue;

      const distance = SceneModelPickMath.distanceFromCamera(entry.boundsMin, entry.boundsMax, entry.modelMatrix, this.cameraEye);
      if (!(distance < nearestDistance)) continue;
      nearest = entry;
      nearestDistance = distance;
    }
    return nearest;
  }
}
