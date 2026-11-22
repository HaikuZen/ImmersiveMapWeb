// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { DebugSettings } from "../../configuration/view-settings.ts";
import { type LabelDistanceRule, LabelDistanceRules } from "../../labels/base/label-distance-rules.ts";
import type { ImmersiveMapLabelOpacity, ImmersiveMapTerrainOcclusion } from "../../style/theme.ts";
import type { GroundReliefHillshadeAmounts, GroundReliefHillshadeFade } from "../../tile/relief/frame/ground-relief-hillshade.ts";
import { RingRuleSets } from "../../tile/visibility/ring-rule-sets.ts";
import { DebugTileGridDensity } from "./debug-tile-grid-density.ts";

/** The debug panel's overlay toggles and dragged rules as a frame reads them (the Swift `DebugOverlayControlSnapshot`). */
export interface DebugOverlayControlSnapshot {
  readonly axesEnabled: boolean;
  readonly tileLayersEnabled: boolean;
  readonly wireframeEnabled: boolean;
  readonly roadLabelTilesEnabled: boolean;
  readonly baseLabelBoundsEnabled: boolean;
  readonly roadLabelBoundsEnabled: boolean;
  readonly tileGridEnabled: boolean;
  /** One of `DebugTileGridDensity.options`. */
  readonly tileGridDensity: number;
  /** The ring rules by target zoom (`RingRuleSets`), normalized. */
  readonly ringRuleSets: RingRuleSets;
  /** The labels' reach by camera zoom (`LabelDistanceRules`), normalized. */
  readonly labelDistanceRules: readonly LabelDistanceRule[];
  /**
   * The local detail's distance the panel has been dragged to, in metres.
   * Undefined keeps the setting's (`localDetailMaximumDistanceMeters`).
   */
  readonly localLabelMaximumDistanceMeters: number | undefined;
  /** The labels' shrink floor the panel has been dragged to. Undefined keeps the setting's (`perspectiveMinimumScale`). */
  readonly labelPerspectiveMinimumScale: number | undefined;
}

/**
 * What the debug panel has switched on and dragged (the Swift
 * `DebugOverlayControlState`). Written by the panel, read by the frame.
 * Everything runs on the main thread, so it holds plain fields. The
 * snapshot is cached until a setter changes something, so a frame that
 * reads it every time allocates nothing.
 */
export class DebugOverlayControlState {
  #axesEnabled = false;
  #tileLayersEnabled = false;
  #wireframeEnabled = false;
  #roadLabelTilesEnabled = false;
  #baseLabelBoundsEnabled = false;
  #roadLabelBoundsEnabled = false;
  #tileGridEnabled = false;
  #tileGridDensity: number = DebugTileGridDensity.standard;
  #ringRuleSets: RingRuleSets = RingRuleSets.default;
  #labelDistanceRules: readonly LabelDistanceRule[] = LabelDistanceRules.default;
  #localLabelMaximumDistanceMeters: number | undefined;
  #labelPerspectiveMinimumScale: number | undefined;
  #hillshadeFade: GroundReliefHillshadeFade | undefined;
  #hillshadeAmounts: GroundReliefHillshadeAmounts | undefined;
  #labelOpacity: ImmersiveMapLabelOpacity | undefined;
  #reliefCastsShadows: boolean | undefined;
  #terrainOcclusion: ImmersiveMapTerrainOcclusion | undefined;
  #terrainOcclusionDebugView = false;
  #snapshot: DebugOverlayControlSnapshot | undefined;

  /** The controls as a frame reads them. */
  snapshot(): DebugOverlayControlSnapshot {
    this.#snapshot ??= Object.freeze({
      axesEnabled: this.#axesEnabled,
      tileLayersEnabled: this.#tileLayersEnabled,
      wireframeEnabled: this.#wireframeEnabled,
      roadLabelTilesEnabled: this.#roadLabelTilesEnabled,
      baseLabelBoundsEnabled: this.#baseLabelBoundsEnabled,
      roadLabelBoundsEnabled: this.#roadLabelBoundsEnabled,
      tileGridEnabled: this.#tileGridEnabled,
      tileGridDensity: this.#tileGridDensity,
      ringRuleSets: this.#ringRuleSets,
      labelDistanceRules: this.#labelDistanceRules,
      localLabelMaximumDistanceMeters: this.#localLabelMaximumDistanceMeters,
      labelPerspectiveMinimumScale: this.#labelPerspectiveMinimumScale,
    });
    return this.#snapshot;
  }

  /** The local detail's distance in metres, undefined for the setting's. */
  localLabelMaximumDistance(): number | undefined {
    return this.#localLabelMaximumDistanceMeters;
  }

  /** The labels' shrink floor, undefined for the setting's. */
  labelPerspectiveMinimum(): number | undefined {
    return this.#labelPerspectiveMinimumScale;
  }

  /** The labels' reach at a camera zoom, from the rule the zoom falls in (`LabelDistanceRules`). */
  labelDistanceScale(cameraZoom: number): number {
    return LabelDistanceRules.scale(this.#labelDistanceRules, cameraZoom);
  }

  /** The hillshade's fade the panel has been dragged to, metres from the eye by the zoom, undefined for the style's. */
  hillshadeFade(): GroundReliefHillshadeFade | undefined {
    return this.#hillshadeFade;
  }

  setHillshadeFade(fade: GroundReliefHillshadeFade | undefined): void {
    this.#hillshadeFade = fade;
  }

  /** The hillshade's amounts the panel has been dragged to, undefined for the style's. */
  hillshadeAmounts(): GroundReliefHillshadeAmounts | undefined {
    return this.#hillshadeAmounts;
  }

  setHillshadeAmounts(amounts: GroundReliefHillshadeAmounts | undefined): void {
    this.#hillshadeAmounts = amounts;
  }

  /** The occlusion of the sky the panel has been dragged to, undefined for the style's (`ImmersiveMapTerrainOcclusion`). */
  terrainOcclusion(): ImmersiveMapTerrainOcclusion | undefined {
    return this.#terrainOcclusion;
  }

  setTerrainOcclusion(occlusion: ImmersiveMapTerrainOcclusion | undefined): void {
    this.#terrainOcclusion = occlusion;
  }

  /** Whether the frame draws the occlusion of the sky alone, in grey, the panel's view of it. */
  terrainOcclusionDebugView(): boolean {
    return this.#terrainOcclusionDebugView;
  }

  setTerrainOcclusionDebugView(isEnabled: boolean): void {
    this.#terrainOcclusionDebugView = isEnabled;
  }

  /** Whether the mountains cast their shadows as the panel set it, undefined for the setting's. */
  reliefCastsShadows(): boolean | undefined {
    return this.#reliefCastsShadows;
  }

  setReliefCastsShadows(isEnabled: boolean | undefined): void {
    this.#reliefCastsShadows = isEnabled;
  }

  /** The names' and the POIs' opacity curves the panel has been dragged to, undefined for the style's. */
  labelOpacity(): ImmersiveMapLabelOpacity | undefined {
    return this.#labelOpacity;
  }

  setLabelOpacity(opacity: ImmersiveMapLabelOpacity | undefined): void {
    this.#labelOpacity = opacity;
  }

  /** Held to 0...1. */
  setLabelPerspectiveMinimumScale(scale: number | undefined): void {
    this.#labelPerspectiveMinimumScale = scale === undefined ? undefined : Math.min(Math.max(scale, 0), 1);
    this.#snapshot = undefined;
  }

  /** Held to zero or more. */
  setLocalLabelMaximumDistanceMeters(meters: number | undefined): void {
    this.#localLabelMaximumDistanceMeters = meters === undefined ? undefined : Math.max(0, meters);
    this.#snapshot = undefined;
  }

  setAxesEnabled(isEnabled: boolean): void {
    this.#axesEnabled = isEnabled;
    this.#snapshot = undefined;
  }

  setTileLayersEnabled(isEnabled: boolean): void {
    this.#tileLayersEnabled = isEnabled;
    this.#snapshot = undefined;
  }

  setWireframeEnabled(isEnabled: boolean): void {
    this.#wireframeEnabled = isEnabled;
    this.#snapshot = undefined;
  }

  setRoadLabelTilesEnabled(isEnabled: boolean): void {
    this.#roadLabelTilesEnabled = isEnabled;
    this.#snapshot = undefined;
  }

  setBaseLabelBoundsEnabled(isEnabled: boolean): void {
    this.#baseLabelBoundsEnabled = isEnabled;
    this.#snapshot = undefined;
  }

  setRoadLabelBoundsEnabled(isEnabled: boolean): void {
    this.#roadLabelBoundsEnabled = isEnabled;
    this.#snapshot = undefined;
  }

  setTileGridEnabled(isEnabled: boolean): void {
    this.#tileGridEnabled = isEnabled;
    this.#snapshot = undefined;
  }

  /** Clamped to the nearest offered density (`DebugTileGridDensity.clamp`). */
  setTileGridDensity(density: number): void {
    this.#tileGridDensity = DebugTileGridDensity.clamp(density);
    this.#snapshot = undefined;
  }

  setRingRuleSets(sets: RingRuleSets): void {
    this.#ringRuleSets = RingRuleSets.normalized(sets);
    this.#snapshot = undefined;
  }

  setLabelDistanceRules(rules: readonly LabelDistanceRule[]): void {
    this.#labelDistanceRules = LabelDistanceRules.normalized(rules);
    this.#snapshot = undefined;
  }
}

/**
 * Whether the frame encodes the debug overlay pass (the Swift
 * `RenderDebugOverlayPolicy`): the panel on and at least one of the
 * overlays it draws switched on. The web has no debug build, so the panel
 * being on is the whole gate.
 */
export const RenderDebugOverlayPolicy = {
  shouldEncode(settings: Pick<DebugSettings, "enableDebugPanel">, controls: DebugOverlayControlSnapshot): boolean {
    if (!settings.enableDebugPanel) return false;
    return (
      controls.axesEnabled ||
      controls.tileLayersEnabled ||
      controls.tileGridEnabled ||
      controls.roadLabelTilesEnabled ||
      controls.baseLabelBoundsEnabled ||
      controls.roadLabelBoundsEnabled
    );
  },
} as const;
