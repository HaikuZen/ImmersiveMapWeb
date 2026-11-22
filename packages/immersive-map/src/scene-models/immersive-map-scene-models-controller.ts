// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import { GeoPathMetrics } from "../geo/geo-path-sampler.ts";
import type { ImmersiveMapGeoPath } from "../geo/immersive-map-geo-path.ts";
import type { ImmersiveMapPathAnimationCurve } from "../geo/immersive-map-path-animation-curve.ts";
import { ImmersiveMapSceneModel } from "./immersive-map-scene-model.ts";
import type { SceneModelPathAnimationRequest, SceneModelPathAnimationResult, SceneModelsSnapshot } from "./scene-model-render-source.ts";

/** Called once when a path animation ends: true when the model reached the end of the path. */
export type SceneModelPathAnimationCompletion = (finished: boolean) => void;

/** How a model flies along a path. Every value has a default. */
export interface SceneModelPathAnimationOptions {
  /** `easeOut` by default. */
  readonly curve?: ImmersiveMapPathAnimationCurve;
  /** Whether the model turns to the path's course. True by default. */
  readonly appliesHeading?: boolean;
  /** Whether the model pitches with the altitude profile's climb. True by default. */
  readonly appliesPitch?: boolean;
}

/** The orientation values to change. The ones left out keep their current value. */
export interface SceneModelOrientation {
  readonly headingDegrees?: number;
  readonly pitchDegrees?: number;
  readonly rollDegrees?: number;
}

/** The default seconds of an orientation, scale or altitude change. */
const defaultTransformDuration = 0.3;

/**
 * The app's 3D scene models, a port of the Swift
 * `ImmersiveMapSceneModelsController`: keep one, attach it to a map, and
 * change the models through it. It collects the changes into snapshots the
 * renderer takes once a frame.
 *
 * ```ts
 * map.sceneModels.add(ImmersiveMapSceneModel.make({ id: 1, source: "models/tower.glb", coordinate: { latitude: 55.75, longitude: 37.62 } }));
 * map.sceneModels.setOrientation(1, { headingDegrees: 90 });
 * map.sceneModels.animate(1, ImmersiveMapGeoPath.between(from, to, { peakAltitudeMeters: 2000 }), 8, {}, (finished) => {});
 * ```
 *
 * Everything runs on the main thread, so the Swift controller's lock has no
 * counterpart here. A path animation's completion is called exactly once,
 * always asynchronously (in a microtask): never from inside the call that
 * ends the animation, so a completion that starts the next animation or
 * changes the models never re-enters the controller or the render loop.
 */
export class ImmersiveMapSceneModelsController {
  private modelsById = new Map<number, ImmersiveMapSceneModel>();
  private readonly removedIds = new Set<number>();
  private readonly transformAnimationDurationsById = new Map<number, number>();
  private pathAnimationsById = new Map<number, SceneModelPathAnimationRequest>();
  private readonly cancelledPathAnimationIds = new Set<number>();
  private readonly pathAnimationCompletionsById = new Map<number, { generation: number; completion: SceneModelPathAnimationCompletion }>();
  /**
   * The descriptor a model had before `animate` moved it to the path's end,
   * kept only until the request is handed to the renderer: cancelling before
   * then must leave the model where it was, not glide it to the destination.
   */
  private readonly descriptorsBeforePathAnimationById = new Map<number, ImmersiveMapSceneModel>();
  private pathAnimationGeneration = 0;
  private version = 0;
  private hasChanges = false;
  private changeHandler: (() => void) | null = null;
  private changeHandlerOwner: object | null = null;

  add(models: ImmersiveMapSceneModel | readonly ImmersiveMapSceneModel[]): void {
    this.upsert(isModelList(models) ? models : [models]);
  }

  /**
   * Replaces every model of the map. Descriptor changes snap (no transform
   * animation). Coordinate changes of surviving ids animate by distance.
   */
  set(models: readonly ImmersiveMapSceneModel[]): void {
    const newIds = new Set(models.map((model) => model.id));
    for (const id of this.modelsById.keys()) if (!newIds.has(id)) this.removedIds.add(id);
    this.modelsById = new Map(models.map((model) => [model.id, model]));
    for (const id of newIds) this.removedIds.delete(id);
    this.transformAnimationDurationsById.clear();
    const droppedCompletions: SceneModelPathAnimationCompletion[] = [];
    for (const [id, entry] of [...this.pathAnimationCompletionsById]) {
      if (newIds.has(id)) continue;
      this.pathAnimationCompletionsById.delete(id);
      droppedCompletions.push(entry.completion);
    }
    for (const id of [...this.pathAnimationsById.keys()]) if (!newIds.has(id)) this.pathAnimationsById.delete(id);
    for (const id of [...this.cancelledPathAnimationIds]) if (!newIds.has(id)) this.cancelledPathAnimationIds.delete(id);
    for (const id of [...this.descriptorsBeforePathAnimationById.keys()]) if (!newIds.has(id)) this.descriptorsBeforePathAnimationById.delete(id);
    this.markChanged();

    for (const completion of droppedCompletions) deliver(completion, false);
    this.notifyChanged();
  }

  /** Puts each model in the place of the one with its id, or adds it. */
  upsert(models: readonly ImmersiveMapSceneModel[]): void {
    for (const model of models) {
      this.modelsById.set(model.id, model);
      this.removedIds.delete(model.id);
    }
    this.markChanged();
    this.notifyChanged();
  }

  /** Moves a model along the great circle, with a duration derived from the distance. */
  move(id: number, coordinate: GeoCoordinate): void {
    const model = this.modelsById.get(id);
    if (model === undefined) return;
    this.modelsById.set(id, ImmersiveMapSceneModel.with(model, { coordinate: { latitude: coordinate.latitude, longitude: coordinate.longitude } }));
    this.markChanged();
    this.notifyChanged();
  }

  /**
   * Rotates a model. The values left out keep their current value. The
   * change animates as a shortest-arc quaternion slerp over `duration`
   * seconds.
   */
  setOrientation(id: number, orientation: SceneModelOrientation, duration = defaultTransformDuration): void {
    this.mutateTransform(id, duration, (model) =>
      ImmersiveMapSceneModel.with(model, {
        headingDegrees: orientation.headingDegrees ?? model.headingDegrees,
        pitchDegrees: orientation.pitchDegrees ?? model.pitchDegrees,
        rollDegrees: orientation.rollDegrees ?? model.rollDegrees,
      }),
    );
  }

  setScale(id: number, scale: number, duration = defaultTransformDuration): void {
    this.mutateTransform(id, duration, (model) => ImmersiveMapSceneModel.with(model, { scale }));
  }

  setAltitude(id: number, meters: number, duration = defaultTransformDuration): void {
    this.mutateTransform(id, duration, (model) => ImmersiveMapSceneModel.with(model, { altitudeMeters: meters }));
  }

  /**
   * Flies the model along `path` over `duration` seconds. While the
   * animation runs the path owns the model's coordinate, altitude and (when
   * the options say so) heading and pitch: `move`, `setAltitude` and
   * `setOrientation` for that id are ignored for as long as it runs, and do
   * not resurface when it ends. Everything else, `setScale` included, still
   * applies.
   *
   * `completion` is called exactly once, asynchronously: true when the model
   * reached the end of the path, false when the animation was superseded,
   * cancelled, or dropped because the model was removed, the map went away,
   * or the renderer was recreated.
   */
  animate(
    id: number,
    path: ImmersiveMapGeoPath,
    duration: number,
    options: SceneModelPathAnimationOptions = {},
    completion: SceneModelPathAnimationCompletion | null = null,
  ): void {
    const superseded = this.takeCompletion(id);
    const model = this.modelsById.get(id);
    const metrics = GeoPathMetrics.make(path);
    if (model === undefined || metrics === null) {
      deliver(superseded, false);
      deliver(completion, false);
      return;
    }

    this.pathAnimationGeneration += 1;
    const generation = this.pathAnimationGeneration;
    if (!this.descriptorsBeforePathAnimationById.has(id)) this.descriptorsBeforePathAnimationById.set(id, model);

    const curve = options.curve ?? "easeOut";
    const appliesHeading = options.appliesHeading ?? true;
    const appliesPitch = options.appliesPitch ?? true;
    // The descriptor lands on the path's end state right away, so when the
    // animation finishes the model settles into what the controller already
    // holds and no later snapshot snaps it back.
    const destination = metrics.sample(1);
    this.modelsById.set(
      id,
      ImmersiveMapSceneModel.with(model, {
        coordinate: destination.coordinate,
        altitudeMeters: destination.altitudeMeters,
        headingDegrees: appliesHeading ? destination.headingDegrees : model.headingDegrees,
        pitchDegrees: appliesPitch ? destination.pitchDegrees : model.pitchDegrees,
      }),
    );
    this.pathAnimationsById.set(id, { generation, path, duration, curve, appliesHeading, appliesPitch });
    this.cancelledPathAnimationIds.delete(id);
    if (completion !== null) this.pathAnimationCompletionsById.set(id, { generation, completion });
    this.markChanged();

    deliver(superseded, false);
    this.notifyChanged();
  }

  /** Stops a running path animation, leaving the model where the flight got to. Its completion gets false. */
  cancelPathAnimation(id: number): void {
    const completion = this.takeCompletion(id);
    // A request the renderer never saw is undone here: nothing moved, so the
    // descriptor goes back to what it was before `animate` aimed it at the
    // destination.
    const wasPending = this.pathAnimationsById.delete(id);
    let changed = wasPending;
    const restored = this.descriptorsBeforePathAnimationById.get(id);
    if (wasPending && restored !== undefined) {
      this.descriptorsBeforePathAnimationById.delete(id);
      this.modelsById.set(id, restored);
    } else if (this.modelsById.has(id)) {
      this.cancelledPathAnimationIds.add(id);
      changed = true;
    }
    if (changed) this.markChanged();

    deliver(completion, false);
    if (changed) this.notifyChanged();
  }

  remove(ids: number | readonly number[]): void {
    const droppedCompletions: SceneModelPathAnimationCompletion[] = [];
    for (const id of typeof ids === "number" ? [ids] : ids) {
      this.modelsById.delete(id);
      this.removedIds.add(id);
      this.transformAnimationDurationsById.delete(id);
      this.pathAnimationsById.delete(id);
      this.cancelledPathAnimationIds.delete(id);
      this.descriptorsBeforePathAnimationById.delete(id);
      const completion = this.takeCompletion(id);
      if (completion !== null) droppedCompletions.push(completion);
    }
    this.markChanged();

    for (const completion of droppedCompletions) deliver(completion, false);
    this.notifyChanged();
  }

  clear(): void {
    for (const id of this.modelsById.keys()) this.removedIds.add(id);
    this.modelsById.clear();
    this.transformAnimationDurationsById.clear();
    this.pathAnimationsById.clear();
    this.cancelledPathAnimationIds.clear();
    this.descriptorsBeforePathAnimationById.clear();
    const droppedCompletions = [...this.pathAnimationCompletionsById.values()].map((entry) => entry.completion);
    this.pathAnimationCompletionsById.clear();
    this.markChanged();

    for (const completion of droppedCompletions) deliver(completion, false);
    this.notifyChanged();
  }

  /** The model with `id` as the controller holds it, null when there is none. */
  model(id: number): ImmersiveMapSceneModel | null {
    return this.modelsById.get(id) ?? null;
  }

  /** Every model of the map, in insertion order. */
  models(): ImmersiveMapSceneModel[] {
    return [...this.modelsById.values()];
  }

  /** @internal The changes since the last snapshot, null when there are none. */
  consumeSnapshot(): SceneModelsSnapshot | null {
    if (!this.hasChanges) return null;
    this.hasChanges = false;
    const snapshot: SceneModelsSnapshot = {
      models: [...this.modelsById.values()],
      transformAnimationDurationsById: new Map(this.transformAnimationDurationsById),
      pathAnimationsById: this.pathAnimationsById,
      cancelledPathAnimationIds: [...this.cancelledPathAnimationIds],
      removedIds: [...this.removedIds],
      version: this.version,
    };
    this.removedIds.clear();
    this.transformAnimationDurationsById.clear();
    this.pathAnimationsById = new Map();
    this.cancelledPathAnimationIds.clear();
    // Handed to the renderer: from here a cancellation has to be answered
    // with where the flight actually stopped, not with the old descriptor.
    this.descriptorsBeforePathAnimationById.clear();
    return snapshot;
  }

  /** @internal The map attaching the controller: one map at a time. */
  setChangeHandler(handler: (() => void) | null, owner: object): void {
    this.changeHandler = handler;
    this.changeHandlerOwner = owner;
  }

  /** @internal Clears the handler only if `owner` still owns it: a map torn down must not detach a newer one. */
  clearChangeHandler(owner: object): void {
    if (this.changeHandlerOwner !== owner) return;
    this.changeHandler = null;
    this.changeHandlerOwner = null;
  }

  /**
   * @internal Records where each ended path animation left its model and
   * delivers the matching completion. Called from the render loop.
   *
   * The descriptor write is deliberately silent: the renderer already shows
   * that state, and marking the snapshot dirty would send it straight back.
   */
  applyPathAnimationResults(results: readonly SceneModelPathAnimationResult[]): void {
    const completions: [SceneModelPathAnimationCompletion, boolean][] = [];
    for (const result of results) {
      const model = this.modelsById.get(result.id);
      if (model !== undefined) {
        this.modelsById.set(
          result.id,
          ImmersiveMapSceneModel.with(model, {
            coordinate: result.coordinate,
            altitudeMeters: result.altitudeMeters,
            headingDegrees: result.headingDegrees,
            pitchDegrees: result.pitchDegrees,
          }),
        );
      }
      // A newer `animate` for the same id already owns the completion. An
      // older result must not resolve it.
      const entry = this.pathAnimationCompletionsById.get(result.id);
      if (entry === undefined || entry.generation !== result.generation) continue;
      this.pathAnimationCompletionsById.delete(result.id);
      completions.push([entry.completion, result.finished]);
    }

    for (const [completion, finished] of completions) deliver(completion, finished);
  }

  /**
   * @internal Drops every pending path animation and delivers its completion
   * with false. Called when the presentation store that owns the running
   * animations is discarded (renderer recreation, map teardown), which would
   * otherwise leave the app's chains waiting forever.
   */
  cancelAllPathAnimations(): void {
    const completions = [...this.pathAnimationCompletionsById.values()].map((entry) => entry.completion);
    this.pathAnimationCompletionsById.clear();
    this.pathAnimationsById.clear();
    this.cancelledPathAnimationIds.clear();
    this.descriptorsBeforePathAnimationById.clear();

    for (const completion of completions) deliver(completion, false);
  }

  /** @internal Every model goes into the next snapshot (a newly attached map). */
  markSnapshotDirty(): void {
    this.markChanged();
  }

  private takeCompletion(id: number): SceneModelPathAnimationCompletion | null {
    const entry = this.pathAnimationCompletionsById.get(id);
    if (entry === undefined) return null;
    this.pathAnimationCompletionsById.delete(id);
    return entry.completion;
  }

  private mutateTransform(id: number, duration: number, mutation: (model: ImmersiveMapSceneModel) => ImmersiveMapSceneModel): void {
    const model = this.modelsById.get(id);
    if (model === undefined) return;
    this.modelsById.set(id, mutation(model));
    this.transformAnimationDurationsById.set(id, Math.max(0, duration));
    this.markChanged();
    this.notifyChanged();
  }

  private markChanged(): void {
    this.version += 1;
    this.hasChanges = true;
  }

  private notifyChanged(): void {
    this.changeHandler?.();
  }
}

function isModelList(models: ImmersiveMapSceneModel | readonly ImmersiveMapSceneModel[]): models is readonly ImmersiveMapSceneModel[] {
  return Array.isArray(models);
}

/** Every exit of a completion routes through here: asynchronously, so a completion never runs inside the call that ended its animation. */
function deliver(completion: SceneModelPathAnimationCompletion | null, finished: boolean): void {
  if (completion === null) return;
  queueMicrotask(() => completion(finished));
}
