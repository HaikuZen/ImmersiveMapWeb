// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type Tile, tileKey } from "../../tile.ts";

/** A load under way, with the failures behind it, or a failed one waiting out its pause. */
export type GroundReliefLoadState =
  | { readonly kind: "loading"; readonly failedAttempts: number }
  | { readonly kind: "failed"; readonly attempts: number; readonly retryAt: number };

/**
 * How the terrain store's loads go, a port of the Swift
 * `GroundReliefLoadStates`: which tiles are on their way and since when,
 * which failed and when they are tried again, which the source does not
 * have, and how many load slots are taken. The bookkeeping alone, so the
 * rules of the retries and the slots are plain values a test reads.
 *
 * A tile the source does not have (`missing`) is remembered for good, and
 * its ancestor is wanted in its place. One that could not be fetched is
 * asked again after a pause that grows with each failure, and counts as
 * unavailable (`isUnavailable`) from `unavailableAfterAttempts` failures
 * on, while the retries go on behind. Times are in seconds.
 */
export class GroundReliefLoadStates {
  static readonly retryBaseDelay = 5;
  static readonly retryMaximumDelay = 60;
  /**
   * How many attempts a load fails before its tile counts as unavailable:
   * the planner then places what rises by it flat instead of waiting, and
   * the retries go on behind. Two: the first failure may be a dropped
   * connection, the second one `retryBaseDelay` later says the source is
   * out of reach.
   */
  static readonly unavailableAfterAttempts = 2;

  readonly maximumConcurrentLoads: number;
  /** By `tileKey`. */
  readonly statesByTile = new Map<string, GroundReliefLoadState>();
  /** When each load started, by `tileKey`, for the status. */
  readonly startedAt = new Map<string, number>();
  private active = 0;
  /** The tiles the source does not have, by `tileKey`. */
  readonly missing = new Set<string>();

  constructor(maximumConcurrentLoads: number) {
    this.maximumConcurrentLoads = Math.max(1, Math.trunc(maximumConcurrentLoads));
  }

  get activeLoads(): number {
    return this.active;
  }

  isMissing(tile: Tile): boolean {
    return this.missing.has(tileKey(tile));
  }

  /** Whether a tile cannot come for now: the source has no such tile, or has not answered for it `unavailableAfterAttempts` times. */
  isUnavailable(tile: Tile): boolean {
    const key = tileKey(tile);
    if (this.missing.has(key)) return true;
    const state = this.statesByTile.get(key);
    return state?.kind === "failed" && state.attempts >= GroundReliefLoadStates.unavailableAfterAttempts;
  }

  /**
   * The wanted tiles to load now, nearest first, while slots are free:
   * neither in (`isLoaded`) nor on their way, and a failed one only once
   * its pause is out. Each is counted as loading from here.
   */
  start(wanted: readonly Tile[], isLoaded: (tile: Tile) => boolean, now: number): Tile[] {
    const started: Tile[] = [];
    for (const tile of wanted) {
      if (this.active >= this.maximumConcurrentLoads) break;
      if (isLoaded(tile)) continue;
      const key = tileKey(tile);
      const state = this.statesByTile.get(key);
      if (state === undefined) {
        this.begin(key, 0, now);
        started.push(tile);
      } else if (state.kind === "failed" && now >= state.retryAt) {
        this.begin(key, state.attempts, now);
        started.push(tile);
      }
    }
    return started;
  }

  private begin(key: string, failedAttempts: number, now: number): void {
    this.statesByTile.set(key, { kind: "loading", failedAttempts });
    this.startedAt.set(key, now);
    this.active += 1;
  }

  /** A load that ended with an answer: the heights, or `missing` for a tile the source does not have. */
  finish(tile: Tile, missing: boolean): void {
    const key = tileKey(tile);
    this.statesByTile.delete(key);
    this.startedAt.delete(key);
    this.active -= 1;
    if (missing) this.missing.add(key);
  }

  /**
   * A load that failed: its tile waits out a pause that doubles with each
   * failure, up to `retryMaximumDelay`. Returns the pause and whether the
   * tile has just turned unavailable.
   */
  fail(tile: Tile, now: number): { delay: number; becameUnavailable: boolean } {
    const key = tileKey(tile);
    const state = this.statesByTile.get(key);
    const attempts = state?.kind === "loading" ? state.failedAttempts + 1 : 1;
    const delay = Math.min(GroundReliefLoadStates.retryMaximumDelay, GroundReliefLoadStates.retryBaseDelay * 2 ** (attempts - 1));
    this.statesByTile.set(key, { kind: "failed", attempts, retryAt: now + delay });
    this.startedAt.delete(key);
    this.active -= 1;
    return { delay, becameUnavailable: attempts === GroundReliefLoadStates.unavailableAfterAttempts };
  }

  /**
   * The wanted tiles still to come: on their way or queued, and a failed
   * one whose retry is due. Not a resident one, not one the source has no
   * tile for, and not one waiting out its retry.
   */
  pendingCount(wanted: readonly Tile[], isLoaded: (tile: Tile) => boolean, now: number): number {
    let pending = 0;
    for (const tile of wanted) {
      const key = tileKey(tile);
      if (isLoaded(tile) || this.missing.has(key)) continue;
      const state = this.statesByTile.get(key);
      if (state === undefined || state.kind === "loading" || now >= state.retryAt) pending += 1;
    }
    return pending;
  }

  get failedCount(): number {
    let count = 0;
    for (const state of this.statesByTile.values()) if (state.kind === "failed") count += 1;
    return count;
  }
}
