// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import { defaultCameraSettings } from "../../configuration/camera-settings.ts";
import { CameraControlMath, type CameraControlDegreesRange } from "./camera-control-math.ts";
import type { ImmersiveMapCameraController } from "./immersive-map-camera-controller.ts";
import { ImmersiveMapCameraAngleLimits, ImmersiveMapCameraBearingLimits, ImmersiveMapCameraSnapshot } from "./immersive-map-camera-snapshot.ts";

/** What the camera control panel is built from. */
export interface ImmersiveMapCameraControlPanelOptions {
  /** The element the panel is laid over, the map's container. It should be positioned (not `static`). */
  readonly container: HTMLElement;
  /** The camera the panel reads and steers. */
  readonly camera: ImmersiveMapCameraController;
  /** The position the panel shows until the camera reports a snapshot. The origin, north up and top-down, by default. */
  readonly initialCameraPosition?: ImmersiveMapCameraPosition;
  /** The pitch ceiling, in radians, until the camera reports a snapshot. The default camera's `maximumPitch` by default. */
  readonly maximumPitch?: number;
}

const accentColor = "rgb(5,140,242)";

const iconPaths = {
  camera:
    '<circle cx="12" cy="12" r="9"/><path d="M12 3l3.5 6M21 12h-7M16.5 19.8L13 14M7.5 19.8L11 14M3 12h7M7.5 4.2L11 10"/>',
  rotateLeft: '<path d="M4 4v5h5"/><path d="M4.6 14a8 8 0 1 0 1.8-8.2L4 9"/>',
  north: '<path d="M12 2v20"/><path d="M8 7l4-5 4 5"/>',
  rotateRight: '<path d="M20 4v5h-5"/><path d="M19.4 14a8 8 0 1 1-1.8-8.2L20 9"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  viewfinder: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><circle cx="12" cy="12" r="2.5"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
} as const;

function icon(paths: string, size: number): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = paths;
  return svg;
}

function samePosition(a: ImmersiveMapCameraPosition, b: ImmersiveMapCameraPosition): boolean {
  return (
    a.latitudeDegrees === b.latitudeDegrees &&
    a.longitudeDegrees === b.longitudeDegrees &&
    a.zoom === b.zoom &&
    a.bearing === b.bearing &&
    a.pitch === b.pitch
  );
}

/** Events stopped at the panel so a press on it never reaches the map's gestures underneath. */
const swallowedEvents = ["pointerdown", "pointermove", "pointerup", "pointercancel", "wheel", "contextmenu", "dblclick", "gesturestart", "gesturechange", "gestureend"] as const;

/** One of the panel's two sliders, its elements and the range it was last drawn with. */
interface ScrubSlider {
  readonly element: HTMLDivElement;
  readonly fill: HTMLDivElement;
  readonly thumb: HTMLDivElement;
  renderedProgress: number | null;
  renderedText: string | null;
}

/**
 * The built-in camera control panel (Swift `ImmersiveMapCameraControlPanel`
 * with its overlay modifier): a card on the trailing side of the map,
 * vertically centred, with a Rotate section (left and right by 15 degrees,
 * reset north, a scrub slider) and a Tilt section (down and up by 5 degrees,
 * reset tilt, a scrub slider), each with a live "N deg" readout.
 *
 * The panel reads the camera through `addCameraSnapshotObserver`, so the
 * app keeps its `onCameraSnapshotChanged` slot, and steers it with
 * `setCameraAngleTarget`, the requested angles clamped by the snapshot. Until
 * the camera reports a snapshot it assumes a free bearing and a pitch from
 * top-down to `maximumPitch`.
 *
 * While a slider is scrubbed the panel shows the target (the draft) rather
 * than the camera, which follows it with a lag that would otherwise jerk the
 * thumb back every frame. The camera's own angles return on the first
 * change after release.
 *
 * Thumbs and fills are placed by CSS from the progress alone. The slider's
 * width is read only on pointer events, never per frame, and the DOM is
 * written only when a readout or a progress changes.
 */
export class ImmersiveMapCameraControlPanel {
  /** The panel's element, a child of the container. */
  readonly element: HTMLDivElement;
  private readonly camera: ImmersiveMapCameraController;
  private readonly maximumPitch: number;
  private livePosition: ImmersiveMapCameraPosition;
  private liveSnapshot: ImmersiveMapCameraSnapshot | null = null;
  private draftBearingDegrees: number | null = null;
  private draftPitchDegrees: number | null = null;
  private isScrubbing = false;
  private isEnabled = true;
  private isDestroyed = false;
  private observerToken: symbol | null = null;
  private readonly bearingReadout: HTMLSpanElement;
  private readonly pitchReadout: HTMLSpanElement;
  private readonly bearingSlider: ScrubSlider;
  private readonly pitchSlider: ScrubSlider;
  private renderedBearingReadout: string | null = null;
  private renderedPitchReadout: string | null = null;
  private readonly abort = new AbortController();

  /** Builds the panel over `options.container`, enabled, and starts following the camera. */
  constructor(options: ImmersiveMapCameraControlPanelOptions) {
    this.camera = options.camera;
    this.maximumPitch = options.maximumPitch ?? defaultCameraSettings.maximumPitch;
    this.livePosition = options.initialCameraPosition ?? ImmersiveMapCameraPosition.default;

    const element = document.createElement("div");
    element.className = "immersive-map-camera-controls";
    element.dataset.immersiveMapCameraControls = "";
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", "Camera");
    element.style.cssText = [
      "position:absolute",
      "top:50%",
      "right:18px",
      "transform:translateY(-50%)",
      "box-sizing:border-box",
      "width:248px",
      "padding:14px",
      "display:flex",
      "flex-direction:column",
      "gap:14px",
      "color:#fff",
      "background:rgba(0,0,0,0.48)",
      "border:1px solid rgba(255,255,255,0.14)",
      "border-radius:8px",
      "box-shadow:0 8px 28px rgba(0,0,0,0.28)",
      "font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
      "user-select:none",
      "-webkit-user-select:none",
      "-webkit-tap-highlight-color:transparent",
      "touch-action:none",
      "pointer-events:auto",
      "z-index:1",
    ].join(";");
    const signal = this.abort.signal;
    for (const type of swallowedEvents) {
      element.addEventListener(type, (event) => event.stopPropagation(), { signal });
    }

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px";
    const headerTitle = document.createElement("span");
    headerTitle.textContent = "Camera";
    headerTitle.style.cssText = "font-size:14px;font-weight:600";
    header.append(icon(iconPaths.camera, 15), headerTitle);

    this.bearingReadout = document.createElement("span");
    this.bearingSlider = this.makeSlider(
      () => CameraControlMath.bearingRangeDegrees(this.snapshot),
      () => this.displayedBearingDegrees,
      (value) => this.setBearing(value),
    );
    const rotateSection = this.makeSection("Rotate", this.bearingReadout, [
      this.makeButton(iconPaths.rotateLeft, "Rotate left 15 deg", () => this.setBearing(this.displayedBearingDegrees - 15)),
      this.makeButton(iconPaths.north, "Reset north", () => this.setBearing(0)),
      this.makeButton(iconPaths.rotateRight, "Rotate right 15 deg", () => this.setBearing(this.displayedBearingDegrees + 15)),
    ], this.bearingSlider);

    const divider = document.createElement("div");
    divider.style.cssText = "height:1px;background:rgba(255,255,255,0.2)";

    this.pitchReadout = document.createElement("span");
    this.pitchSlider = this.makeSlider(
      () => CameraControlMath.pitchRangeDegrees(this.snapshot),
      () => this.displayedPitchDegrees,
      (value) => this.setPitch(value),
    );
    const tiltSection = this.makeSection("Tilt", this.pitchReadout, [
      this.makeButton(iconPaths.chevronDown, "Tilt down 5 deg", () => this.setPitch(this.displayedPitchDegrees - 5)),
      this.makeButton(iconPaths.viewfinder, "Reset tilt", () => this.setPitch(0)),
      this.makeButton(iconPaths.chevronUp, "Tilt up 5 deg", () => this.setPitch(this.displayedPitchDegrees + 5)),
    ], this.pitchSlider);

    element.append(header, rotateSection, divider, tiltSection);
    options.container.append(element);
    this.element = element;
    this.subscribe();
    this.render();
  }

  /**
   * Shows or hides the panel. A hidden panel stops following the camera and
   * forgets its drafts, as Swift's overlay drops the panel. Shown again, it
   * picks up the camera's current snapshot.
   */
  setEnabled(isEnabled: boolean): void {
    if (this.isDestroyed || isEnabled === this.isEnabled) {
      return;
    }
    this.isEnabled = isEnabled;
    this.element.style.display = isEnabled ? "flex" : "none";
    if (isEnabled) {
      this.subscribe();
      this.render();
    } else {
      this.unsubscribe();
      this.draftBearingDegrees = null;
      this.draftPitchDegrees = null;
      this.isScrubbing = false;
    }
  }

  /** Stops following the camera and removes the panel from the container. */
  destroy(): void {
    if (this.isDestroyed) {
      return;
    }
    this.isDestroyed = true;
    this.unsubscribe();
    this.abort.abort();
    this.element.remove();
  }

  /** The camera's snapshot, or the fallback Swift assumes until one arrives. */
  private get snapshot(): ImmersiveMapCameraSnapshot {
    return (
      this.liveSnapshot ??
      new ImmersiveMapCameraSnapshot(
        this.livePosition,
        new ImmersiveMapCameraBearingLimits(Math.PI),
        new ImmersiveMapCameraAngleLimits(0, this.maximumPitch),
        false,
      )
    );
  }

  private get displayedBearingDegrees(): number {
    return this.draftBearingDegrees ?? CameraControlMath.degreesFromRadians(this.snapshot.position.bearing);
  }

  private get displayedPitchDegrees(): number {
    return this.draftPitchDegrees ?? CameraControlMath.degreesFromRadians(this.snapshot.position.pitch);
  }

  private subscribe(): void {
    if (this.observerToken !== null) {
      return;
    }
    this.observerToken = this.camera.addCameraSnapshotObserver((snapshot) => this.receive(snapshot));
    const current = this.camera.currentCameraSnapshot();
    if (current !== null) {
      this.receive(current);
    }
  }

  private unsubscribe(): void {
    if (this.observerToken === null) {
      return;
    }
    this.camera.removeCameraSnapshotObserver(this.observerToken);
    this.observerToken = null;
  }

  private receive(snapshot: ImmersiveMapCameraSnapshot): void {
    const previousPosition = this.snapshot.position;
    this.liveSnapshot = snapshot;
    this.livePosition = snapshot.position;
    // While scrubbing the camera chases the target, so the thumb stays on the draft. Sync resumes after release.
    if (!this.isScrubbing && !samePosition(previousPosition, snapshot.position)) {
      this.draftBearingDegrees = null;
      this.draftPitchDegrees = null;
    }
    this.render();
  }

  private setBearing(degrees: number): void {
    const value = CameraControlMath.clampedBearingDegrees(degrees, CameraControlMath.bearingRangeDegrees(this.snapshot));
    this.draftBearingDegrees = value;
    this.apply(value, this.displayedPitchDegrees);
  }

  private setPitch(degrees: number): void {
    const value = CameraControlMath.clampedDegrees(degrees, CameraControlMath.pitchRangeDegrees(this.snapshot));
    this.draftPitchDegrees = value;
    this.apply(this.displayedBearingDegrees, value);
  }

  private apply(bearingDegrees: number, pitchDegrees: number): void {
    const snapshot = this.snapshot;
    const requested = CameraControlMath.positionWithCameraAngles(snapshot.position, bearingDegrees, pitchDegrees);
    const constrained = snapshot.clampedPosition(requested);
    this.livePosition = constrained;
    this.camera.setCameraAngleTarget(constrained.bearing, constrained.pitch);
    this.render();
  }

  private render(): void {
    if (!this.isEnabled) {
      return;
    }
    const snapshot = this.snapshot;
    const bearing = this.displayedBearingDegrees;
    const pitch = this.displayedPitchDegrees;
    const bearingText = CameraControlMath.formattedDegrees(bearing);
    const pitchText = CameraControlMath.formattedDegrees(pitch);
    if (bearingText !== this.renderedBearingReadout) {
      this.renderedBearingReadout = bearingText;
      this.bearingReadout.textContent = bearingText;
    }
    if (pitchText !== this.renderedPitchReadout) {
      this.renderedPitchReadout = pitchText;
      this.pitchReadout.textContent = pitchText;
    }
    this.renderSlider(this.bearingSlider, bearing, CameraControlMath.bearingRangeDegrees(snapshot), bearingText);
    this.renderSlider(this.pitchSlider, pitch, CameraControlMath.pitchRangeDegrees(snapshot), pitchText);
  }

  private renderSlider(slider: ScrubSlider, value: number, range: CameraControlDegreesRange, text: string): void {
    const progress = CameraControlMath.sliderProgress(value, range);
    if (progress !== slider.renderedProgress) {
      slider.renderedProgress = progress;
      const half = CameraControlMath.sliderThumbSize / 2;
      const travel = `(100% - ${CameraControlMath.sliderThumbSize}px) * ${progress}`;
      slider.thumb.style.left = `calc(${travel})`;
      slider.fill.style.width = `calc(${half}px + ${travel})`;
    }
    if (text !== slider.renderedText) {
      slider.renderedText = text;
      slider.element.setAttribute("aria-valuetext", text);
      slider.element.setAttribute("aria-valuenow", String(Math.round(value)));
      slider.element.setAttribute("aria-valuemin", String(Math.round(range.lowerBound)));
      slider.element.setAttribute("aria-valuemax", String(Math.round(range.upperBound)));
    }
  }

  private makeSection(title: string, readout: HTMLSpanElement, buttons: HTMLButtonElement[], slider: ScrubSlider): HTMLDivElement {
    const section = document.createElement("div");
    section.style.cssText = "display:flex;flex-direction:column;gap:10px";
    const heading = document.createElement("div");
    heading.style.cssText = "display:flex;align-items:baseline;justify-content:space-between";
    const label = document.createElement("span");
    label.textContent = title;
    label.style.cssText = "font-size:12px;font-weight:500;color:rgba(255,255,255,0.82)";
    readout.style.cssText = "font-size:12px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:rgba(255,255,255,0.88)";
    heading.append(label, readout);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px";
    row.append(...buttons);
    section.append(heading, row, slider.element);
    return section;
  }

  private makeButton(paths: string, help: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.title = help;
    button.setAttribute("aria-label", help);
    button.style.cssText = [
      "box-sizing:border-box",
      "width:40px",
      "height:34px",
      "padding:0",
      "margin:0",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "color:#fff",
      "background:rgba(255,255,255,0.12)",
      "border:1px solid rgba(255,255,255,0.16)",
      "border-radius:8px",
      "cursor:pointer",
    ].join(";");
    button.append(icon(paths, 15));
    button.addEventListener("click", action, { signal: this.abort.signal });
    return button;
  }

  /**
   * A scrub slider: a press anywhere on it jumps the value under the pointer
   * and captures the pointer until release. The arrow keys step one degree.
   */
  private makeSlider(range: () => CameraControlDegreesRange, current: () => number, onValue: (value: number) => void): ScrubSlider {
    const thumbSize = CameraControlMath.sliderThumbSize;
    const element = document.createElement("div");
    element.setAttribute("role", "slider");
    element.setAttribute("aria-label", "Camera slider");
    element.tabIndex = 0;
    element.style.cssText = "position:relative;height:34px;cursor:pointer;touch-action:none;outline-offset:2px";

    const track = document.createElement("div");
    track.style.cssText = "position:absolute;left:0;right:0;top:13px;height:8px;border-radius:4px;background:rgba(255,255,255,0.14)";
    const fill = document.createElement("div");
    fill.style.cssText = `position:absolute;left:0;top:13px;height:8px;border-radius:4px;background:${accentColor};width:${thumbSize / 2}px`;
    const thumb = document.createElement("div");
    thumb.style.cssText = `position:absolute;left:0;top:6px;width:${thumbSize}px;height:${thumbSize}px;border-radius:50%;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,0.22)`;
    element.append(track, fill, thumb);

    const signal = this.abort.signal;
    let left = 0;
    let width = 0;
    let activePointer: number | null = null;
    const valueAt = (event: PointerEvent): number => CameraControlMath.sliderValue(event.clientX - left, width, range());

    element.addEventListener(
      "pointerdown",
      (event) => {
        if (activePointer !== null || event.button !== 0) {
          return;
        }
        event.preventDefault();
        element.focus({ preventScroll: true });
        activePointer = event.pointerId;
        element.setPointerCapture(event.pointerId);
        // The one layout read of a scrub, at its press.
        const rect = element.getBoundingClientRect();
        left = rect.left;
        width = rect.width;
        this.isScrubbing = true;
        onValue(valueAt(event));
      },
      { signal },
    );
    element.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerId !== activePointer) {
          return;
        }
        onValue(valueAt(event));
      },
      { signal },
    );
    const end = (event: PointerEvent, isCancelled: boolean): void => {
      if (event.pointerId !== activePointer) {
        return;
      }
      activePointer = null;
      if (element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      if (!isCancelled) {
        onValue(valueAt(event));
      }
      this.isScrubbing = false;
    };
    element.addEventListener("pointerup", (event) => end(event, false), { signal });
    element.addEventListener("pointercancel", (event) => end(event, true), { signal });
    element.addEventListener(
      "keydown",
      (event) => {
        const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
        if (step === 0) {
          return;
        }
        event.preventDefault();
        onValue(current() + step);
      },
      { signal },
    );

    return { element, fill, thumb, renderedProgress: null, renderedText: null };
  }
}
