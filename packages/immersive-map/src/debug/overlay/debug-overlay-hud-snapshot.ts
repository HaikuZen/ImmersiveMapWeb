// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapCameraState } from "../../camera/immersive-map-camera-state.ts";
import type { Rgb } from "../../configuration/color.ts";
import type { DebugSettings } from "../../configuration/view-settings.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { DebugFrameReport } from "../../render/debug/debug-frame-report.ts";
import { DebugOverlayHUDContentRequest } from "../../render/debug/debug-overlay-hud-snapshot-store.ts";
import type { GroundReliefStatusSnapshot } from "../../tile/relief/store/ground-relief-status-snapshot.ts";
import type { Tile } from "../../tile/tile.ts";
import type { FlatRingBand } from "../../tile/visibility/flat-ring-rules.ts";
import { DebugOverlayReliefCoverage } from "./debug-overlay-relief-coverage.ts";
import { type DebugOverlayCoordinateLines, type DebugOverlayFrameDiagnostics, DebugOverlayText } from "./debug-overlay-text.ts";
import { DebugOverlayTileCoverage } from "./debug-overlay-tile-coverage.ts";

/**
 * The loader's status as the HUD shows it (the Swift
 * `TileLoadingStatusSnapshot`'s `lines` and `tiles`), generic over the row
 * the reporter hands out.
 */
export interface DebugOverlayTileLoadingStatus<Row> {
  readonly lines: readonly string[];
  readonly tiles: readonly Row[];
}

/**
 * What the debug panel shows for one frame (the Swift
 * `DebugOverlayHUDSnapshot`): the coordinate lines, the diagnostics lines,
 * the loader's rows, the panel's text settings, the zooms and the view's
 * compass direction, and the coverage maps of the tabs shown.
 */
export interface DebugOverlayHUDSnapshot<Row = unknown> {
  readonly coordinateLines: DebugOverlayCoordinateLines;
  readonly diagnosticsLines: readonly string[];
  readonly tileLoadingStatusLines: readonly string[];
  readonly tileLoadingStatusTiles: readonly Row[];
  readonly coordinateScale: number;
  readonly diagnosticsScale: number;
  readonly leftPadding: number;
  readonly topPadding: number;
  readonly sectionSpacing: number;
  readonly textColor: Rgb;
  /**
   * The planning zoom as a number, for the controls that read a value off a
   * zoom curve (the ground fog group), which the frame reads at that zoom.
   */
  readonly cameraZoom: number;
  /** The camera's own zoom as a number, for the zoom badge, which shows it beside `cameraZoom`. */
  readonly zoom: number;
  /** The compass direction the camera looks in, in degrees clockwise from north: the sun picker turns with it. */
  readonly viewAzimuthDegrees: number;
  /** The frame's tile coverage from above, for the panel's coverage map, `undefined` with the tiles tab not shown. */
  readonly tileCoverage: DebugOverlayTileCoverage | undefined;
  /** The terrain store's status, `undefined` with the relief off or its tab not shown. */
  readonly reliefStatus: GroundReliefStatusSnapshot | undefined;
  /** The terrain from above, for the relief tab's map. */
  readonly reliefCoverage: DebugOverlayReliefCoverage | undefined;
}

/** The inputs of `DebugOverlayHUDSnapshot.make`, the Swift `make`'s arguments. */
export interface DebugOverlayHUDSnapshotInput<Row> {
  readonly settings: DebugSettings;
  readonly zoom: number;
  /** Defaults to `zoom`. */
  readonly planningZoom?: number | undefined;
  readonly viewAzimuthDegrees?: number | undefined;
  readonly latitude: number;
  readonly longitude: number;
  readonly cameraDebugLines: readonly string[];
  readonly diagnostics: DebugOverlayFrameDiagnostics | undefined;
  readonly tileLoadingStatus?: DebugOverlayTileLoadingStatus<Row> | undefined;
  readonly tileCoverage?: DebugOverlayTileCoverage | undefined;
  readonly reliefStatus?: GroundReliefStatusSnapshot | undefined;
  readonly reliefCoverage?: DebugOverlayReliefCoverage | undefined;
  /** What the panel shows (`DebugOverlayHUDSnapshotStore.requestedContent`), all of it by default. */
  readonly content?: DebugOverlayHUDContentRequest | undefined;
}

const twoDigits = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A value as the camera lines print it: two decimals. */
function format(value: number): string {
  return twoDigits.format(value);
}

export const DebugOverlayHUDSnapshot = {
  /** The snapshot, `undefined` with the panel off. What the panel does not show (`content`) is left empty. */
  make<Row>(input: DebugOverlayHUDSnapshotInput<Row>): DebugOverlayHUDSnapshot<Row> | undefined {
    const settings = input.settings;
    if (!settings.enableDebugPanel) return undefined;
    const content = input.content ?? DebugOverlayHUDContentRequest.all;
    const has = (part: DebugOverlayHUDContentRequest): boolean => DebugOverlayHUDContentRequest.contains(content, part);
    const tileLoadingStatus = has(DebugOverlayHUDContentRequest.tiles) ? input.tileLoadingStatus : undefined;
    return {
      coordinateLines: DebugOverlayText.makeCoordinateTextLines(input.zoom, input.latitude, input.longitude),
      diagnosticsLines: has(DebugOverlayHUDContentRequest.stats) ? DebugOverlayText.makeOverlayDiagnosticsTextLines(input.cameraDebugLines, input.diagnostics) : [],
      tileLoadingStatusLines: tileLoadingStatus?.lines ?? [],
      tileLoadingStatusTiles: tileLoadingStatus?.tiles ?? [],
      coordinateScale: settings.coordinateScale,
      diagnosticsScale: settings.diagnosticsScale,
      leftPadding: settings.leftPadding,
      topPadding: settings.topPadding,
      sectionSpacing: settings.sectionSpacing,
      textColor: settings.textColor,
      cameraZoom: input.planningZoom ?? input.zoom,
      zoom: input.zoom,
      viewAzimuthDegrees: input.viewAzimuthDegrees ?? 0,
      tileCoverage: has(DebugOverlayHUDContentRequest.tiles) ? input.tileCoverage : undefined,
      reliefStatus: has(DebugOverlayHUDContentRequest.relief) ? input.reliefStatus : undefined,
      reliefCoverage: has(DebugOverlayHUDContentRequest.relief) ? input.reliefCoverage : undefined,
    };
  },

  /**
   * The frame's snapshot for the panel's `content`: the rest is left empty
   * and never built. The terrain store's status is read off the frame's
   * relief only for the relief tab.
   */
  fromFrame<Row>(
    settings: DebugSettings,
    report: DebugFrameReport,
    tileLoadingStatus?: DebugOverlayTileLoadingStatus<Row>,
    content: DebugOverlayHUDContentRequest = DebugOverlayHUDContentRequest.all,
  ): DebugOverlayHUDSnapshot<Row> | undefined {
    if (!settings.enableDebugPanel) return undefined;
    const has = (part: DebugOverlayHUDContentRequest): boolean => DebugOverlayHUDContentRequest.contains(content, part);
    const camera = report.mapCameraState;
    const position = ImmersiveMapCameraState.cameraPosition(camera);
    const reliefStatus = has(DebugOverlayHUDContentRequest.relief) ? report.reliefFrame?.statusSnapshot() : undefined;
    if (reliefStatus !== undefined) reliefStatus.surroundings = report.terrainSurroundings;
    const viewCoverage = has(DebugOverlayHUDContentRequest.tiles) || reliefStatus !== undefined ? DebugOverlayTileCoverage.make(report) : undefined;
    return DebugOverlayHUDSnapshot.make({
      settings,
      zoom: camera.zoom,
      planningZoom: report.planningZoom,
      viewAzimuthDegrees: DebugOverlayHUDSnapshot.viewAzimuthDegrees(camera.bearing),
      latitude: position.latitudeDegrees,
      longitude: position.longitudeDegrees,
      cameraDebugLines: has(DebugOverlayHUDContentRequest.stats) ? DebugOverlayHUDSnapshot.cameraDebugLines(report) : [],
      diagnostics: DebugOverlayHUDSnapshot.frameDiagnostics(report),
      tileLoadingStatus,
      tileCoverage: has(DebugOverlayHUDContentRequest.tiles) ? viewCoverage : undefined,
      reliefStatus,
      reliefCoverage: reliefStatus !== undefined && viewCoverage !== undefined ? DebugOverlayReliefCoverage.make(reliefStatus, viewCoverage) : undefined,
      content,
    });
  },

  /** The same frame snapshot with the tile list read again from the reporter: what the panel applies between frames. */
  replacingTileLoadingStatus<Row>(snapshot: DebugOverlayHUDSnapshot<Row>, status: DebugOverlayTileLoadingStatus<Row> | undefined): DebugOverlayHUDSnapshot<Row> {
    return { ...snapshot, tileLoadingStatusLines: status?.lines ?? [], tileLoadingStatusTiles: status?.tiles ?? [] };
  },

  /** Whether two snapshots show the same: structural equality of their plain data, the Swift `Equatable`. */
  isEqual<Row>(lhs: DebugOverlayHUDSnapshot<Row>, rhs: DebugOverlayHUDSnapshot<Row>): boolean {
    return deepEqual(lhs, rhs);
  },

  /**
   * The compass direction the camera looks in, in degrees clockwise from
   * north, 0 to 360: the camera turned by `bearingRadians` sees the world
   * rotated by it (`ZoomAnchorMath`), so its view is the bearing's opposite
   * turn. What the panel's sun picker turns its disc by.
   */
  viewAzimuthDegrees(bearingRadians: number): number {
    const degrees = ((-bearingRadians * 180) / Math.PI) % 360;
    return degrees < 0 ? degrees + 360 : degrees + 0;
  },

  /** The web frame's numbers for the diagnostics sections. */
  frameDiagnostics(report: DebugFrameReport): DebugOverlayFrameDiagnostics {
    return {
      frameIndex: report.frameIndex,
      frameDeltaSeconds: report.timings.frameDeltaSeconds,
      cpuMilliseconds: report.timings.cpuMilliseconds,
      gpuMilliseconds: report.timings.gpuMilliseconds,
      drawCount: report.timings.drawCount,
      tiles: report.tiles,
      pending: report.pending,
      labelCounts: report.labelCounts,
    };
  },

  /** The camera's lines, one value a line, so a reader finds the one they watch. */
  cameraDebugLines(report: DebugFrameReport): string[] {
    const camera = report.mapCameraState;
    const pitchDegrees = (camera.pitch * 180.0) / Math.PI;
    const bearingDegrees = (camera.bearing * 180.0) / Math.PI;
    const surface = report.renderSurfaceMode === "spherical" ? "globe" : "flat";
    const eye = report.cameraEye;
    const lines = [
      `camera z:${format(camera.zoom)}`,
      `planning z:${format(report.planningZoom)}`,
      `animated z:${format(report.animatedZoom)}`,
      `pitch:${format(pitchDegrees)}`,
      `bearing:${format(bearingDegrees)}`,
      `surface:${surface}`,
      `transition:${format(report.transition)}`,
      `viewport:${Math.trunc(report.drawWidth)}x${Math.trunc(report.drawHeight)}`,
      `eye x:${format(eye[0])}`,
      `eye y:${format(eye[1])}`,
      `eye z:${format(eye[2])}`,
      ...DebugOverlayHUDSnapshot.reliefLines(report),
    ];
    const follow = report.terrainFollowReport;
    if (follow !== undefined && report.renderSurfaceMode === "flat") {
      lines.push(`follow:${follow.path}`, `arm:${format(follow.armMetres)}m`, `clear:${format(follow.clearedZoomDelta)}`);
    }
    lines.push(
      DebugOverlayHUDSnapshot.ringRulesLine(report.flatRingBands),
      DebugOverlayHUDSnapshot.zoomCountsLine(
        "targetZ",
        report.placements.map((placeTile) => placeTile.placeIn.tile),
      ),
      DebugOverlayHUDSnapshot.zoomCountsLine(
        "srcZ",
        report.placements.map((placeTile) => placeTile.resident.tile),
      ),
    );
    return lines;
  },

  /**
   * The ground relief under the camera: the terrain under the point it looks
   * at, the datum the relief is drawn from, and the eye's own altitude over
   * the sea in the terrain's metres as drawn, which a pan over the relief
   * keeps (`CameraTerrainFollow`). Empty without a relief or off the flat
   * map.
   */
  reliefLines(report: Pick<DebugFrameReport, "reliefFrame" | "renderSurfaceMode" | "mapCameraState" | "flatRenderState" | "cameraEye" | "tileZoomLevel">): string[] {
    const relief = report.reliefFrame;
    if (relief === undefined || report.renderSurfaceMode !== "flat") return [];
    const centre = report.mapCameraState.centerWorldMercator;
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(centre[1]);
    const unitsPerMetre = ImmersiveMapProjection.worldUnitsPerMeter(latitude, report.flatRenderState.renderMapSize);
    const eyeHeightMetres = report.cameraEye[2] / unitsPerMetre;
    const strength = relief.strengthAt(centre, relief.terrainZoom(report.tileZoomLevel));
    return [
      `relief:${relief.isActive ? "on" : "off"}`,
      `datum:${format(relief.datumMetres)}m`,
      `eye alt:${format(relief.datumMetres + eyeHeightMetres)}m`,
      `eye height:${format(eyeHeightMetres)}m`,
      `strength:x${strength === undefined ? "-" : format(strength)}`,
    ];
  },

  /**
   * The ring rules as the frame resolved them on either surface, nearest
   * first: each band's zoom, last ring and tile count. "rules: none" for a
   * frame with no coverage.
   */
  ringRulesLine(bands: readonly FlatRingBand[]): string {
    if (bands.length === 0) return "rules: none";
    return `rules: ${bands.map((band) => `z${band.zoom} ≤${band.distance} (${band.tileCount})`).join(" / ")}`;
  },

  /** How many of `tiles` each zoom has, coarsest first: `title: z12:4 z13:9`, or `title: none`. */
  zoomCountsLine(title: string, tiles: readonly Tile[]): string {
    const counts = new Map<number, number>();
    for (const tile of tiles) counts.set(tile.z, (counts.get(tile.z) ?? 0) + 1);
    const text = [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([zoom, count]) => `z${zoom}:${count}`)
      .join(" ");
    return `${title}: ${text === "" ? "none" : text}`;
  },
} as const;

function deepEqual(lhs: unknown, rhs: unknown): boolean {
  if (Object.is(lhs, rhs)) return true;
  if (typeof lhs !== "object" || typeof rhs !== "object" || lhs === null || rhs === null) return false;
  if (Array.isArray(lhs) !== Array.isArray(rhs)) return false;
  const lhsKeys = Object.keys(lhs);
  const rhsKeys = Object.keys(rhs);
  if (lhsKeys.length !== rhsKeys.length) return false;
  for (const key of lhsKeys) {
    if (!Object.hasOwn(rhs, key)) return false;
    if (!deepEqual((lhs as Record<string, unknown>)[key], (rhs as Record<string, unknown>)[key])) return false;
  }
  return true;
}
