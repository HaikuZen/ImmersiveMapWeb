// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../../geo/geo-coordinate.ts";
import { GeoProjectionBasis } from "../../geo/geo-projection-basis.ts";
import type { ImmersiveMapPin } from "../immersive-map-pin.ts";
import type { PinsSnapshot } from "../immersive-map-pins-controller.ts";

/** How a moved pin travels to its new place, a port of the Swift `PinAnimationMath`. */
export const PinAnimationMath = Object.freeze({
  minimumDuration: 0.14,
  maximumDuration: 0.6,
  saturationDistanceMeters: 250,
  minimumAnimatedDistanceMeters: 0.01,

  /** Seconds for the trip: longer for a longer one, saturating at `saturationDistanceMeters`, 0 for none. */
  animationDuration(start: GeoCoordinate, target: GeoCoordinate): number {
    const distance = geodesicDistanceMeters(start, target);
    if (!(distance > PinAnimationMath.minimumAnimatedDistanceMeters)) return 0;
    const normalized = Math.min(Math.max(distance / PinAnimationMath.saturationDistanceMeters, 0), 1);
    const eased = normalized ** 0.6;
    return PinAnimationMath.minimumDuration + (PinAnimationMath.maximumDuration - PinAnimationMath.minimumDuration) * eased;
  },

  /** The point at `progress` of the great circle from `start` to `target`. */
  coordinate(start: GeoCoordinate, target: GeoCoordinate, progress: number): GeoCoordinate {
    const clamped = Math.min(Math.max(progress, 0), 1);
    if (!(clamped > 0)) return start;
    if (!(clamped < 1)) return target;
    const from = unitVector(start);
    const to = unitVector(target);
    // The Swift math runs in Float: the dot is rounded to it.
    const dot = Math.min(Math.max(Math.fround(from[0] * to[0] + from[1] * to[1] + from[2] * to[2]), -1), 1);
    if (dot > 0.9995) {
      return coordinateOf([from[0] + (to[0] - from[0]) * clamped, from[1] + (to[1] - from[1]) * clamped, from[2] + (to[2] - from[2]) * clamped]);
    }
    if (dot < -0.9995) return fallbackCoordinate(start, target, clamped);
    const angle = Math.acos(dot);
    const sinAngle = Math.sin(angle);
    if (!(sinAngle > Number.MIN_VALUE)) return target;
    const startWeight = Math.sin((1 - clamped) * angle) / sinAngle;
    const targetWeight = Math.sin(clamped * angle) / sinAngle;
    return coordinateOf([from[0] * startWeight + to[0] * targetWeight, from[1] * startWeight + to[1] * targetWeight, from[2] * startWeight + to[2] * targetWeight]);
  },

  /** Ease-out cubic. */
  easedProgress(rawProgress: number): number {
    const clamped = Math.min(Math.max(rawProgress, 0), 1);
    const inverse = 1 - clamped;
    return 1 - inverse * inverse * inverse;
  },
});

/** The selected pin's breathing squash, a port of the Swift `PinSelectionAnimationMath`. */
export const PinSelectionAnimationMath = Object.freeze({
  cycleDuration: 0.9,
  entryDuration: 0.18,
  minimumScale: 0.94,

  /** The quad's scale on x and y `elapsed` seconds into the selection. */
  squashScale(elapsed: number): [number, number] {
    const { cycleDuration, minimumScale } = PinSelectionAnimationMath;
    if (!(cycleDuration > 0)) return [1, 1];
    const normalized = elapsed % cycleDuration;
    const positive = normalized < 0 ? normalized + cycleDuration : normalized;
    const phase = (positive / cycleDuration) * 2 * Math.PI - Math.PI / 2;
    const horizontalShare = 0.5 * (1 + Math.sin(phase));
    const verticalShare = 1 - horizontalShare;
    const amplitude = (1 - minimumScale) * entryEnvelope(elapsed);
    return [Math.fround(1 - amplitude * horizontalShare), Math.fround(1 - amplitude * verticalShare)];
  },
});

function entryEnvelope(elapsed: number): number {
  const duration = PinSelectionAnimationMath.entryDuration;
  if (!(duration > 0)) return 1;
  const clamped = Math.min(Math.max(elapsed / duration, 0), 1);
  return 0.5 - 0.5 * Math.cos(clamped * Math.PI);
}

function geodesicDistanceMeters(start: GeoCoordinate, target: GeoCoordinate): number {
  const latitude1 = (start.latitude * Math.PI) / 180;
  const latitude2 = (target.latitude * Math.PI) / 180;
  const sinLatitude = Math.sin((latitude2 - latitude1) * 0.5);
  const sinLongitude = Math.sin((((target.longitude - start.longitude) * Math.PI) / 180) * 0.5);
  const a = sinLatitude * sinLatitude + Math.cos(latitude1) * Math.cos(latitude2) * sinLongitude * sinLongitude;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function unitVector(coordinate: GeoCoordinate): [number, number, number] {
  const latitude = (coordinate.latitude * Math.PI) / 180;
  const longitude = (coordinate.longitude * Math.PI) / 180;
  const cosLatitude = Math.cos(latitude);
  return [cosLatitude * Math.cos(longitude), cosLatitude * Math.sin(longitude), Math.sin(latitude)];
}

function coordinateOf(vector: [number, number, number]): GeoCoordinate {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  const x = vector[0] / length;
  const y = vector[1] / length;
  const z = vector[2] / length;
  return { latitude: (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI, longitude: (Math.atan2(y, x) * 180) / Math.PI };
}

function fallbackCoordinate(start: GeoCoordinate, target: GeoCoordinate, progress: number): GeoCoordinate {
  let delta = normalizedLongitude(target.longitude) - normalizedLongitude(start.longitude);
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  return { latitude: start.latitude + (target.latitude - start.latitude) * progress, longitude: normalizedLongitude(start.longitude + delta * progress) };
}

function normalizedLongitude(longitude: number): number {
  let normalized = longitude % 360;
  if (normalized > 180) normalized -= 360;
  else if (normalized < -180) normalized += 360;
  return normalized;
}

/** A pin as this frame shows it: where it is on its way, its selection squash, its draw order and the trigonometry of its place. */
export interface PresentedPin {
  readonly pin: ImmersiveMapPin;
  readonly squashScaleX: number;
  readonly squashScaleY: number;
  readonly drawOrder: number;
  readonly projectionBasis: GeoProjectionBasis;
}

interface PinPositionAnimation {
  readonly startCoordinate: GeoCoordinate;
  readonly targetCoordinate: GeoCoordinate;
  readonly startTime: number;
  readonly duration: number;
}

function animationCoordinate(animation: PinPositionAnimation, time: number): GeoCoordinate {
  if (!(animation.duration > 0)) return animation.targetCoordinate;
  const progress = PinAnimationMath.easedProgress((time - animation.startTime) / animation.duration);
  return PinAnimationMath.coordinate(animation.startCoordinate, animation.targetCoordinate, progress);
}

class PinPresentationEntry {
  pin: ImmersiveMapPin;
  private displayedCoordinate: GeoCoordinate;
  private projectionBasis: GeoProjectionBasis;
  private animation: PinPositionAnimation | null = null;
  private selectionAnimationStartTime: number | null;

  constructor(pin: ImmersiveMapPin, time: number) {
    this.pin = pin;
    this.displayedCoordinate = pin.coordinate;
    this.projectionBasis = GeoProjectionBasis.fromCoordinate(pin.coordinate);
    this.selectionAnimationStartTime = pin.isSelected ? time : null;
  }

  /** A new shown coordinate computes the basis again: the only per-pin trigonometry. */
  private moveDisplayedCoordinate(coordinate: GeoCoordinate): void {
    if (coordinate.latitude === this.displayedCoordinate.latitude && coordinate.longitude === this.displayedCoordinate.longitude) return;
    this.displayedCoordinate = coordinate;
    this.projectionBasis = GeoProjectionBasis.fromCoordinate(coordinate);
  }

  presentedPin(time: number, drawOrder: number): PresentedPin {
    const animation = this.animation;
    if (animation !== null) {
      this.moveDisplayedCoordinate(animationCoordinate(animation, time));
      if (time >= animation.startTime + animation.duration) {
        this.moveDisplayedCoordinate(animation.targetCoordinate);
        this.animation = null;
      }
    }
    const [squashScaleX, squashScaleY] = this.selectionSquashScale(time);
    const pin = this.displayedCoordinate === this.pin.coordinate ? this.pin : { ...this.pin, coordinate: this.displayedCoordinate };
    return { pin, squashScaleX, squashScaleY, drawOrder, projectionBasis: this.projectionBasis };
  }

  update(pin: ImmersiveMapPin, time: number): void {
    const previous = this.pin.coordinate;
    if (previous.latitude !== pin.coordinate.latitude || previous.longitude !== pin.coordinate.longitude) {
      const start = this.presentedPin(time, 0).pin.coordinate;
      const duration = PinAnimationMath.animationDuration(start, pin.coordinate);
      this.moveDisplayedCoordinate(start);
      this.animation = duration > 0 ? { startCoordinate: start, targetCoordinate: pin.coordinate, startTime: time, duration } : null;
      if (duration === 0) this.moveDisplayedCoordinate(pin.coordinate);
    }
    if (this.pin.isSelected !== pin.isSelected) {
      this.selectionAnimationStartTime = pin.isSelected ? time : null;
    } else if (pin.isSelected && this.selectionAnimationStartTime === null) {
      this.selectionAnimationStartTime = time;
    }
    this.pin = pin;
  }

  get hasActiveAnimations(): boolean {
    return this.animation !== null || this.pin.isSelected;
  }

  private selectionSquashScale(time: number): [number, number] {
    if (!this.pin.isSelected || this.selectionAnimationStartTime === null) return [1, 1];
    return PinSelectionAnimationMath.squashScale(time - this.selectionAnimationStartTime);
  }
}

/**
 * The pins as they are shown, a port of the Swift `PinPresentationStateStore`:
 * the entries sorted by id and a cached list of what they show. A frame
 * costs as much as the pins that animate (usually a handful), not as many
 * as there are: thousands of still pins cost the cached list between
 * changes.
 */
export class PinPresentationStateStore {
  private entries: PinPresentationEntry[] = [];
  private drawOrders: number[] = [];
  private presentedCache: PresentedPin[] = [];
  private animatingIndices: number[] = [];
  private animating = false;

  get hasActiveAnimations(): boolean {
    return this.animating;
  }

  apply(snapshot: PinsSnapshot, time: number): void {
    const previous = new Map<number, PinPresentationEntry>();
    for (const entry of this.entries) previous.set(entry.pin.id, entry);
    const sortedPins = [...snapshot.pins].sort((a, b) => a.id - b.id);
    this.entries = sortedPins.map((pin) => {
      const existing = previous.get(pin.id);
      if (existing !== undefined) {
        existing.update(pin, time);
        return existing;
      }
      return new PinPresentationEntry(pin, time);
    });
    // Draw orders by (drawPriority, id) are set when the pins change: the
    // solver gets its input sorted by id with the order in a field, and no
    // frame sorts.
    const entries = this.entries;
    const ranked = entries.map((_, index) => index);
    ranked.sort((a, b) => entries[a]!.pin.drawPriority - entries[b]!.pin.drawPriority || entries[a]!.pin.id - entries[b]!.pin.id);
    this.drawOrders = new Array<number>(entries.length).fill(0);
    ranked.forEach((index, rank) => {
      this.drawOrders[index] = rank;
    });
    this.presentedCache = entries.map((entry, index) => entry.presentedPin(time, this.drawOrders[index]!));
    this.animatingIndices = [];
    entries.forEach((entry, index) => {
      if (entry.hasActiveAnimations) this.animatingIndices.push(index);
    });
    this.animating = this.animatingIndices.length > 0;
  }

  presentedPins(time: number): ImmersiveMapPin[] {
    return this.presentedEntries(time).map((entry) => entry.pin);
  }

  /** The shown pins in ascending id order (the draw order is a field). The list is updated in place: read it within the frame. */
  presentedEntries(time: number): readonly PresentedPin[] {
    if (this.animatingIndices.length === 0) {
      this.animating = false;
      return this.presentedCache;
    }
    const still: number[] = [];
    for (const index of this.animatingIndices) {
      const entry = this.entries[index]!;
      this.presentedCache[index] = entry.presentedPin(time, this.drawOrders[index]!);
      if (entry.hasActiveAnimations) still.push(index);
    }
    this.animatingIndices = still;
    this.animating = still.length > 0;
    return this.presentedCache;
  }
}
