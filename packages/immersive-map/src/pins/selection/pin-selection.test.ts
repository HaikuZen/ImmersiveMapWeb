// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `ImmersiveMapPinTapEventTests` and the snapshot part
// of `PinSelectionProjectorConsistencyTests`.

import { describe, expect, test } from "vitest";
import { ImmersiveMapSelectionHandler } from "../../selection/immersive-map-selection-handler.ts";
import { ImmersiveMapSelectionController, ImmersiveMapSelectionKind } from "../../selection/immersive-map-selection.ts";
import type { PinCollisionItem } from "../clustering/pin-collision-types.ts";
import { ImmersiveMapPin, type PinImage } from "../immersive-map-pin.ts";
import { ImmersiveMapPinsController } from "../immersive-map-pins-controller.ts";
import { PinStyle, pinShapeMetrics } from "../pin-types.ts";
import { PinShape } from "../../configuration/pin-shape.ts";
import { type ImmersiveMapPinTapEvent, PinSelection } from "./pin-selection.ts";
import { PinSelectionProjector, PinSelectionSnapshot } from "./pin-selection-projector.ts";

const pinID = 7;
const pinTapPoint = { x: 400, y: 300 };
const backgroundTapPoint = { x: 10, y: 10 };

/** A handler with one pin `pinID` whose hit zone covers `pinTapPoint` (contents scale 1, the snapshot's y up). */
function makeEnvironment(): { handler: ImmersiveMapSelectionHandler; selection: PinSelection; pins: ImmersiveMapPinsController } {
  const pins = new ImmersiveMapPinsController();
  pins.add(ImmersiveMapPin.make({ id: pinID, coordinate: { latitude: 0, longitude: 0 }, image: {} as unknown as PinImage }));
  const selection = new PinSelection({ pin: (id) => pins.pin(id), updatePinSelection: (id, isSelected) => pins.update(id, { isSelected }) });
  const handler = new ImmersiveMapSelectionHandler({ contentsScale: 1, requestFrame: () => undefined }, [selection]);
  const drawHeight = 600;
  const anchorX = pinTapPoint.x;
  const anchorY = drawHeight - pinTapPoint.y - 50;
  handler.updatePickData([
    new PinSelectionSnapshot(1, 800, drawHeight, [{ pinID, minX: anchorX - 50, minY: anchorY, maxX: anchorX + 50, maxY: anchorY + 100, anchorX, anchorY, drawOrder: 0 }]),
  ]);
  return { handler, selection, pins };
}

describe("pin taps", () => {
  test("the tap action gets the tapped pin without a selection controller", () => {
    const { handler, selection } = makeEnvironment();
    const events: ImmersiveMapPinTapEvent[] = [];
    selection.tapAction = (event) => events.push(event);
    expect(handler.handleMapTap(pinTapPoint)).toBe("consumed");
    expect(events).toHaveLength(1);
    expect(events[0]!.pin.id).toBe(pinID);
    expect(events[0]!.screenPoint).toEqual(pinTapPoint);
    expect(handler.currentMapSelection()).toBeNull();
  });

  test("a tap with no one listening falls back to the background", () => {
    const { handler } = makeEnvironment();
    expect(handler.handleMapTap(pinTapPoint)).toBe("background");
  });

  test("the tap action fires on every tap while the selection changes once", () => {
    const { handler, selection, pins } = makeEnvironment();
    const controller = new ImmersiveMapSelectionController();
    handler.syncController(controller);
    let taps = 0;
    let changes = 0;
    selection.tapAction = () => (taps += 1);
    controller.onSelectionChanged = () => (changes += 1);
    expect(handler.handleMapTap(pinTapPoint)).toBe("consumed");
    expect(handler.handleMapTap(pinTapPoint)).toBe("consumed");
    expect(taps).toBe(2);
    expect(changes).toBe(1);
    expect(handler.currentMapSelection()).toEqual({ kind: ImmersiveMapSelectionKind.pin, objectID: pinID });
    expect(controller.currentSelection()).toEqual({ kind: ImmersiveMapSelectionKind.pin, objectID: pinID });
    // The selected pin is drawn as selected.
    expect(pins.pin(pinID)!.isSelected).toBe(true);
  });

  test("a background tap fires no pin tap and clears the selection", () => {
    const { handler, selection } = makeEnvironment();
    const controller = new ImmersiveMapSelectionController();
    handler.syncController(controller);
    let taps = 0;
    let cleared = 0;
    let backgrounds = 0;
    selection.tapAction = () => (taps += 1);
    controller.onSelectionCleared = () => (cleared += 1);
    controller.onMapBackgroundTap = () => (backgrounds += 1);
    expect(controller.select({ kind: ImmersiveMapSelectionKind.pin, objectID: pinID })).toBe(true);
    expect(handler.handleMapTap(backgroundTapPoint)).toBe("background");
    expect(taps).toBe(0);
    expect(cleared).toBe(1);
    expect(backgrounds).toBe(1);
  });

  test("a selection of a pin the map does not hold is refused, and a removed pin's selection is cleared", () => {
    const { handler, pins } = makeEnvironment();
    const controller = new ImmersiveMapSelectionController();
    handler.syncController(controller);
    expect(controller.select({ kind: ImmersiveMapSelectionKind.pin, objectID: 999 })).toBe(false);
    expect(controller.select({ kind: ImmersiveMapSelectionKind.pin, objectID: pinID })).toBe(true);
    let source: string | null = null;
    controller.onSelectionCleared = (event) => (source = event.source);
    pins.remove(pinID);
    handler.handleFeatureDidChange();
    expect(source).toBe("system");
    expect(controller.currentSelection()).toBeNull();
  });

  test("an older frame's pick data does not replace a newer one's", () => {
    const { handler, selection } = makeEnvironment();
    let taps = 0;
    selection.tapAction = () => (taps += 1);
    handler.updatePickData([PinSelectionSnapshot.empty]);
    expect(handler.handleMapTap(pinTapPoint)).toBe("consumed");
    expect(taps).toBe(1);
  });
});

describe("PinSelectionProjector snapshot", () => {
  const style = new PinStyle({ sizePx: 100, outlineWidthPx: 3, metrics: pinShapeMetrics(PinShape.bubble) });
  const item = (id: number, x: number, y: number, displayScale: number, visibilityAlpha = 1): PinCollisionItem => {
    const point = { positionX: x, positionY: y, depth: 0, visible: 1, visibilityAlpha };
    return {
      pin: ImmersiveMapPin.make({ id, coordinate: { latitude: 0, longitude: 0 }, image: {} as unknown as PinImage }),
      squashScaleX: 1,
      squashScaleY: 1,
      screenPoint: point,
      anchorScreenPoint: point,
      displayScale,
      morph: 0,
      isFlowerPetal: false,
      drawOrder: id,
    };
  };

  test("a hit zone is the drawn quad, scaled as the pin is shrunk", () => {
    const snapshot = new PinSelectionProjector().makeSnapshot([item(1, 100, 100, 1), item(2, 400, 100, 0.5)], 800, 600, style);
    const [first, second] = snapshot.entries;
    expect(first!.maxX - first!.minX).toBeCloseTo(100, 4);
    expect(second!.maxX - second!.minX).toBeCloseTo(50, 4);
    // The bubble stands on its tail: the quad rises from the anchor.
    expect(first!.minY).toBeCloseTo(100, 4);
    expect(snapshot.hitTest(100, 150)).toBe(1);
    expect(snapshot.hitTest(100, 90)).toBeNull();
  });

  test("the pin drawn last wins, and a faded out pin takes no tap", () => {
    const snapshot = new PinSelectionProjector().makeSnapshot([item(1, 100, 100, 1), item(2, 110, 100, 1), item(3, 300, 100, 1, 0)], 800, 600, style);
    expect(snapshot.hitTest(105, 150)).toBe(2);
    expect(snapshot.entries.map((entry) => entry.pinID)).toEqual([1, 2]);
  });
});
