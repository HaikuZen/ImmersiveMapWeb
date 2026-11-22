// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/Camera.md.

import {
  CameraBoundsEdgeBehavior,
  CameraFlightOptions,
  geoCoordinate,
  ImmersiveMap,
  ImmersiveMapCameraControlPanel,
  ImmersiveMapCameraPosition,
  ImmersiveMapCameraTourController,
  ImmersiveMapCameraTourShot,
  ImmersiveMapCity,
  ImmersiveMapSettings,
  PullCurve,
} from "@artembobkin/immersive-map";

/** The control zones turned off where the app's own controls sit. */
export const noControlZones: ImmersiveMapSettings = ImmersiveMapSettings.default.cameraControlZones({ pitch: false, zoom: false });

/** A slower tilt drag that tilts the other way. */
export const invertedTilt: ImmersiveMapSettings = ImmersiveMapSettings.default.tiltGestureSensitivity(-1);

/** The starting position. */
export async function startingPosition(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({
    container,
    camera: ImmersiveMapCameraPosition.make(48.8584, 2.2945, 16, 0, 1.0),
  });
  return map;
}

/** The same start as a view: the point as longitude and latitude, the angles in radians. */
export async function startingView(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({
    container,
    camera: { center: [2.2945, 48.8584], zoom: 16, bearing: 0, pitch: 1.0 },
  });
  return map;
}

/** A city's centre. */
export async function cityStart(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({ container, camera: { city: "paris" } });
  return map;
}

/** A city with the rest of the position set. */
export const tokyo: ImmersiveMapCameraPosition = ImmersiveMapCameraPosition.city("tokyo", 13, 0.5, 1.0);

/** The cities for a picker. */
export function cityPicker(select: HTMLSelectElement): void {
  for (const city of ImmersiveMapCity.allCases) {
    select.append(new Option(ImmersiveMapCity.name(city), city));
  }
}

/** Jumps, flights, and the camera's callbacks. */
export function movingTheCamera(map: ImmersiveMap): void {
  const position = ImmersiveMapCameraPosition.city("sydney", 12);

  map.camera.jump(position);

  map.camera.fly(position);

  map.camera.fly(position, CameraFlightOptions.make(4, "automatic", "overviewFirst"), (finished) => {
    // false when a gesture or another command interrupted it
    console.log(finished);
  });

  map.camera.cancelFlight();

  map.camera.onCameraPositionChanged = (current) => console.log(current.zoom);
  map.camera.onUserInteractionBegan = () => console.log("the user took the camera");
  console.log(map.camera.currentCameraPosition());
}

/** The camera carried along a path. */
export function followingAPath(map: ImmersiveMap): void {
  const path = {
    waypoints: [geoCoordinate(48.8584, 2.2945), geoCoordinate(48.8606, 2.3376), geoCoordinate(48.853, 2.3499)],
    baseAltitudeMeters: 0,
    peakAltitudeMeters: 0,
  };
  map.camera.follow(path, 20, "linear");

  map.camera.cancelFollow();
}

/** A tour of shots, looped until the user touches the map. */
export function tour(map: ImmersiveMap): ImmersiveMapCameraTourController {
  const eiffelTower = ImmersiveMapCameraPosition.make(48.8584, 2.2945, 16, 0, 1.0);
  const louvre = ImmersiveMapCameraPosition.make(48.8606, 2.3376, 16, 0.6, 0.9);

  const tour = new ImmersiveMapCameraTourController(map.camera);
  tour.start(
    [
      ImmersiveMapCameraTourShot.make(eiffelTower, CameraFlightOptions.default, 2),
      ImmersiveMapCameraTourShot.make(louvre, CameraFlightOptions.make(3)),
    ],
    { loop: true },
  );
  return tour;
}

/** The on-screen camera buttons. */
export async function cameraButtons(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({ container, cameraControls: true });
  return map;
}

/** The same panel placed by the app, in an element of its own. */
export function ownCameraPanel(map: ImmersiveMap, sidebar: HTMLElement): ImmersiveMapCameraControlPanel {
  const panel = new ImmersiveMapCameraControlPanel({ container: sidebar, camera: map.camera });
  return panel;
}

/** The limits every gesture, command and flight keeps within. */
export const limits: ImmersiveMapSettings = ImmersiveMapSettings.default
  .zoomRange({ minimum: 3, maximum: 18 })
  .pitchRange({ minimum: 0, maximum: 1.2 })
  .bearingLimit(Math.PI / 2); // at most a quarter turn from north

/** The zoomed-out globe's pull to north-up, tuned and turned off. */
export function uprightPull(): ImmersiveMapSettings[] {
  const tuned = ImmersiveMapSettings.default.globeUprightPull({ zoomRange: { lowerBound: 2, upperBound: 5 }, halfLife: 0.3 });
  const off = ImmersiveMapSettings.default.globeUprightPull(null);
  return [tuned, off];
}

/** The camera kept over Moscow. */
export const moscowBounds: ImmersiveMapSettings = ImmersiveMapSettings.default.cameraBounds({
  southWest: geoCoordinate(55.57, 37.36),
  northEast: geoCoordinate(55.92, 37.86),
});

/** The bounds' pull and edge. */
export const tunedBounds: ImmersiveMapSettings = ImmersiveMapSettings.default.cameraBounds({
  southWest: geoCoordinate(55.57, 37.36),
  northEast: geoCoordinate(55.92, 37.86),
  pullZoomRange: { lowerBound: 3, upperBound: 3 },
  pullCurve: PullCurve.make(0.2, 0.8, 0.4, 1),
  edgeBehavior: CameraBoundsEdgeBehavior.elastic({ maximumStretch: 150, pullHalfLife: 0.3 }),
});

/** A hard edge, and the whole world again. */
export const otherBounds: ImmersiveMapSettings[] = [
  ImmersiveMapSettings.default.cameraBounds({
    southWest: geoCoordinate(55.57, 37.36),
    northEast: geoCoordinate(55.92, 37.86),
    edgeBehavior: CameraBoundsEdgeBehavior.hard,
  }),
  ImmersiveMapSettings.default.cameraBounds(null),
];
