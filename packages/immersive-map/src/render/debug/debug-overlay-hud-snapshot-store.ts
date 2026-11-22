// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * What the debug panel shows right now, so a frame builds only that (the
 * Swift `DebugOverlayHUDContentRequest`): a bit set of the panel's tabs.
 * The panel is in step with every rendered frame, one to one, and the frame
 * pays for one tab's data, not the whole panel's.
 */
export type DebugOverlayHUDContentRequest = number;

export const DebugOverlayHUDContentRequest = {
  none: 0,
  /** The camera's lines and the frame's diagnostics. */
  stats: 1 << 0,
  /** The loader's status, the tile cards and the coverage map. */
  tiles: 1 << 1,
  /** The terrain store's status, the terrain cards and their map. */
  relief: 1 << 2,
  all: (1 << 0) | (1 << 1) | (1 << 2),

  /** Whether the request holds every bit of `part`. */
  contains(request: DebugOverlayHUDContentRequest, part: DebugOverlayHUDContentRequest): boolean {
    return (request & part) === part;
  },
} as const;

/** One published snapshot and the version it was published under (the Swift `DebugOverlayHUDSnapshotStoreValue`). */
export interface DebugOverlayHUDSnapshotStoreValue<Snapshot> {
  readonly version: number;
  readonly snapshot: Snapshot | undefined;
}

/**
 * The frame's HUD snapshot on its way from the engine to the panel, and the
 * panel's wishes on their way back (the Swift `DebugOverlayHUDSnapshotStore`),
 * generic over the snapshot and the loader status the debug entry builds.
 * Every rendered frame publishes a snapshot and the panel applies it in the
 * same task (`onSnapshotPublished`), so the numbers on the panel are the
 * frame's on screen. Between frames the loader goes on and the on-demand
 * loop sleeps: the reporter says when its state moved
 * (`noteTileLoadingStatusChanged`), the store folds a burst of changes into
 * one microtask, and the panel reads the rows from the provider, so the rows
 * never stay behind the loader. The panel says which content it shows
 * (`requestedContent`), and a frame builds only that. Everything runs on the
 * main thread, so it holds plain fields.
 */
export class DebugOverlayHUDSnapshotStore<Snapshot, Status> {
  /** What the panel shows, for the frame to build: the panel sets it on a tab change, the engine reads it every frame. */
  requestedContent: DebugOverlayHUDContentRequest = DebugOverlayHUDContentRequest.all;
  /** The panel's hook for a frame's snapshot just published, called by whoever publishes once the frame is on screen. */
  onSnapshotPublished: (() => void) | undefined;
  /** The panel's hook for the loader's state moved between frames, once for a burst. */
  onTileLoadingStatusChanged: (() => void) | undefined;

  #version = 0;
  #snapshot: Snapshot | undefined;
  #provider: (() => Status | undefined) | undefined;
  #isRefreshScheduled = false;

  /** The reporter's word that its state moved: one microtask for a burst of changes, where the panel reads the rows again. */
  noteTileLoadingStatusChanged(): void {
    if (this.#isRefreshScheduled) return;
    this.#isRefreshScheduled = true;
    queueMicrotask(() => {
      this.#isRefreshScheduled = false;
      this.onTileLoadingStatusChanged?.();
    });
  }

  /** The engine attaches its reporter when it is built and detaches it (undefined) when discarded. */
  attachTileLoadingStatus(provider: (() => Status | undefined) | undefined): void {
    this.#provider = provider;
  }

  /** The reporter's state right now, or undefined without a provider (no engine, or the panel is off and the engine keeps no reporter). */
  currentTileLoadingStatus(): Status | undefined {
    return this.#provider?.();
  }

  /**
   * The between-frames refresh: the snapshot the panel shows with its tile
   * list read again from the reporter (`replace`), or undefined when nothing
   * is shown, there is no provider, or nothing moved since (`isEqual`).
   */
  refreshedSnapshot(
    applied: Snapshot | undefined,
    replace: (snapshot: Snapshot, status: Status) => Snapshot,
    isEqual: (lhs: Snapshot, rhs: Snapshot) => boolean,
  ): Snapshot | undefined {
    if (applied === undefined) return undefined;
    const status = this.currentTileLoadingStatus();
    if (status === undefined) return undefined;
    const refreshed = replace(applied, status);
    return isEqual(refreshed, applied) ? undefined : refreshed;
  }

  /**
   * Publishes a frame's snapshot, undefined included, under a new version.
   * The frame's sink calls `onSnapshotPublished` after it, as the Swift sink
   * does, so the store stays free of the frame's order.
   */
  publish(snapshot: Snapshot | undefined): number {
    this.#version += 1;
    this.#snapshot = snapshot;
    return this.#version;
  }

  /** The latest snapshot if its version is not the one already consumed. */
  consumeLatest(consumedVersion: number): DebugOverlayHUDSnapshotStoreValue<Snapshot> | undefined {
    if (this.#version === consumedVersion) return undefined;
    return { version: this.#version, snapshot: this.#snapshot };
  }
}
