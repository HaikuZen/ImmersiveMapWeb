// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * What the country around the point the camera looks at is like, read off
 * the relief's own heights: mountains or a plain, a port of the Swift
 * `ImmersiveMapTerrainSurroundings`. Reported through
 * `ImmersiveMap.onTerrainSurroundingsChange` whenever it changes, `null`
 * while the map is off the terrain (the relief disabled, collapsed by the
 * zoom, or the globe on screen), for the effects an app turns on in the
 * mountains: a mountain atmosphere, a thinner air, a different light.
 *
 * The reading is the span of the terrain's heights, its highest less its
 * lowest, over a disc of `TerrainSurroundingsSettings.sampleRadiusMetres`
 * around the point the camera looks at, smoothed over time
 * (`smoothingHalfLife`) so a pan does not flicker it. `mountainousness`
 * places the span between the settings' two thresholds, and `kind` is a
 * switch over the same thresholds with the band between them as its
 * hysteresis: it rises to `"mountains"` once the span passes
 * `mountainsAboveMetres` and falls back to `"plain"` once the span is under
 * `plainBelowMetres`, and holds in between.
 */
export interface ImmersiveMapTerrainSurroundings {
  /** Mountains or a plain, with the hysteresis described above. */
  readonly kind: "plain" | "mountains";
  /** How mountainous the country is, 0 on a plain and 1 in the mountains, linear between the settings' two thresholds. */
  readonly mountainousness: number;
  /** The span of the terrain's heights over the sampled disc, in metres, as smoothed. */
  readonly heightSpanMetres: number;
  /** The terrain under the point the camera looks at, in metres over the sea, the height the relief is drawn from. */
  readonly groundMetres: number;
}

/** Whether two readings are the same: the event fires only when the reading changes. */
export function terrainSurroundingsEqual(lhs: ImmersiveMapTerrainSurroundings | null, rhs: ImmersiveMapTerrainSurroundings | null): boolean {
  if (lhs === null || rhs === null) return lhs === rhs;
  return lhs.kind === rhs.kind && lhs.mountainousness === rhs.mountainousness && lhs.heightSpanMetres === rhs.heightSpanMetres && lhs.groundMetres === rhs.groundMetres;
}
