// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import { DebugOverlayHUDContentRequest, DebugOverlayHUDSnapshotStore } from "../render/debug/debug-overlay-hud-snapshot-store.ts";
import type { DebugFrameReport } from "../render/debug/debug-frame-report.ts";
import { TileLoadingStatusSnapshot, type TileLoadingStatusTileSnapshot } from "../render/debug/tile-loading-status-reporter.ts";
import { TileTraceEvent } from "../render/debug/tile-trace-recorder.ts";
import type { ImmersiveMapDebugPanelHost, ImmersiveMapDebugPanelRuntime } from "../ui/immersive-map-debug-panel.ts";
import { DebugHudView } from "./hud/debug-hud-view.ts";
import { installDebugHudStyles } from "./hud/debug-hud-controls.ts";
import { DebugOverlayHUDSnapshot, type DebugOverlayTileLoadingStatus } from "./overlay/debug-overlay-hud-snapshot.ts";
import { planDebugOverlay } from "./overlay/debug-overlay-planner.ts";
import { canvasTextMeasurer, drawDebugOverlay, type DebugOverlayTextMeasurer } from "./overlay/debug-overlay-primitives.ts";
import { type DebugOverlayAppGroundFog, DebugOverlaySettingsOverride } from "./panel/debug-overlay-settings-override.ts";
import { DebugOverlaySettingsExport } from "./panel/debug-overlay-settings-export.ts";
import { DebugOverlayHUDTextComposer } from "./panel/debug-overlay-hud-content.ts";
import { DebugOverlayZoomBadge } from "./panel/debug-overlay-zoom-badge.ts";
import { RenderDebugOverlayPolicy } from "../render/debug/debug-overlay-control-state.ts";

type HudSnapshot = DebugOverlayHUDSnapshot<TileLoadingStatusTileSnapshot>;
type HudTileStatus = DebugOverlayTileLoadingStatus<TileLoadingStatusTileSnapshot>;

/** The reporter's status as the HUD shows it: its lines and its rows. */
const hudTileStatus = (snapshot: TileLoadingStatusSnapshot): HudTileStatus => ({ lines: TileLoadingStatusSnapshot.lines(snapshot), tiles: snapshot.tiles });

/** The one thing neither a frame nor the loader announces: a stage growing old, in whole seconds. */
const stageAgeTimerMilliseconds = 1000;

/**
 * The debug panel's runtime, the Swift `ImmersiveMapDebugOverlayRuntime`:
 * wires the HUD view (`DebugHudView`), the zoom badge and the overlay
 * canvas to the engine's controls, its recorders and its frames, and hands
 * the map the settings the panel drags (`ImmersiveMapDebugPanelRuntime`).
 * Every drawn frame publishes a snapshot that the panel applies in the same
 * turn, so the numbers on the panel are the frame's on screen. Between
 * frames the loader goes on, and its status reaches the panel through the
 * snapshot store.
 */
export class ImmersiveMapDebugOverlayRuntime implements ImmersiveMapDebugPanelRuntime {
  onSettingsChangeRequested: ((settings: ImmersiveMapSettings) => void) | null = null;
  private readonly view: DebugHudView;
  private readonly badge: HTMLDivElement;
  private readonly overlay: HTMLCanvasElement;
  private readonly overlayContext: CanvasRenderingContext2D | null;
  private readonly measurer: DebugOverlayTextMeasurer | undefined;
  private readonly store = new DebugOverlayHUDSnapshotStore<HudSnapshot, HudTileStatus>();
  private consumedVersion = 0;
  private appliedSnapshot: HudSnapshot | undefined;
  private currentSettings: ImmersiveMapSettings | undefined;
  private override: DebugOverlaySettingsOverride = DebugOverlaySettingsOverride.empty;
  /** The airs the app gave, for the Air group's reset. */
  private appGroundFog: DebugOverlayAppGroundFog | undefined;
  private showsPanel = false;
  private showsZoomBadge = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastTracedStatus: TileLoadingStatusSnapshot | undefined;
  private overlayDrawn = false;

  constructor(private readonly host: ImmersiveMapDebugPanelHost) {
    installDebugHudStyles();
    const controls = host.controls;
    this.view = new DebugHudView({
      controls,
      requestFrame: () => host.requestFrame(),
      switchRenderMode: () => host.switchRenderMode(),
      publish: (patch) => this.publish(patch),
      resetGroundFog: () => this.resetGroundFog(),
      toggleTileTrace: () => this.toggleTrace(host.tileTraceRecorder),
      toggleLabelTrace: () => this.toggleTrace(host.baseLabelTraceRecorder),
      exportSettings: () => this.exportSettings(),
      contentChanged: (content) => {
        // The tab just opened fills on the next frame, asked for here.
        this.store.requestedContent = content;
        host.requestFrame();
      },
    });
    this.store.requestedContent = this.view.shownContent;
    this.overlay = document.createElement("canvas");
    this.overlay.className = "imm-debug-overlay";
    this.overlay.hidden = true;
    this.overlayContext = this.overlay.getContext("2d");
    this.measurer = this.overlayContext === null ? undefined : canvasTextMeasurer(this.overlayContext);
    this.badge = document.createElement("div");
    this.badge.className = "imm-debug-zoom-badge";
    this.badge.hidden = true;
    host.container.append(this.overlay, this.view.element, this.badge);

    // The loader's status between frames: one hop to the panel for a burst of changes.
    host.tileLoadingStatus.onChange = () => this.store.noteTileLoadingStatusChanged();
    this.store.attachTileLoadingStatus(() => hudTileStatus(host.tileLoadingStatus.snapshot()));
    this.store.onTileLoadingStatusChanged = () => this.refreshBetweenFrames();
    this.view.applyTraces(host.tileTraceRecorder.snapshot(), host.baseLabelTraceRecorder.snapshot());
  }

  get wantsLabelBoxes(): boolean {
    const controls = this.host.controls.snapshot();
    return controls.baseLabelBoundsEnabled || controls.roadLabelBoundsEnabled;
  }

  /**
   * The settings the map should run with: the ones it was given, with the
   * panel's drags on top. Turning the panel off drops them, so the app's
   * own values come straight back.
   */
  applyingOverrides(settings: ImmersiveMapSettings): ImmersiveMapSettings {
    this.override = DebugOverlaySettingsOverride.retained(this.override, settings);
    // The panel's own request carries the dragged air, anything else the app's.
    this.appGroundFog = DebugOverlaySettingsOverride.appGroundFog(this.appGroundFog, this.override, settings);
    return DebugOverlaySettingsOverride.applied(this.override, settings);
  }

  apply(settings: ImmersiveMapSettings): void {
    this.currentSettings = settings;
    this.appGroundFog ??= { groundFog: settings.scene.groundFog, mountainGroundFog: settings.scene.mountainGroundFog };
    // Hidden with the map's controls, the panel keeps what was dragged in it
    // and only stops showing and reading the frames.
    this.showsPanel = settings.debug.enableDebugPanel && !settings.controls.isHidden;
    this.showsZoomBadge = this.showsPanel && settings.debug.showsZoomBadge;
    if (!settings.debug.enableDebugPanel) {
      // The panel's reach goes with the panel, like its other values.
      const controls = this.host.controls;
      controls.setLocalLabelMaximumDistanceMeters(undefined);
      controls.setLabelPerspectiveMinimumScale(undefined);
      controls.setHillshadeFade(undefined);
      controls.setHillshadeAmounts(undefined);
      controls.setLabelOpacity(undefined);
      controls.setReliefCastsShadows(undefined);
      controls.setTerrainOcclusion(undefined);
      controls.setTerrainOcclusionDebugView(false);
    }
    this.view.setShown(this.showsPanel);
    this.view.applySettings(settings);
    this.view.applyTraces(this.host.tileTraceRecorder.snapshot(), this.host.baseLabelTraceRecorder.snapshot());
    if (this.showsPanel) {
      this.timer ??= setInterval(() => this.flush(), stageAgeTimerMilliseconds);
      this.flush();
    } else {
      if (this.timer !== undefined) clearInterval(this.timer);
      this.timer = undefined;
      this.consumedVersion = this.store.publish(undefined);
      this.appliedSnapshot = undefined;
      this.view.applySnapshot(undefined);
      this.clearOverlay();
    }
    this.applyZoomBadge(this.appliedSnapshot);
  }

  frameDrawn(report: DebugFrameReport): void {
    const settings = this.currentSettings;
    if (settings === undefined || !this.showsPanel) return;
    const content = this.store.requestedContent;
    const tiles = DebugOverlayHUDContentRequest.contains(content, DebugOverlayHUDContentRequest.tiles);
    const status = tiles ? this.host.tileLoadingStatus.snapshot() : undefined;
    // A moved status is traced while the tile trace records, as the Swift engine does.
    const recorder = this.host.tileTraceRecorder;
    if (status !== undefined && recorder.isRecording && (this.lastTracedStatus === undefined || !TileLoadingStatusSnapshot.equals(status, this.lastTracedStatus))) {
      this.lastTracedStatus = status;
      recorder.record(TileTraceEvent.tileLoadingStatusSnapshot(report.frameIndex, status));
    }
    this.store.publish(DebugOverlayHUDSnapshot.fromFrame(settings.debug, report, status === undefined ? undefined : hudTileStatus(status), content));
    this.flush();
    this.drawOverlay(report, settings);
  }

  destroy(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.host.tileLoadingStatus.onChange = undefined;
    this.store.attachTileLoadingStatus(undefined);
    this.view.element.remove();
    this.badge.remove();
    this.overlay.remove();
  }

  // MARK: Settings the panel drags

  private publish(patch: DebugOverlaySettingsOverride): void {
    const settings = this.currentSettings;
    if (settings === undefined) return;
    this.override = { ...this.override, ...patch };
    this.onSettingsChangeRequested?.(DebugOverlaySettingsOverride.applied(this.override, settings));
  }

  private resetGroundFog(): void {
    const settings = this.currentSettings;
    if (settings === undefined) return;
    const reset = DebugOverlaySettingsOverride.resettingGroundFog(this.override, settings, this.appGroundFog);
    this.override = reset.override;
    this.onSettingsChangeRequested?.(reset.settings);
  }

  // MARK: Traces and the export

  private toggleTrace(recorder: { startRecording(): string; stopRecording(): void; takeBlob(): Blob | undefined; snapshot(): { readonly isRecording: boolean; readonly fileName: string | undefined } }): void {
    if (recorder.snapshot().isRecording) {
      recorder.stopRecording();
      const blob = recorder.takeBlob();
      const name = recorder.snapshot().fileName;
      if (blob !== undefined && name !== undefined) download(blob, name);
    } else {
      recorder.startRecording();
    }
    this.view.applyTraces(this.host.tileTraceRecorder.snapshot(), this.host.baseLabelTraceRecorder.snapshot());
    this.host.requestFrame();
  }

  /** The settings the map runs with as the modifiers that set them, downloaded as a TypeScript file. */
  private exportSettings(): void {
    const settings = this.currentSettings;
    if (settings === undefined) return;
    const date = new Date();
    const snapshot = this.appliedSnapshot;
    const cameraLines = snapshot === undefined ? [] : [snapshot.coordinateLines.zoom, snapshot.coordinateLines.latLon];
    const text = DebugOverlaySettingsExport.typeScriptCode(settings, date, cameraLines, this.host.controls.labelOpacity());
    const fileName = DebugOverlaySettingsExport.fileName(date);
    download(new Blob([text], { type: "text/typescript" }), fileName);
    this.view.applyExportStatus(DebugOverlayHUDTextComposer.exportStatusText(fileName));
  }

  // MARK: Snapshots

  /** Applies the newest frame snapshot, or, without one, the tile list read again from the reporter. */
  private flush(): void {
    const value = this.store.consumeLatest(this.consumedVersion);
    if (value !== undefined) {
      this.consumedVersion = value.version;
      this.appliedSnapshot = value.snapshot;
      this.view.applySnapshot(value.snapshot);
      this.applyZoomBadge(value.snapshot);
      return;
    }
    this.refreshBetweenFrames();
  }

  private refreshBetweenFrames(): void {
    if (!this.showsPanel) return;
    const refreshed = this.store.refreshedSnapshot(this.appliedSnapshot, (snapshot, status) => DebugOverlayHUDSnapshot.replacingTileLoadingStatus(snapshot, status), DebugOverlayHUDSnapshot.isEqual);
    if (refreshed === undefined) return;
    this.appliedSnapshot = refreshed;
    this.view.applySnapshot(refreshed);
  }

  /** The badge on the panel's snapshot: shown with the panel while it asks for it. */
  private applyZoomBadge(snapshot: HudSnapshot | undefined): void {
    if (!this.showsZoomBadge || snapshot === undefined) {
      this.badge.hidden = true;
      return;
    }
    const [zoom, plan] = DebugOverlayZoomBadge.lines(snapshot.zoom, snapshot.cameraZoom);
    if (this.badge.firstChild?.textContent !== zoom || this.badge.lastChild?.textContent !== plan) {
      const planLine = document.createElement("small");
      planLine.textContent = plan;
      this.badge.replaceChildren(document.createTextNode(zoom), planLine);
    }
    this.badge.hidden = false;
  }

  // MARK: The overlay

  /** The frame's overlay on the 2D canvas over the map, the drawable's size, redrawn every frame it shows. */
  private drawOverlay(report: DebugFrameReport, settings: ImmersiveMapSettings): void {
    const context = this.overlayContext;
    const controls = this.host.controls.snapshot();
    if (context === null || this.measurer === undefined || !RenderDebugOverlayPolicy.shouldEncode(settings.debug, controls)) {
      this.clearOverlay();
      return;
    }
    const canvas = this.overlay;
    if (canvas.width !== report.drawWidth || canvas.height !== report.drawHeight) [canvas.width, canvas.height] = [report.drawWidth, report.drawHeight];
    canvas.hidden = false;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    drawDebugOverlay(context, planDebugOverlay(report, controls, { measurer: this.measurer, diagnosticsScale: settings.debug.diagnosticsScale }));
    this.overlayDrawn = true;
  }

  private clearOverlay(): void {
    if (!this.overlayDrawn) return;
    this.overlayDrawn = false;
    this.overlay.hidden = true;
    this.overlayContext?.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
}

/** Hands the page's reader a file, the browser's download in place of Swift's Downloads folder. */
function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
