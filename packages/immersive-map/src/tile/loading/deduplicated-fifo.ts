// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A bounded FIFO of tiles without duplicates. When full, a push overwrites
 * the oldest element, as the Swift `FIFOStack` does.
 */

import { type Tile, tileKey } from "../tile.ts";

export class DeduplicatedTilesFIFO {
  private readonly elements: (Tile | undefined)[];
  private head = 0;
  private tail = 0;
  private size = 0;
  private readonly enqueued = new Set<string>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
    this.elements = new Array<Tile | undefined>(this.capacity).fill(undefined);
  }

  get count(): number {
    return this.size;
  }

  enqueue(tile: Tile): boolean {
    const key = tileKey(tile);
    if (this.enqueued.has(key)) return false;
    this.enqueued.add(key);
    const overwritten = this.size === this.capacity ? this.elements[this.head] : undefined;
    this.elements[this.tail] = tile;
    this.tail = (this.tail + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    } else {
      this.head = (this.head + 1) % this.capacity;
      // The overwritten tile is no longer queued.
      if (overwritten) this.enqueued.delete(tileKey(overwritten));
    }
    return true;
  }

  dequeue(): Tile | undefined {
    if (this.size === 0) return undefined;
    const tile = this.elements[this.head];
    this.elements[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.size--;
    if (tile) this.enqueued.delete(tileKey(tile));
    return tile;
  }

  clear(): void {
    this.elements.fill(undefined);
    this.head = 0;
    this.tail = 0;
    this.size = 0;
    this.enqueued.clear();
  }
}
