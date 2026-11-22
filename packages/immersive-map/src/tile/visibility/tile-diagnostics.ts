// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** The counters the coverage and the working set report, by the Swift engine's names. */
export type TileDiagnosticCounter =
  | "globeCullingVisitedNodes"
  | "globeCullingFrustumRejects"
  | "globeCullingHorizonRejects"
  | "globeCullingPlacedTiles"
  | "globeCullingAcceptedWholeSubtrees"
  | "visibleTiles"
  | "readyTiles"
  | "requestedTiles"
  | "renderedTiles";

/** The measurements the coverage reports. */
export type TileDiagnosticMeasurement = "globeCullingDurationMs";

/** Where the coverage and the working set write the frame's figures, for a debug overlay. */
export interface TileDiagnostics {
  setCounter(name: TileDiagnosticCounter, value: number): void;
  setMeasurement(name: TileDiagnosticMeasurement, value: number): void;
}
