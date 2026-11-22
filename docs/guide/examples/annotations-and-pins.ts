// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/AnnotationsAndPins.md.

import {
  type GeoCoordinate,
  geoCoordinate,
  ImmersiveMap,
  ImmersiveMapPin,
  ImmersiveMapSelectionController,
  ImmersiveMapSelectionKind,
  ImmersiveMapSettings,
  PinImageFactory,
  PinImageSource,
  PinShape,
} from "@artembobkin/immersive-map";

interface Place {
  readonly id: string;
  readonly name: string;
  readonly coordinate: GeoCoordinate;
}

/** DOM elements standing at coordinates. */
export function annotations(map: ImmersiveMap, places: readonly Place[]): void {
  map.annotations.set(places, {
    id: (place) => place.id,
    coordinate: (place) => place.coordinate,
    render: (place) => {
      const label = document.createElement("div");
      label.className = "place-label";
      label.textContent = place.name;
      return label;
    },
    anchor: { x: 0.5, y: 1 },
  });
}

/** A button as an annotation: it takes its own clicks. */
export function annotationButton(map: ImmersiveMap, place: Place, open: (place: Place) => void): void {
  map.annotations.set([place], {
    id: (item) => item.id,
    coordinate: (item) => item.coordinate,
    render: (item) => {
      const button = document.createElement("button");
      button.textContent = item.name;
      button.addEventListener("click", () => open(item));
      return button;
    },
  });

  map.annotations.clear();
}

/** Pins with remote pictures and one drawn locally. */
export async function pins(container: HTMLElement, photoURL: string): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({ container, camera: { city: "moscow", zoom: 14 } });
  const placeholder = PinImageFactory.number(1, 128);

  map.pins.set([
    ImmersiveMapPin.make({
      id: 1,
      coordinate: geoCoordinate(55.75, 37.62),
      image: PinImageSource.remote(photoURL, placeholder),
    }),
    ImmersiveMapPin.make({
      id: 2,
      coordinate: geoCoordinate(55.752, 37.6175),
      image: PinImageFactory.number(2, 128, "rgb(181, 62, 52)"),
      borderColor: [0.7, 0.1, 0.1, 1],
      drawPriority: 1,
    }),
  ]);
  return map;
}

/** The pins' changes. */
export function pinChanges(map: ImmersiveMap, picture: ImageBitmap): void {
  map.pins.add(ImmersiveMapPin.make({ id: 3, coordinate: geoCoordinate(55.754, 37.62), image: picture }));
  map.pins.upsert([ImmersiveMapPin.make({ id: 3, coordinate: geoCoordinate(55.754, 37.62), image: picture, screenSizeScale: 1.5 })]);
  map.pins.move(3, geoCoordinate(55.756, 37.615));
  map.pins.update(3, { borderColor: [0, 0.4, 0.9, 1], isSelected: true });
  map.pins.remove([1, 2]);
  map.pins.clear();
}

/** Several pins shown as one, with a counter, and split again. */
export function groups(map: ImmersiveMap): void {
  map.pins.merge([10, 11, 12], 100);
  map.pins.unmerge(100);
}

/** The size of every pin. */
export const pinSize: ImmersiveMapSettings = ImmersiveMapSettings.default.pinSettings({ size: 128, sizeScale: 1.5 });

/** The frame every pin is drawn in. */
export const pinFrame: ImmersiveMapSettings = ImmersiveMapSettings.default.pinSettings({
  shape: PinShape.circle,
  borderWidthPx: 2,
  borderColor: [0, 0, 0, 1],
  fillColor: [1, 1, 1, 1],
  contentInset: 0.04,
});

/** A shape from a picture of it. */
export const maskShape: ImmersiveMapSettings = ImmersiveMapSettings.default.pinSettings({
  shape: PinShape.mask("/images/pin-mask.png", { x: 0.5, y: 1 }, { x: 0, y: 0, width: 1, height: 0.9 }),
});

/** A shape from a path in the unit square. */
export const diamondShape: ImmersiveMapSettings = ImmersiveMapSettings.default.pinSettings({
  shape: PinShape.path("M0.5,0 L1,0.5 L0.5,1 L0,0.5 Z", { x: 0.5, y: 1 }, { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }),
});

/** The other built-in shapes, and no frame at all. */
export const otherShapes: ImmersiveMapSettings[] = [
  ImmersiveMapSettings.default.pinSettings({ shape: PinShape.roundedRectangle(0.2, true) }),
  ImmersiveMapSettings.default.pinSettings({ shape: PinShape.picture() }),
];

/** Pins that stand exactly on their coordinates. */
export const pinsInPlace: ImmersiveMapSettings = ImmersiveMapSettings.default.pinSettings({ spreadsApart: false });

/** Taps on pins, models and the empty map. */
export function taps(map: ImmersiveMap): void {
  map.onPinTap((event) => {
    console.log(`tapped pin ${event.pin.id}`);
  });
  map.onSceneModelTap((event) => {
    console.log(`tapped model ${event.model.id}`);
  });
  map.camera.onMapBackgroundTap = () => console.log("tapped the map");
}

/** The selection: a tap selects, a tap on the empty map clears. */
export function selection(map: ImmersiveMap): ImmersiveMapSelectionController {
  const selection = new ImmersiveMapSelectionController();
  map.selection = selection;

  selection.onSelectionChanged = (event) => console.log(event.selection.kind, event.selection.objectID, event.source);
  selection.onSelectionCleared = (event) => console.log("cleared", event.previousSelection);

  selection.select({ kind: ImmersiveMapSelectionKind.pin, objectID: 1 });
  selection.clearSelection();
  return selection;
}

/** The selection controller given when the map is made. */
export async function selectionOption(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({ container, selection: new ImmersiveMapSelectionController() });
  return map;
}
