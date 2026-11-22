// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type GeoCoordinate, geoCoordinatesEqual } from "../../geo/geo-coordinate.ts";
import { GeoGreatCircleMath } from "../../geo/geo-great-circle-math.ts";
import { GeoPathMetrics } from "../../geo/geo-path-sampler.ts";
import { GeoProjectionBasis } from "../../geo/geo-projection-basis.ts";
import { type ImmersiveMapPathAnimationCurve, pathAnimationFraction } from "../../geo/immersive-map-path-animation-curve.ts";
import type { Quat } from "../../math/quaternion.ts";
import { ImmersiveMapSceneModel, type ImmersiveMapSceneModelSource } from "../immersive-map-scene-model.ts";
import type { SceneModelPathAnimationRequest, SceneModelPathAnimationResult, SceneModelsSnapshot } from "../scene-model-render-source.ts";
import { SceneModelAnimationMath } from "./scene-model-animation-math.ts";

/**
 * A scene model resolved for the current frame: the displayed (possibly
 * animated) coordinate basis and transform values, plus the descriptor
 * fields the renderer needs to pick and size the mesh.
 */
export interface PresentedSceneModel {
  readonly id: number;
  readonly source: ImmersiveMapSceneModelSource;
  readonly fitDiameterMeters: number | null;
  /**
   * Where the model is being drawn this frame. Mid-flight this is a point
   * on the path, while the descriptor already holds the destination.
   */
  readonly coordinate: GeoCoordinate;
  readonly projectionBasis: GeoProjectionBasis;
  readonly orientation: Quat;
  readonly scale: number;
  readonly altitudeMeters: number;
  /** See `ImmersiveMapSceneModel.cutsIntoGround`. */
  readonly cutsIntoGround: boolean;
}

class PositionAnimation {
  constructor(
    readonly startCoordinate: GeoCoordinate,
    readonly targetCoordinate: GeoCoordinate,
    readonly startTime: number,
    readonly duration: number,
  ) {}

  coordinate(time: number): GeoCoordinate {
    if (!(this.duration > 0)) return this.targetCoordinate;
    const progress = SceneModelAnimationMath.easedProgress((time - this.startTime) / this.duration);
    return GeoGreatCircleMath.coordinate(this.startCoordinate, this.targetCoordinate, progress);
  }

  isFinished(time: number): boolean {
    return time >= this.startTime + this.duration;
  }
}

/**
 * Orientation, scale, and altitude animate as one eased segment: a combined
 * `setOrientation` and `setScale` mutation lands as a single coherent motion.
 */
class TransformAnimation {
  constructor(
    readonly startOrientation: Quat,
    readonly targetOrientation: Quat,
    readonly startScale: number,
    readonly targetScale: number,
    readonly startAltitude: number,
    readonly targetAltitude: number,
    readonly startTime: number,
    readonly duration: number,
  ) {}

  progress(time: number): number {
    if (!(this.duration > 0)) return 1;
    return SceneModelAnimationMath.easedProgress((time - this.startTime) / this.duration);
  }

  isFinished(time: number): boolean {
    return time >= this.startTime + this.duration;
  }
}

/**
 * A model flying along a path. The cached `GeoPathMetrics` keeps the
 * per-frame cost to one exact evaluation, and the model rides the drawn
 * ribbon because both resolve a fraction through the same metrics.
 */
class PathAnimation {
  private constructor(
    readonly generation: number,
    readonly metrics: GeoPathMetrics,
    readonly startTime: number,
    readonly duration: number,
    readonly curve: ImmersiveMapPathAnimationCurve,
    readonly appliesHeading: boolean,
    readonly appliesPitch: boolean,
  ) {}

  /** Null when the path cannot describe a trajectory. */
  static make(request: SceneModelPathAnimationRequest, startTime: number): PathAnimation | null {
    const metrics = GeoPathMetrics.make(request.path);
    if (metrics === null) return null;
    return new PathAnimation(request.generation, metrics, startTime, Math.max(0, request.duration), request.curve, request.appliesHeading, request.appliesPitch);
  }

  fraction(time: number): number {
    return pathAnimationFraction(this.curve, time - this.startTime, this.duration);
  }

  isFinished(time: number): boolean {
    return time >= this.startTime + this.duration;
  }
}

function orientationOf(model: ImmersiveMapSceneModel): Quat {
  return SceneModelAnimationMath.orientationQuaternion(model.headingDegrees, model.pitchDegrees, model.rollDegrees);
}

class PresentationEntry {
  model: ImmersiveMapSceneModel;
  displayedCoordinate: GeoCoordinate;
  projectionBasis: GeoProjectionBasis;
  displayedOrientation: Quat;
  displayedScale: number;
  displayedAltitude: number;
  positionAnimation: PositionAnimation | null = null;
  transformAnimation: TransformAnimation | null = null;
  pathAnimation: PathAnimation | null = null;
  /**
   * Where a path animation ended, set once on the frame it ends and drained
   * by the store, so the app's completion fires exactly once and the
   * controller learns where a cancelled flight stopped.
   */
  private pendingPathAnimationResult: SceneModelPathAnimationResult | null = null;

  constructor(model: ImmersiveMapSceneModel) {
    this.model = model;
    this.displayedCoordinate = model.coordinate;
    this.projectionBasis = GeoProjectionBasis.fromCoordinate(model.coordinate);
    this.displayedOrientation = orientationOf(model);
    this.displayedScale = model.scale;
    this.displayedAltitude = model.altitudeMeters;
  }

  get hasActiveAnimations(): boolean {
    return this.positionAnimation !== null || this.transformAnimation !== null || this.pathAnimation !== null;
  }

  presentedModel(time: number): PresentedSceneModel {
    const positionAnimation = this.positionAnimation;
    if (positionAnimation !== null) {
      this.moveDisplayedCoordinate(positionAnimation.coordinate(time));
      if (positionAnimation.isFinished(time)) {
        this.moveDisplayedCoordinate(positionAnimation.targetCoordinate);
        this.positionAnimation = null;
      }
    }
    const transformAnimation = this.transformAnimation;
    if (transformAnimation !== null) {
      const progress = transformAnimation.progress(time);
      this.displayedOrientation = SceneModelAnimationMath.orientation(transformAnimation.startOrientation, transformAnimation.targetOrientation, progress);
      this.displayedScale = SceneModelAnimationMath.scalar(transformAnimation.startScale, transformAnimation.targetScale, progress);
      this.displayedAltitude = SceneModelAnimationMath.scalar(transformAnimation.startAltitude, transformAnimation.targetAltitude, progress);
      if (transformAnimation.isFinished(time)) {
        this.displayedOrientation = transformAnimation.targetOrientation;
        this.displayedScale = transformAnimation.targetScale;
        this.displayedAltitude = transformAnimation.targetAltitude;
        this.transformAnimation = null;
      }
    }

    // Last, so the path owns the fields it drives: a transform animation
    // started while flying effectively animates only the scale.
    const pathAnimation = this.pathAnimation;
    if (pathAnimation !== null) {
      const sample = pathAnimation.metrics.sample(pathAnimation.fraction(time));
      this.moveDisplayedCoordinate(sample.coordinate);
      this.displayedAltitude = sample.altitudeMeters;
      this.displayedOrientation = SceneModelAnimationMath.orientationQuaternion(
        pathAnimation.appliesHeading ? sample.headingDegrees : this.model.headingDegrees,
        pathAnimation.appliesPitch ? sample.pitchDegrees : this.model.pitchDegrees,
        this.model.rollDegrees,
      );
      if (pathAnimation.isFinished(time)) {
        this.pathAnimation = null;
        this.recordPathAnimationResult(pathAnimation.generation, true);
      }
    }

    const model = this.model;
    return {
      id: model.id,
      source: model.source,
      fitDiameterMeters: model.fitDiameterMeters,
      coordinate: this.displayedCoordinate,
      projectionBasis: this.projectionBasis,
      orientation: this.displayedOrientation,
      scale: this.displayedScale,
      altitudeMeters: this.displayedAltitude,
      cutsIntoGround: model.cutsIntoGround,
    };
  }

  update(
    incoming: ImmersiveMapSceneModel,
    transformDuration: number,
    pathAnimationRequest: SceneModelPathAnimationRequest | undefined,
    cancelsPathAnimation: boolean,
    time: number,
  ): void {
    // Which fields the path owns on this frame. A cancellation keeps that
    // ownership for the frame it lands on: the descriptor in the same
    // snapshot still names the destination, because the controller only
    // learns where the flight stopped from the result this frame emits.
    let pathOwnedFields: { appliesHeading: boolean; appliesPitch: boolean } | null = null;

    const cancelled = this.pathAnimation;
    if (cancelsPathAnimation && cancelled !== null) {
      this.presentedModel(time);
      this.pathAnimation = null;
      this.recordPathAnimationResult(cancelled.generation, false);
      this.adoptDisplayedTransform();
      pathOwnedFields = { appliesHeading: cancelled.appliesHeading, appliesPitch: cancelled.appliesPitch };
    }
    const active = this.pathAnimation;
    if (active !== null) pathOwnedFields = { appliesHeading: active.appliesHeading, appliesPitch: active.appliesPitch };

    if (pathAnimationRequest !== undefined) {
      // Settle first, then let the path take over: a competing move or
      // transform must not keep running underneath it.
      this.presentedModel(time);
      this.positionAnimation = null;
      this.transformAnimation = null;
      this.pathAnimation = PathAnimation.make(pathAnimationRequest, time);
      this.pendingPathAnimationResult = null;
      // The descriptor in this very snapshot is the path's destination,
      // which is what makes the landing seamless, so it is taken as given
      // rather than frozen. Everything below still runs, so a `setScale`
      // that rode in with the request is not lost.
      pathOwnedFields = null;
    }

    // While a path owns a field, an incoming value for it is ignored rather
    // than recorded: recording it would make the entry compare the new
    // descriptor against itself once the flight ends and silently drop the
    // change forever. Everything else, scale included, applies normally.
    let model = incoming;
    if (pathOwnedFields !== null) {
      const owned = this.model;
      model = ImmersiveMapSceneModel.with(model, {
        coordinate: owned.coordinate,
        altitudeMeters: owned.altitudeMeters,
        headingDegrees: pathOwnedFields.appliesHeading ? owned.headingDegrees : model.headingDegrees,
        pitchDegrees: pathOwnedFields.appliesPitch ? owned.pitchDegrees : model.pitchDegrees,
      });
    }

    const previous = this.model;
    const coordinateChanged = !geoCoordinatesEqual(previous.coordinate, model.coordinate);
    const transformChanged =
      previous.headingDegrees !== model.headingDegrees ||
      previous.pitchDegrees !== model.pitchDegrees ||
      previous.rollDegrees !== model.rollDegrees ||
      previous.scale !== model.scale ||
      previous.altitudeMeters !== model.altitudeMeters;
    if (coordinateChanged || transformChanged) {
      // Settle in-flight animations to the current time so the new segment
      // starts from what is on screen, not from stale targets.
      this.presentedModel(time);
    }

    // The path drives the position itself, so an installed path suppresses
    // the glide toward the destination the descriptor now names.
    if (coordinateChanged && this.pathAnimation === null) {
      const duration = SceneModelAnimationMath.positionAnimationDuration(this.displayedCoordinate, model.coordinate);
      this.positionAnimation = duration > 0 ? new PositionAnimation(this.displayedCoordinate, model.coordinate, time, duration) : null;
      if (duration === 0) this.moveDisplayedCoordinate(model.coordinate);
    }

    if (transformChanged) {
      const targetOrientation = orientationOf(model);
      if (transformDuration > 0) {
        this.transformAnimation = new TransformAnimation(
          this.displayedOrientation,
          targetOrientation,
          this.displayedScale,
          model.scale,
          this.displayedAltitude,
          model.altitudeMeters,
          time,
          transformDuration,
        );
      } else {
        this.transformAnimation = null;
        this.displayedOrientation = targetOrientation;
        this.displayedScale = model.scale;
        this.displayedAltitude = model.altitudeMeters;
      }
    }

    this.model = model;
  }

  takePathAnimationResult(): SceneModelPathAnimationResult | null {
    const result = this.pendingPathAnimationResult;
    this.pendingPathAnimationResult = null;
    return result;
  }

  /**
   * Changing the presented coordinate recomputes the projection basis: the
   * only place with per-model trigonometry.
   */
  private moveDisplayedCoordinate(coordinate: GeoCoordinate): void {
    if (geoCoordinatesEqual(coordinate, this.displayedCoordinate)) return;
    this.displayedCoordinate = coordinate;
    this.projectionBasis = GeoProjectionBasis.fromCoordinate(coordinate);
  }

  /**
   * Makes the descriptor agree with what is on screen, so a later snapshot
   * carrying the same descriptor starts no animation.
   */
  private adoptDisplayedTransform(): void {
    const angles = SceneModelAnimationMath.orientationAngles(this.displayedOrientation);
    this.model = ImmersiveMapSceneModel.with(this.model, {
      coordinate: this.displayedCoordinate,
      altitudeMeters: this.displayedAltitude,
      headingDegrees: angles.headingDegrees,
      pitchDegrees: angles.pitchDegrees,
      rollDegrees: angles.rollDegrees,
    });
  }

  private recordPathAnimationResult(generation: number, finished: boolean): void {
    const angles = SceneModelAnimationMath.orientationAngles(this.displayedOrientation);
    this.pendingPathAnimationResult = {
      id: this.model.id,
      generation,
      finished,
      coordinate: this.displayedCoordinate,
      altitudeMeters: this.displayedAltitude,
      headingDegrees: angles.headingDegrees,
      pitchDegrees: angles.pitchDegrees,
    };
  }
}

/**
 * Scene model presentation store, a port of the Swift
 * `SceneModelPresentationStateStore`: keeps the entries sorted by ascending
 * id plus a cached presented list. The per-frame cost is proportional to the
 * number of animating models, not the total count: still models between
 * mutations cost only returning the cached array.
 *
 * Deterministic with injected times (seconds): the animations are pure
 * functions of the snapshot, the apply time and the query time.
 */
export class SceneModelPresentationStateStore {
  private entries: PresentationEntry[] = [];
  private presentedCache: PresentedSceneModel[] = [];
  private animatingIndices: number[] = [];
  private pathAnimationResults: SceneModelPathAnimationResult[] = [];
  private activeAnimations = false;

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /** Whether a model is still moving after the last `apply` or `presentedEntries`. */
  get hasActiveAnimations(): boolean {
    return this.activeAnimations;
  }

  apply(snapshot: SceneModelsSnapshot, time: number): void {
    const previousEntriesById = new Map<number, PresentationEntry>();
    for (const entry of this.entries) previousEntriesById.set(entry.model.id, entry);

    const cancelledPathAnimationIds = new Set(snapshot.cancelledPathAnimationIds);
    const sortedModels = [...snapshot.models].sort((a, b) => a.id - b.id);
    this.entries = sortedModels.map((model) => {
      const existing = previousEntriesById.get(model.id);
      if (existing !== undefined) {
        existing.update(
          model,
          snapshot.transformAnimationDurationsById.get(model.id) ?? 0,
          snapshot.pathAnimationsById.get(model.id),
          cancelledPathAnimationIds.has(model.id),
          time,
        );
        return existing;
      }
      const entry = new PresentationEntry(model);
      const request = snapshot.pathAnimationsById.get(model.id);
      if (request !== undefined) entry.update(model, 0, request, false, time);
      return entry;
    });

    this.presentedCache = this.entries.map((entry) => {
      const presented = entry.presentedModel(time);
      this.collectPathAnimationResult(entry);
      return presented;
    });
    this.animatingIndices = [];
    for (let index = 0; index < this.entries.length; index++) {
      if (this.entries[index]!.hasActiveAnimations) this.animatingIndices.push(index);
    }
    this.activeAnimations = this.animatingIndices.length > 0;
  }

  /**
   * The presented list sorted by ascending id. The array is the store's own
   * cache, updated in place on the next call: read it this frame and do not
   * keep it.
   */
  presentedEntries(time: number): readonly PresentedSceneModel[] {
    if (this.animatingIndices.length === 0) {
      this.activeAnimations = false;
      return this.presentedCache;
    }

    const stillAnimating: number[] = [];
    for (const index of this.animatingIndices) {
      const entry = this.entries[index]!;
      this.presentedCache[index] = entry.presentedModel(time);
      this.collectPathAnimationResult(entry);
      if (entry.hasActiveAnimations) stillAnimating.push(index);
    }
    this.animatingIndices = stillAnimating;
    this.activeAnimations = stillAnimating.length > 0;
    return this.presentedCache;
  }

  /** Drains the path animations that ended since the last call. */
  consumePathAnimationResults(): SceneModelPathAnimationResult[] {
    const results = this.pathAnimationResults;
    this.pathAnimationResults = [];
    return results;
  }

  private collectPathAnimationResult(entry: PresentationEntry): void {
    const result = entry.takePathAnimationResult();
    if (result !== null) this.pathAnimationResults.push(result);
  }
}
