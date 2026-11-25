// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type ImmersiveMap, ImmersiveMapPin, ImmersiveMapSelectionController, PinImageFactory, type PinImage } from "@artembobkin/immersive-map";

/** The e2e app's `pins=1`: pins near the default view (the centre of Moscow) with pictures drawn locally, so nothing is fetched. */
const centre = { latitude: 55.752, longitude: 37.6175 };

const palette = ["rgb(46, 51, 61)", "rgb(181, 62, 52)", "rgb(42, 111, 151)", "rgb(57, 129, 72)", "rgb(158, 104, 31)", "rgb(103, 64, 150)"];

/**
 * Stands three kinds of pins: a ring of numbered ones around the Kremlin,
 * a dense pile of event pins (a flower), and a merged group with a
 * counter. A selection controller makes a tap select a pin, and the
 * counts of taps and selections are kept on `window.samplePinEvents` for
 * the e2e test.
 */
export function addSamplePins(map: ImmersiveMap): void {
  const pictures: PinImage[] = palette.map((color, index) => PinImageFactory.number(index + 1, 128, color));
  const pins: ImmersiveMapPin[] = [];
  // A ring around the centre.
  for (let index = 0; index < 12; index++) {
    const angle = (index / 12) * Math.PI * 2;
    pins.push(
      ImmersiveMapPin.make({
        id: index + 1,
        coordinate: { latitude: centre.latitude + Math.sin(angle) * 0.006, longitude: centre.longitude + Math.cos(angle) * 0.01 },
        image: pictures[index % pictures.length]!,
        drawPriority: index % 3,
      }),
    );
  }
  // A pile on one place: the event pins lay out as a flower.
  for (let index = 0; index < 9; index++) {
    pins.push(
      ImmersiveMapPin.make({
        id: 100 + index,
        coordinate: { latitude: centre.latitude + 0.0002 * Math.sin(index), longitude: centre.longitude + 0.0002 * Math.cos(index) },
        image: pictures[index % pictures.length]!,
        clusterPolicy: "event",
      }),
    );
  }
  // Three pins merged into one with a counter.
  for (let index = 0; index < 3; index++) {
    pins.push(
      ImmersiveMapPin.make({
        id: 200 + index,
        coordinate: { latitude: centre.latitude - 0.004 + index * 0.0003, longitude: centre.longitude + 0.004 },
        image: pictures[(index + 2) % pictures.length]!,
      }),
    );
  }
  map.pins.set(pins);
  map.pins.merge([200, 201, 202], 300);

  const events = { taps: 0, selections: 0 };
  const selection = new ImmersiveMapSelectionController();
  selection.onSelectionChanged = () => (events.selections += 1);
  map.selection = selection;
  map.onPinTap(() => (events.taps += 1));
  Object.assign(window, { samplePinEvents: events });
}
