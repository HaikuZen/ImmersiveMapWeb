// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type GeoCoordinate, type ImmersiveMap, geoCoordinate } from "@immersive-map/web";

/** A sample annotation of the playground's `annotations=1`: a place and how it shows. */
interface SamplePlace {
  readonly id: string;
  readonly name: string;
  readonly coordinate: GeoCoordinate;
  readonly kind: "label" | "button";
}

/** Places near the default view, the centre of Moscow. */
const places: readonly SamplePlace[] = [
  { id: "kremlin", name: "Kremlin", coordinate: geoCoordinate(55.752, 37.6175), kind: "label" },
  { id: "red-square", name: "Red Square", coordinate: geoCoordinate(55.7539, 37.6208), kind: "label" },
  { id: "alexander-garden", name: "Alexander Garden", coordinate: geoCoordinate(55.7525, 37.613), kind: "button" },
];

function label(place: SamplePlace): HTMLElement {
  const element = document.createElement("div");
  element.dataset.sampleAnnotation = place.id;
  element.textContent = place.name;
  element.style.cssText =
    "padding:4px 10px;border-radius:999px;font:600 13px system-ui,sans-serif;white-space:nowrap;" +
    "color:#14161c;background:rgb(255 255 255 / 0.88);box-shadow:0 1px 4px rgb(0 0 0 / 0.3)";
  return element;
}

function button(place: SamplePlace, onPress: () => void): HTMLElement {
  const element = document.createElement("button");
  element.type = "button";
  element.dataset.sampleAnnotation = place.id;
  element.textContent = `${place.name} ▸`;
  element.style.cssText =
    "padding:6px 12px;border:0;border-radius:8px;font:600 13px system-ui,sans-serif;white-space:nowrap;cursor:pointer;" +
    "color:#fff;background:#d4372c;box-shadow:0 2px 6px rgb(0 0 0 / 0.35)";
  element.addEventListener("click", onPress);
  return element;
}

/**
 * Shows the sample annotations: two labels standing on their points by
 * their bottom centre and a button that counts its presses
 * (`window.annotationPresses`).
 */
export function addSampleAnnotations(map: ImmersiveMap): void {
  const presses = { count: 0 };
  Object.assign(window, { annotationPresses: presses });
  map.annotations.set(places, {
    id: (place) => place.id,
    coordinate: (place) => place.coordinate,
    render: (place) =>
      place.kind === "label"
        ? label(place)
        : button(place, () => {
            presses.count += 1;
          }),
    anchor: { x: 0.5, y: 1 },
    // The video export's picture of each annotation (stage 8): the label's pill drawn on a canvas.
    exportImage: (place, scale) => exportPicture(place, scale),
  });
}

/** An annotation's pill as the video export draws it, at `scale` pixels per CSS pixel. */
function exportPicture(place: SamplePlace, scale: number): OffscreenCanvas {
  const text = place.kind === "label" ? place.name : `${place.name} ▸`;
  const font = `600 ${13 * scale}px system-ui, sans-serif`;
  const measure = new OffscreenCanvas(1, 1).getContext("2d")!;
  measure.font = font;
  const [paddingX, height] = [(place.kind === "label" ? 10 : 12) * scale, 26 * scale];
  const width = Math.ceil(measure.measureText(text).width + paddingX * 2);
  const canvas = new OffscreenCanvas(width, Math.ceil(height));
  const context = canvas.getContext("2d")!;
  context.fillStyle = place.kind === "label" ? "rgb(255 255 255 / 0.88)" : "#d4372c";
  context.beginPath();
  context.roundRect(0, 0, width, height, place.kind === "label" ? height / 2 : 8 * scale);
  context.fill();
  context.font = font;
  context.textBaseline = "middle";
  context.fillStyle = place.kind === "label" ? "#14161c" : "#fff";
  context.fillText(text, paddingX, height / 2);
  return canvas;
}
