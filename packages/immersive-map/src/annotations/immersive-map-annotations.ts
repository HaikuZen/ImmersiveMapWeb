// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { CameraUniform } from "../camera/camera-uniform.ts";
import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import { GeoScreenProjectionFrameConstants } from "../geo/geo-screen-projection-math.ts";
import type { ResolvedPresentationState } from "../presentation/resolved-presentation-state.ts";
import type { AnnotationAnchor } from "./annotation-overlay-layout-math.ts";
import { DomAnnotationOverlay } from "./annotation-overlay-dom.ts";
import { projectAnnotations } from "./annotation-projection.ts";
import { type AnnotationRuntimeItem, ImmersiveMapAnnotationRuntime } from "./immersive-map-annotation-runtime.ts";
import { type ImmersiveMapAnnotationExportContent, rasterizeAnnotationElement } from "../export/video-export-annotation-overlay.ts";

/** How the map reads the app's items: the web form of Swift's `.annotations(items, coordinate:, anchor:, content:)`. */
export interface ImmersiveMapAnnotationOptions<Item> {
  /** Where the item stands. Read on every `set`. */
  readonly coordinate: (item: Item) => GeoCoordinate;
  /**
   * The item's element. Called when the item is new, and again when its
   * item changed (`equals`). The element has to be made from the item
   * alone: what it reads from elsewhere does not reach an annotation whose
   * item did not change.
   */
  readonly render: (item: Item) => HTMLElement;
  /** The item's key, unique in the set: an item with the key of one already shown is that annotation. */
  readonly id: (item: Item) => unknown;
  /** Which point of the element stands on the coordinate, in its unit square. The centre by default. */
  readonly anchor?: AnnotationAnchor;
  /**
   * Whether the item is still what it was, so its element stays untouched.
   * `Object.is` by default: the same object is the same annotation, and a
   * new or changed object is rendered again. An app that mutates its items
   * in place passes its own comparison, or `() => false` to render every
   * annotation on every `set`.
   */
  readonly equals?: (previous: Item, next: Item) => boolean;
  /**
   * The item's picture for a video export (`ImmersiveMapVideoExportConfiguration.includesAnnotations`),
   * at `scale` pixels per CSS pixel: drawn at its own pixel size, the anchor
   * on the projected point, as Swift rasterizes an annotation's view once at
   * the export's start. Left out, an element `render` makes that is an
   * `<img>` or a `<canvas>` is drawn as it is, and any other is left out of
   * the video with a warning (a browser draws no DOM into a frame). Null
   * leaves the item out.
   */
  readonly exportImage?: (item: Item, scale: number) => ImageBitmapSource | null | Promise<ImageBitmapSource | null>;
}

/**
 * The map's annotations: live DOM elements the app gives, standing on their
 * coordinates on every drawn frame, on the globe and on the flat map, and
 * fading out behind the globe's horizon. The last item draws on top. An
 * annotation takes its own pointer events, and a press anywhere else goes
 * to the map. A later `set` replaces the earlier set, and an item whose key
 * stays and whose item is equal keeps its element as it is, so adding or
 * removing a few annotations costs only those few.
 *
 * ```ts
 * map.annotations.set(places, {
 *   id: (place) => place.id,
 *   coordinate: (place) => place.coordinate,
 *   render: (place) => label(place.name),
 *   anchor: { x: 0.5, y: 1 },
 * });
 * ```
 *
 * Use annotations for a few rich elements. Each one is a live element the
 * page moves every frame, and hundreds of them slow the map down: for many
 * points use pins or a layer.
 */
export class ImmersiveMapAnnotations {
  private readonly runtime: ImmersiveMapAnnotationRuntime<HTMLElement>;
  private readonly canvas: HTMLCanvasElement;
  private readonly resizeObserver: ResizeObserver;
  /** The canvas's CSS width, from its resize observer: the frame never reads layout. */
  private cssWidth = 0;
  /** The last set as the app gave it, for an export's own copy (`exportContent`). */
  private exported: ImmersiveMapAnnotationExportContent | null = null;

  /** @internal The map builds its controller. */
  constructor(canvas: HTMLCanvasElement, requestFrame: () => void) {
    this.canvas = canvas;
    this.runtime = new ImmersiveMapAnnotationRuntime<HTMLElement>({
      makeOverlay: () => new DomAnnotationOverlay(canvas),
      contentsScale: () => (this.cssWidth > 0 ? this.canvas.width / this.cssWidth : devicePixelRatio),
      requestFrame,
    });
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry !== undefined) this.cssWidth = entry.contentRect.width;
    });
    this.resizeObserver.observe(canvas);
  }

  /** Shows `items` as the map's annotations, in place of the ones shown before. */
  set<Item>(items: Iterable<Item>, options: ImmersiveMapAnnotationOptions<Item>): void {
    const equals = options.equals ?? Object.is;
    const compare = (previous: unknown, next: unknown) => equals(previous as Item, next as Item);
    const list = [...items];
    const runtimeItems: AnnotationRuntimeItem<HTMLElement>[] = [];
    for (const item of list) {
      runtimeItems.push({ id: options.id(item), coordinate: options.coordinate(item), value: item, render: () => options.render(item), equals: compare });
    }
    const anchor = options.anchor ?? { x: 0.5, y: 0.5 };
    this.runtime.update({ anchor, items: runtimeItems });
    const exportImage = options.exportImage;
    this.exported = {
      anchor,
      items: list.map((item) => ({
        coordinate: options.coordinate(item),
        rasterize: async (scale: number): Promise<ImageBitmap | null> => {
          if (exportImage === undefined) return rasterizeAnnotationElement(options.render(item), scale);
          const source = await exportImage(item, scale);
          return source === null ? null : createImageBitmap(source);
        },
      })),
    };
  }

  /**
   * @internal The annotations as they are, for a video export: the anchor,
   * and each item's coordinate and picture. Null while there are none.
   */
  exportContent(): ImmersiveMapAnnotationExportContent | null {
    return this.runtime.isEmpty ? null : this.exported;
  }

  /** Removes every annotation. */
  clear(): void {
    this.exported = null;
    this.runtime.update(null);
  }

  /** The overlay element over the canvas, null while there are no annotations. */
  get overlayElement(): HTMLElement | null {
    const overlay = this.runtime.overlayIfLoaded;
    return overlay instanceof DomAnnotationOverlay ? overlay.element : null;
  }

  /**
   * @internal What the frame drew, at the end of the map's frame: the
   * annotations project with the frame's camera and presentation and move
   * to the projected points. A map with no annotations does nothing here.
   */
  frameDrawn(drawWidth: number, drawHeight: number, cameraUniform: CameraUniform, presentation: ResolvedPresentationState, frameIndex: number): void {
    if (this.runtime.isEmpty) return;
    const constants = new GeoScreenProjectionFrameConstants(drawWidth, drawHeight, cameraUniform, presentation);
    this.runtime.apply(projectAnnotations(this.runtime.projectionInput, constants, frameIndex));
  }

  /** @internal Tears the annotations down with the map. */
  destroy(): void {
    this.resizeObserver.disconnect();
    this.clear();
  }
}
