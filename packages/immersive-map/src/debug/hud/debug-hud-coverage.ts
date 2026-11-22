// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgb } from "../../configuration/color.ts";
import type { Vec2 } from "../../math/vec.ts";
import { DebugOverlayReliefCoverage, DebugOverlayReliefCoverageSquare } from "../overlay/debug-overlay-relief-coverage.ts";
import { type DebugOverlayTileCoverage, DebugOverlayTileCoverageLayout, DebugOverlayTileCoveragePlacement, type DebugRect } from "../overlay/debug-overlay-tile-coverage.ts";
import { DebugTileZoomPalette } from "../overlay/debug-tile-zoom-palette.ts";

const css = (color: Rgb, alpha: number) => `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${alpha})`;

/** The canvas sized to its box in device pixels and its context in CSS pixels, `undefined` while it has no box. */
function prepare(canvas: HTMLCanvasElement): { context: CanvasRenderingContext2D; side: number } | undefined {
  const side = canvas.clientWidth;
  if (side === 0) return undefined;
  const pixels = Math.round(side * devicePixelRatio);
  if (canvas.width !== pixels || canvas.height !== pixels) [canvas.width, canvas.height] = [pixels, pixels];
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, side, side);
  return { context, side };
}

/** The view's footprint, the point looked at and the eye, over the squares. */
function drawView(context: CanvasRenderingContext2D, view: { readonly footprint: readonly Vec2[]; readonly center: Vec2; readonly eye: Vec2 | undefined }, window: DebugRect, side: number): void {
  const layout = DebugOverlayTileCoverageLayout;
  if (view.footprint.length > 2) {
    context.beginPath();
    view.footprint.forEach((point, index) => {
      const [x, y] = layout.point(point, window, side);
      if (index === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    });
    context.closePath();
    context.fillStyle = `rgba(255,255,255,${layout.footprintFillAlpha})`;
    context.fill();
    context.strokeStyle = "rgba(255,255,255,0.8)";
    context.lineWidth = layout.footprintLineWidth;
    context.stroke();
  }
  const marker = (point: Vec2, color: string) => {
    const [x, y] = layout.point(point, window, side);
    context.fillStyle = color;
    context.beginPath();
    context.arc(x, y, layout.markerRadius, 0, Math.PI * 2);
    context.fill();
  };
  marker(view.center, "#ff9500");
  if (view.eye !== undefined) marker(view.eye, "#0a84ff");
}

/**
 * The tiles tab's coverage map (the Swift panel's coverage view): every
 * slot as its square in its zoom's colour, a stand-in's slot labelled with
 * its source, the view's footprint, the point looked at and the eye, north
 * up, never stretched.
 */
export function drawDebugTileCoverage(canvas: HTMLCanvasElement, coverage: DebugOverlayTileCoverage | undefined): void {
  const prepared = prepare(canvas);
  if (prepared === undefined || coverage === undefined) return;
  const { context, side } = prepared;
  const layout = DebugOverlayTileCoverageLayout;
  const window = layout.window(coverage);
  context.save();
  context.beginPath();
  context.rect(0, 0, side, side);
  context.clip();
  context.font = `${layout.labelFontSize}px ui-monospace, Menlo, monospace`;
  for (const placement of layout.drawingOrder(coverage.placements)) {
    const rect = layout.rect(DebugOverlayTileCoveragePlacement.square(placement), window, side);
    const color = DebugTileZoomPalette.color(placement.slot.z);
    context.fillStyle = css(color, layout.tileFillAlpha);
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    context.strokeStyle = css(color, 0.9);
    context.lineWidth = layout.tileLineWidth;
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
    if (rect.width < layout.labelledSquareSide) continue;
    context.fillStyle = "#fff";
    context.fillText(`z${placement.slot.z}`, rect.x + 3, rect.y + 10);
    if (DebugOverlayTileCoveragePlacement.isStandIn(placement) && rect.width >= layout.sourceLabelledSquareSide) {
      context.fillStyle = css(DebugTileZoomPalette.color(placement.source.z), 1);
      context.fillText(`from z${placement.source.z}`, rect.x + 3, rect.y + 21);
    }
  }
  drawView(context, coverage, window, side);
  context.restore();
}

const reliefStateColor: Record<string, Rgb> = { resident: [0.2, 0.78, 0.35], loading: [1, 0.84, 0.04], queued: [0.6, 0.6, 0.6], failed: [1, 0.27, 0.23] };

/** The relief tab's map: every terrain tile the store lists by its state, the wanted strong and the kept faint, over the view. */
export function drawDebugReliefCoverage(canvas: HTMLCanvasElement, coverage: DebugOverlayReliefCoverage | undefined): void {
  const prepared = prepare(canvas);
  if (prepared === undefined || coverage === undefined) return;
  const { context, side } = prepared;
  const layout = DebugOverlayTileCoverageLayout;
  const window = DebugOverlayReliefCoverage.window(coverage);
  context.save();
  context.beginPath();
  context.rect(0, 0, side, side);
  context.clip();
  for (const square of DebugOverlayReliefCoverage.drawingOrder(coverage)) {
    const rect = layout.rect(DebugOverlayReliefCoverageSquare.square(square), window, side);
    const color = reliefStateColor[square.state] ?? [1, 1, 1];
    context.fillStyle = css(color, square.isWanted ? 0.35 : 0.1);
    context.fillRect(rect.x, rect.y, rect.width, rect.height);
    context.strokeStyle = css(color, square.isWanted ? 0.9 : 0.35);
    context.lineWidth = layout.tileLineWidth;
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  }
  drawView(context, coverage, window, side);
  context.restore();
}
