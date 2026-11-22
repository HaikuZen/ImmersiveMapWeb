// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapAttribution } from "../../configuration/attribution.ts";
import type { AttributionSettings } from "../../configuration/attribution-settings.ts";
import type { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import { AttributionBadgeLayoutMath } from "./attribution-badge-layout-math.ts";
import { AttributionBadgeLine, AttributionBadgeState } from "./attribution-badge-line.ts";
import { AttributionHiddenNotice } from "./attribution-hidden-notice.ts";

/**
 * The attribution badge (Swift `AttributionBadgeView`): one line of plain
 * bold text along the map's edge, no plate, each glyph in a dark halo that
 * fades out around it so the words read on any map colour underneath. The
 * line holds the credits shown at the camera's zoom
 * (`ImmersiveMapAttribution.creditsAtZoom`), with a dot between them. A tap
 * opens the attribution's `linkURL` in a new tab.
 *
 * The badge is an element over the canvas in the map's container, placed by
 * CSS alone (`AttributionBadgeLayoutMath.cssPlacement`): the browser lays it
 * out, so the map never measures it. The DOM is written when the settings
 * change and when the camera's zoom crosses a credit's range, never on the
 * other frames.
 */
export class AttributionBadge {
  /** The badge's element: an anchor, with an `href` while the attribution has a link. */
  readonly element: HTMLAnchorElement;
  private readonly state = new AttributionBadgeState();
  private settings: ImmersiveMapSettings | null = null;
  private renderedText: string | null = null;

  /** Builds the badge and puts it right after `after`, the map's canvas, in the map's container. */
  constructor(after: Element, settings: ImmersiveMapSettings) {
    const element = document.createElement("a");
    element.className = "immersive-map-attribution";
    element.dataset.immersiveMapAttribution = "";
    element.target = "_blank";
    element.rel = "noopener";
    element.style.cssText = [
      "position:absolute",
      "box-sizing:border-box",
      "display:block",
      "white-space:nowrap",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "line-height:1.2",
      "text-decoration:none",
      "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
      "-webkit-tap-highlight-color:transparent",
      "user-select:none",
    ].join(";");
    after.after(element);
    this.element = element;
    this.sync(settings, null);
    AttributionHiddenNotice.warnIfWarranted(settings);
  }

  /**
   * The frame's settings and camera zoom. The settings are compared by
   * reference (they are immutable values), and the zoom by the credits it
   * shows: a frame that changes neither writes nothing.
   */
  sync(settings: ImmersiveMapSettings, zoom: number | null): void {
    if (settings !== this.settings) {
      this.settings = settings;
      this.state.applyZoom(zoom);
      this.apply(settings.resolvedAttribution, settings.attribution);
      return;
    }
    if (this.state.applyZoom(zoom)) this.renderLine();
  }

  /** The words on the line now, as the badge shows them. */
  get text(): string {
    return AttributionBadgeLine.text(this.state.segments());
  }

  destroy(): void {
    this.element.remove();
  }

  private apply(attribution: ImmersiveMapAttribution, look: AttributionSettings): void {
    this.state.apply(attribution, look);
    const metrics = AttributionBadgeLayoutMath.metrics(look.size);
    // Leading and trailing follow the direction the container lays out in,
    // read when the look changes and on no frame.
    const isRightToLeft = getComputedStyle(this.element).direction === "rtl";
    const placement = AttributionBadgeLayoutMath.cssPlacement(look.position, look.margin, look.respectsBottomSafeArea, isRightToLeft);
    const style = this.element.style;
    style.top = placement.top;
    style.bottom = placement.bottom;
    style.left = placement.left;
    style.right = placement.right;
    style.transform = placement.transform;
    style.maxWidth = placement.maxWidth;
    style.fontSize = `${metrics.fontSize}px`;
    style.padding = `${metrics.verticalInset}px ${metrics.horizontalInset}px`;
    if (attribution.linkURL === null) {
      this.element.removeAttribute("href");
    } else {
      this.element.href = attribution.linkURL;
    }
    this.renderedText = null;
    this.renderLine();
  }

  private renderLine(): void {
    const look = this.settings?.attribution;
    const element = this.element;
    element.style.display = this.state.isShown ? "block" : "none";
    element.style.pointerEvents = this.state.isInteractive ? "auto" : "none";
    const segments = this.state.segments();
    const text = AttributionBadgeLine.text(segments);
    element.title = text;
    if (text === this.renderedText) return;
    this.renderedText = text;
    const color = look?.textColor ?? AttributionBadgeLine.defaultTextColor;
    const spans = segments.map((segment) => {
      const span = document.createElement("span");
      span.textContent = segment.text;
      span.style.fontWeight = String(segment.fontWeight);
      span.style.color = AttributionBadgeLine.cssColor(color, segment.alphaShare);
      span.style.textShadow = AttributionBadgeLine.cssHalo(segment.alphaShare);
      return span;
    });
    element.replaceChildren(...spans);
  }
}
