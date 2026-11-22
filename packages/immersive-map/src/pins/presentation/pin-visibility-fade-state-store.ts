// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ProjectedPin } from "../clustering/pin-collision-types.ts";

export interface PinVisibilityFadeResolution {
  readonly projectedPins: readonly ProjectedPin[];
  readonly hasActiveAnimations: boolean;
}

interface Entry {
  currentAlpha: number;
  targetAlpha: number;
  lastUpdateTime: number;
}

/**
 * The pins' fades in and out as they cross the globe's horizon, a port of
 * the Swift `PinVisibilityFadeStateStore`. A fully visible pin carries no
 * state, so a flat map of pins costs nothing here.
 */
export class PinVisibilityFadeStateStore {
  static readonly activeAlphaThreshold = 0.0001;

  private readonly entriesById = new Map<number, Entry>();
  /** The fully visible pins of the last frame that carry no state, ascending: a fade of one of them starts at one. */
  private previouslyFullyVisibleIDs: number[] = [];
  private animating = false;

  get hasActiveAnimations(): boolean {
    return this.animating;
  }

  resolve(projectedPins: readonly ProjectedPin[], time: number, fadeInSeconds: number, fadeOutSeconds: number): PinVisibilityFadeResolution {
    const resolved: ProjectedPin[] = [];
    const seen = new Set<number>();
    const fullyVisible: number[] = [];
    let hasActiveAnimations = false;

    for (const projected of projectedPins) {
      if (projected.screenPoint.visible === 0) continue;
      const id = projected.pin.id;
      const targetAlpha = Math.min(Math.max(projected.screenPoint.visibilityAlpha, 0), 1);
      // A fully visible pin without fade state passes straight through.
      if (targetAlpha >= 1 && (this.entriesById.size === 0 || !this.entriesById.has(id))) {
        fullyVisible.push(id);
        resolved.push(projected);
        continue;
      }
      seen.add(id);
      let entry = this.entriesById.get(id);
      if (entry === undefined) {
        entry = containsSorted(this.previouslyFullyVisibleIDs, id)
          ? { currentAlpha: 1, targetAlpha: 1, lastUpdateTime: time }
          : { currentAlpha: targetAlpha, targetAlpha, lastUpdateTime: time };
      } else {
        entry = { ...entry };
      }
      advance(entry, entry.targetAlpha, time, fadeInSeconds, fadeOutSeconds);
      entry.targetAlpha = targetAlpha;
      entry.lastUpdateTime = time;
      const active = Math.abs(entry.currentAlpha - entry.targetAlpha) > 0.001;

      // A fade that reached full visibility drops its state: the pin takes the free path again.
      if (!active && targetAlpha >= 1 && entry.currentAlpha >= 1) {
        this.entriesById.delete(id);
        fullyVisible.push(id);
        resolved.push(projected);
        continue;
      }
      const threshold = PinVisibilityFadeStateStore.activeAlphaThreshold;
      if (entry.currentAlpha > threshold || targetAlpha > threshold || active) {
        resolved.push({ ...projected, screenPoint: { ...projected.screenPoint, visibilityAlpha: entry.currentAlpha } });
        hasActiveAnimations = hasActiveAnimations || active;
      }
      this.entriesById.set(id, entry);
    }

    if (this.entriesById.size > 0) {
      for (const id of [...this.entriesById.keys()]) if (!seen.has(id)) this.entriesById.delete(id);
    }
    for (let index = 1; index < fullyVisible.length; index++) {
      if (fullyVisible[index - 1]! > fullyVisible[index]!) {
        fullyVisible.sort((a, b) => a - b);
        break;
      }
    }
    this.previouslyFullyVisibleIDs = fullyVisible;
    this.animating = hasActiveAnimations;
    return { projectedPins: resolved, hasActiveAnimations };
  }
}

function containsSorted(sorted: readonly number[], id: number): boolean {
  let low = 0;
  let high = sorted.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = sorted[middle]!;
    if (value === id) return true;
    if (value < id) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

function advance(entry: Entry, targetAlpha: number, time: number, fadeInSeconds: number, fadeOutSeconds: number): void {
  const elapsed = Math.max(0, time - entry.lastUpdateTime);
  if (!(elapsed > 0)) return;
  if (targetAlpha > entry.currentAlpha) {
    const duration = Math.max(0, fadeInSeconds);
    entry.currentAlpha = duration === 0 ? targetAlpha : Math.min(targetAlpha, entry.currentAlpha + elapsed / duration);
  } else if (targetAlpha < entry.currentAlpha) {
    const duration = Math.max(0, fadeOutSeconds);
    entry.currentAlpha = duration === 0 ? targetAlpha : Math.max(targetAlpha, entry.currentAlpha - elapsed / duration);
  }
}
