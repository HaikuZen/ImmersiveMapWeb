// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A pin: a picture the map draws itself at a coordinate, in the frame of
 * the map's pin shape (`PinSettings.shape`), a port of the Swift
 * `ImmersiveMapPin`, `PinCountBadge`, `PinClusterPolicy` and
 * `PinImageSource`.
 *
 * ```ts
 * map.pins.set([
 *   ImmersiveMapPin.make({ id: 1, coordinate: { latitude: 55.75, longitude: 37.62 }, image: PinImageSource.remote(photoURL) }),
 * ]);
 * ```
 */

import type { Rgba } from "../configuration/color.ts";
import type { GeoCoordinate } from "../geo/geo-coordinate.ts";

/** A picture the browser can draw into a canvas: what a pin shows. */
export type PinImage = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageData | SVGImageElement | VideoFrame;

/**
 * Where a pin's picture comes from: one the app made (`image`), or one at
 * a URL (`remote`), which the map downloads and shows the placeholder
 * until then (the built-in one when none is given).
 */
export type PinImageSource = { readonly kind: "image"; readonly image: PinImage } | { readonly kind: "remote"; readonly url: string; readonly placeholder: PinImage | null };

export const PinImageSource = Object.freeze({
  image(image: PinImage): PinImageSource {
    return Object.freeze({ kind: "image", image });
  },
  /** A picture at `url`, resolved against the page. */
  remote(url: string | URL, placeholder: PinImage | null = null): PinImageSource {
    return Object.freeze({ kind: "remote", url: String(url), placeholder });
  },
  /** The URL of a remote source, null for a picture the app made. */
  remoteURL(source: PinImageSource): string | null {
    return source.kind === "remote" ? source.url : null;
  },
});

/**
 * Whether a pin takes part in the event clusters of the collision layout:
 * `"event"` pins piled on one place are laid out as a flower of petals,
 * `"none"` pins only push each other apart.
 */
export type PinClusterPolicy = "none" | "event";

/**
 * The bubble counter on a pin: the number of merged pins. Set on merged pins
 * (`ImmersiveMapPinsController.merge`), and can be set by hand. Above 999 it
 * reads "999+".
 */
export interface PinCountBadge {
  readonly count: number;
}

export function pinCountBadge(count: number): PinCountBadge {
  return Object.freeze({ count: Math.max(1, Math.floor(count)) });
}

export interface ImmersiveMapPin {
  /** A whole number up to 2^53, unique among the map's pins. */
  readonly id: number;
  readonly coordinate: GeoCoordinate;
  /** Where the picture comes from. */
  readonly imageSource: PinImageSource;
  /**
   * The picture shown now: the app's own, the remote one once it arrived,
   * or the placeholder until then. The controller fills it in.
   */
  readonly image: PinImage | null;
  readonly countBadge: PinCountBadge | null;
  /** The outline's color for this pin, the map's (`PinSettings.borderColor`) when null. */
  readonly borderColor: Rgba | null;
  /** The pin's size on screen as a part of the map's pin size. 1 by default. */
  readonly screenSizeScale: number;
  readonly isSelected: boolean;
  /** A higher priority draws on top, and wins room when pins push each other. 0 by default. */
  readonly drawPriority: number;
  readonly clusterPolicy: PinClusterPolicy;
}

/** What a pin is made from: the id, the coordinate and the picture, the rest at its default. */
export interface ImmersiveMapPinOptions {
  readonly id: number;
  readonly coordinate: GeoCoordinate;
  /** A source, or a picture the app made. */
  readonly image: PinImageSource | PinImage;
  readonly countBadge?: PinCountBadge | null;
  readonly borderColor?: Rgba | null;
  readonly screenSizeScale?: number;
  readonly isSelected?: boolean;
  readonly drawPriority?: number;
  readonly clusterPolicy?: PinClusterPolicy;
}

function isImageSource(value: PinImageSource | PinImage): value is PinImageSource {
  const kind = (value as { kind?: unknown }).kind;
  return (kind === "image" || kind === "remote") && !(typeof ImageData !== "undefined" && value instanceof ImageData);
}

/** The picture a source shows before anything is loaded: its own, its placeholder, or null for the built-in placeholder. */
export function initialPinImage(source: PinImageSource): PinImage | null {
  return source.kind === "image" ? source.image : source.placeholder;
}

function make(options: ImmersiveMapPinOptions): ImmersiveMapPin {
  if (!Number.isSafeInteger(options.id)) throw new RangeError(`An ImmersiveMapPin's id must be a safe integer, got ${String(options.id)}.`);
  const imageSource = isImageSource(options.image) ? options.image : PinImageSource.image(options.image);
  return Object.freeze({
    id: options.id,
    coordinate: Object.freeze({ latitude: options.coordinate.latitude, longitude: options.coordinate.longitude }),
    imageSource,
    image: initialPinImage(imageSource),
    countBadge: options.countBadge ?? null,
    borderColor: options.borderColor ?? null,
    screenSizeScale: options.screenSizeScale ?? 1,
    isSelected: options.isSelected ?? false,
    drawPriority: options.drawPriority ?? 0,
    clusterPolicy: options.clusterPolicy ?? "none",
  });
}

/** A copy of the pin with the values given, the rest as they are. */
function withValues(pin: ImmersiveMapPin, values: Partial<Omit<ImmersiveMapPin, "id">>): ImmersiveMapPin {
  return Object.freeze({ ...pin, ...values });
}

export const ImmersiveMapPin = Object.freeze({
  make,
  with: withValues,
  /** A pin with a picture at a URL: the placeholder (the built-in one when none) shows until it arrives. */
  remote(id: number, latitude: number, longitude: number, imageURL: string | URL, options: Omit<ImmersiveMapPinOptions, "id" | "coordinate" | "image"> & { readonly placeholder?: PinImage | null } = {}): ImmersiveMapPin {
    return make({ ...options, id, coordinate: { latitude, longitude }, image: PinImageSource.remote(imageURL, options.placeholder ?? null) });
  },
});
