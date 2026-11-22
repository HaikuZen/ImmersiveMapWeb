// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { AnnotationItemHost, AnnotationOverlay } from "./immersive-map-annotation-runtime.ts";

/**
 * One annotation's box in the DOM: an absolutely positioned element at the
 * overlay's origin holding the app's element, moved by its transform. The
 * app's element keeps its own style, transform included. Every write is
 * skipped when the value is what the box already has, so a frame that
 * moves nothing writes nothing.
 */
class DomAnnotationItemHost implements AnnotationItemHost<HTMLElement> {
  readonly box: HTMLDivElement;
  private transform = "";
  private alpha = -1;
  private interactive: boolean | null = null;
  private visible = false;

  constructor() {
    const box = document.createElement("div");
    box.dataset.immersiveMapAnnotation = "";
    // Hidden until its first placement: no flash at the origin.
    box.style.cssText = "position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;will-change:transform";
    this.box = box;
  }

  setContent(content: HTMLElement): void {
    if (this.box.firstChild === content && this.box.childNodes.length === 1) return;
    this.box.replaceChildren(content);
  }

  place(transform: string, alpha: number, interactive: boolean): void {
    const style = this.box.style;
    if (transform !== this.transform) {
      this.transform = transform;
      style.transform = transform;
    }
    // The fade is kept to a thousandth: finer steps change nothing on screen.
    const roundedAlpha = Math.round(alpha * 1000) / 1000;
    if (roundedAlpha !== this.alpha) {
      this.alpha = roundedAlpha;
      style.opacity = roundedAlpha >= 1 ? "" : String(roundedAlpha);
    }
    if (interactive !== this.interactive) {
      this.interactive = interactive;
      style.pointerEvents = interactive ? "auto" : "none";
    }
    if (!this.visible) {
      this.visible = true;
      style.visibility = "";
    }
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.box.style.visibility = "hidden";
    this.interactive = false;
    this.box.style.pointerEvents = "none";
  }

  remove(): void {
    this.box.remove();
  }
}

/**
 * The overlay over the map's canvas (Swift `AnnotationOverlayContainerView`):
 * it covers the canvas and takes no pointer events itself, so a press
 * between the annotations reaches the canvas, while each annotation's box
 * takes its own. It sits right over the canvas, under the attribution badge.
 */
export class DomAnnotationOverlay implements AnnotationOverlay<HTMLElement> {
  readonly element: HTMLDivElement;

  constructor(canvas: HTMLElement) {
    const element = document.createElement("div");
    element.className = "immersive-map-annotations";
    element.dataset.immersiveMapAnnotations = "";
    element.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;overflow:hidden;pointer-events:none;contain:layout style";
    canvas.after(element);
    this.element = element;
  }

  makeHost(): AnnotationItemHost<HTMLElement> {
    return new DomAnnotationItemHost();
  }

  place(host: AnnotationItemHost<HTMLElement>, below: AnnotationItemHost<HTMLElement> | null): void {
    const box = (host as DomAnnotationItemHost).box;
    if (below === null) {
      this.element.prepend(box);
    } else {
      (below as DomAnnotationItemHost).box.after(box);
    }
  }

  remove(): void {
    this.element.remove();
  }
}
