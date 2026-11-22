// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The slot a debug panel fills, the Swift `ImmersiveMapDebugPanel` with its
 * host and runtime protocols. The engine keeps no panel of its own: it holds
 * what a panel reads and drags (`DebugOverlayControlState`, the trace
 * recorders, the tile loading status) and hands the panel every frame's
 * report (`DebugFrameReport`), so a page that imports `@immersive-map/web`
 * alone carries nothing of the panel's views. The panel itself is the
 * `@immersive-map/web/debug` entry (`ImmersiveMapDebugPanel.hud`).
 */

import type { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import { BaseLabelTraceRecorder } from "../render/debug/base-label-trace-recorder.ts";
import { DebugOverlayControlState } from "../render/debug/debug-overlay-control-state.ts";
import type { DebugFrameReport } from "../render/debug/debug-frame-report.ts";
import { TileLoadingStatusReporter } from "../render/debug/tile-loading-status-reporter.ts";
import { TileTraceRecorder } from "../render/debug/tile-trace-recorder.ts";

/**
 * A debug panel drawn over the map: the one `@immersive-map/web/debug`
 * ships (`ImmersiveMapDebugPanel.hud`), installed with the map's
 * `debugPanel` option or `installDebugPanel`. Opaque to an app.
 */
export interface ImmersiveMapDebugPanel {
  /** @internal Makes the panel's runtime over the host the map hands it, once per map. */
  readonly makeRuntime: (host: ImmersiveMapDebugPanelHost) => ImmersiveMapDebugPanelRuntime;
}

/**
 * @internal What the map hands a debug panel to work with: the element to
 * lay itself into, the controls it drags, the recorders and the loading
 * status it reads, and the map it asks for a frame or a surface switch.
 */
export interface ImmersiveMapDebugPanelHost {
  /** The map's container, which the panel's elements are laid over. */
  readonly container: HTMLElement;
  /** The map's canvas, which the overlay matches in size. */
  readonly canvas: HTMLCanvasElement;
  readonly controls: DebugOverlayControlState;
  readonly tileTraceRecorder: TileTraceRecorder;
  readonly baseLabelTraceRecorder: BaseLabelTraceRecorder;
  /** The tile loader's status, recorded while the panel is shown (`TileLoadingStatusReporter.onChange` says it moved). */
  readonly tileLoadingStatus: TileLoadingStatusReporter;
  requestFrame(): void;
  /** Ends the camera's animations and switches between the globe and the flat map. */
  switchRenderMode(): void;
}

/** @internal What the map asks of an installed debug panel. */
export interface ImmersiveMapDebugPanelRuntime {
  /**
   * Settings the panel asks for. The map applies them the way it applies
   * any others, so a change here goes through the same planner as one the
   * app makes.
   */
  onSettingsChangeRequested: ((settings: ImmersiveMapSettings) => void) | null;
  /** The settings the map should run with: the ones it was given, with whatever the panel has been dragged to on top. */
  applyingOverrides(settings: ImmersiveMapSettings): ImmersiveMapSettings;
  /** The settings the map runs with, for the panel to show. */
  apply(settings: ImmersiveMapSettings): void;
  /** Whether the panel wants the frame's label boxes in its reports (the label boxes overlay is on). */
  readonly wantsLabelBoxes: boolean;
  /** A drawn frame, while the panel is shown: read synchronously, the report's arrays are the frame's own. */
  frameDrawn(report: DebugFrameReport): void;
  destroy(): void;
}

/** @internal The renderer's side of the debug panel: what the frame reads and reports to. */
export interface ImmersiveMapDebugFrameHooks {
  readonly controls: DebugOverlayControlState;
  readonly tileTraceRecorder: TileTraceRecorder;
  readonly baseLabelTraceRecorder: BaseLabelTraceRecorder;
  readonly tileLoadingStatus: TileLoadingStatusReporter;
  /**
   * Whether a panel is installed and shown (`DebugSettings.enableDebugPanel`
   * and not hidden with the controls): only then the frame builds its
   * report and the loader reports its status. A panel hidden or absent
   * costs the frame nothing.
   */
  readonly isActive: boolean;
  /** Whether the frame builds its label boxes for the report. */
  readonly wantsLabelBoxes: boolean;
  frameDrawn(report: DebugFrameReport): void;
}

/** @internal What the map gives the slot. */
export interface ImmersiveMapDebugSlotHost {
  readonly container: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  requestFrame(): void;
  switchRenderMode(): void;
  /** The panel's settings, applied as the app's are. */
  applySettings(settings: ImmersiveMapSettings): Promise<void>;
}

/**
 * @internal The map's debug panel slot (the Swift runtime graph's
 * `installDebugPanel` with the state it keeps for the frames): the controls
 * and the recorders outlive every renderer, as they outlive the Swift
 * renderer, and the panel installed first is kept.
 */
export class ImmersiveMapDebugRuntimeSlot {
  readonly controls = new DebugOverlayControlState();
  readonly tileTraceRecorder = new TileTraceRecorder();
  readonly baseLabelTraceRecorder = new BaseLabelTraceRecorder();
  readonly tileLoadingStatus = new TileLoadingStatusReporter();
  readonly frameHooks: ImmersiveMapDebugFrameHooks;
  private runtime: ImmersiveMapDebugPanelRuntime | null = null;
  private shown = false;

  constructor(private readonly host: ImmersiveMapDebugSlotHost) {
    const slot = this;
    this.frameHooks = {
      controls: this.controls,
      tileTraceRecorder: this.tileTraceRecorder,
      baseLabelTraceRecorder: this.baseLabelTraceRecorder,
      tileLoadingStatus: this.tileLoadingStatus,
      get isActive(): boolean {
        return slot.runtime !== null && slot.shown;
      },
      get wantsLabelBoxes(): boolean {
        return slot.runtime !== null && slot.shown && slot.runtime.wantsLabelBoxes;
      },
      frameDrawn: (report) => {
        if (this.shown) this.runtime?.frameDrawn(report);
      },
    };
  }

  /** Installs the panel, the first one given kept: false when one is installed already. */
  install(panel: ImmersiveMapDebugPanel, settings: ImmersiveMapSettings): boolean {
    if (this.runtime !== null) return false;
    const runtime = panel.makeRuntime({
      container: this.host.container,
      canvas: this.host.canvas,
      controls: this.controls,
      tileTraceRecorder: this.tileTraceRecorder,
      baseLabelTraceRecorder: this.baseLabelTraceRecorder,
      tileLoadingStatus: this.tileLoadingStatus,
      requestFrame: () => this.host.requestFrame(),
      switchRenderMode: () => this.host.switchRenderMode(),
    });
    runtime.onSettingsChangeRequested = (requested) => void this.host.applySettings(requested);
    this.runtime = runtime;
    this.apply(settings);
    return true;
  }

  applyingOverrides(settings: ImmersiveMapSettings): ImmersiveMapSettings {
    return this.runtime?.applyingOverrides(settings) ?? settings;
  }

  /** The settings the map now runs with: the panel shows them, and is shown or hidden by them. */
  apply(settings: ImmersiveMapSettings): void {
    this.shown = settings.debug.enableDebugPanel && !settings.controls.isHidden;
    this.runtime?.apply(settings);
  }

  destroy(): void {
    this.runtime?.destroy();
    this.runtime = null;
    this.shown = false;
  }
}
