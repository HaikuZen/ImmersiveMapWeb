// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `MergedPinsTests`, `ImmersiveMapPinsControllerDetachedCopyTests`,
// `PinRemoteImageSourceTests` and `PinScreenSizeScaleTests`.

import { afterEach, describe, expect, test, vi } from "vitest";
import { ImmersiveMapPin, type PinImage, PinImageSource } from "./immersive-map-pin.ts";
import { ImmersiveMapPinsController } from "./immersive-map-pins-controller.ts";

/** A picture stand-in: the controller and the atlas key pictures by identity only. */
const image = (name: string): PinImage => ({ name }) as unknown as PinImage;
const mergedID = 100;

function pin(id: number, latitude: number, longitude: number, picture: PinImage = image(`p${id}`)): ImmersiveMapPin {
  return ImmersiveMapPin.make({ id, coordinate: { latitude, longitude }, image: picture });
}

function mergedController(imageA = image("a"), imageB = image("b")): ImmersiveMapPinsController {
  const controller = new ImmersiveMapPinsController(() => Promise.reject(new Error("no network")));
  controller.add(pin(1, 10, 20, imageA));
  controller.add(pin(2, 12, 22, imageB));
  controller.merge([1, 2], mergedID, 0);
  return controller;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("merged pins", () => {
  test("merge hides the members and adds the merged pin", () => {
    const controller = new ImmersiveMapPinsController();
    const imageA = image("a");
    controller.add(pin(1, 10, 20, imageA));
    controller.add(pin(2, 12, 22, image("b")));
    controller.add(pin(3, 50, 50, imageA));
    controller.merge([1, 2], mergedID);
    const snapshot = controller.consumeSnapshot()!;
    expect(new Set(snapshot.pins.map((p) => p.id))).toEqual(new Set([mergedID, 3]));
    expect(snapshot.removedIds).toEqual(expect.arrayContaining([1, 2]));
    const merged = snapshot.pins.find((p) => p.id === mergedID)!;
    expect(merged.countBadge?.count).toBe(2);
    expect(merged.image).toBe(imageA);
    expect(merged.coordinate.latitude).toBeCloseTo(11, 1);
    expect(merged.coordinate.longitude).toBeCloseTo(21, 1);
    controller.dispose();
  });

  test("the merged pin averages the members' live coordinates", () => {
    const controller = mergedController();
    controller.consumeSnapshot();
    controller.move(1, { latitude: 30, longitude: 40 });
    const merged = controller.consumeSnapshot()!.pins.find((p) => p.id === mergedID)!;
    const expected = ImmersiveMapPinsController.averageCoordinate([
      { latitude: 30, longitude: 40 },
      { latitude: 12, longitude: 22 },
    ]);
    expect(merged.coordinate.latitude).toBeCloseTo(expected.latitude, 9);
    expect(merged.coordinate.longitude).toBeCloseTo(expected.longitude, 9);
  });

  test("a step of the cycle switches the members' pictures", () => {
    const imageA = image("a");
    const imageB = image("b");
    const controller = mergedController(imageA, imageB);
    controller.consumeSnapshot();
    controller.advanceMergedImageCycle(mergedID);
    expect(controller.consumeSnapshot()!.pins.find((p) => p.id === mergedID)!.image).toBe(imageB);
    controller.advanceMergedImageCycle(mergedID);
    expect(controller.consumeSnapshot()!.pins.find((p) => p.id === mergedID)!.image).toBe(imageA);
  });

  test("the cycle's timer advances by itself", () => {
    vi.useFakeTimers();
    const imageB = image("b");
    const controller = new ImmersiveMapPinsController();
    controller.add(pin(1, 10, 20, image("a")));
    controller.add(pin(2, 12, 22, imageB));
    controller.merge([1, 2], mergedID, 0.05);
    controller.consumeSnapshot();
    let changes = 0;
    controller.setChangeHandler(() => (changes += 1), {});
    vi.advanceTimersByTime(50);
    expect(changes).toBe(1);
    expect(controller.pin(mergedID)!.image).toBe(imageB);
    controller.dispose();
  });

  test("unmerge restores the members", () => {
    const controller = mergedController();
    controller.consumeSnapshot();
    controller.unmerge(mergedID);
    const snapshot = controller.consumeSnapshot()!;
    expect(new Set(snapshot.pins.map((p) => p.id))).toEqual(new Set([1, 2]));
    expect(snapshot.removedIds).toContain(mergedID);
  });

  test("removing the merged pin removes the members", () => {
    const controller = mergedController();
    controller.consumeSnapshot();
    controller.remove(mergedID);
    expect(controller.consumeSnapshot()!.pins).toEqual([]);
    expect(controller.pin(1)).toBeNull();
    expect(controller.pin(2)).toBeNull();
    expect(controller.pin(mergedID)).toBeNull();
  });

  test("removing a member shrinks the group, and an empty group is dissolved", () => {
    const controller = mergedController();
    controller.consumeSnapshot();
    controller.remove(2);
    const merged = controller.consumeSnapshot()!.pins.find((p) => p.id === mergedID)!;
    expect(merged.countBadge?.count).toBe(1);
    expect(controller.mergedMemberIDs(mergedID)).toEqual([1]);
    controller.remove(1);
    expect(controller.consumeSnapshot()!.pins).toEqual([]);
    expect(controller.mergedMemberIDs(mergedID)).toBeNull();
  });

  test("selecting the merged pin selects it", () => {
    const controller = mergedController();
    controller.consumeSnapshot();
    controller.update(mergedID, { isSelected: true });
    const merged = controller.pin(mergedID)!;
    expect(merged.isSelected).toBe(true);
    expect(merged.countBadge?.count).toBe(2);
  });

  test("the average across the antimeridian does not collapse to zero longitude", () => {
    const average = ImmersiveMapPinsController.averageCoordinate([
      { latitude: 0, longitude: 179.5 },
      { latitude: 0, longitude: -179.5 },
    ]);
    expect(Math.abs(average.longitude)).toBeCloseTo(180, 2);
    expect(average.latitude).toBeCloseTo(0, 2);
  });

  test("merge leaves out the members of other groups", () => {
    const controller = mergedController();
    controller.add(pin(3, 50, 50));
    controller.consumeSnapshot();
    controller.merge([1, 3], 200);
    expect(controller.mergedMemberIDs(200)).toEqual([3]);
    expect(controller.mergedMemberIDs(mergedID)).toEqual([1, 2]);
  });
});

describe("the detached copy for an export", () => {
  test("carries a full pending snapshot after the original was drained", () => {
    const original = new ImmersiveMapPinsController();
    original.add([pin(1, 1, 1), pin(2, 2, 2)]);
    expect(original.consumeSnapshot()).not.toBeNull();
    expect(original.consumeSnapshot()).toBeNull();
    const copy = original.makeDetachedCopyForExport();
    const snapshot = copy.consumeSnapshot()!;
    expect(snapshot.pins.map((p) => p.id).sort()).toEqual([1, 2]);
    expect([...snapshot.imageUpdateIds].sort()).toEqual([1, 2]);
    expect(copy.consumeSnapshot()).toBeNull();
  });

  test("does not disturb the original", () => {
    const original = new ImmersiveMapPinsController();
    original.add(pin(1, 1, 1));
    original.makeDetachedCopyForExport();
    expect(original.consumeSnapshot()!.pins.map((p) => p.id)).toEqual([1]);
  });

  test("is isolated from later mutations of the original", () => {
    const original = new ImmersiveMapPinsController();
    original.add(pin(1, 1, 1));
    original.consumeSnapshot();
    const copy = original.makeDetachedCopyForExport();
    original.add(pin(2, 2, 2));
    expect(copy.consumeSnapshot()!.pins.map((p) => p.id)).toEqual([1]);
    expect(original.consumeSnapshot()!.pins.map((p) => p.id).sort()).toEqual([1, 2]);
  });
});

describe("remote pictures", () => {
  test("a remote source stores its URL and shows the placeholder", () => {
    const placeholder = image("placeholder");
    const remote = ImmersiveMapPin.remote(7, 55.75, 37.62, "https://example.com/a.png", { placeholder });
    expect(PinImageSource.remoteURL(remote.imageSource)).toBe("https://example.com/a.png");
    expect(remote.image).toBe(placeholder);
    // No placeholder: the built-in one, which the renderer draws for `null`.
    expect(ImmersiveMapPin.remote(8, 0, 0, "https://example.com/b.png").image).toBeNull();
  });

  test("the controller loads a remote picture and publishes the change", async () => {
    const loaded = image("loaded");
    let resolve: (value: PinImage) => void = () => undefined;
    const requested: string[] = [];
    const controller = new ImmersiveMapPinsController((url) => {
      requested.push(url);
      return new Promise((done) => (resolve = done));
    });
    controller.set([ImmersiveMapPin.remote(7, 55.75, 37.62, "https://example.com/a.png")]);
    expect(requested).toEqual(["https://example.com/a.png"]);
    controller.consumeSnapshot();
    let notified = 0;
    controller.setChangeHandler(() => (notified += 1), {});
    resolve(loaded);
    await Promise.resolve();
    await Promise.resolve();
    expect(notified).toBe(1);
    const snapshot = controller.consumeSnapshot()!;
    expect(snapshot.imageUpdateIds).toEqual([7]);
    expect(snapshot.pins[0]!.image).toBe(loaded);
  });

  test("the same URL is not requested twice while it loads", () => {
    const requested: string[] = [];
    const controller = new ImmersiveMapPinsController((url) => {
      requested.push(url);
      return new Promise(() => undefined);
    });
    const remote = ImmersiveMapPin.remote(7, 0, 0, "https://example.com/a.png");
    controller.set([remote]);
    controller.upsert([remote]);
    expect(requested).toEqual(["https://example.com/a.png"]);
  });
});

describe("the pin's screen size scale", () => {
  test("defaults to one", () => {
    expect(pin(1, 0, 0).screenSizeScale).toBe(1);
  });

  test("keeps a custom one", () => {
    expect(ImmersiveMapPin.make({ id: 1, coordinate: { latitude: 0, longitude: 0 }, image: image("a"), screenSizeScale: 1.6 }).screenSizeScale).toBe(1.6);
  });
});
