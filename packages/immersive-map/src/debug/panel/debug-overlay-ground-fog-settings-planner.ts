// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { closedRange } from "../../math/closed-range.ts";
import type { Rgb } from "../../configuration/color.ts";
import { mountainAir, overviewStopZooms, replacingOverviewStops } from "../../configuration/scene-settings.ts";
import type { GroundFogCurveField, GroundFogSettings } from "../../configuration/scene-settings.ts";
import { zoomCurveValue } from "../../configuration/zoom-curve.ts";
import type { ImmersiveMapZoomCurve } from "../../configuration/zoom-curve.ts";
import { DebugOverlayValueText, formatFixed, formatG, swiftRounded } from "./debug-overlay-geometry.ts";
import { DebugOverlayZoomCurveAxes } from "./debug-overlay-zoom-curve-editing.ts";

const zoomRange = closedRange(0, 22);
const logarithmic = { isLogarithmic: true, interpolation: "geometric" } as const;
const densityAxes = DebugOverlayZoomCurveAxes.of(zoomRange, closedRange(0.001, 100), logarithmic);
const heightAxes = DebugOverlayZoomCurveAxes.of(zoomRange, closedRange(1, 500_000), logarithmic);
const startDistanceAxes = DebugOverlayZoomCurveAxes.of(zoomRange, closedRange(10, 2_000_000), logarithmic);
const startSoftnessAxes = DebugOverlayZoomCurveAxes.of(zoomRange, closedRange(10, 10_000_000), logarithmic);
const maximumOpacityAxes = DebugOverlayZoomCurveAxes.of(zoomRange, closedRange(0, 1));

function valueAt(curve: ImmersiveMapZoomCurve, axes: DebugOverlayZoomCurveAxes, cameraZoom: number): number {
  return zoomCurveValue(curve, cameraZoom, axes.interpolation);
}

/** The Air group's two airs as the panel holds them: the plain's, and the mountains' or `null` for one air everywhere. */
export interface DebugOverlayAirs {
  readonly plain: GroundFogSettings;
  readonly mountain: GroundFogSettings | null;
  /** Whether the group's controls show and edit the mountains' air: only while it is on and chosen. */
  readonly editsMountainAir: boolean;
}

/** Where an edit of the Air group goes: the settings to send and which modifier of the override takes them. */
export interface DebugOverlayAirEdit {
  readonly airs: DebugOverlayAirs;
  /** `"plain"` for `SceneSettings.groundFog`, `"mountain"` for `SceneSettings.mountainGroundFog`. */
  readonly target: "plain" | "mountain";
  readonly settings: GroundFogSettings | null;
}

/**
 * The Air tab's graph axes, titles and edits (the Swift
 * `DebugOverlayGroundFogSettingsPlanner`, and the air switching the Swift
 * panel view does). The panel edits `GroundFogSettings` live.
 *
 * Every value of the fog but the colour is a curve over the zoom, edited on
 * a graph of its own (`DebugOverlayZoomCurveGraph`): the zoom across, the
 * value up. A title carries the value at the camera's zoom, which the graph
 * marks with a line. The lengths and the density are drawn in decades and
 * run geometrically between their stops, as the fog reads them, so 50 m and
 * 20 km are both on one axis.
 *
 * The group edits one of two airs: the plain's, or the mountains' once it
 * is on (`SceneSettings.mountainGroundFog`) and chosen on the
 * `airChoiceTitles` segments.
 */
export const DebugOverlayGroundFogSettingsPlanner = {
  /** The zooms every graph spans: the whole range a camera reaches, so a value the same at every zoom (one stop at zoom 0) is on it too. */
  zoomRange,
  /** Per kilometre at the ground: a veil at the bottom, a wall at the top. */
  densityAxes,
  /** Metres: a layer at the feet of the buildings to a haze that fills the view of a camera pulled back to the plane's lowest zoom. */
  heightAxes,
  /** Metres from the eye, from the street to the plane's lowest zoom. */
  startDistanceAxes,
  /** Metres past the start. */
  startSoftnessAxes,
  maximumOpacityAxes,
  /** The altitude the density is stated at, metres: sea level to the high valleys. */
  baseAltitudeRange: closedRange(0, 5000),
  /** The base altitude slider's step, in metres. */
  baseAltitudeStep: 50,
  /** The zooms the overview's stops of the shipping curves sit at, the relief's zooms and below. */
  overviewStopZooms,
  /** The segments that choose which air the group edits. */
  airChoiceTitles: Object.freeze(["Plain air", "Mountain air"]) as readonly string[],
  groupTitle: "Air",
  enabledTitle: "Enabled",
  mountainAirTitle: "Mountain air by terrain",
  veilsBuildingsTitle: "Veil buildings",
  takesSkyColorTitle: "Sky colour above the line",
  heightsFromSeaLevelTitle: "Heights from sea level",
  colorTitle: "Colour",
  resetTitle: "Reset to the app's values",
  mountainPresetTitle: "Mountain air preset",

  /** The axes of a curve field's graph. */
  axes(field: GroundFogCurveField): DebugOverlayZoomCurveAxes {
    switch (field) {
      case "densityPerKilometer":
        return densityAxes;
      case "heightMeters":
        return heightAxes;
      case "startDistanceMeters":
        return startDistanceAxes;
      case "startSoftnessMeters":
        return startSoftnessAxes;
      case "maximumOpacity":
        return maximumOpacityAxes;
    }
  },

  /** A curve field's graph value text: the density per kilometre, the opacity to two places, the lengths in metres. */
  valueText(field: GroundFogCurveField): (value: number) => string {
    switch (field) {
      case "densityPerKilometer":
        return DebugOverlayGroundFogSettingsPlanner.densityText;
      case "maximumOpacity":
        return (value: number) => formatFixed(value, 2);
      default:
        return DebugOverlayGroundFogSettingsPlanner.metersText;
    }
  },

  /** A curve field's title at the camera's zoom. */
  title(field: GroundFogCurveField, curve: ImmersiveMapZoomCurve, cameraZoom: number): string {
    const planner = DebugOverlayGroundFogSettingsPlanner;
    switch (field) {
      case "densityPerKilometer":
        return planner.densityTitle(curve, cameraZoom);
      case "heightMeters":
        return planner.heightTitle(curve, cameraZoom);
      case "startDistanceMeters":
        return planner.startDistanceTitle(curve, cameraZoom);
      case "startSoftnessMeters":
        return planner.startSoftnessTitle(curve, cameraZoom);
      case "maximumOpacity":
        return planner.maximumOpacityTitle(curve, cameraZoom);
    }
  },

  densityTitle(density: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return `Density ${DebugOverlayGroundFogSettingsPlanner.densityText(valueAt(density, densityAxes, cameraZoom))}`;
  },

  heightTitle(height: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return `Height ${DebugOverlayGroundFogSettingsPlanner.metersText(valueAt(height, heightAxes, cameraZoom))}`;
  },

  startDistanceTitle(distance: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return `From ${DebugOverlayGroundFogSettingsPlanner.metersText(valueAt(distance, startDistanceAxes, cameraZoom))}`;
  },

  startSoftnessTitle(softness: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return `Soft start ${DebugOverlayGroundFogSettingsPlanner.metersText(valueAt(softness, startSoftnessAxes, cameraZoom))}`;
  },

  maximumOpacityTitle(opacity: ImmersiveMapZoomCurve, cameraZoom: number): string {
    return `Max opacity ${formatFixed(valueAt(opacity, maximumOpacityAxes, cameraZoom), 2)}`;
  },

  baseAltitudeTitle(meters: number): string {
    return `Full density up to ${DebugOverlayGroundFogSettingsPlanner.metersText(meters)}`;
  },

  /** A length as it reads best (`DebugOverlayValueText.meters`). */
  metersText(meters: number): string {
    return DebugOverlayValueText.meters(meters);
  },

  /** A density per kilometre to a hundredth, in its shortest form. */
  densityText(density: number): string {
    return `${formatG(swiftRounded(density * 100) / 100)}/km`;
  },

  /**
   * A starting point for the air over mountains, to drag from: the
   * settings' own (`mountainAir`), the default air over the mountains made
   * of the plain's.
   */
  mountainAirPreset(fog: GroundFogSettings): GroundFogSettings {
    return mountainAir(fog);
  },

  replacingOverviewStops(curve: ImmersiveMapZoomCurve, value: number): ImmersiveMapZoomCurve {
    return replacingOverviewStops(curve, value);
  },

  // The two airs.

  /** The air the group shows and edits: the mountains' while it is on and chosen, else the plain's. */
  editedAir(airs: DebugOverlayAirs): GroundFogSettings {
    return airs.editsMountainAir ? (airs.mountain ?? airs.plain) : airs.plain;
  },

  /** The airs with the edited one replaced, and where the edit goes: the mountains' air while it is on and chosen, else the plain's. */
  publishing(airs: DebugOverlayAirs, settings: GroundFogSettings): DebugOverlayAirEdit {
    if (airs.editsMountainAir && airs.mountain !== null) {
      return { airs: { ...airs, mountain: settings }, target: "mountain", settings };
    }
    return { airs: { ...airs, plain: settings }, target: "plain", settings };
  },

  /**
   * The airs as the map runs with them, after a change from anywhere. The
   * mountains' air switched off while it was being edited turns the group
   * back to the plain's.
   */
  applying(airs: DebugOverlayAirs, plain: GroundFogSettings, mountain: GroundFogSettings | null): DebugOverlayAirs {
    return { plain, mountain, editsMountainAir: mountain === null ? false : airs.editsMountainAir };
  },

  /**
   * The "Mountain air by terrain" switch. On, the mountains' air starts as
   * the preset from the plain's and the group turns to editing it. Off,
   * there is one air again. Either way the mountains' air goes out.
   */
  mountainSwitched(airs: DebugOverlayAirs, isOn: boolean): DebugOverlayAirEdit {
    const mountain = isOn ? mountainAir(airs.plain) : null;
    return { airs: { plain: airs.plain, mountain, editsMountainAir: isOn }, target: "mountain", settings: mountain };
  },

  /** The air segments: the mountains' chosen only while it is on. */
  airChosen(airs: DebugOverlayAirs, segment: number): DebugOverlayAirs {
    return { ...airs, editsMountainAir: segment === 1 && airs.mountain !== null };
  },

  /** The segment the air choice shows. */
  airChoiceIndex(airs: DebugOverlayAirs): number {
    return airs.editsMountainAir && airs.mountain !== null ? 1 : 0;
  },

  /** Whether the air segments can be used: only with the mountains' air on. */
  airChoiceEnabled(airs: DebugOverlayAirs): boolean {
    return airs.mountain !== null;
  },

  /** The "Mountain air preset" button: the preset made of the air being edited, to publish to it. */
  presetApplied(airs: DebugOverlayAirs): DebugOverlayAirEdit {
    const planner = DebugOverlayGroundFogSettingsPlanner;
    return planner.publishing(airs, mountainAir(planner.editedAir(airs)));
  },

  // The edits of the controls, each on the air being edited.

  /** Every control below the switch means something only with the air on. */
  controlsEnabled(fog: GroundFogSettings): boolean {
    return fog.isEnabled;
  },

  /** The base altitude slider only means something with the air on and its heights from the sea. */
  baseAltitudeEnabled(fog: GroundFogSettings): boolean {
    return fog.isEnabled && fog.heightsFromSeaLevel;
  },

  /** The colour the colour input shows: the air's own, or the horizon's while it takes it. */
  displayedColor(fog: GroundFogSettings, horizonColor: Rgb): Rgb {
    return fog.color ?? horizonColor;
  },

  withEnabled(fog: GroundFogSettings, isEnabled: boolean): GroundFogSettings {
    return { ...fog, isEnabled };
  },

  withVeilsBuildings(fog: GroundFogSettings, veilsBuildings: boolean): GroundFogSettings {
    return { ...fog, veilsBuildings };
  },

  withTakesSkyColor(fog: GroundFogSettings, takesSkyColor: boolean): GroundFogSettings {
    return { ...fog, takesSkyColor };
  },

  withHeightsFromSeaLevel(fog: GroundFogSettings, heightsFromSeaLevel: boolean): GroundFogSettings {
    return { ...fog, heightsFromSeaLevel };
  },

  /** The base altitude slider, to the step of 50 m. */
  withBaseAltitude(fog: GroundFogSettings, sliderValue: number): GroundFogSettings {
    const step = DebugOverlayGroundFogSettingsPlanner.baseAltitudeStep;
    return { ...fog, baseAltitudeMeters: swiftRounded(sliderValue / step) * step };
  },

  withColor(fog: GroundFogSettings, color: Rgb): GroundFogSettings {
    return { ...fog, color };
  },

  withCurve(fog: GroundFogSettings, field: GroundFogCurveField, curve: ImmersiveMapZoomCurve): GroundFogSettings {
    return { ...fog, [field]: curve };
  },
} as const;
