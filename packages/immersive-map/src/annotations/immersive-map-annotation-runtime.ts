// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import { geoCoordinatesEqual } from "../geo/geo-coordinate.ts";
import { GeoProjectionBasis } from "../geo/geo-projection-basis.ts";
import { type AnnotationAnchor, AnnotationOverlayLayoutMath } from "./annotation-overlay-layout-math.ts";
import {
  type AnnotationProjectedEntry,
  type AnnotationProjectionEntry,
  type AnnotationProjectionInput,
  type AnnotationProjectionSnapshot,
  emptyAnnotationProjectionInput,
} from "./annotation-projection.ts";

/**
 * One annotation as the runtime takes it (Swift `AnnotationViewItem`): the
 * app's key, the coordinate, the app's item and how to make its content.
 * `render` runs only when the annotation is new or its item changed.
 */
export interface AnnotationRuntimeItem<Content> {
  readonly id: unknown;
  readonly coordinate: GeoCoordinate;
  /** The app's item the content is made from. */
  readonly value: unknown;
  readonly render: () => Content;
  /** Whether two items make the same content. */
  readonly equals: (previous: unknown, next: unknown) => boolean;
}

/** The full annotation set of one `set` call: a repeated call replaces the previous set entirely. */
export interface AnnotationRuntimeContent<Content> {
  readonly anchor: AnnotationAnchor;
  readonly items: readonly AnnotationRuntimeItem<Content>[];
}

/**
 * The host of one annotation in the overlay (Swift
 * `AnnotationOverlayItemHost`): a box holding the app's content, moved by
 * a transform. A new host is hidden until its first placement.
 */
export interface AnnotationItemHost<Content> {
  setContent(content: Content): void;
  /** Shows the host at `transform` and `alpha`, taking pointer events while `interactive`. */
  place(transform: string, alpha: number, interactive: boolean): void;
  hide(): void;
  remove(): void;
}

/** The overlay over the map's canvas the hosts live in (Swift `AnnotationOverlayContainerView`). */
export interface AnnotationOverlay<Content> {
  makeHost(): AnnotationItemHost<Content>;
  /** Puts `host` right over `below` in the overlay, or under every host when there is none. */
  place(host: AnnotationItemHost<Content>, below: AnnotationItemHost<Content> | null): void;
  /** Takes the overlay off the map. */
  remove(): void;
}

export interface AnnotationRuntimeEnvironment<Content> {
  /** Makes the overlay, once the first annotation needs it. */
  readonly makeOverlay: () => AnnotationOverlay<Content>;
  /** The drawable's pixels per CSS pixel. */
  readonly contentsScale: () => number;
  /** Asks the map for a frame. */
  readonly requestFrame: () => void;
}

interface Entry<Content> {
  readonly internalID: number;
  coordinate: GeoCoordinate;
  basis: GeoProjectionBasis;
  /** The item the host's content was last made from. */
  value: unknown;
  readonly host: AnnotationItemHost<Content>;
}

/**
 * Owns the annotations on the page side (Swift
 * `ImmersiveMapAnnotationRuntime`): diffs the set by key, so a change of the
 * set costs what changed in it. A new annotation is made once, a gone one
 * is removed, and one that stays keeps its content while its item is equal
 * to what it was, or is rendered again otherwise. Keeps the hosts in the
 * overlay in item order, feeds the frame the coordinates
 * (`projectionInput`), and applies each frame's projection snapshot by one
 * transform per host, with no layout read.
 */
export class ImmersiveMapAnnotationRuntime<Content> {
  private readonly environment: AnnotationRuntimeEnvironment<Content>;
  private overlay: AnnotationOverlay<Content> | null = null;
  private readonly entriesByID = new Map<unknown, Entry<Content>>();
  private orderedIDs: unknown[] = [];
  private anchor: AnnotationAnchor = AnnotationOverlayLayoutMath.center;
  private nextInternalID = 1;
  private input: AnnotationProjectionInput = emptyAnnotationProjectionInput;
  private lastSnapshot: AnnotationProjectionSnapshot | null = null;
  private readonly projectedScratch = new Map<number, AnnotationProjectedEntry>();

  constructor(environment: AnnotationRuntimeEnvironment<Content>) {
    this.environment = environment;
  }

  /** The overlay: null while there are no annotations. */
  get overlayIfLoaded(): AnnotationOverlay<Content> | null {
    return this.overlay;
  }

  get projectionInput(): AnnotationProjectionInput {
    return this.input;
  }

  get isEmpty(): boolean {
    return this.entriesByID.size === 0;
  }

  update(content: AnnotationRuntimeContent<Content> | null): void {
    const items = content?.items ?? [];
    const newAnchor = content?.anchor ?? AnnotationOverlayLayoutMath.center;
    const anchorChanged = !AnnotationOverlayLayoutMath.anchorsEqual(newAnchor, this.anchor);
    this.anchor = newAnchor;

    const seenIDs = new Set<unknown>();
    const newOrderedIDs: unknown[] = [];
    let needsFrame = false;
    for (const item of items) {
      // A duplicate key in the collection: the first one wins.
      if (seenIDs.has(item.id)) continue;
      seenIDs.add(item.id);
      newOrderedIDs.push(item.id);

      const entry = this.entriesByID.get(item.id);
      if (entry !== undefined) {
        // An annotation made from an equal item keeps its content as it is.
        if (!ImmersiveMapAnnotationRuntime.hasSameContent(item, entry.value)) {
          entry.host.setContent(item.render());
          entry.value = item.value;
        }
        if (!geoCoordinatesEqual(item.coordinate, entry.coordinate)) {
          entry.coordinate = item.coordinate;
          entry.basis = GeoProjectionBasis.fromCoordinate(item.coordinate);
          needsFrame = true;
        }
      } else {
        const host = this.ensureOverlay().makeHost();
        host.setContent(item.render());
        this.entriesByID.set(item.id, {
          internalID: this.nextInternalID,
          coordinate: item.coordinate,
          basis: GeoProjectionBasis.fromCoordinate(item.coordinate),
          value: item.value,
          host,
        });
        this.nextInternalID += 1;
        // Its host goes into the overlay at its place among the others, below (`placeHosts`).
        needsFrame = true;
      }
    }

    for (const [id, entry] of this.entriesByID) {
      if (seenIDs.has(id)) continue;
      entry.host.remove();
      this.entriesByID.delete(id);
    }

    if (!sameOrder(newOrderedIDs, this.orderedIDs)) {
      const previousIDs = this.orderedIDs;
      this.orderedIDs = newOrderedIDs;
      this.placeHosts(previousIDs);
    }
    this.rebuildProjectionInput();

    if (this.entriesByID.size === 0) {
      this.overlay?.remove();
      this.overlay = null;
      this.lastSnapshot = null;
      return;
    }
    // An anchor change is applied from the last snapshot at once, while new
    // coordinates need a fresh projection frame.
    if (anchorChanged && this.lastSnapshot !== null) this.applySnapshot(this.lastSnapshot);
    if (needsFrame) this.environment.requestFrame();
  }

  /** The frame's projection, applied to the hosts: called right after the frame is submitted. */
  apply(snapshot: AnnotationProjectionSnapshot): void {
    if (this.entriesByID.size === 0) return;
    this.lastSnapshot = snapshot;
    this.applySnapshot(snapshot);
  }

  /** Removes every annotation and the overlay. */
  destroy(): void {
    this.update(null);
  }

  /**
   * Whether the annotation's content is certainly the one its previous item
   * made: the items compare equal.
   */
  static hasSameContent(item: Pick<AnnotationRuntimeItem<unknown>, "value" | "equals">, previousValue: unknown): boolean {
    return item.equals(previousValue, item.value);
  }

  private ensureOverlay(): AnnotationOverlay<Content> {
    if (this.overlay === null) this.overlay = this.environment.makeOverlay();
    return this.overlay;
  }

  /**
   * Z-order follows the collection order: the last item is on top. Only the
   * hosts that have to move are touched, since moving a node in the DOM
   * costs a style pass of its content. The usual change keeps the
   * annotations that stay in the order they were, and then only the new
   * ones are inserted, each over the annotation before it. All are put in
   * order again only when the app reordered the ones that stay.
   */
  private placeHosts(previousIDs: readonly unknown[]): void {
    if (this.orderedIDs.length === 0) return;
    const overlay = this.ensureOverlay();
    const previous = new Set(previousIDs);
    const stayingNow = this.orderedIDs.filter((id) => previous.has(id));
    const current = new Set(this.orderedIDs);
    const stayingBefore = previousIDs.filter((id) => current.has(id));
    const keepsOrder = sameOrder(stayingBefore, stayingNow);

    let below: AnnotationItemHost<Content> | null = null;
    for (const id of this.orderedIDs) {
      const entry = this.entriesByID.get(id);
      if (entry === undefined) continue;
      if (!keepsOrder || !previous.has(id)) overlay.place(entry.host, below);
      below = entry.host;
    }
  }

  private rebuildProjectionInput(): void {
    if (this.entriesByID.size === 0) {
      this.input = emptyAnnotationProjectionInput;
      return;
    }
    const entries: AnnotationProjectionEntry[] = [];
    for (const id of this.orderedIDs) {
      const entry = this.entriesByID.get(id);
      if (entry !== undefined) entries.push({ id: entry.internalID, basis: entry.basis });
    }
    this.input = { entries };
  }

  private applySnapshot(snapshot: AnnotationProjectionSnapshot): void {
    const projectedByID = this.projectedScratch;
    projectedByID.clear();
    for (const projected of snapshot.entries) projectedByID.set(projected.id, projected);
    const contentsScale = this.environment.contentsScale();
    for (const entry of this.entriesByID.values()) {
      const projected = projectedByID.get(entry.internalID);
      if (projected === undefined) {
        // Not in the snapshot: past the globe's horizon or behind the camera.
        entry.host.hide();
        continue;
      }
      const point = AnnotationOverlayLayoutMath.pointFromPixel(projected.positionX, projected.positionY, snapshot.drawHeight, contentsScale);
      const alpha = projected.visibilityAlpha;
      entry.host.place(AnnotationOverlayLayoutMath.cssTransform(point, this.anchor), alpha, alpha > AnnotationOverlayLayoutMath.interactionAlphaThreshold);
    }
    projectedByID.clear();
  }
}

function sameOrder(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (!Object.is(a[index], b[index])) return false;
  }
  return true;
}
