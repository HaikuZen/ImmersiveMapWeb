// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * How far the parts of a layer of standing things (the extruded buildings by
 * the cell of the map they stand in, the trees, the models by their tile)
 * have risen out of the ground: 0 not drawn, 1 at full height. A port of the
 * Swift `ExtrusionRise`.
 *
 * A part rises over `seconds` from the frame it is first drawn in: when the
 * camera reaches the layer's zoom, and when its tile arrives later, while
 * the camera is already there. It is forgotten once a frame leaves it out,
 * so it rises again on its return. Leaving the zoom, the whole layer is gone
 * at once.
 *
 * Parts are told apart by `keyString`, the identity a Swift `Hashable` key
 * has: two keys of one string are one part.
 */
export class ExtrusionRise<Key> {
  private startTimes = new Map<string, { key: Key; start: number }>();
  private lastTime: number | undefined;
  private seconds = 0;
  private animating = false;

  constructor(private readonly keyString: (key: Key) => string) {}

  /** Whether a part is still rising and the frames have to keep coming. */
  get isAnimating(): boolean {
    return this.animating;
  }

  /**
   * Starts the parts first drawn in this frame and forgets the ones it leaves
   * out. `keys` are the parts the frame draws, empty when the camera is off
   * the layer's zoom. The first frame stands its parts up at once: a map
   * opened at a street zoom shows its buildings standing. `seconds` of zero
   * stands every part up at once. `overlaps` names the last frame's parts a
   * new part takes the place of: the new part goes on from the furthest
   * risen of them, so a part handed over to another (a coarser tile's
   * buildings to its children's when the zoom changes) stays standing, and
   * only a part on ground nothing stood on rises. Time is in seconds.
   */
  advance(keys: Iterable<Key>, time: number, seconds: number, overlaps?: (a: Key, b: Key) => boolean): void {
    const isFirstFrame = this.lastTime === undefined;
    this.lastTime = time;
    this.seconds = seconds;
    const drawn = new Map<string, { key: Key; start: number }>();
    for (const key of keys) {
      const id = this.keyString(key);
      if (drawn.has(id)) continue;
      const known = this.startTimes.get(id);
      let start: number;
      if (known !== undefined) {
        start = known.start;
      } else if (isFirstFrame) {
        start = -Infinity;
      } else {
        let inherited: number | undefined;
        if (overlaps) {
          for (const previous of this.startTimes.values()) {
            if (overlaps(key, previous.key) && (inherited === undefined || previous.start < inherited)) inherited = previous.start;
          }
        }
        start = inherited ?? time;
      }
      drawn.set(id, { key, start });
    }
    this.startTimes = drawn;
    let animating = false;
    if (seconds > 0) {
      for (const entry of drawn.values()) {
        if (time - entry.start < seconds) {
          animating = true;
          break;
        }
      }
    }
    this.animating = animating;
  }

  /** 0 to 1, linear in time. 0 for a part the frame does not draw. */
  progress(key: Key, time: number): number {
    const entry = this.startTimes.get(this.keyString(key));
    if (entry === undefined) return 0;
    if (!(this.seconds > 0)) return 1;
    return Math.min(Math.max((time - entry.start) / this.seconds, 0), 1);
  }

  /** The progress eased out: quick from the ground, settling at the top. 0 for a part the frame does not draw. */
  heightScale(key: Key, time: number): number {
    if (!this.startTimes.has(this.keyString(key))) return 0;
    const remaining = 1 - this.progress(key, time);
    return 1 - remaining * remaining * remaining;
  }

  reset(): void {
    this.startTimes = new Map();
    this.lastTime = undefined;
    this.seconds = 0;
    this.animating = false;
  }
}
