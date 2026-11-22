// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgb } from "../../configuration/color.ts";
import type { ImmersiveMapSettings } from "../../configuration/immersive-map-settings.ts";
import type { GroundFogSettings } from "../../configuration/scene-settings.ts";
import type { ImmersiveMapZoomCurve } from "../../configuration/zoom-curve.ts";
import type { LabelDistanceRule } from "../../labels/base/label-distance-rules.ts";
import { DebugOverlayHUDContentRequest } from "../../render/debug/debug-overlay-hud-snapshot-store.ts";
import type { DebugOverlayControlState } from "../../render/debug/debug-overlay-control-state.ts";
import type { TraceRecorderSnapshot } from "../../render/debug/json-lines-trace.ts";
import type { TileLoadingStatusTileSnapshot } from "../../render/debug/tile-loading-status-reporter.ts";
import { GroundReliefHillshade } from "../../tile/relief/frame/ground-relief-hillshade.ts";
import type { FlatRingRule } from "../../tile/visibility/flat-ring-rules.ts";
import type { DebugOverlayHUDSnapshot } from "../overlay/debug-overlay-hud-snapshot.ts";
import { DebugOverlayAtmosphereSettingsPlanner, DebugOverlaySkySettingsPlanner } from "../panel/debug-overlay-atmosphere-settings-planner.ts";
import { DebugOverlayGlobeLightSettingsPlanner } from "../panel/debug-overlay-globe-light-settings-planner.ts";
import { type DebugOverlayAirs, DebugOverlayGroundFogSettingsPlanner } from "../panel/debug-overlay-ground-fog-settings-planner.ts";
import { DebugOverlayHUDTextComposer, DebugOverlayTileCard } from "../panel/debug-overlay-hud-content.ts";
import { DebugOverlayLabelOpacitySettingsPlanner } from "../panel/debug-overlay-label-opacity-settings-planner.ts";
import { DebugOverlayModelArchiveSettingsPlanner } from "../panel/debug-overlay-model-archive-settings-planner.ts";
import { DebugOverlayOcclusionPlanner } from "../panel/debug-overlay-occlusion-planner.ts";
import { DebugOverlayPanelCategory } from "../panel/debug-overlay-panel-category.ts";
import { DebugOverlayLabelSettingsPlanner, DebugOverlayRingRuleEditing, type DebugOverlayRingRuleField } from "../panel/debug-overlay-rule-editing.ts";
import type { DebugOverlaySettingsOverride } from "../panel/debug-overlay-settings-override.ts";
import { DebugOverlayShadowSettingsPlanner } from "../panel/debug-overlay-shadow-settings-planner.ts";
import { DebugOverlaySunAngles } from "../panel/debug-overlay-sun-angles.ts";
import { DebugOverlayTerrainSurroundingsSettingsPlanner } from "../panel/debug-overlay-terrain-surroundings-settings-planner.ts";
import { debugHudButton, debugHudClass, debugHudColor, debugHudGroup, debugHudHint, debugHudSegments, debugHudSlider, debugHudSwitch, debugHudText } from "./debug-hud-controls.ts";
import { drawDebugReliefCoverage, drawDebugTileCoverage } from "./debug-hud-coverage.ts";
import { DebugZoomCurveView } from "./debug-zoom-curve-view.ts";

/** What the panel's view asks of its runtime. */
export interface DebugHudContext {
  readonly controls: DebugOverlayControlState;
  requestFrame(): void;
  switchRenderMode(): void;
  /** The dragged groups, put over the settings and applied. */
  publish(patch: DebugOverlaySettingsOverride): void;
  /** The Air group's reset: the app's own airs back. */
  resetGroundFog(): void;
  toggleTileTrace(): void;
  toggleLabelTrace(): void;
  exportSettings(): void;
  /** The tab shown changed what the frame builds. */
  contentChanged(content: DebugOverlayHUDContentRequest): void;
}

type HudSnapshot = DebugOverlayHUDSnapshot<TileLoadingStatusTileSnapshot>;

/** A group of the panel, shown on the tabs of its category. */
interface HudGroup {
  readonly category: DebugOverlayPanelCategory;
  readonly element: HTMLElement;
}

/**
 * The debug panel's view, the Swift `DebugOverlayHUDViewMac` in plain DOM:
 * a rail along the map's leading edge with its tabs (`DebugOverlayPanelCategory`),
 * each tab the groups of its category, every control wired to the planners
 * of `../panel` and to the engine's controls. `apply(settings)` shows the
 * values the map runs with, and `apply(snapshot)` the frame's.
 */
export class DebugHudView {
  readonly element: HTMLDivElement;
  private readonly groups: HudGroup[] = [];
  private readonly refreshers: (() => void)[] = [];
  private readonly zoomListeners: ((zoom: number) => void)[] = [];
  private readonly tabButtons = new Map<DebugOverlayPanelCategory, HTMLButtonElement>();
  private selected: DebugOverlayPanelCategory = "stats";
  private settings: ImmersiveMapSettings | undefined;
  private snapshot: HudSnapshot | undefined;
  private airs: DebugOverlayAirs | undefined;
  private selectedLabelRule = 0;
  private selectedRingSet = 0;
  private cameraZoom = 0;
  private tileTrace: TraceRecorderSnapshot = { isRecording: false, fileName: undefined };
  private labelTrace: TraceRecorderSnapshot = { isRecording: false, fileName: undefined };
  private exportStatus = "";
  private readonly scroll: HTMLDivElement;
  private readonly snapshotViews: ((snapshot: HudSnapshot | undefined) => void)[] = [];

  constructor(private readonly context: DebugHudContext) {
    const root = document.createElement("div");
    root.className = debugHudClass.root;
    root.hidden = true;
    // The panel takes its own pointer and wheel: the map under it does not pan.
    for (const type of ["pointerdown", "wheel", "dblclick", "contextmenu"]) root.addEventListener(type, (event) => event.stopPropagation());
    this.element = root;

    const header = document.createElement("div");
    header.className = "imm-debug-header";
    header.textContent = "Debug";
    const collapse = debugHudButton("Hide", () => {
      const collapsed = root.dataset["collapsed"] !== "true";
      root.dataset["collapsed"] = String(collapsed);
      collapse.setTitle(collapsed ? "Show" : "Hide");
      tabs.hidden = collapsed;
      this.scroll.hidden = collapsed;
    });
    header.append(collapse.element);

    const tabs = document.createElement("div");
    tabs.className = "imm-debug-tabs";
    for (const category of DebugOverlayPanelCategory.allCases) {
      const button = debugHudButton(DebugOverlayPanelCategory.title(category), () => this.select(category)).element;
      this.tabButtons.set(category, button);
      tabs.append(button);
    }
    this.scroll = document.createElement("div");
    this.scroll.className = "imm-debug-scroll";
    root.append(header, tabs, this.scroll);

    this.buildStats();
    this.buildLabels();
    this.buildLight();
    this.buildShadows();
    this.buildOcclusion();
    this.buildSky();
    this.buildGlobe();
    this.buildAir();
    this.buildMap();
    this.buildModels();
    this.buildTiles();
    this.buildRelief();
    this.buildExport();
    this.select(this.selected);
  }

  /** What the shown tab needs of a frame. */
  get shownContent(): DebugOverlayHUDContentRequest {
    return DebugOverlayPanelCategory.shownContent(this.selected);
  }

  setShown(isShown: boolean): void {
    this.element.hidden = !isShown;
  }

  /** The settings the map runs with, and the controls' state over them. */
  applySettings(settings: ImmersiveMapSettings): void {
    this.settings = settings;
    const plain = settings.scene.groundFog;
    const mountain = settings.scene.mountainGroundFog;
    this.airs = this.airs === undefined ? { plain, mountain, editsMountainAir: false } : DebugOverlayGroundFogSettingsPlanner.applying(this.airs, plain, mountain);
    this.refresh();
  }

  applyTraces(tile: TraceRecorderSnapshot, label: TraceRecorderSnapshot): void {
    this.tileTrace = tile;
    this.labelTrace = label;
    this.refresh();
  }

  applyExportStatus(text: string): void {
    this.exportStatus = text;
    this.refresh();
  }

  /** The frame's snapshot: the texts, the cards, the maps and the camera zoom the curves mark. */
  applySnapshot(snapshot: HudSnapshot | undefined): void {
    this.snapshot = snapshot;
    for (const view of this.snapshotViews) view(snapshot);
    const zoom = snapshot?.cameraZoom ?? this.cameraZoom;
    if (zoom !== this.cameraZoom) {
      this.cameraZoom = zoom;
      for (const listener of this.zoomListeners) listener(zoom);
      // The titles carry the curves' values at the camera's zoom.
      this.refresh();
    }
  }

  private select(category: DebugOverlayPanelCategory): void {
    const content = this.shownContent;
    this.selected = category;
    for (const [tab, button] of this.tabButtons) button.setAttribute("aria-selected", String(tab === category));
    for (const group of this.groups) group.element.hidden = !DebugOverlayPanelCategory.shows(category, group.category);
    if (this.shownContent !== content) this.context.contentChanged(this.shownContent);
  }

  private refresh(): void {
    if (this.settings === undefined) return;
    for (const refresh of this.refreshers) refresh();
  }

  private group(category: DebugOverlayPanelCategory, title: string): HTMLDivElement {
    const group = debugHudGroup(title);
    this.groups.push({ category, element: group.element });
    this.scroll.append(group.element);
    return group.body;
  }

  /** A curve graph with a title line over it, its value at the camera's zoom in the title. */
  private curve(
    body: HTMLElement,
    axes: ConstructorParameters<typeof DebugZoomCurveView>[0],
    valueText: (value: number) => string,
    title: (zoom: number) => string,
    current: () => ImmersiveMapZoomCurve | undefined,
    onChange: (curve: ImmersiveMapZoomCurve) => void,
    isEnabled: () => boolean = () => true,
  ): void {
    const heading = debugHudText();
    const view = new DebugZoomCurveView(axes, valueText, onChange);
    body.append(heading.element, view.element);
    this.zoomListeners.push((zoom) => view.setCameraZoom(zoom));
    this.refreshers.push(() => {
      const curve = current();
      if (curve === undefined) return;
      heading.set(title(this.cameraZoom));
      view.set(curve);
      view.setEnabled(isEnabled());
    });
  }

  private settingsOf(): ImmersiveMapSettings {
    return this.settings!;
  }

  // MARK: Stats

  private buildStats(): void {
    const stats = this.group("stats", "Stats");
    const coordinates = debugHudText();
    const diagnostics = debugHudText();
    stats.append(coordinates.element, diagnostics.element);
    this.snapshotViews.push((snapshot) => {
      coordinates.set(snapshot === undefined ? "" : `${snapshot.coordinateLines.zoom}\n${snapshot.coordinateLines.latLon}`);
      diagnostics.set(snapshot?.diagnosticsLines.join("\n") ?? "");
    });

    const text = DebugOverlayHUDTextComposer;
    const body = this.group("stats", text.controlsGroupTitle);
    const controls = this.context.controls;
    const toggle = (title: string, set: (isOn: boolean) => void, get: () => boolean) => {
      const control = debugHudSwitch(title, (isOn) => {
        set(isOn);
        this.context.requestFrame();
      });
      body.append(control.element);
      this.refreshers.push(() => control.set(get()));
    };
    toggle(text.axesTitle, (isOn) => controls.setAxesEnabled(isOn), () => controls.snapshot().axesEnabled);
    toggle(text.tileLayersTitle, (isOn) => controls.setTileLayersEnabled(isOn), () => controls.snapshot().tileLayersEnabled);
    toggle(text.tileGridTitle, (isOn) => controls.setTileGridEnabled(isOn), () => controls.snapshot().tileGridEnabled);
    const density = debugHudSegments(
      "Grid density",
      text.tileGridDensityTitles.map((title, index) => ({ title, value: index })),
      (index) => {
        controls.setTileGridDensity(text.tileGridDensity(index));
        this.context.requestFrame();
      },
    );
    body.append(density.element);
    this.refreshers.push(() => density.set(text.tileGridDensityIndex(controls.snapshot().tileGridDensity)));
    body.append(debugHudHint(`${text.wireframeTitle}: WebGPU has no line fill mode, so the panel has no wireframe.`));
    body.append(debugHudButton(text.surfaceModeButtonTitle, () => this.context.switchRenderMode()).element);

    const tileTrace = debugHudButton(text.traceButtonTitle(false), () => this.context.toggleTileTrace());
    const tileTraceStatus = debugHudText();
    const labelTrace = debugHudButton(text.traceButtonTitle(false), () => this.context.toggleLabelTrace());
    const labelTraceStatus = debugHudText();
    body.append(debugHudHint("Tile trace"), tileTrace.element, tileTraceStatus.element, debugHudHint("Base label trace"), labelTrace.element, labelTraceStatus.element);
    this.refreshers.push(() => {
      tileTrace.setTitle(text.traceButtonTitle(this.tileTrace.isRecording));
      tileTraceStatus.set(text.tileTraceStatusText(this.tileTrace));
      labelTrace.setTitle(text.traceButtonTitle(this.labelTrace.isRecording));
      labelTraceStatus.set(text.baseLabelTraceStatusText(this.labelTrace));
    });
  }

  // MARK: Labels

  private buildLabels(): void {
    const planner = DebugOverlayLabelSettingsPlanner;
    const controls = this.context.controls;
    const body = this.group("labels", planner.baseLabelsGroupTitle);
    const toggle = (title: string, set: (isOn: boolean) => void, get: () => boolean) => {
      const control = debugHudSwitch(title, (isOn) => {
        set(isOn);
        this.context.requestFrame();
      });
      body.append(control.element);
      this.refreshers.push(() => control.set(get()));
    };
    toggle(planner.roadLabelTilesTitle, (isOn) => controls.setRoadLabelTilesEnabled(isOn), () => controls.snapshot().roadLabelTilesEnabled);
    toggle(planner.baseLabelBoundsTitle, (isOn) => controls.setBaseLabelBoundsEnabled(isOn), () => controls.snapshot().baseLabelBoundsEnabled);
    toggle(planner.roadLabelBoundsTitle, (isOn) => controls.setRoadLabelBoundsEnabled(isOn), () => controls.snapshot().roadLabelBoundsEnabled);

    const local = debugHudSlider("", planner.localLabelDistanceRange, () => "", (value) => {
      controls.setLocalLabelMaximumDistanceMeters(planner.localLabelDistanceMeters(value));
      this.refresh();
      this.context.requestFrame();
    });
    const minimum = debugHudSlider("", planner.labelMinimumScaleRange, () => "", (value) => {
      controls.setLabelPerspectiveMinimumScale(planner.labelMinimumScale(value));
      this.refresh();
      this.context.requestFrame();
    });
    body.append(local.element, minimum.element);
    this.refreshers.push(() => {
      const base = this.settingsOf().data.labels.base;
      const meters = controls.localLabelMaximumDistance() ?? base.localDetailMaximumDistanceMeters;
      const scale = controls.labelPerspectiveMinimum() ?? base.perspectiveMinimumScale;
      local.set(meters);
      local.element.firstElementChild!.textContent = planner.localLabelDistanceTitle(meters);
      minimum.set(scale);
      minimum.element.firstElementChild!.textContent = planner.labelMinimumScaleTitle(scale);
    });

    const opacity = DebugOverlayLabelOpacitySettingsPlanner;
    const currentOpacity = () => controls.labelOpacity() ?? this.settingsOf().data.mapStyle.theme.labelOpacity;
    for (const field of ["names", "pois"] as const) {
      this.curve(
        body,
        opacity.opacityAxes,
        opacity.opacityText,
        (zoom) => (field === "names" ? opacity.namesTitle(currentOpacity().names, zoom) : opacity.poisTitle(currentOpacity().pois, zoom)),
        () => currentOpacity()[field],
        (curve) => {
          controls.setLabelOpacity(opacity.withCurve(currentOpacity(), field, curve));
          this.context.requestFrame();
        },
      );
    }

    // The labels' reach by camera zoom: a picker of the rules, the chosen one's zooms and scale.
    const rules = this.group("labels", planner.labelDistanceGroupTitle);
    const ruleList = () => controls.snapshot().labelDistanceRules;
    const setRules = (next: readonly LabelDistanceRule[] | undefined, selected?: number) => {
      if (next === undefined) return;
      controls.setLabelDistanceRules(next);
      if (selected !== undefined) this.selectedLabelRule = selected;
      this.refresh();
      this.context.requestFrame();
    };
    const picker = document.createElement("select");
    picker.addEventListener("change", () => {
      this.selectedLabelRule = Number(picker.value);
      this.refresh();
    });
    const firstZoom = debugHudSlider("", planner.labelDistanceFirstZoomRange, () => "", (value) => setRules(planner.movingRuleFirstZoom(ruleList(), this.selectedLabelRule, value)), 1);
    const scale = debugHudSlider("", { lowerBound: 0, upperBound: 1 }, () => "", (value) => setRules(planner.withRuleScale(ruleList(), this.selectedLabelRule, value)));
    const split = debugHudButton(planner.splitRuleTitle, () => {
      const edit = planner.splittingRule(ruleList(), this.selectedLabelRule);
      if (edit !== undefined) setRules(edit.rules, edit.selectedIndex);
    });
    const remove = debugHudButton(planner.removeRuleTitle, () => {
      const edit = planner.removingRule(ruleList(), this.selectedLabelRule);
      if (edit !== undefined) setRules(edit.rules, edit.selectedIndex);
    });
    rules.append(picker, firstZoom.element, scale.element, split.element, remove.element);
    this.refreshers.push(() => {
      const list = ruleList();
      this.selectedLabelRule = Math.min(this.selectedLabelRule, list.length - 1);
      fillSelect(picker, list.map((_, index) => planner.ruleTitle(list, index)), this.selectedLabelRule);
      const rule = list[this.selectedLabelRule]!;
      const limits = planner.ruleFirstZoomLimits(list, this.selectedLabelRule);
      firstZoom.element.hidden = limits === undefined;
      firstZoom.set(rule.firstZoom);
      firstZoom.element.firstElementChild!.textContent = planner.ruleFirstZoomTitle(rule.firstZoom);
      scale.set(planner.scaleSliderValue(rule.scale));
      scale.element.firstElementChild!.textContent = planner.scaleTitle(rule.scale);
      remove.element.disabled = !planner.canRemoveRule(list);
    });
  }

  // MARK: Light

  private buildLight(): void {
    const planner = DebugOverlayShadowSettingsPlanner;
    const body = this.group("light", "Light");
    const angles = () => DebugOverlaySunAngles.angles(this.settingsOf().scene.light.direction);
    const azimuth = debugHudSlider("", planner.azimuthRange, () => "", (value) => this.context.publish({ sunDirection: planner.sunDirection(value, angles().elevationDegrees) }), 1);
    const elevation = debugHudSlider("", planner.elevationRange, () => "", (value) => this.context.publish({ sunDirection: planner.sunDirection(angles().azimuthDegrees, value) }), 1);
    const view = debugHudText();
    body.append(azimuth.element, elevation.element, view.element);
    this.refreshers.push(() => {
      const sun = angles();
      azimuth.set(sun.azimuthDegrees);
      azimuth.element.firstElementChild!.textContent = planner.azimuthTitle(sun.azimuthDegrees);
      elevation.set(sun.elevationDegrees);
      elevation.element.firstElementChild!.textContent = planner.elevationTitle(sun.elevationDegrees);
      view.set(`camera looks at ${Math.round(this.snapshot?.viewAzimuthDegrees ?? 0)}°`);
    });
  }

  // MARK: Shadows and the hillshade

  private buildShadows(): void {
    const planner = DebugOverlayShadowSettingsPlanner;
    const body = this.group("shadows", "Shadows");
    const shadows = () => this.settingsOf().scene.shadows;
    const publish = (next: ReturnType<typeof shadows>) => this.context.publish({ shadows: next });
    const enabled = debugHudSwitch("Enabled", (isOn) => publish(planner.withEnabled(shadows(), isOn)));
    const resolution = debugHudSegments(
      "Map px",
      planner.mapResolutionTitles.map((title, index) => ({ title, value: index })),
      (index) => publish(planner.withMapResolutionIndex(shadows(), index)),
    );
    body.append(enabled.element, resolution.element, debugHudHint("Click to add a point, drag to move it, double-click to remove it"));
    this.curve(body, planner.strengthAxes, planner.strengthText, (zoom) => planner.strengthTitle(shadows().strength, zoom), () => shadows().strength, (curve) => publish(planner.withCurve(shadows(), "strength", curve)), () => planner.controlsEnabled(shadows()));
    this.curve(body, planner.coverageAxes, planner.metersText, (zoom) => planner.nearCoverageTitle(shadows().nearCoverageMeters, zoom), () => shadows().nearCoverageMeters, (curve) => publish(planner.withCurve(shadows(), "nearCoverageMeters", curve)), () => planner.controlsEnabled(shadows()));
    this.curve(
      body,
      planner.coverageAxes,
      planner.metersText,
      (zoom) => planner.farCoverageTitle(shadows().farCoverageMeters, shadows().nearCoverageMeters, zoom),
      () => shadows().farCoverageMeters,
      (curve) => publish(planner.withCurve(shadows(), "farCoverageMeters", curve)),
      () => planner.controlsEnabled(shadows()),
    );
    const offset = debugHudSlider("", planner.normalOffsetRange, () => "", (value) => publish(planner.withNormalOffset(shadows(), value)));
    const height = debugHudSlider("", planner.casterHeightRange, () => "", (value) => publish(planner.withCasterHeight(shadows(), value)));
    const softness = debugHudSlider("", planner.softnessRange, () => "", (value) => publish(planner.withSoftness(shadows(), value)));
    body.append(offset.element, height.element, softness.element);
    this.refreshers.push(() => {
      const value = shadows();
      enabled.set(value.isEnabled);
      resolution.set(planner.mapResolutionIndex(value.mapResolution));
      offset.set(value.normalOffsetTexels);
      offset.element.firstElementChild!.textContent = planner.normalOffsetTitle(value.normalOffsetTexels);
      height.set(value.maxCasterHeightMeters);
      height.element.firstElementChild!.textContent = planner.casterHeightTitle(value.maxCasterHeightMeters);
      softness.set(value.softness);
      softness.element.firstElementChild!.textContent = planner.softnessTitle(value.softness);
    });

    // The hillshade with the mountains' shadows, dragged over the style.
    const controls = this.context.controls;
    const hillshade = this.group("shadows", "Hillshade");
    const style = () => this.settingsOf().data.mapStyle.theme.hillshade;
    const fade = () => controls.hillshadeFade() ?? planner.hillshadeFadeOfStyle(style());
    const amounts = () => controls.hillshadeAmounts() ?? GroundReliefHillshade.amountsOfStyle(style());
    const fadeChanged = (field: "startMeters" | "endMeters", curve: ImmersiveMapZoomCurve) => {
      controls.setHillshadeFade(planner.withHillshadeFadeCurve(fade(), field, curve));
      this.context.requestFrame();
    };
    this.curve(hillshade, planner.hillshadeFadeAxes, planner.metersText, (zoom) => planner.hillshadeFadeStartTitle(fade().startMeters, zoom), () => fade().startMeters, (curve) => fadeChanged("startMeters", curve));
    this.curve(hillshade, planner.hillshadeFadeAxes, planner.metersText, (zoom) => planner.hillshadeFadeEndTitle(fade().endMeters, zoom), () => fade().endMeters, (curve) => fadeChanged("endMeters", curve));
    const amountSlider = (title: (value: number) => string, pick: (a: ReturnType<typeof amounts>) => number, make: (value: number) => ReturnType<typeof amounts>) => {
      const slider = debugHudSlider("", planner.hillshadeAmountRange, () => "", (value) => {
        controls.setHillshadeAmounts(make(value));
        this.refresh();
        this.context.requestFrame();
      });
      hillshade.append(slider.element);
      this.refreshers.push(() => {
        const value = pick(amounts());
        slider.set(value);
        slider.element.firstElementChild!.textContent = title(value);
      });
    };
    amountSlider(planner.hillshadeIntensityTitle, (a) => a.intensity, (value) => planner.hillshadeAmounts(value, amounts().shadow, amounts().highlight));
    amountSlider(planner.hillshadeShadowTitle, (a) => a.shadow, (value) => planner.hillshadeAmounts(amounts().intensity, value, amounts().highlight));
    amountSlider(planner.hillshadeHighlightTitle, (a) => a.highlight, (value) => planner.hillshadeAmounts(amounts().intensity, amounts().shadow, value));
    const mountainShadows = debugHudSwitch(planner.reliefShadowsTitle, (isOn) => {
      controls.setReliefCastsShadows(isOn);
      this.context.requestFrame();
    });
    hillshade.append(mountainShadows.element);
    this.refreshers.push(() => mountainShadows.set(controls.reliefCastsShadows() ?? this.settingsOf().tiles.groundRelief.castsShadows));
  }

  // MARK: Occlusion

  private buildOcclusion(): void {
    const planner = DebugOverlayOcclusionPlanner;
    const controls = this.context.controls;
    const body = this.group("occlusion", planner.groupTitle);
    const occlusion = () => controls.terrainOcclusion() ?? this.settingsOf().data.mapStyle.theme.terrainOcclusion;
    const enabled = debugHudSwitch(planner.enabledTitle, () => publish());
    const strength = debugHudSlider("", planner.strengthRange, () => "", () => publish());
    const radius = debugHudSlider("", planner.sliderRange, () => "", () => publish());
    const directions = debugHudSegments(planner.directionsTitle, planner.directionsOptions.map((value, index) => ({ title: String(value), value: index })), () => publish());
    const resolution = debugHudSegments(planner.resolutionTitle, planner.resolutionOptions.map((value, index) => ({ title: String(value), value: index })), () => publish());
    const debugView = debugHudSwitch(planner.debugViewTitle, (isOn) => {
      controls.setTerrainOcclusionDebugView(isOn);
      this.context.requestFrame();
    });
    body.append(enabled.element, strength.element, radius.element, directions.element, resolution.element, debugView.element);
    const inputs = () => body.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select");
    const publish = () => {
      const [enabledInput, strengthInput, radiusInput, directionsInput, resolutionInput] = [...inputs()];
      controls.setTerrainOcclusion(
        planner.occlusion(occlusion(), {
          isEnabled: (enabledInput as HTMLInputElement).checked,
          strengthSlider: Number(strengthInput!.value),
          radiusSlider: Number(radiusInput!.value),
          directionsSegment: Number(directionsInput!.value),
          resolutionSegment: Number(resolutionInput!.value),
        }),
      );
      this.refresh();
      this.context.requestFrame();
    };
    this.refreshers.push(() => {
      const value = occlusion();
      enabled.set(value.isEnabled);
      strength.set(value.strength);
      strength.element.firstElementChild!.textContent = planner.strengthTitle(value.strength);
      radius.set(planner.sliderValue(value.radiusMeters));
      radius.element.firstElementChild!.textContent = planner.radiusTitle(value.radiusMeters);
      directions.set(planner.directionsIndex(value.directions));
      resolution.set(planner.resolutionIndex(value.resolution));
      debugView.set(controls.terrainOcclusionDebugView());
    });
  }

  // MARK: Sky

  private buildSky(): void {
    const sky = DebugOverlaySkySettingsPlanner;
    const horizon = this.group("sky", sky.groupTitle);
    const fog = () => this.settingsOf().scene.fog;
    const fogEnabled = debugHudSwitch(sky.enabledTitle, (isOn) => this.context.publish({ fog: sky.withEnabled(fog(), isOn) }));
    const skyColor = debugHudColor(sky.skyColorTitle, (color) => this.context.publish({ fog: sky.withSkyColor(fog(), color) }));
    const horizonColor = debugHudColor(sky.horizonColorTitle, (color) => this.context.publish({ fog: sky.withHorizonColor(fog(), color) }));
    horizon.append(fogEnabled.element, skyColor.element, horizonColor.element);
    this.refreshers.push(() => {
      fogEnabled.set(fog().isEnabled);
      skyColor.set(fog().skyColor);
      horizonColor.set(fog().horizonColor);
    });

    const planner = DebugOverlayAtmosphereSettingsPlanner;
    const body = this.group("sky", "Atmosphere");
    const atmosphere = () => this.settingsOf().scene.atmosphere;
    const publish = (next: ReturnType<typeof atmosphere>) => this.context.publish({ atmosphere: next });
    const enabled = debugHudSwitch("Enabled", (isOn) => publish(planner.withEnabled(atmosphere(), isOn)));
    const color = debugHudColor("Colour", (value) => publish(planner.withColor(atmosphere(), value)));
    const intensity = debugHudSlider("", planner.intensityRange, () => "", (value) => publish(planner.withIntensity(atmosphere(), value)));
    body.append(enabled.element, color.element, intensity.element);
    this.curve(body, planner.thicknessAxes, planner.thicknessText, (zoom) => planner.thicknessTitle(atmosphere().thickness, zoom), () => atmosphere().thickness, (curve) => publish(planner.withThickness(atmosphere(), curve)), () => planner.controlsEnabled(atmosphere()));
    const influence = debugHudSlider("", planner.sunInfluenceRange, () => "", (value) => publish(planner.withSunInfluence(atmosphere(), value)));
    body.append(influence.element);
    this.refreshers.push(() => {
      const value = atmosphere();
      enabled.set(value.isEnabled);
      color.set(value.color);
      intensity.set(value.intensity);
      intensity.element.firstElementChild!.textContent = planner.intensityTitle(value.intensity);
      influence.set(value.sunInfluence);
      influence.element.firstElementChild!.textContent = planner.sunInfluenceTitle(value.sunInfluence);
    });
  }

  // MARK: Globe

  private buildGlobe(): void {
    const planner = DebugOverlayGlobeLightSettingsPlanner;
    const body = this.group("globe", "Globe light");
    const light = () => this.settingsOf().scene.globeLight;
    const publish = (next: ReturnType<typeof light>) => this.context.publish({ globeLight: next });
    const enabled = debugHudSwitch("Enabled", (isOn) => publish(planner.withEnabled(light(), isOn)));
    const latitude = debugHudSlider("", planner.subsolarLatitudeRange, () => "", (value) => publish(planner.withSubsolarLatitude(light(), value)), 1);
    const longitude = debugHudSlider("", planner.subsolarLongitudeRange, () => "", (value) => publish(planner.withSubsolarLongitude(light(), value)), 1);
    body.append(enabled.element, latitude.element, longitude.element);
    this.curve(body, planner.strengthAxes, planner.strengthText, (zoom) => planner.strengthTitle(light().strength, zoom), () => light().strength, (curve) => publish(planner.withStrength(light(), curve)), () => planner.controlsEnabled(light()));
    const softness = debugHudSlider("", planner.softnessRange, () => "", (value) => publish(planner.withTerminatorSoftness(light(), value)));
    const night = debugHudColor("Night colour", (color) => publish(planner.withNightColor(light(), color)));
    body.append(softness.element, night.element);
    this.refreshers.push(() => {
      const value = light();
      enabled.set(value.isEnabled);
      latitude.set(value.subsolarLatitudeDegrees);
      latitude.element.firstElementChild!.textContent = planner.subsolarLatitudeTitle(value.subsolarLatitudeDegrees);
      longitude.set(value.subsolarLongitudeDegrees);
      longitude.element.firstElementChild!.textContent = planner.subsolarLongitudeTitle(value.subsolarLongitudeDegrees);
      softness.set(value.terminatorSoftness);
      softness.element.firstElementChild!.textContent = planner.softnessTitle(value.terminatorSoftness);
      night.set(value.nightColor);
    });
  }

  // MARK: Air

  private buildAir(): void {
    const planner = DebugOverlayGroundFogSettingsPlanner;
    const body = this.group("air", planner.groupTitle);
    const airs = () => this.airs!;
    const fog = () => planner.editedAir(airs());
    const send = (edit: { readonly airs: DebugOverlayAirs; readonly target: "plain" | "mountain"; readonly settings: GroundFogSettings | null }) => {
      this.airs = edit.airs;
      if (edit.target === "plain" && edit.settings !== null) this.context.publish({ groundFog: edit.settings });
      else this.context.publish({ mountainGroundFog: edit.settings });
    };
    const publish = (next: GroundFogSettings) => send(planner.publishing(airs(), next));
    const enabled = debugHudSwitch(planner.enabledTitle, (isOn) => publish(planner.withEnabled(fog(), isOn)));
    const mountain = debugHudSwitch(planner.mountainAirTitle, (isOn) => send(planner.mountainSwitched(airs(), isOn)));
    const choice = debugHudSegments(
      "Edits",
      planner.airChoiceTitles.map((title, index) => ({ title, value: index })),
      (index) => {
        this.airs = planner.airChosen(airs(), index);
        this.refresh();
      },
    );
    const veil = debugHudSwitch(planner.veilsBuildingsTitle, (isOn) => publish(planner.withVeilsBuildings(fog(), isOn)));
    const skyColor = debugHudSwitch(planner.takesSkyColorTitle, (isOn) => publish(planner.withTakesSkyColor(fog(), isOn)));
    const seaLevel = debugHudSwitch(planner.heightsFromSeaLevelTitle, (isOn) => publish(planner.withHeightsFromSeaLevel(fog(), isOn)));
    const baseAltitude = debugHudSlider("", planner.baseAltitudeRange, () => "", (value) => publish(planner.withBaseAltitude(fog(), value)), planner.baseAltitudeStep);
    body.append(enabled.element, mountain.element, choice.element, veil.element, skyColor.element, seaLevel.element, baseAltitude.element);
    for (const field of ["densityPerKilometer", "heightMeters", "startDistanceMeters", "startSoftnessMeters", "maximumOpacity"] as const) {
      this.curve(body, planner.axes(field), planner.valueText(field), (zoom) => planner.title(field, fog()[field], zoom), () => fog()[field], (curve) => publish(planner.withCurve(fog(), field, curve)), () => planner.controlsEnabled(fog()));
    }
    const color = debugHudColor(planner.colorTitle, (value: Rgb) => publish(planner.withColor(fog(), value)));
    const reset = debugHudButton(planner.resetTitle, () => this.context.resetGroundFog());
    const preset = debugHudButton(planner.mountainPresetTitle, () => send(planner.presetApplied(airs())));
    body.append(color.element, reset.element, preset.element);
    this.refreshers.push(() => {
      const value = fog();
      enabled.set(value.isEnabled);
      mountain.set(airs().mountain !== null);
      choice.set(planner.airChoiceIndex(airs()));
      (choice.element.querySelector("select") as HTMLSelectElement).disabled = !planner.airChoiceEnabled(airs());
      veil.set(value.veilsBuildings);
      skyColor.set(value.takesSkyColor);
      seaLevel.set(value.heightsFromSeaLevel);
      baseAltitude.set(value.baseAltitudeMeters);
      baseAltitude.element.firstElementChild!.textContent = planner.baseAltitudeTitle(value.baseAltitudeMeters);
      (baseAltitude.element.querySelector("input") as HTMLInputElement).disabled = !planner.baseAltitudeEnabled(value);
      color.set(planner.displayedColor(value, this.settingsOf().scene.fog.horizonColor));
    });

    const surroundingsPlanner = DebugOverlayTerrainSurroundingsSettingsPlanner;
    const surroundings = this.group("air", surroundingsPlanner.groupTitle);
    const current = () => this.settingsOf().tiles.groundRelief.surroundings;
    const sliders: Record<"sampleRadiusMetres" | "plainBelowMetres" | "mountainsAboveMetres" | "smoothingHalfLife", ReturnType<typeof debugHudSlider>> = {} as never;
    const publishSurroundings = () =>
      this.context.publish({
        terrainSurroundings: surroundingsPlanner.settings(current(), {
          sampleRadiusMetres: Number(sliders.sampleRadiusMetres.element.querySelector("input")!.value),
          plainBelowMetres: Number(sliders.plainBelowMetres.element.querySelector("input")!.value),
          mountainsAboveMetres: Number(sliders.mountainsAboveMetres.element.querySelector("input")!.value),
          smoothingHalfLife: Number(sliders.smoothingHalfLife.element.querySelector("input")!.value),
        }),
      });
    const entries = [
      ["sampleRadiusMetres", surroundingsPlanner.sampleRadiusRange, surroundingsPlanner.sampleRadiusTitle],
      ["plainBelowMetres", surroundingsPlanner.plainBelowRange, surroundingsPlanner.plainBelowTitle],
      ["mountainsAboveMetres", surroundingsPlanner.mountainsAboveRange, surroundingsPlanner.mountainsAboveTitle],
      ["smoothingHalfLife", surroundingsPlanner.smoothingHalfLifeRange, surroundingsPlanner.smoothingHalfLifeTitle],
    ] as const;
    for (const [field, range] of entries) {
      sliders[field] = debugHudSlider("", range, () => "", () => publishSurroundings());
      surroundings.append(sliders[field].element);
    }
    this.refreshers.push(() => {
      const value = current();
      for (const [field, , title] of entries) {
        sliders[field].set(value[field]);
        sliders[field].element.firstElementChild!.textContent = title(value[field]);
      }
    });
  }

  // MARK: Map: the ring rules

  private buildMap(): void {
    const editing = DebugOverlayRingRuleEditing;
    const controls = this.context.controls;
    const body = this.group("map", editing.groupTitle);
    const sets = () => controls.snapshot().ringRuleSets;
    const apply = (next: ReturnType<typeof sets> | undefined, selected?: number) => {
      if (next === undefined) return;
      controls.setRingRuleSets(next);
      if (selected !== undefined) this.selectedRingSet = selected;
      this.refresh();
      this.context.requestFrame();
    };
    const picker = document.createElement("select");
    picker.addEventListener("change", () => {
      this.selectedRingSet = Number(picker.value);
      this.refresh();
    });
    const firstZoom = debugHudSlider("", editing.setFirstZoomRange, () => "", (value) => apply(editing.movingSetFirstZoom(sets(), this.selectedRingSet, value)), 1);
    const split = debugHudButton(editing.splitSetTitle, () => {
      const edit = editing.splittingSet(sets(), this.selectedRingSet);
      if (edit !== undefined) apply(edit.rules, edit.selectedIndex);
    });
    const removeSet = debugHudButton(editing.removeSetTitle, () => {
      const edit = editing.removingSet(sets(), this.selectedRingSet);
      if (edit !== undefined) apply(edit.rules, edit.selectedIndex);
    });
    const cards = document.createElement("div");
    const addRule = debugHudButton(editing.addRuleTitle, () => apply(editing.addingRule(sets(), this.selectedRingSet)));
    const removeRule = debugHudButton(editing.removeRuleTitle, () => apply(editing.removingLastRule(sets(), this.selectedRingSet)));
    body.append(picker, firstZoom.element, split.element, removeSet.element, cards, addRule.element, removeRule.element);
    let shownRules: readonly FlatRingRule[] | undefined;
    const edit = (ruleIndex: number, field: DebugOverlayRingRuleField) => apply(editing.editingRule(sets(), this.selectedRingSet, ruleIndex, field));
    this.refreshers.push(() => {
      const value = sets();
      this.selectedRingSet = Math.min(this.selectedRingSet, value.sets.length - 1);
      fillSelect(picker, value.sets.map((_, index) => editing.setTitle(value, index)), this.selectedRingSet);
      const limits = editing.setFirstZoomLimits(value, this.selectedRingSet);
      firstZoom.element.hidden = limits === undefined;
      const set = value.sets[this.selectedRingSet]!;
      firstZoom.set(set.firstZoom);
      firstZoom.element.firstElementChild!.textContent = editing.setFirstZoomTitle(set.firstZoom);
      removeSet.element.disabled = !editing.canRemoveSet(value);
      removeRule.element.disabled = !editing.canRemoveRule(value, this.selectedRingSet);
      const rules = editing.rules(value, this.selectedRingSet);
      // The cards are built again only when the rules change, so a slider keeps its drag.
      if (rules === shownRules) return;
      shownRules = rules;
      cards.replaceChildren(
        ...rules.map((rule, index) => {
          const card = debugHudGroup(editing.cardTitle(index));
          const drop = debugHudSegments(editing.dropTitle, editing.dropChoiceTitles.map((title, segment) => ({ title, value: segment })), (segment) => edit(index, { kind: "zoomDropSegment", segment }));
          drop.set(editing.dropSegment(rule.zoomDrop));
          const distance = debugHudSlider(editing.distanceTitle(rule.distance), editing.distanceSliderRange, () => "", (sliderValue) => edit(index, { kind: "distanceSlider", sliderValue }));
          distance.set(editing.distanceSliderValue(rule.distance));
          const lines = debugHudSwitch(editing.linesTitle, (isOn) => edit(index, { kind: "drawsLines", isOn }));
          lines.set(rule.drawsLines);
          const labels = debugHudSwitch(editing.labelsTitle, (isOn) => edit(index, { kind: "drawsLabels", isOn }));
          labels.set(rule.drawsLabels);
          const raster = debugHudSegments(editing.rasterTitle, editing.rasterChoiceTitles.map((title, segment) => ({ title, value: segment })), (segment) => edit(index, { kind: "rasterSegment", segment }));
          raster.set(editing.rasterChoiceIndex(rule.rasterSize));
          const terrain = debugHudSegments(
            editing.terrainTitle(rule.terrainZoomDrop),
            editing.terrainChoiceTitles.map((title, segment) => ({ title, value: segment })),
            (segment) => edit(index, { kind: "terrainSegment", segment }),
          );
          terrain.set(editing.terrainSegment(rule.terrainZoomDrop));
          card.body.append(drop.element, distance.element, lines.element, labels.element, raster.element, terrain.element);
          return card.element;
        }),
      );
    });
  }

  // MARK: 3D buildings

  private buildModels(): void {
    const planner = DebugOverlayModelArchiveSettingsPlanner;
    const body = this.group("buildingModels", planner.groupTitle);
    const absent = debugHudHint(planner.absentTitle);
    body.append(absent);
    const depthBias = () => planner.depthBias(this.settingsOf().data.modelArchive);
    this.curve(
      body,
      planner.depthBiasAxes,
      planner.depthBiasText,
      (zoom) => planner.depthBiasTitle(planner.displayedDepthBias(depthBias()), zoom),
      () => planner.displayedDepthBias(depthBias()),
      (curve) => this.context.publish({ modelDepthBias: planner.edited(curve) }),
      () => depthBias() !== undefined,
    );
    this.refreshers.push(() => {
      absent.hidden = depthBias() !== undefined;
    });
  }

  // MARK: Tiles and relief

  private buildTiles(): void {
    const body = this.group("tiles", "Tiles");
    const status = debugHudText();
    const total = debugHudText();
    total.element.style.color = "#ffd479";
    const map = document.createElement("canvas");
    map.className = "imm-debug-coverage";
    const cards = document.createElement("div");
    cards.className = "imm-debug-cards";
    body.append(status.element, total.element, map, cards);
    this.snapshotViews.push((snapshot) => {
      if (snapshot === undefined || !DebugOverlayHUDContentRequest.contains(this.shownContent, DebugOverlayHUDContentRequest.tiles)) return;
      status.set(DebugOverlayHUDTextComposer.tilesStatusText(snapshot.tileLoadingStatusLines));
      total.set(DebugOverlayHUDTextComposer.tilesTotalText(snapshot.tileLoadingStatusTiles.length));
      drawDebugTileCoverage(map, snapshot.tileCoverage);
      renderCards(cards, DebugOverlayTileCard.cards(snapshot.tileLoadingStatusTiles));
    });
  }

  private buildRelief(): void {
    const body = this.group("relief", "Relief");
    const texts = debugHudText();
    const map = document.createElement("canvas");
    map.className = "imm-debug-coverage";
    const cards = document.createElement("div");
    cards.className = "imm-debug-cards";
    body.append(texts.element, map, cards);
    this.snapshotViews.push((snapshot) => {
      if (snapshot === undefined || !DebugOverlayHUDContentRequest.contains(this.shownContent, DebugOverlayHUDContentRequest.relief)) return;
      const relief = DebugOverlayHUDTextComposer.reliefTexts(snapshot.reliefStatus);
      texts.set([relief.state, relief.loading, relief.memory, relief.occlusion, relief.surroundings, relief.tilesCount].filter((line) => line.length > 0).join("\n"));
      drawDebugReliefCoverage(map, snapshot.reliefCoverage);
      renderCards(cards, snapshot.reliefStatus === undefined ? [] : DebugOverlayTileCard.reliefCards(snapshot.reliefStatus));
    });
  }

  // MARK: Export

  private buildExport(): void {
    const text = DebugOverlayHUDTextComposer;
    const body = this.group("export", "Export");
    const status = debugHudText();
    body.append(debugHudHint(text.exportHint), debugHudButton(text.exportButtonTitle, () => this.context.exportSettings()).element, status.element);
    this.refreshers.push(() => status.set(this.exportStatus));
  }
}

/** The options of a picker, the selected one chosen, built again only when the titles change. */
function fillSelect(select: HTMLSelectElement, titles: readonly string[], selected: number): void {
  const current = [...select.options].map((option) => option.textContent);
  if (current.length !== titles.length || current.some((title, index) => title !== titles[index])) {
    select.replaceChildren(
      ...titles.map((title, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = title;
        return option;
      }),
    );
  }
  select.value = String(selected);
}

const toneColor = { ready: "#34c759", failed: "#ff453a", live: "#ffd60a" } as const;

/** The tile cards, the Swift `DebugOverlayTileCardLayout` in CSS: a stripe, the headline, the stages, the layers, the progress. */
function renderCards(container: HTMLElement, cards: readonly DebugOverlayTileCard[]): void {
  container.replaceChildren(
    ...cards.map((card) => {
      const element = document.createElement("div");
      element.className = "imm-debug-card";
      const color = toneColor[DebugOverlayTileCard.statusTone(card.status)];
      const stripe = document.createElement("div");
      stripe.className = "imm-debug-card-stripe";
      stripe.style.background = color;
      const title = document.createElement("div");
      title.className = "imm-debug-card-title";
      const address = document.createElement("span");
      address.textContent = card.title;
      const statusText = document.createElement("span");
      statusText.textContent = card.statusText;
      statusText.style.color = color;
      title.append(address, statusText);
      const stages = document.createElement("div");
      stages.className = "imm-debug-card-detail";
      stages.textContent = card.stagesText;
      const layers = document.createElement("div");
      layers.className = "imm-debug-card-detail";
      layers.textContent = card.layersText;
      const track = document.createElement("div");
      track.className = "imm-debug-card-track";
      const progress = document.createElement("div");
      progress.className = "imm-debug-card-progress";
      progress.style.width = `${Math.round(Math.min(1, Math.max(0, card.progress)) * 100)}%`;
      progress.style.background = color;
      track.append(progress);
      element.append(stripe, title, stages, layers, track);
      return element;
    }),
  );
}
