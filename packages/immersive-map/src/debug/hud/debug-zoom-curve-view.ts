// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type ImmersiveMapZoomCurve, zoomCurve, zoomCurveStops } from "../../configuration/zoom-curve.ts";
import type { DebugOverlayPoint, DebugOverlayRect } from "../panel/debug-overlay-geometry.ts";
import { type DebugOverlayZoomCurveAxes, DebugOverlayZoomCurveGraph } from "../panel/debug-overlay-zoom-curve-editing.ts";

/**
 * A value over the camera zoom drawn as a graph in the debug panel and
 * edited on it, the Swift `DebugOverlayZoomCurveView` on a 2D canvas: the
 * zoom runs across, the value up, the curve between its stops as the map
 * reads it, and a dashed line marks the camera's zoom with the value there.
 * A press on empty graph adds a stop that follows the pointer while it is
 * down, a drag moves a stop, and a double press or a secondary press removes
 * one (the last stays). Every change goes out at once through `onChange`,
 * so the map follows the drag. The arithmetic is
 * `DebugOverlayZoomCurveGraph`'s.
 */
export class DebugZoomCurveView {
  readonly element: HTMLCanvasElement;
  private curve: ImmersiveMapZoomCurve = zoomCurve(0);
  private cameraZoom = 0;
  private isEnabled = true;
  private draggedStop: number | undefined;
  private hoveredStop: number | undefined;
  private drawQueued = false;

  constructor(
    private axes: DebugOverlayZoomCurveAxes,
    private readonly valueText: (value: number) => string,
    private readonly onChange: (curve: ImmersiveMapZoomCurve) => void,
  ) {
    const canvas = document.createElement("canvas");
    canvas.className = "imm-debug-curve";
    this.element = canvas;
    canvas.addEventListener("contextmenu", (event) => event.preventDefault());
    canvas.addEventListener("pointerdown", (event) => this.pointerDown(event));
    canvas.addEventListener("pointermove", (event) => this.pointerMove(event));
    canvas.addEventListener("pointerup", (event) => this.pointerUp(event));
    canvas.addEventListener("pointercancel", (event) => this.pointerUp(event));
    // A graph on a tab not shown has no box: it draws once the tab shows it.
    new ResizeObserver(() => this.queueDraw()).observe(canvas);
    canvas.addEventListener("pointerleave", () => {
      if (this.draggedStop === undefined) this.setHovered(undefined);
    });
  }

  /** The curve the map runs with, drawn without firing `onChange`. */
  set(curve: ImmersiveMapZoomCurve): void {
    if (this.draggedStop !== undefined) return;
    this.curve = curve;
    this.queueDraw();
  }

  setCameraZoom(zoom: number): void {
    if (zoom === this.cameraZoom) return;
    this.cameraZoom = zoom;
    this.queueDraw();
  }

  setEnabled(isEnabled: boolean): void {
    if (isEnabled === this.isEnabled) return;
    this.isEnabled = isEnabled;
    this.queueDraw();
  }

  setAxes(axes: DebugOverlayZoomCurveAxes): void {
    this.axes = axes;
    this.queueDraw();
  }

  private get bounds(): DebugOverlayRect {
    return { x: 0, y: 0, width: this.element.clientWidth, height: this.element.clientHeight };
  }

  private point(event: PointerEvent): DebugOverlayPoint {
    const rect = this.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private pointerDown(event: PointerEvent): void {
    const plot = DebugOverlayZoomCurveGraph.plotRect(this.bounds);
    const point = this.point(event);
    if (event.button === 2) {
      this.publish(DebugOverlayZoomCurveGraph.secondaryPressed(this.curve, this.axes, plot, point, this.isEnabled));
      return;
    }
    // A second press soon after the first on the same stop is the double press that removes it.
    const drag = DebugOverlayZoomCurveGraph.pressed(this.curve, this.axes, plot, point, event.detail, this.isEnabled);
    this.draggedStop = drag.draggedStop;
    this.publish(drag.curve);
    if (drag.draggedStop !== undefined) this.element.setPointerCapture(event.pointerId);
  }

  private pointerMove(event: PointerEvent): void {
    const plot = DebugOverlayZoomCurveGraph.plotRect(this.bounds);
    const point = this.point(event);
    if (this.draggedStop !== undefined) {
      const drag = DebugOverlayZoomCurveGraph.dragged(this.curve, this.axes, plot, point, this.draggedStop, this.isEnabled);
      this.draggedStop = drag.draggedStop;
      this.publish(drag.curve);
      return;
    }
    const stops = DebugOverlayZoomCurveGraph.stopPoints(this.curve, this.axes, plot);
    const radius = DebugOverlayZoomCurveGraph.hitRadius;
    let nearest: number | undefined;
    let nearestDistance = Infinity;
    stops.forEach((stop, index) => {
      const distance = Math.hypot(stop.x - point.x, stop.y - point.y);
      if (distance <= radius && distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    });
    this.setHovered(nearest);
  }

  private pointerUp(event: PointerEvent): void {
    if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
    this.draggedStop = undefined;
    this.queueDraw();
  }

  private setHovered(index: number | undefined): void {
    if (index === this.hoveredStop) return;
    this.hoveredStop = index;
    this.queueDraw();
  }

  private publish(curve: ImmersiveMapZoomCurve): void {
    if (curve !== this.curve) {
      this.curve = curve;
      this.onChange(curve);
    }
    this.queueDraw();
  }

  private queueDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  private draw(): void {
    const canvas = this.element;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const scale = devicePixelRatio;
    if (canvas.width !== Math.round(width * scale) || canvas.height !== Math.round(height * scale)) {
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
    }
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, width, height);
    const graph = DebugOverlayZoomCurveGraph;
    const alpha = this.isEnabled ? 1 : graph.disabledAlpha;
    const plot = graph.plotRect({ x: 0, y: 0, width, height });
    const axes = this.axes;

    // The grid: a line and a label every few zooms, the value range's ends at the left.
    context.font = "9px ui-monospace, Menlo, monospace";
    context.lineWidth = 1;
    for (const zoom of graph.gridZooms(axes)) {
      const x = plot.x + ((zoom - axes.zoomRange.lowerBound) / (axes.zoomRange.upperBound - axes.zoomRange.lowerBound)) * plot.width;
      context.strokeStyle = `rgba(255,255,255,${0.1 * alpha})`;
      context.beginPath();
      context.moveTo(x, plot.y);
      context.lineTo(x, plot.y + plot.height);
      context.stroke();
      context.fillStyle = `rgba(255,255,255,${0.5 * alpha})`;
      const label = graph.gridZoomLabel(zoom);
      context.fillText(label, x - context.measureText(label).width / 2, plot.y + plot.height + 10);
    }
    const lower = this.valueText(axes.valueRange.lowerBound);
    const upper = this.valueText(axes.valueRange.upperBound);
    context.fillText(upper, Math.max(0, plot.x - context.measureText(upper).width - 4), plot.y + 6);
    context.fillText(lower, Math.max(0, plot.x - context.measureText(lower).width - 4), plot.y + plot.height);
    context.strokeStyle = `rgba(255,255,255,${0.2 * alpha})`;
    context.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.width - 1, plot.height - 1);

    // The curve as the map reads it.
    const points = graph.curvePoints(this.curve, axes, plot);
    context.strokeStyle = `rgba(255,255,255,${0.85 * alpha})`;
    context.lineWidth = 1.5;
    context.beginPath();
    points.forEach((point, index) => (index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y)));
    context.stroke();

    // The camera's zoom and the value there.
    const marker = graph.cameraMarker(this.curve, axes, plot, this.cameraZoom);
    context.strokeStyle = `rgba(255,149,0,${alpha})`;
    context.fillStyle = `rgba(255,149,0,${alpha})`;
    context.lineWidth = 1;
    context.setLineDash([3, 2]);
    context.beginPath();
    context.moveTo(marker.x, plot.y);
    context.lineTo(marker.x, plot.y + plot.height);
    context.stroke();
    context.setLineDash([]);
    context.beginPath();
    context.arc(marker.x, marker.y, 3, 0, Math.PI * 2);
    context.fill();

    // The stops, the hovered or dragged one larger and labelled.
    const stops = zoomCurveStops(this.curve);
    graph.stopPoints(this.curve, axes, plot).forEach((centre, index) => {
      const isActive = index === this.hoveredStop || index === this.draggedStop;
      const radius = isActive ? graph.stopRadius + graph.activeStopGrowth : graph.stopRadius;
      context.fillStyle = isActive ? `rgba(10,132,255,${alpha})` : `rgba(255,255,255,${alpha})`;
      context.beginPath();
      context.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
      context.fill();
      const stop = stops[index];
      if (!isActive || stop === undefined) return;
      context.font = "600 10px ui-monospace, Menlo, monospace";
      const text = graph.stopLabel(stop, this.valueText);
      const size = { width: context.measureText(text).width, height: 12 };
      const origin = graph.stopLabelOrigin(centre, size.width, size.height, plot);
      context.fillStyle = "rgba(0,0,0,0.7)";
      context.fillRect(origin.x - 3, origin.y - 1, size.width + 6, size.height + 2);
      context.fillStyle = "#fff";
      context.fillText(text, origin.x, origin.y + 10);
    });
  }
}
