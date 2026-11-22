// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { LabelWorkingSetChange } from "../common/label-working-set-change.ts";

/**
 * The fade alpha of every label of a working set, index-aligned with the
 * set (the Swift `BaseLabelFadeState`): no map, no per-frame allocation. The
 * arrays are sized once when the set changes (`rebind`), carrying each
 * surviving tile's run of alphas to its new place, so a tile that moves in
 * the set keeps its fades. A frame then only advances the alphas in place.
 *
 * A target set this frame takes effect from the next frame on: the alpha
 * first moves toward the previous target over the time elapsed, then the
 * new target is stored, so a label that flips its decision mid-fade
 * finishes the step it was on before turning around.
 *
 * Times are in seconds.
 */
export class BaseLabelFadeState {
  currentAlphas = new Float32Array(0);
  private targetAlphas = new Float32Array(0);
  private lastUpdateTimes = new Float64Array(0);

  get count(): number {
    return this.currentAlphas.length;
  }

  /**
   * Binds the state to a set of `change.count` labels. A run that survived
   * keeps its alphas, targets and times at its new place, everything else
   * starts invisible with `time` as its last update, so the first advance
   * moves nothing.
   */
  rebind(change: LabelWorkingSetChange, time: number): void {
    this.currentAlphas = change.carry(this.currentAlphas, 0);
    this.targetAlphas = change.carry(this.targetAlphas, 0);
    this.lastUpdateTimes = change.carry(this.lastUpdateTimes, time);
  }

  /**
   * Advances every label toward its stored target over the time since its
   * last update, then stores `targetVisibility` as the new target. Returns
   * whether any label is still mid-fade. A missing entry of
   * `targetVisibility` counts as hidden. Only the labels of `spans` (start
   * and end pairs, `LabelActiveSpans`) move, the rest are dark and stay so.
   * Undefined moves every label.
   */
  advance(targetVisibility: Uint8Array, time: number, fadeInSeconds: number, fadeOutSeconds: number, spans?: ArrayLike<number>, spanCount?: number): boolean {
    const count = this.currentAlphas.length;
    if (count === 0) return false;
    const fadeIn = Math.max(0, fadeInSeconds);
    const fadeOut = Math.max(0, fadeOutSeconds);
    const alphas = this.currentAlphas;
    const targets = this.targetAlphas;
    const times = this.lastUpdateTimes;
    const visibleCount = targetVisibility.length;
    let active = false;
    const pairs = spans === undefined ? 1 : (spanCount ?? spans.length / 2);
    for (let s = 0; s < pairs; s++) {
      const start = spans === undefined ? 0 : spans[s * 2]!;
      const end = Math.min(spans === undefined ? count : spans[s * 2 + 1]!, count);
      for (let index = start; index < end; index++) {
        const elapsed = time - times[index]!;
        const target = targets[index]!;
        let alpha = alphas[index]!;
        if (elapsed > 0) {
          if (target > alpha) {
            if (fadeIn === 0) alpha = target;
            else {
              const next = Math.fround(alpha + Math.fround(elapsed / fadeIn));
              alpha = next < target ? next : target;
            }
          } else if (target < alpha) {
            if (fadeOut === 0) alpha = target;
            else {
              const next = Math.fround(alpha - Math.fround(elapsed / fadeOut));
              alpha = next > target ? next : target;
            }
          }
        }
        const nextTarget = index < visibleCount && targetVisibility[index] !== 0 ? 1 : 0;
        alphas[index] = alpha;
        targets[index] = nextTarget;
        times[index] = time;
        const delta = alpha - nextTarget;
        if (delta > 0.001 || delta < -0.001) active = true;
      }
    }
    return active;
  }

  /**
   * `loser` is another tile's copy of the feature `winner` is, the copy the
   * working set keeps: the winner takes the fuller alpha of the two so a
   * change of winner shows no blink, and the loser goes out at once, not
   * through a fade, or the text would draw twice while it faded.
   */
  transfer(loser: number, winner: number): void {
    const count = this.currentAlphas.length;
    if (loser === winner || loser < 0 || loser >= count || winner < 0 || winner >= count) return;
    if (this.currentAlphas[loser]! > this.currentAlphas[winner]!) {
      this.currentAlphas[winner] = this.currentAlphas[loser]!;
      this.targetAlphas[winner] = this.targetAlphas[loser]!;
      this.lastUpdateTimes[winner] = this.lastUpdateTimes[loser]!;
    }
    this.currentAlphas[loser] = 0;
    this.targetAlphas[loser] = 0;
  }

  reset(): void {
    this.currentAlphas = new Float32Array(0);
    this.targetAlphas = new Float32Array(0);
    this.lastUpdateTimes = new Float64Array(0);
  }
}
