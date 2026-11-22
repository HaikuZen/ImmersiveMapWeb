// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `ImmersiveMapAnnotationRuntimeTests`: the runtime diffs the set
// by key, keeps the hosts in the overlay in item order, and applies the
// projection snapshots by transform, alpha and visibility. The overlay is a
// recording fake: the tests need no DOM and no map.

import { describe, expect, test } from "vitest";
import { type GeoCoordinate, geoCoordinate } from "../geo/geo-coordinate.ts";
import { GeoProjectionBasis } from "../geo/geo-projection-basis.ts";
import type { AnnotationAnchor } from "./annotation-overlay-layout-math.ts";
import type { AnnotationProjectionSnapshot } from "./annotation-projection.ts";
import {
  type AnnotationItemHost,
  type AnnotationOverlay,
  type AnnotationRuntimeContent,
  type AnnotationRuntimeItem,
  ImmersiveMapAnnotationRuntime,
} from "./immersive-map-annotation-runtime.ts";

class FakeHost implements AnnotationItemHost<string> {
  content: string | null = null;
  renders = 0;
  transform = "";
  alpha = 1;
  interactive = false;
  hidden = true;
  constructor(private readonly overlay: FakeOverlay) {}
  setContent(content: string): void {
    this.content = content;
    this.renders += 1;
  }
  place(transform: string, alpha: number, interactive: boolean): void {
    this.transform = transform;
    this.alpha = alpha;
    this.interactive = interactive;
    this.hidden = false;
  }
  hide(): void {
    this.hidden = true;
    this.interactive = false;
  }
  remove(): void {
    const index = this.overlay.children.indexOf(this);
    if (index >= 0) this.overlay.children.splice(index, 1);
  }
}

class FakeOverlay implements AnnotationOverlay<string> {
  readonly children: FakeHost[] = [];
  moves = 0;
  removed = false;
  makeHost(): AnnotationItemHost<string> {
    return new FakeHost(this);
  }
  place(host: AnnotationItemHost<string>, below: AnnotationItemHost<string> | null): void {
    const fake = host as FakeHost;
    const current = this.children.indexOf(fake);
    if (current >= 0) this.children.splice(current, 1);
    const at = below === null ? 0 : this.children.indexOf(below as FakeHost) + 1;
    this.children.splice(at, 0, fake);
    this.moves += 1;
  }
  remove(): void {
    this.removed = true;
  }
}

interface Environment {
  readonly runtime: ImmersiveMapAnnotationRuntime<string>;
  readonly overlays: FakeOverlay[];
  frameRequests: number;
}

function makeEnvironment(contentsScale = 1): Environment {
  const overlays: FakeOverlay[] = [];
  const environment: { runtime?: ImmersiveMapAnnotationRuntime<string>; overlays: FakeOverlay[]; frameRequests: number } = { overlays, frameRequests: 0 };
  environment.runtime = new ImmersiveMapAnnotationRuntime<string>({
    makeOverlay: () => {
      const overlay = new FakeOverlay();
      overlays.push(overlay);
      return overlay;
    },
    contentsScale: () => contentsScale,
    requestFrame: () => {
      environment.frameRequests += 1;
    },
  });
  return environment as Environment;
}

function item(id: number, coordinate: GeoCoordinate = geoCoordinate(0, 0), value: unknown = `marker-${id}`): AnnotationRuntimeItem<string> {
  return { id, coordinate, value, render: () => `marker-${id}:${String(value)}`, equals: Object.is };
}

function content(ids: number[], anchor: AnnotationAnchor = { x: 0.5, y: 0.5 }, coordinateFor: (id: number) => GeoCoordinate = () => geoCoordinate(0, 0)): AnnotationRuntimeContent<string> {
  return { anchor, items: ids.map((id) => item(id, coordinateFor(id))) };
}

function overlayOf(environment: Environment): FakeOverlay {
  const overlay = environment.runtime.overlayIfLoaded;
  expect(overlay).not.toBeNull();
  return overlay as FakeOverlay;
}

function snapshot(entries: { id: number; x: number; y: number; alpha: number }[]): AnnotationProjectionSnapshot {
  return { frameIndex: 1, drawWidth: 400, drawHeight: 300, entries: entries.map((entry) => ({ id: entry.id, positionX: entry.x, positionY: entry.y, visibilityAlpha: entry.alpha })) };
}

describe("ImmersiveMapAnnotationRuntime", () => {
  test("an update creates the overlay and the hosts in item order", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1, 2, 3]));
    const overlay = overlayOf(environment);
    expect(overlay.children.map((host) => host.content)).toEqual(["marker-1:marker-1", "marker-2:marker-2", "marker-3:marker-3"]);
    expect(environment.runtime.projectionInput.entries.length).toBe(3);
    expect(environment.frameRequests).toBe(1);
  });

  test("empty content removes the overlay and the input", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1]));
    const overlay = overlayOf(environment);
    environment.runtime.update(null);
    expect(environment.runtime.overlayIfLoaded).toBeNull();
    expect(overlay.removed).toBe(true);
    expect(environment.runtime.projectionInput.entries.length).toBe(0);
  });

  test("an update removes the missing annotations and keeps the internal id", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1, 2, 3]));
    const secondInternalID = environment.runtime.projectionInput.entries[1]!.id;
    environment.runtime.update(content([2]));
    expect(overlayOf(environment).children.length).toBe(1);
    const after = environment.runtime.projectionInput;
    expect(after.entries.length).toBe(1);
    // The internal id of a surviving annotation does not change across a diff.
    expect(after.entries[0]!.id).toBe(secondInternalID);
  });

  test("a reorder follows the item order", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1, 2]));
    const overlay = overlayOf(environment);
    const [first, second] = overlay.children;
    environment.runtime.update(content([2, 1]));
    expect(overlay.children.length).toBe(2);
    expect(overlay.children[0]).toBe(second);
    expect(overlay.children[1]).toBe(first);
  });

  /** The usual change keeps the staying hosts where they are and inserts only the new ones. */
  test("adding an annotation moves only the new host", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1, 3]));
    const overlay = overlayOf(environment);
    const movesBefore = overlay.moves;
    environment.runtime.update(content([1, 2, 3]));
    expect(overlay.moves - movesBefore).toBe(1);
    expect(overlay.children.map((host) => host.content)).toEqual(["marker-1:marker-1", "marker-2:marker-2", "marker-3:marker-3"]);
  });

  test("a coordinate change rebuilds the projection basis", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1]));
    const before = environment.runtime.projectionInput.entries[0]!.basis;
    const requests = environment.frameRequests;
    environment.runtime.update(content([1], { x: 0.5, y: 0.5 }, () => geoCoordinate(10, 20)));
    const after = environment.runtime.projectionInput.entries[0]!.basis;
    expect(after).not.toEqual(before);
    expect(after).toEqual(GeoProjectionBasis.fromCoordinate(geoCoordinate(10, 20)));
    expect(environment.frameRequests).toBe(requests + 1);
  });

  test("a new annotation is hidden until the first snapshot", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1]));
    // Before the first projection snapshot an annotation stays hidden: no flash at the origin.
    expect(overlayOf(environment).children[0]!.hidden).toBe(true);
  });

  test("applying the positions shows the host and applies the alpha", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1]));
    const internalID = environment.runtime.projectionInput.entries[0]!.id;
    // A contents scale of 1: the snapshot's drawable is in CSS pixels.
    environment.runtime.apply(snapshot([{ id: internalID, x: 200, y: 150, alpha: 0.5 }]));
    const host = overlayOf(environment).children[0]!;
    expect(host.hidden).toBe(false);
    expect(host.transform).toBe("translate3d(200px, 150px, 0) translate(-50%, -50%)");
    expect(host.alpha).toBeCloseTo(0.5, 6);
    expect(host.interactive).toBe(true);
  });

  test("the drawable's pixels become CSS pixels by the contents scale", () => {
    const environment = makeEnvironment(2);
    environment.runtime.update(content([1]));
    const internalID = environment.runtime.projectionInput.entries[0]!.id;
    environment.runtime.apply(snapshot([{ id: internalID, x: 200, y: 100, alpha: 1 }]));
    expect(overlayOf(environment).children[0]!.transform).toBe("translate3d(100px, 100px, 0) translate(-50%, -50%)");
  });

  test("an annotation absent from the snapshot is hidden", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1, 2]));
    const firstInternalID = environment.runtime.projectionInput.entries[0]!.id;
    environment.runtime.apply(snapshot([{ id: firstInternalID, x: 100, y: 100, alpha: 1 }]));
    const overlay = overlayOf(environment);
    expect(overlay.children[0]!.hidden).toBe(false);
    // An annotation past the horizon (absent from the snapshot) hides.
    expect(overlay.children[1]!.hidden).toBe(true);
  });

  test("an almost transparent annotation near the horizon takes no pointer events", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1]));
    const internalID = environment.runtime.projectionInput.entries[0]!.id;
    environment.runtime.apply(snapshot([{ id: internalID, x: 100, y: 100, alpha: 0.00005 }]));
    const host = overlayOf(environment).children[0]!;
    expect(host.hidden).toBe(false);
    expect(host.interactive).toBe(false);
  });

  test("the bottom anchor shifts the box up", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1], { x: 0.5, y: 1 }));
    const internalID = environment.runtime.projectionInput.entries[0]!.id;
    environment.runtime.apply(snapshot([{ id: internalID, x: 200, y: 150, alpha: 1 }]));
    // With the bottom anchor the box's bottom centre lands on the projected point.
    expect(overlayOf(environment).children[0]!.transform).toBe("translate3d(200px, 150px, 0) translate(-50%, -100%)");
  });

  test("an anchor change applies the last snapshot at once", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1]));
    const internalID = environment.runtime.projectionInput.entries[0]!.id;
    environment.runtime.apply(snapshot([{ id: internalID, x: 200, y: 150, alpha: 1 }]));
    environment.runtime.update(content([1], { x: 0, y: 0 }));
    expect(overlayOf(environment).children[0]!.transform).toBe("translate3d(200px, 150px, 0) translate(0%, 0%)");
  });

  test("a duplicate key keeps the first item", () => {
    const environment = makeEnvironment();
    environment.runtime.update({ anchor: { x: 0.5, y: 0.5 }, items: [item(1, geoCoordinate(0, 0), "a"), item(1, geoCoordinate(0, 0), "b")] });
    expect(overlayOf(environment).children.map((host) => host.content)).toEqual(["marker-1:a"]);
  });

  /**
   * An annotation keeps its content only when its item compares equal to
   * the one it was made from, and is rendered again otherwise.
   */
  test("an annotation is rendered again only when its item changed", () => {
    const environment = makeEnvironment();
    const shared = { name: "a" };
    environment.runtime.update({ anchor: { x: 0.5, y: 0.5 }, items: [item(1, geoCoordinate(0, 0), shared)] });
    const host = overlayOf(environment).children[0]!;
    expect(host.renders).toBe(1);
    environment.runtime.update({ anchor: { x: 0.5, y: 0.5 }, items: [item(1, geoCoordinate(0, 0), shared)] });
    expect(host.renders).toBe(1);
    environment.runtime.update({ anchor: { x: 0.5, y: 0.5 }, items: [item(1, geoCoordinate(0, 0), { name: "a" })] });
    expect(host.renders).toBe(2);
  });

  test("the equality decides whether the content is the same", () => {
    const byName = (previous: unknown, next: unknown) => (previous as { name: string }).name === (next as { name: string }).name;
    const never = () => false;
    expect(ImmersiveMapAnnotationRuntime.hasSameContent({ value: { name: "a" }, equals: byName }, { name: "a" })).toBe(true);
    expect(ImmersiveMapAnnotationRuntime.hasSameContent({ value: { name: "a" }, equals: byName }, { name: "b" })).toBe(false);
    expect(ImmersiveMapAnnotationRuntime.hasSameContent({ value: "1", equals: Object.is }, 1)).toBe(false);
    // What is never equal is always taken as changed.
    expect(ImmersiveMapAnnotationRuntime.hasSameContent({ value: "a", equals: never }, "a")).toBe(false);
  });

  test("an overlay comes back after the set emptied it", () => {
    const environment = makeEnvironment();
    environment.runtime.update(content([1]));
    environment.runtime.update(content([]));
    expect(environment.runtime.overlayIfLoaded).toBeNull();
    environment.runtime.update(content([2]));
    expect(overlayOf(environment).children.length).toBe(1);
    expect(environment.overlays.length).toBe(2);
  });
});
