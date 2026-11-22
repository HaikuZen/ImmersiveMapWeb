// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Manages tile-download retry windows so the map does not create a request
 * storm under persistent errors: a per-tile backoff and a global cooldown
 * (an emergency fuse on 401/403 and 429 that throttles the whole stream).
 * A port of the Swift `TileRetryController`. Times are seconds.
 */

import type { TileRetryFailureReason } from "./download-failure.ts";
import { type Tile, tileKey } from "../tile.ts";

export interface RetryPolicy {
  baseBackoff: number;
  maxBackoff: number;
  parseFailureCooldown: number;
  notFoundCooldown: number;
  missingAuthorizationTokenCooldown: number;
  authCooldown: number;
  genericClientCooldown: number;
  rateLimitCooldown: number;
  globalAuthCooldown: number;
  globalRateLimitCooldown: number;
  maxExponent: number;
}

export const defaultRetryPolicy: Readonly<RetryPolicy> = {
  baseBackoff: 0.5,
  maxBackoff: 30,
  parseFailureCooldown: 120,
  notFoundCooldown: 600,
  missingAuthorizationTokenCooldown: 30,
  authCooldown: 30,
  genericClientCooldown: 60,
  rateLimitCooldown: 5,
  globalAuthCooldown: 15,
  globalRateLimitCooldown: 2,
  maxExponent: 6,
};

export class TileRetryController {
  private readonly stateByTile = new Map<string, { failureCount: number; nextRetryAt: number }>();
  private globalBlockedUntil: number | undefined;

  constructor(
    private readonly policy: Readonly<RetryPolicy> = defaultRetryPolicy,
    private readonly now: () => number = () => performance.now() / 1000,
  ) {}

  /** Whether the tile must not be requested right now: the global cooldown or its own backoff. */
  shouldBlock(tile: Tile): boolean {
    const now = this.now();
    this.clearExpiredGlobalBlock(now);
    if (this.globalBlockedUntil !== undefined && now < this.globalBlockedUntil) return true;
    const state = this.stateByTile.get(tileKey(tile));
    return state !== undefined && now < state.nextRetryAt;
  }

  registerSuccess(tile: Tile): void {
    this.stateByTile.delete(tileKey(tile));
    this.clearExpiredGlobalBlock(this.now());
  }

  registerFailure(tile: Tile, reason: TileRetryFailureReason): void {
    const now = this.now();
    const key = tileKey(tile);
    const failureCount = this.stateByTile.get(key)?.failureCount ?? 0;
    this.stateByTile.set(key, { failureCount: failureCount + 1, nextRetryAt: now + this.retryDelay(reason, failureCount) });
    const globalDelay = this.globalRetryDelay(reason);
    if (globalDelay !== undefined) {
      const next = now + globalDelay;
      this.globalBlockedUntil = this.globalBlockedUntil === undefined ? next : Math.max(this.globalBlockedUntil, next);
    }
  }

  /**
   * The nearest future moment a blocked tile becomes requestable: the
   * scheduler wakes the on-demand render loop then. Expired windows are
   * ignored. An active global cooldown wins: no tile unblocks before it.
   */
  earliestNextRetryDate(): number | undefined {
    const now = this.now();
    this.clearExpiredGlobalBlock(now);
    if (this.globalBlockedUntil !== undefined) return this.globalBlockedUntil;
    let earliest: number | undefined;
    for (const state of this.stateByTile.values()) {
      if (state.nextRetryAt > now && (earliest === undefined || state.nextRetryAt < earliest)) earliest = state.nextRetryAt;
    }
    return earliest;
  }

  /** Keeps retry state only for the current tile set. */
  retainOnly(keys: ReadonlySet<string>): void {
    for (const key of this.stateByTile.keys()) if (!keys.has(key)) this.stateByTile.delete(key);
    this.clearExpiredGlobalBlock(this.now());
  }

  reset(): void {
    this.stateByTile.clear();
    this.globalBlockedUntil = undefined;
  }

  private clearExpiredGlobalBlock(now: number): void {
    if (this.globalBlockedUntil !== undefined && this.globalBlockedUntil <= now) this.globalBlockedUntil = undefined;
  }

  private retryDelay(reason: TileRetryFailureReason, failureCount: number): number {
    const p = this.policy;
    switch (reason.kind) {
      case "parseFailed":
        return p.parseFailureCooldown;
      case "stalled":
      case "materializeFailed":
        return this.exponentialBackoff(failureCount);
      case "download":
        switch (reason.failure.kind) {
          case "missingAuthorizationToken":
            return p.missingAuthorizationTokenCooldown;
          case "unauthorized":
          case "forbidden":
            return p.authCooldown;
          case "notFound":
          case "gone":
            return p.notFoundCooldown;
          case "rateLimited":
            return Math.max(reason.failure.retryAfter ?? 0, p.rateLimitCooldown);
          case "client":
            return p.genericClientCooldown;
          case "server":
          case "network":
          case "nonHTTPResponse":
          case "emptyBody":
          case "archiveUnavailable":
            return this.exponentialBackoff(failureCount);
        }
    }
  }

  private globalRetryDelay(reason: TileRetryFailureReason): number | undefined {
    if (reason.kind !== "download") return undefined;
    switch (reason.failure.kind) {
      case "missingAuthorizationToken":
      case "unauthorized":
      case "forbidden":
        return this.policy.globalAuthCooldown;
      case "rateLimited":
        return Math.max(reason.failure.retryAfter ?? 0, this.policy.globalRateLimitCooldown);
      default:
        return undefined;
    }
  }

  private exponentialBackoff(failureCount: number): number {
    const exponent = Math.min(failureCount, this.policy.maxExponent);
    return Math.min(this.policy.baseBackoff * 2 ** exponent, this.policy.maxBackoff);
  }
}
