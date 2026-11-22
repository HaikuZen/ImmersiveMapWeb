// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type Tile, tileKey } from "../../tile.ts";
import type { GroundReliefTile } from "./ground-relief-tile.ts";

/**
 * The terrain tiles the frame stopped reading, kept for a frame that reads
 * them again (`GroundReliefStore.request`), up to `capacityBytes`
 * (`GroundReliefSettings.releasedCacheBytes`), the oldest released let go
 * first: a port of the Swift `GroundReliefReleasedCache`. A tile asked for
 * again comes back from here without a load. A tile let go is handed to
 * `release`, which frees its textures.
 */
export class GroundReliefReleasedCache {
  readonly capacityBytes: number;
  /** By `tileKey`, in the order they were released, oldest first (a `Map` keeps its insertion order). */
  private readonly terrains = new Map<string, { tile: Tile; terrain: GroundReliefTile }>();
  private byteCount = 0;

  constructor(
    capacityBytes: number,
    private readonly release: (terrain: GroundReliefTile) => void = () => undefined,
  ) {
    this.capacityBytes = Math.max(0, capacityBytes);
  }

  get count(): number {
    return this.terrains.size;
  }

  get bytes(): number {
    return this.byteCount;
  }

  /** The tiles kept, for what is computed again over every tile in (the occlusion under a new key). */
  get all(): { tile: Tile; terrain: GroundReliefTile }[] {
    return [...this.terrains.values()];
  }

  /**
   * Keeps a tile the frame stopped reading, the oldest kept let go past the
   * capacity. A tile that alone costs more than the capacity is not kept.
   */
  keep(tile: Tile, terrain: GroundReliefTile): void {
    if (this.capacityBytes <= 0 || terrain.costInBytes > this.capacityBytes) {
      this.release(terrain);
      return;
    }
    const key = tileKey(tile);
    const existing = this.terrains.get(key);
    if (existing === undefined) {
      this.byteCount += terrain.costInBytes;
    } else {
      this.terrains.delete(key);
      if (existing.terrain !== terrain) {
        this.byteCount += terrain.costInBytes - existing.terrain.costInBytes;
        this.release(existing.terrain);
      }
    }
    this.terrains.set(key, { tile, terrain });
    for (const [oldestKey, oldest] of this.terrains) {
      if (this.byteCount <= this.capacityBytes) break;
      this.terrains.delete(oldestKey);
      this.byteCount -= oldest.terrain.costInBytes;
      this.release(oldest.terrain);
    }
  }

  /** A tile out of the cache, if it is there. */
  take(tile: Tile): GroundReliefTile | undefined {
    const key = tileKey(tile);
    const entry = this.terrains.get(key);
    if (entry === undefined) return undefined;
    this.terrains.delete(key);
    this.byteCount -= entry.terrain.costInBytes;
    return entry.terrain;
  }

  removeAll(): void {
    for (const entry of this.terrains.values()) this.release(entry.terrain);
    this.terrains.clear();
    this.byteCount = 0;
  }
}
