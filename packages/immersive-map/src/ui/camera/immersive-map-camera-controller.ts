// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { CameraFlightOptions, type ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import type { ImmersiveMapGeoPath } from "../../geo/immersive-map-geo-path.ts";
import type { ImmersiveMapPathAnimationCurve } from "../../geo/immersive-map-path-animation-curve.ts";
import { ImmersiveMapCameraFollowOptions } from "./immersive-map-camera-follow-options.ts";
import type { ImmersiveMapCameraSnapshot } from "./immersive-map-camera-snapshot.ts";

/** Called once when a flight or a follow ends: true when it ran out, false when it was cancelled or superseded. */
export type CameraCompletion = (finished: boolean) => void;

/** A command of the camera controller, as the map's command handler receives it. */
export type ImmersiveMapCameraCommand =
  | { readonly kind: "jump"; readonly position: ImmersiveMapCameraPosition }
  | {
      readonly kind: "fly";
      readonly position: ImmersiveMapCameraPosition;
      readonly options: CameraFlightOptions;
      readonly completion: CameraCompletion | null;
    }
  | { readonly kind: "cancelFlight" }
  | {
      readonly kind: "follow";
      readonly path: ImmersiveMapGeoPath;
      readonly duration: number;
      readonly curve: ImmersiveMapPathAnimationCurve;
      readonly options: ImmersiveMapCameraFollowOptions;
      readonly completion: CameraCompletion | null;
    }
  | { readonly kind: "cancelFollow" }
  | { readonly kind: "setAngleTarget"; readonly bearing: number; readonly pitch: number };

/**
 * Public command and callback surface for app-driven camera control.
 * Accumulates commands until attached to a map and keeps the latest camera
 * position for callers.
 *
 * Everything runs on the main thread, so the Swift controller's lock has no
 * counterpart here.
 */
export class ImmersiveMapCameraController {
  private currentPosition: ImmersiveMapCameraPosition | null = null;
  private currentSnapshot: ImmersiveMapCameraSnapshot | null = null;
  private pendingCommands: ImmersiveMapCameraCommand[] = [];
  private commandHandler: ((command: ImmersiveMapCameraCommand) => void) | null = null;
  /** Owner of the current attachment (the camera runtime of a specific map). */
  private runtimeOwner: object | null = null;
  /** Internal subscribers to the start of a user gesture (the camera tour), apart from the public `onUserInteractionBegan`. */
  private readonly userInteractionObservers = new Map<symbol, () => void>();
  /**
   * Internal subscribers to snapshot changes (the built-in camera control
   * panel), apart from the public `onCameraSnapshotChanged`, so a panel never
   * takes the app's callback slot.
   */
  private readonly cameraSnapshotObservers = new Map<symbol, (snapshot: ImmersiveMapCameraSnapshot) => void>();

  onMapBackgroundTap: (() => void) | null = null;
  onUserInteractionBegan: (() => void) | null = null;
  onCameraPositionChanged: ((position: ImmersiveMapCameraPosition) => void) | null = null;
  onCameraSnapshotChanged: ((snapshot: ImmersiveMapCameraSnapshot) => void) | null = null;

  /** Puts the camera at `position` at once. */
  jump(position: ImmersiveMapCameraPosition): void {
    this.updateCurrentCameraPosition(position);
    this.enqueue({ kind: "jump", position });
  }

  /** Flies the camera to `position`. `completion` is called once, true on arrival. */
  fly(position: ImmersiveMapCameraPosition, options: CameraFlightOptions = CameraFlightOptions.default, completion: CameraCompletion | null = null): void {
    this.enqueue({ kind: "fly", position, options, completion });
  }

  cancelFlight(): void {
    this.enqueue({ kind: "cancelFlight" });
  }

  /**
   * Travels the camera along `path` over `duration` seconds, the same
   * traversal a scene model gets from its path animation. Start both with the
   * same duration and curve and the camera stays on the model.
   *
   * The camera keeps whatever zoom and pitch it has unless `options` names
   * them, so the app can keep zooming while the camera travels. `completion`
   * is called exactly once: true when the traversal ran out, false when it
   * was superseded by another camera command, cancelled, or interrupted by
   * the user taking the camera.
   */
  follow(
    path: ImmersiveMapGeoPath,
    duration: number,
    curve: ImmersiveMapPathAnimationCurve = "easeOut",
    options: ImmersiveMapCameraFollowOptions = ImmersiveMapCameraFollowOptions.default,
    completion: CameraCompletion | null = null,
  ): void {
    this.enqueue({ kind: "follow", path, duration, curve, options, completion });
  }

  cancelFollow(): void {
    this.enqueue({ kind: "cancelFollow" });
  }

  /**
   * Smoothly steers the camera angles (bearing and pitch, in radians) toward
   * the target, for interactive controls. Unlike `jump`, the actual angles
   * approach the target frame by frame.
   */
  setCameraAngleTarget(bearingRadians: number, pitchRadians: number): void {
    this.enqueue({ kind: "setAngleTarget", bearing: bearingRadians, pitch: pitchRadians });
  }

  currentCameraPosition(): ImmersiveMapCameraPosition | null {
    return this.currentPosition;
  }

  currentCameraSnapshot(): ImmersiveMapCameraSnapshot | null {
    return this.currentSnapshot;
  }

  /**
   * Attaches the controller to the map runtime and replays the accumulated
   * commands. `owner` is remembered so detaching is strictly owner-scoped.
   */
  attachRuntime(owner: object, commandHandler: (command: ImmersiveMapCameraCommand) => void): void {
    this.runtimeOwner = owner;
    this.commandHandler = commandHandler;
    const commands = this.pendingCommands;
    this.pendingCommands = [];
    for (const command of commands) {
      commandHandler(command);
    }
  }

  /**
   * Detaches the controller only if `owner` still owns it: a map torn down
   * after a new one took the controller must not wipe the new attachment and
   * the caches it installed.
   */
  detachRuntime(owner: object): void {
    if (this.runtimeOwner !== owner) {
      return;
    }
    this.runtimeOwner = null;
    this.commandHandler = null;
    this.updateCurrentCameraPosition(null);
    this.updateCurrentCameraSnapshot(null);
  }

  updateCurrentCameraPosition(position: ImmersiveMapCameraPosition | null): void {
    this.currentPosition = position;
  }

  updateCurrentCameraSnapshot(snapshot: ImmersiveMapCameraSnapshot | null): void {
    this.currentSnapshot = snapshot;
  }

  notifyMapBackgroundTap(): void {
    this.onMapBackgroundTap?.();
  }

  /** Subscribes to the start of a user gesture. Returns the token `removeUserInteractionObserver` takes. */
  addUserInteractionObserver(observer: () => void): symbol {
    const token = Symbol("userInteractionObserver");
    this.userInteractionObservers.set(token, observer);
    return token;
  }

  removeUserInteractionObserver(token: symbol): void {
    this.userInteractionObservers.delete(token);
  }

  notifyUserInteractionBegan(): void {
    this.onUserInteractionBegan?.();
    for (const observer of [...this.userInteractionObservers.values()]) {
      observer();
    }
  }

  /** Subscribes to camera snapshot changes. Returns the token `removeCameraSnapshotObserver` takes. */
  addCameraSnapshotObserver(observer: (snapshot: ImmersiveMapCameraSnapshot) => void): symbol {
    const token = Symbol("cameraSnapshotObserver");
    this.cameraSnapshotObservers.set(token, observer);
    return token;
  }

  removeCameraSnapshotObserver(token: symbol): void {
    this.cameraSnapshotObservers.delete(token);
  }

  notifyCameraPositionChanged(position: ImmersiveMapCameraPosition): void {
    this.updateCurrentCameraPosition(position);
    this.onCameraPositionChanged?.(position);
  }

  notifyCameraSnapshotChanged(snapshot: ImmersiveMapCameraSnapshot): void {
    this.updateCurrentCameraSnapshot(snapshot);
    this.onCameraSnapshotChanged?.(snapshot);
    for (const observer of [...this.cameraSnapshotObservers.values()]) {
      observer(snapshot);
    }
  }

  private enqueue(command: ImmersiveMapCameraCommand): void {
    if (this.commandHandler === null) {
      this.pendingCommands.push(command);
      return;
    }
    this.commandHandler(command);
  }
}
