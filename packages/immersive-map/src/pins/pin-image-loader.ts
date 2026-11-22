// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { PinImage } from "./immersive-map-pin.ts";

/** Why a remote pin picture could not be loaded. */
export class PinImageLoaderError extends Error {
  constructor(
    readonly reason: "unacceptableStatusCode" | "cannotDecodeImage",
    readonly statusCode: number | null = null,
  ) {
    super(reason === "unacceptableStatusCode" ? `ImmersiveMap: a pin picture answered HTTP ${String(statusCode)}` : "ImmersiveMap: a pin picture could not be decoded");
    this.name = "PinImageLoaderError";
  }
}

/** The side of the built-in placeholder, in pixels. */
const placeholderSize = 64;
let placeholder: OffscreenCanvas | undefined;

/**
 * Loads pin pictures from plain URLs, a port of the Swift `PinImageLoader`:
 * a fetch and a decode into an `ImageBitmap`, with no credentials of the
 * app's (`credentials: "omit"`, CORS), so the picture can be uploaded to
 * the GPU.
 */
export const PinImageLoader = Object.freeze({
  async load(url: string): Promise<PinImage> {
    const response = await fetch(new URL(url, globalThis.location?.href), { credentials: "omit", mode: "cors" });
    if (!response.ok) throw new PinImageLoaderError("unacceptableStatusCode", response.status);
    return PinImageLoader.decode(await response.blob());
  },

  async decode(data: Blob): Promise<PinImage> {
    try {
      return await createImageBitmap(data, { colorSpaceConversion: "default", premultiplyAlpha: "default" });
    } catch {
      throw new PinImageLoaderError("cannotDecodeImage");
    }
  },

  /**
   * The picture a remote pin shows until its own arrives, when the app gave
   * none: a dark square with a light figure, the Swift engine's. Made once,
   * on first use.
   */
  get defaultPlaceholder(): PinImage {
    if (placeholder === undefined) {
      const canvas = new OffscreenCanvas(placeholderSize, placeholderSize);
      const context = canvas.getContext("2d")!;
      context.fillStyle = "rgb(46, 51, 61)";
      context.fillRect(0, 0, placeholderSize, placeholderSize);
      context.fillStyle = "rgb(107, 117, 133)";
      context.beginPath();
      context.ellipse(32, 24, 10, 10, 0, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.ellipse(32, 49, 18, 11, 0, 0, Math.PI * 2);
      context.fill();
      placeholder = canvas;
    }
    return placeholder;
  },
});
