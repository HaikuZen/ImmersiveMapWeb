// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { AnnotationAnchor } from "../annotations/annotation-overlay-layout-math.ts";
import { type AnnotationProjectionInput, projectAnnotations } from "../annotations/annotation-projection.ts";
import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import { GeoProjectionBasis } from "../geo/geo-projection-basis.ts";
import type { GeoScreenProjectionFrameConstants } from "../geo/geo-screen-projection-math.ts";

/** A rectangle in pixels. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The placement math of the export's annotation compositor, the Swift
 * `VideoExportAnnotationCompositorMath`. The annotation projection gives
 * drawable pixels with a bottom-left origin and y up, and an anchor's y is
 * measured from the top of the annotation, hence the `1 - anchor.y`.
 */
export const VideoExportAnnotationCompositorMath = {
  /** The rectangle, in the bottom-up pixel space, that puts the image's `anchor` point on `anchorX`, `anchorY`. */
  rectPx(anchorX: number, anchorY: number, width: number, height: number, anchor: AnnotationAnchor): PixelRect {
    return { x: anchorX - width * anchor.x, y: anchorY - height * (1 - anchor.y), width, height };
  },

  /** The same rectangle in a 2D canvas's space (top-left origin, y down) of a frame `drawHeight` pixels high. */
  canvasRect(rect: PixelRect, drawHeight: number): PixelRect {
    return { x: rect.x, y: drawHeight - rect.y - rect.height, width: rect.width, height: rect.height };
  },
} as const;

/**
 * What an export draws of the map's annotations: the anchor of the set and
 * each item's coordinate and picture at a scale, as the map's annotations
 * are when the export starts (`ImmersiveMapAnnotations.exportContent`).
 */
export interface ImmersiveMapAnnotationExportContent {
  readonly anchor: AnnotationAnchor;
  readonly items: readonly {
    readonly coordinate: GeoCoordinate;
    /** The item's picture at `scale` pixels per CSS pixel, null for an item with none. */
    readonly rasterize: (scale: number) => Promise<ImageBitmap | null>;
  }[];
}

interface OverlayItem {
  readonly internalID: number;
  readonly image: ImageBitmap;
}

/**
 * The annotations of a video export, the Swift `VideoExportAnnotationOverlay`.
 * The live map hosts its annotations as DOM elements over the canvas, which
 * no offscreen frame contains. Instead each annotation is rasterized once at
 * the export's start, the export projects the coordinates each frame exactly
 * as the live overlay does, and the pictures are drawn over the finished
 * frame at the projected points with the anchor and the globe-horizon fade.
 */
export class VideoExportAnnotationOverlay {
  private constructor(
    /** In the set's order, the last on top. */
    private readonly items: readonly OverlayItem[],
    private readonly anchor: AnnotationAnchor,
    private readonly projectionInput: AnnotationProjectionInput,
  ) {}

  /** Rasterizes the annotations: null when there is nothing to draw (no items, or none with a picture). */
  static async make(content: ImmersiveMapAnnotationExportContent, scale: number): Promise<VideoExportAnnotationOverlay | null> {
    const images = await Promise.all(content.items.map((item) => item.rasterize(scale).catch(() => null)));
    const items: OverlayItem[] = [];
    const entries: { id: number; basis: GeoProjectionBasis }[] = [];
    let nextInternalID = 1;
    images.forEach((image, index) => {
      if (image === null) return;
      const internalID = nextInternalID++;
      items.push({ internalID, image });
      entries.push({ id: internalID, basis: GeoProjectionBasis.fromCoordinate(content.items[index]!.coordinate) });
    });
    if (items.length === 0) return null;
    return new VideoExportAnnotationOverlay(items, content.anchor, { entries });
  }

  /** Draws the annotations over the frame the 2D context holds, projected by the frame's camera. */
  composite(context: OffscreenCanvasRenderingContext2D, projection: GeoScreenProjectionFrameConstants, frameIndex: number): void {
    const snapshot = projectAnnotations(this.projectionInput, projection, frameIndex);
    if (snapshot.entries.length === 0) return;
    const entriesByID = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
    for (const item of this.items) {
      const entry = entriesByID.get(item.internalID);
      if (entry === undefined) continue;
      const rect = VideoExportAnnotationCompositorMath.canvasRect(
        VideoExportAnnotationCompositorMath.rectPx(entry.positionX, entry.positionY, item.image.width, item.image.height, this.anchor),
        snapshot.drawHeight,
      );
      context.globalAlpha = entry.visibilityAlpha;
      context.drawImage(item.image, rect.x, rect.y, rect.width, rect.height);
    }
    context.globalAlpha = 1;
  }

  /** Lets the pictures go. */
  close(): void {
    for (const item of this.items) item.image.close();
  }
}

/**
 * An annotation's element as a picture at `scale` pixels per CSS pixel, for
 * an export: an `<img>` or a `<canvas>`, at the size it lays out to in a
 * hidden box of the page. Any other element gives null, and the export
 * leaves it out with a warning: a browser draws no DOM into a canvas (an SVG
 * `foreignObject`, the one way, taints the canvas and no video frame can be
 * made of it), so an app with such annotations gives
 * `ImmersiveMapAnnotationOptions.exportImage`.
 */
export async function rasterizeAnnotationElement(element: HTMLElement, scale: number): Promise<ImageBitmap | null> {
  if (!(element instanceof HTMLImageElement || element instanceof HTMLCanvasElement)) {
    console.warn(`ImmersiveMap leaves an annotation out of the video: a <${element.localName}> cannot be drawn into a frame. Give the annotations an exportImage.`);
    return null;
  }
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;contain:layout style";
  host.append(element);
  document.body.append(host);
  try {
    if (element instanceof HTMLImageElement) await element.decode();
    const box = element.getBoundingClientRect();
    if (!(box.width > 0 && box.height > 0)) return null;
    return await createImageBitmap(element, { resizeWidth: Math.max(1, Math.round(box.width * scale)), resizeHeight: Math.max(1, Math.round(box.height * scale)), resizeQuality: "high" });
  } finally {
    host.remove();
  }
}
