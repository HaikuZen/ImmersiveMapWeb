// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from the Swift `ImmersiveMapSceneModelTapEventTests` (the CPU part):
// a tap on a 3D model delivers `ImmersiveMapSceneModelTapEvent` and, with a
// selection controller attached, selects the model. A pin drawn over it
// keeps taking the tap, and a removed model stops being selected.

import { describe, expect, test } from "vitest";
import { Matrix, mat4Identity, mat4Multiply } from "../../math/matrix.ts";
import type { Vec3 } from "../../math/vec.ts";
import { ImmersiveMapPin, type PinImage } from "../../pins/immersive-map-pin.ts";
import { ImmersiveMapPinsController } from "../../pins/immersive-map-pins-controller.ts";
import { PinSelection } from "../../pins/selection/pin-selection.ts";
import { PinSelectionSnapshot } from "../../pins/selection/pin-selection-projector.ts";
import { ImmersiveMapSelectionHandler } from "../../selection/immersive-map-selection-handler.ts";
import { type ImmersiveMapScreenPoint, type ImmersiveMapSelectionClearEvent, ImmersiveMapSelectionController, ImmersiveMapSelectionKind } from "../../selection/immersive-map-selection.ts";
import { ImmersiveMapSceneModel } from "../immersive-map-scene-model.ts";
import type { ImmersiveMapSceneModelTapEvent } from "../immersive-map-scene-model-tap-event.ts";
import { ImmersiveMapSceneModelsController } from "../immersive-map-scene-models-controller.ts";
import { SceneModelSelection } from "./scene-model-selection.ts";
import { SceneModelSelectionSnapshot } from "./scene-model-selection-snapshot.ts";

const modelID = 11;
const drawWidth = 800;
const drawHeight = 600;
const eye: Vec3 = [0, 0, 10];
const projectionView = mat4Multiply(
  mat4Identity(),
  Matrix.perspectiveMatrix(mat4Identity(), Math.PI / 4, drawWidth / drawHeight, 0.01, 200),
  Matrix.lookAt(mat4Identity(), eye, [0, 0, 0], [0, 1, 0]),
);
const flightCoordinate = { latitude: 12, longitude: 34 };
const destinationCoordinate = { latitude: 55.75, longitude: 37.61 };
const modelTapPoint: ImmersiveMapScreenPoint = { x: drawWidth * 0.5, y: drawHeight * 0.5 };
const backgroundTapPoint: ImmersiveMapScreenPoint = { x: 10, y: 10 };

interface Environment {
  readonly handler: ImmersiveMapSelectionHandler;
  readonly pinSelection: PinSelection;
  readonly sceneModelSelection: SceneModelSelection;
  readonly sceneModels: ImmersiveMapSceneModelsController;
  readonly pins: ImmersiveMapPinsController;
  /** Places a pin whose hit zone covers `point` (contents scale 1, snapshot y up). */
  addPin(id: number, point: ImmersiveMapScreenPoint): void;
}

/**
 * A selection handler holding one model whose hit volume covers the viewport
 * center, drawn away from the descriptor's coordinate so the two can be told
 * apart. The pins come first: they are drawn over the world pass.
 */
function makeEnvironment(): Environment {
  const pins = new ImmersiveMapPinsController();
  const sceneModels = new ImmersiveMapSceneModelsController();
  const pinSelection = new PinSelection({ pin: (id) => pins.pin(id), updatePinSelection: (id, isSelected) => pins.update(id, { isSelected }) });
  const sceneModelSelection = new SceneModelSelection(sceneModels);
  const handler = new ImmersiveMapSelectionHandler({ contentsScale: 1, requestFrame: () => undefined }, [pinSelection, sceneModelSelection]);
  const owner = {};
  sceneModels.setChangeHandler(() => handler.handleFeatureDidChange(), owner);
  pins.setChangeHandler(() => handler.handleFeatureDidChange(), owner);

  sceneModels.add(ImmersiveMapSceneModel.make({ id: modelID, source: "models/model.glb", coordinate: destinationCoordinate }));
  handler.updatePickData([
    new SceneModelSelectionSnapshot(2, drawWidth, drawHeight, projectionView, eye, [
      { id: modelID, coordinate: flightCoordinate, modelMatrix: mat4Identity(), boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1] },
    ]),
  ]);

  return {
    handler,
    pinSelection,
    sceneModelSelection,
    sceneModels,
    pins,
    addPin(id, point) {
      pins.add(ImmersiveMapPin.make({ id, coordinate: { latitude: 0, longitude: 0 }, image: {} as unknown as PinImage }));
      const anchorX = point.x;
      const anchorY = drawHeight - point.y - 50;
      handler.updatePickData([
        new PinSelectionSnapshot(1, drawWidth, drawHeight, [{ pinID: id, minX: anchorX - 50, minY: anchorY, maxX: anchorX + 50, maxY: anchorY + 100, anchorX, anchorY, drawOrder: 0 }]),
      ]);
    },
  };
}

describe("scene model taps", () => {
  test("the tap action receives the model without a selection controller", () => {
    const environment = makeEnvironment();
    const events: ImmersiveMapSceneModelTapEvent[] = [];
    environment.sceneModelSelection.tapAction = (event) => events.push(event);
    expect(environment.handler.handleMapTap(modelTapPoint)).toBe("consumed");
    expect(events).toHaveLength(1);
    expect(events[0]!.model.id).toBe(modelID);
    expect(events[0]!.screenPoint).toEqual(modelTapPoint);
    // A tap action without a selection controller does not create a selection.
    expect(environment.handler.currentMapSelection()).toBeNull();
  });

  test("the event reports the drawn coordinate rather than the descriptor's destination", () => {
    const environment = makeEnvironment();
    let received: ImmersiveMapSceneModelTapEvent | null = null;
    environment.sceneModelSelection.tapAction = (event) => (received = event);
    environment.handler.handleMapTap(modelTapPoint);
    const event = received as ImmersiveMapSceneModelTapEvent | null;
    expect(event?.coordinate).toEqual(flightCoordinate);
    expect(event?.model.coordinate).toEqual(destinationCoordinate);
  });

  test("a tap with no one listening falls back to the background", () => {
    expect(makeEnvironment().handler.handleMapTap(modelTapPoint)).toBe("background");
  });

  test("a background tap fires no model tap", () => {
    const environment = makeEnvironment();
    let taps = 0;
    environment.sceneModelSelection.tapAction = () => (taps += 1);
    expect(environment.handler.handleMapTap(backgroundTapPoint)).toBe("background");
    expect(taps).toBe(0);
  });

  test("a tap selects with the sceneModel kind, and the event fires on every tap", () => {
    const environment = makeEnvironment();
    const controller = new ImmersiveMapSelectionController();
    environment.handler.syncController(controller);
    let taps = 0;
    let changes = 0;
    environment.sceneModelSelection.tapAction = () => (taps += 1);
    controller.onSelectionChanged = () => (changes += 1);
    expect(environment.handler.handleMapTap(modelTapPoint)).toBe("consumed");
    expect(environment.handler.handleMapTap(modelTapPoint)).toBe("consumed");
    expect(taps).toBe(2);
    expect(changes).toBe(1);
    expect(environment.handler.currentMapSelection()).toEqual({ kind: ImmersiveMapSelectionKind.sceneModel, objectID: modelID });
  });

  test("a background tap clears the model's selection", () => {
    const environment = makeEnvironment();
    const controller = new ImmersiveMapSelectionController();
    environment.handler.syncController(controller);
    const cleared: ImmersiveMapSelectionClearEvent[] = [];
    controller.onSelectionCleared = (event) => cleared.push(event);
    expect(environment.handler.handleMapTap(modelTapPoint)).toBe("consumed");
    expect(environment.handler.handleMapTap(backgroundTapPoint)).toBe("background");
    expect(environment.handler.currentMapSelection()).toBeNull();
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.source).toBe("tap");
  });

  test("a pin over the model wins the tap", () => {
    const environment = makeEnvironment();
    environment.addPin(5, modelTapPoint);
    let pinTaps = 0;
    let modelTaps = 0;
    environment.pinSelection.tapAction = () => (pinTaps += 1);
    environment.sceneModelSelection.tapAction = () => (modelTaps += 1);
    expect(environment.handler.handleMapTap(modelTapPoint)).toBe("consumed");
    expect(pinTaps).toBe(1);
    expect(modelTaps).toBe(0);
  });

  test("a pin no one listens to falls through to the model", () => {
    const environment = makeEnvironment();
    environment.addPin(5, modelTapPoint);
    let modelTaps = 0;
    environment.sceneModelSelection.tapAction = () => (modelTaps += 1);
    expect(environment.handler.handleMapTap(modelTapPoint)).toBe("consumed");
    expect(modelTaps).toBe(1);
  });

  test("removing a selected model clears the selection", () => {
    const environment = makeEnvironment();
    environment.handler.syncController(new ImmersiveMapSelectionController());
    environment.sceneModelSelection.tapAction = () => undefined;
    expect(environment.handler.handleMapTap(modelTapPoint)).toBe("consumed");
    environment.sceneModels.remove(modelID);
    expect(environment.handler.currentMapSelection()).toBeNull();
  });

  test("an older snapshot does not replace the current one", () => {
    const environment = makeEnvironment();
    environment.sceneModelSelection.tapAction = () => undefined;
    environment.handler.updatePickData([new SceneModelSelectionSnapshot(1, drawWidth, drawHeight, projectionView, eye, [])]);
    expect(environment.handler.handleMapTap(modelTapPoint)).toBe("consumed");
  });

  test("reset pick data forgets what was drawn", () => {
    const environment = makeEnvironment();
    environment.sceneModelSelection.tapAction = () => undefined;
    environment.handler.resetPickData();
    expect(environment.handler.handleMapTap(modelTapPoint)).toBe("background");
  });

  test("the contents scale maps CSS pixels to drawable pixels", () => {
    const sceneModels = new ImmersiveMapSceneModelsController();
    sceneModels.add(ImmersiveMapSceneModel.make({ id: 1, source: "m.glb", coordinate: destinationCoordinate }));
    const selection = new SceneModelSelection(sceneModels);
    selection.updatePickData(
      new SceneModelSelectionSnapshot(1, drawWidth, drawHeight, projectionView, eye, [
        { id: 1, coordinate: flightCoordinate, modelMatrix: mat4Identity(), boundsMin: [-1, -1, -1], boundsMax: [1, 1, 1] },
      ]),
    );
    // At scale 2 the drawable's center is CSS point (200, 150).
    expect(selection.hitTest({ x: 200, y: 150 }, 2)?.selection).toEqual({ kind: ImmersiveMapSelectionKind.sceneModel, objectID: 1 });
    expect(selection.hitTest({ x: 400, y: 300 }, 2)).toBeNull();
  });
});
