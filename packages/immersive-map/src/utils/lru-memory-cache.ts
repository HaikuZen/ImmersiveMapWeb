// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A cost-bounded cache, least recently used out first, a port of the Swift
 * `LRUMemoryCache`. Recency is a tick on the entry, so a probe is O(1) and
 * the victim search runs only on eviction. Protected keys (what the frame
 * wants) never go, and the cache may then stay over its limit.
 */

export interface LruEntry<K, V> {
  readonly key: K;
  readonly value: V;
  readonly cost: number;
}

interface Slot<V> {
  value: V;
  cost: number;
  tick: number;
}

export class LruMemoryCache<K, V> {
  private readonly slots = new Map<K, Slot<V>>();
  private tick = 0;
  private total = 0;
  private readonly costLimit: number;

  constructor(costLimit: number) {
    this.costLimit = Math.max(0, costLimit);
  }

  get totalCost(): number {
    return this.total;
  }

  get size(): number {
    return this.slots.size;
  }

  keys(): IterableIterator<K> {
    return this.slots.keys();
  }

  /** The value, its recency bumped. */
  value(key: K): V | undefined {
    const slot = this.slots.get(key);
    if (slot === undefined) return undefined;
    slot.tick = ++this.tick;
    return slot.value;
  }

  /** Inserts the value and evicts down to the limit, never the inserted key nor a protected one. Returns what went. */
  set(key: K, value: V, cost: number, protectedKeys: ReadonlySet<K> = new Set()): LruEntry<K, V>[] {
    const normalized = Math.max(0, cost);
    const existing = this.slots.get(key);
    if (existing !== undefined) this.total -= existing.cost;
    this.slots.set(key, { value, cost: normalized, tick: ++this.tick });
    this.total += normalized;
    return this.evict(this.costLimit, protectedKeys, key, true);
  }

  /** Evicts down to `targetCost`, the protected keys kept. Returns what went. */
  trim(targetCost: number, protectedKeys: ReadonlySet<K> = new Set()): LruEntry<K, V>[] {
    return this.evict(Math.max(0, targetCost), protectedKeys, undefined, false);
  }

  remove(key: K): LruEntry<K, V> | undefined {
    const slot = this.slots.get(key);
    if (slot === undefined) return undefined;
    this.slots.delete(key);
    this.total -= slot.cost;
    return { key, value: slot.value, cost: slot.cost };
  }

  /** Every entry, least recently used first, the cache left empty. */
  removeAll(): LruEntry<K, V>[] {
    const entries = [...this.slots].sort((a, b) => a[1].tick - b[1].tick).map(([key, slot]) => ({ key, value: slot.value, cost: slot.cost }));
    this.slots.clear();
    this.total = 0;
    return entries;
  }

  private evict(targetCost: number, protectedKeys: ReadonlySet<K>, insertedKey: K | undefined, keepOne: boolean): LruEntry<K, V>[] {
    const evicted: LruEntry<K, V>[] = [];
    const minimumCount = keepOne ? 1 : 0;
    while (this.total > targetCost && this.slots.size > minimumCount) {
      let victim: K | undefined;
      let victimTick = Infinity;
      let found = false;
      for (const [key, slot] of this.slots) {
        if (key === insertedKey || protectedKeys.has(key)) continue;
        if (slot.tick < victimTick) {
          victimTick = slot.tick;
          victim = key;
          found = true;
        }
      }
      // Everything left is protected: the limit is exceeded.
      if (!found) break;
      const entry = this.remove(victim as K)!;
      evicted.push(entry);
    }
    return evicted;
  }
}
