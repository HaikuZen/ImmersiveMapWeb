// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgb, Vector3 } from "../../configuration/color.ts";
import type { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import type { GroundFogSettings, SceneSettings } from "../../configuration/scene-settings.ts";
import type { TerrainSurroundingsSettings } from "../../configuration/tile-settings.ts";
import { zoomCurveConstantValue, zoomCurveStops } from "../../configuration/zoom-curve.ts";
import type { ImmersiveMapZoomCurve } from "../../configuration/zoom-curve.ts";
import type { ImmersiveMapLabelOpacity } from "../../style/theme.ts";

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function vector(value: Rgb | Vector3): string {
  const number = DebugOverlaySettingsExport.number;
  return `[${number(value[0])}, ${number(value[1])}, ${number(value[2])}]`;
}

function options(entries: readonly string[]): string {
  return `{ ${entries.join(", ")} }`;
}

/**
 * What the debug panel's Export tab writes (the Swift
 * `DebugOverlaySettingsExport`): the values the panel tunes, as the
 * `ImmersiveMapSettings` modifiers that set them, so a look found by hand is
 * pasted into an app as it is. The sky, the ground fog with its zoom curves
 * and the air over the mountains, the light and the shadows, the globe's
 * atmosphere and sun, and how the country around the camera is read as
 * mountains or a plain.
 *
 * And the labels' opacity curves where the panel has dragged them: a
 * style's values, not a setting's, so they are written into the style's
 * theme with `edit`.
 *
 * Only those. The rest of the settings holds the tile archive's address and
 * request headers, where an access token lives, and a file made to be passed
 * around must not carry one.
 */
export const DebugOverlaySettingsExport = {
  /**
   * The file's text: a header naming when and where it was taken (the
   * camera's lines as comments), the import, then the settings built from
   * the default by the modifiers, one a line.
   */
  typeScriptCode(
    settings: ImmersiveMapSettings,
    date: Date,
    cameraLines: readonly string[],
    labelOpacity?: ImmersiveMapLabelOpacity,
  ): string {
    const imports = labelOpacity === undefined
      ? "ImmersiveMapSettings"
      : "ImmersiveMapSettings, zoomCurve";
    const lines = [
      "// ImmersiveMap settings exported from the debug panel",
      `// ${DebugOverlaySettingsExport.isoDate(date)}`,
      ...cameraLines.map((line) => `// ${line}`),
      "",
      `import { ${imports} } from "@immersive-map/web";`,
      "",
      "export const settings = ImmersiveMapSettings.default",
      ...DebugOverlaySettingsExport.modifiers(settings.scene, settings.tiles.groundRelief.surroundings).map((line) => `  ${line}`),
    ];
    if (labelOpacity !== undefined) {
      lines.push(`  ${DebugOverlaySettingsExport.labelOpacityModifier(labelOpacity)}`);
    }
    lines[lines.length - 1] += ";";
    return `${lines.join("\n")}\n`;
  },

  /**
   * The labels' opacity curves written into the style's theme with the
   * settings' `edit`: the style's modifiers are not public on the web, and
   * `edit` with the public `zoomCurve` keeps the rest of the style as it is.
   */
  labelOpacityModifier(opacity: ImmersiveMapLabelOpacity): string {
    const curve = DebugOverlaySettingsExport.curve;
    return (
      ".edit((s) => void (s.mapStyle.theme.labelOpacity = " +
      `{ names: zoomCurve(${curve(opacity.names)}), pois: zoomCurve(${curve(opacity.pois)}) }))`
    );
  },

  /** The file's name, sortable by when it was taken, in local time: "ImmersiveMapSettings-2026-11-22-090507.ts". */
  fileName(date: Date): string {
    const day = `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
    const time = `${twoDigits(date.getHours())}${twoDigits(date.getMinutes())}${twoDigits(date.getSeconds())}`;
    return `ImmersiveMapSettings-${day}-${time}.ts`;
  },

  /** The moment in ISO 8601 to the second, in UTC, as the Swift header writes it. */
  isoDate(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  },

  /** The modifiers, one a line. */
  modifiers(scene: SceneSettings, surroundings: TerrainSurroundingsSettings): string[] {
    const { number, curve } = DebugOverlaySettingsExport;
    const fog = scene.fog;
    const shadows = scene.shadows;
    const atmosphere = scene.atmosphere;
    const globeLight = scene.globeLight;
    const groundFog = (fogSettings: GroundFogSettings) => options(DebugOverlaySettingsExport.groundFogArguments(fogSettings));
    return [
      `.fogSettings(${options([`isEnabled: ${fog.isEnabled}`, `skyColor: ${vector(fog.skyColor)}`, `horizonColor: ${vector(fog.horizonColor)}`])})`,
      `.groundFog(${groundFog(scene.groundFog)})`,
      `.mountainGroundFog(${scene.mountainGroundFog === null ? "null" : groundFog(scene.mountainGroundFog)})`,
      `.sceneLight(${options([`direction: ${vector(scene.light.direction)}`])})`,
      `.shadows(${options([
        `isEnabled: ${shadows.isEnabled}`,
        `strength: ${curve(shadows.strength)}`,
        `mapResolution: ${shadows.mapResolution}`,
        `nearCoverageMeters: ${curve(shadows.nearCoverageMeters)}`,
        `farCoverageMeters: ${curve(shadows.farCoverageMeters)}`,
        `maxCasterHeightMeters: ${number(shadows.maxCasterHeightMeters)}`,
        `normalOffsetTexels: ${number(shadows.normalOffsetTexels)}`,
        `softness: ${number(shadows.softness)}`,
        `tint: ${vector(shadows.tint)}`,
      ])})`,
      `.atmosphereSettings(${options([
        `isEnabled: ${atmosphere.isEnabled}`,
        `color: ${vector(atmosphere.color)}`,
        `intensity: ${number(atmosphere.intensity)}`,
        `thickness: ${curve(atmosphere.thickness)}`,
        `sunInfluence: ${number(atmosphere.sunInfluence)}`,
      ])})`,
      `.globeLight(${options([
        `isEnabled: ${globeLight.isEnabled}`,
        `subsolarLatitudeDegrees: ${number(globeLight.subsolarLatitudeDegrees)}`,
        `subsolarLongitudeDegrees: ${number(globeLight.subsolarLongitudeDegrees)}`,
        `strength: ${curve(globeLight.strength)}`,
        `terminatorSoftness: ${number(globeLight.terminatorSoftness)}`,
        `nightColor: ${vector(globeLight.nightColor)}`,
      ])})`,
      `.terrainSurroundings(${options([
        `sampleRadiusMetres: ${number(surroundings.sampleRadiusMetres)}`,
        `plainBelowMetres: ${number(surroundings.plainBelowMetres)}`,
        `mountainsAboveMetres: ${number(surroundings.mountainsAboveMetres)}`,
        `smoothingHalfLife: ${number(surroundings.smoothingHalfLife)}`,
      ])})`,
    ];
  },

  /**
   * An air's values as the options of `groundFog(...)` and
   * `mountainGroundFog(...)`, which take the same. The colour is written
   * even when it follows the horizon (`null`), since an omitted option keeps
   * whatever the settings it is applied to have.
   */
  groundFogArguments(fog: GroundFogSettings): string[] {
    const { number, curve } = DebugOverlaySettingsExport;
    return [
      `isEnabled: ${fog.isEnabled}`,
      `densityPerKilometer: ${curve(fog.densityPerKilometer)}`,
      `heightMeters: ${curve(fog.heightMeters)}`,
      `startDistanceMeters: ${curve(fog.startDistanceMeters)}`,
      `startSoftnessMeters: ${curve(fog.startSoftnessMeters)}`,
      `color: ${fog.color === null ? "null" : vector(fog.color)}`,
      `maximumOpacity: ${curve(fog.maximumOpacity)}`,
      `veilsBuildings: ${fog.veilsBuildings}`,
      `takesSkyColor: ${fog.takesSkyColor}`,
      `heightsFromSeaLevel: ${fog.heightsFromSeaLevel}`,
      `baseAltitudeMeters: ${number(fog.baseAltitudeMeters)}`,
    ];
  },

  /** A curve as the literal that writes it: one value, or its stops by zoom. */
  curve(curveValue: ImmersiveMapZoomCurve): string {
    const number = DebugOverlaySettingsExport.number;
    const constant = zoomCurveConstantValue(curveValue);
    if (constant !== null) return number(constant);
    const stops = zoomCurveStops(curveValue).map((stop) => `${number(stop.zoom)}: ${number(stop.value)}`);
    return `{ ${stops.join(", ")} }`;
  },

  /** A value with as many decimals as it has, up to four: a hand-tuned 0.3 reads 0.3, not 0.30000000000000004. */
  number(value: number): string {
    if (!Number.isFinite(value)) return String(value);
    let text = value.toFixed(4);
    while (text.endsWith("0")) text = text.slice(0, -1);
    if (text.endsWith(".")) text = text.slice(0, -1);
    return text === "-0" ? "0" : text;
  },
} as const;
