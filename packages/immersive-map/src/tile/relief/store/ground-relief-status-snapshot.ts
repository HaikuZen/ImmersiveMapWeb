// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ClosedRange } from "../../../math/closed-range.ts";
import type { Tile } from "../../tile.ts";
import type { ImmersiveMapTerrainSurroundings } from "../lifts/terrain-surroundings.ts";

/** Where a terrain tile the store wants or keeps is: waiting for a load slot, loading, in memory, or failed and waiting out its pause. */
export type GroundReliefTileState = "queued" | "loading" | "resident" | "failed";

export interface GroundReliefTileStatus {
  readonly tile: Tile;
  readonly state: GroundReliefTileState;
  /** The tile's place in the frame's demand, nearest first from 0, `undefined` for one kept from earlier frames. */
  readonly priority: number | undefined;
  /** What it costs in memory, zero until it is in. */
  readonly bytes: number;
  /** Its lowest and highest heights in metres, once it is in. */
  readonly heightRange: ClosedRange | undefined;
  /** Seconds the load has run, or till the next attempt of a failed one. */
  readonly seconds: number;
  /** The failed attempts so far. */
  readonly attempts: number;
}

export interface GroundReliefStatusFields {
  readonly tiles: readonly GroundReliefTileStatus[];
  readonly isActive: boolean;
  readonly standingShare: number;
  readonly datumMetres: number;
  readonly cameraTerrainZoom: number;
  readonly terrainByRing: string;
  readonly wantedCount: number;
  readonly wantedResidentCount: number;
  readonly residentCount: number;
  readonly residentBytes: number;
  readonly releasedCount: number;
  readonly releasedBytes: number;
  readonly releasedCacheBytes: number;
  readonly occlusionComputedCount: number;
  readonly occlusionMillisecondsLast: number;
  readonly loadingCount: number;
  readonly maximumConcurrentLoads: number;
  readonly failedCount: number;
  readonly missingCount: number;
}

/**
 * What the terrain store holds and does at a moment
 * (`GroundReliefFrame.statusSnapshot`), for the debug panel's relief tab, a
 * port of the Swift `GroundReliefStatusSnapshot`: every terrain tile the
 * frame wants or the store keeps, and the totals, as the panel's lines.
 */
export class GroundReliefStatusSnapshot implements GroundReliefStatusFields {
  readonly tiles: readonly GroundReliefTileStatus[];
  readonly isActive: boolean;
  readonly standingShare: number;
  readonly datumMetres: number;
  readonly cameraTerrainZoom: number;
  readonly terrainByRing: string;
  readonly wantedCount: number;
  readonly wantedResidentCount: number;
  readonly residentCount: number;
  readonly residentBytes: number;
  readonly releasedCount: number;
  readonly releasedBytes: number;
  readonly releasedCacheBytes: number;
  readonly occlusionComputedCount: number;
  readonly occlusionMillisecondsLast: number;
  readonly loadingCount: number;
  readonly maximumConcurrentLoads: number;
  readonly failedCount: number;
  readonly missingCount: number;
  /** The country around the camera as the frame read it, `undefined` off the terrain or before the terrain under the camera is in. */
  surroundings: ImmersiveMapTerrainSurroundings | undefined;

  constructor(fields: GroundReliefStatusFields, surroundings?: ImmersiveMapTerrainSurroundings) {
    this.tiles = fields.tiles;
    this.isActive = fields.isActive;
    this.standingShare = fields.standingShare;
    this.datumMetres = fields.datumMetres;
    this.cameraTerrainZoom = fields.cameraTerrainZoom;
    this.terrainByRing = fields.terrainByRing;
    this.wantedCount = fields.wantedCount;
    this.wantedResidentCount = fields.wantedResidentCount;
    this.residentCount = fields.residentCount;
    this.residentBytes = fields.residentBytes;
    this.releasedCount = fields.releasedCount;
    this.releasedBytes = fields.releasedBytes;
    this.releasedCacheBytes = fields.releasedCacheBytes;
    this.occlusionComputedCount = fields.occlusionComputedCount;
    this.occlusionMillisecondsLast = fields.occlusionMillisecondsLast;
    this.loadingCount = fields.loadingCount;
    this.maximumConcurrentLoads = fields.maximumConcurrentLoads;
    this.failedCount = fields.failedCount;
    this.missingCount = fields.missingCount;
    this.surroundings = surroundings;
  }

  /** The frame on the terrain or off it, how far the relief has risen and the datum: the panel's Relief group. */
  get stateLines(): string[] {
    return [`relief: ${this.isActive ? "on the terrain" : "off the terrain"}`, `standing ${fixed(this.standingShare, 2)}`, `datum ${fixed(this.datumMetres, 0)} m`];
  }

  /** What the frame wants and how the loads go: the panel's Terrain loading group. */
  get loadingLines(): string[] {
    return [
      `wanted ${this.wantedCount}`,
      `wanted and in ${this.wantedResidentCount}`,
      `loading ${this.loadingCount} of ${this.maximumConcurrentLoads}`,
      `failed ${this.failedCount}`,
      `missing ${this.missingCount}`,
    ];
  }

  /** What the store keeps and which maps it reads: the panel's Terrain memory group. */
  get memoryLines(): string[] {
    const megabytes = (bytes: number) => fixed(bytes / 1_048_576, 1);
    return [
      `in memory ${this.residentCount} tiles, ${megabytes(this.residentBytes)} MB`,
      `released ${this.releasedCount} tiles, ${megabytes(this.releasedBytes)} of ${megabytes(this.releasedCacheBytes)} MB`,
      `camera map z${this.cameraTerrainZoom}`,
      `terrain by ring ${this.terrainByRing === "" ? "none" : this.terrainByRing}`,
    ];
  }

  /** The occlusion of the sky as computed: the panel's AO tab. */
  get occlusionLines(): string[] {
    return [`computed ${this.occlusionComputedCount} of ${this.residentCount} tiles`, `last tile ${fixed(this.occlusionMillisecondsLast, 1)} ms`];
  }

  /** The country around the camera as read: "waiting for terrain" on the terrain before the reading, "off the terrain" otherwise. */
  get surroundingsLines(): string[] {
    const surroundings = this.surroundings;
    if (surroundings === undefined) return [`around: ${this.isActive ? "waiting for terrain" : "off the terrain"}`];
    return [
      `around: ${surroundings.kind}`,
      `span ${fixed(surroundings.heightSpanMetres, 0)} m`,
      `mountainousness ${fixed(surroundings.mountainousness, 2)}`,
      `ground ${fixed(surroundings.groundMetres, 0)} m`,
    ];
  }

  /** Every group's lines in turn. */
  get lines(): string[] {
    return [...this.stateLines, ...this.loadingLines, ...this.memoryLines, ...this.surroundingsLines];
  }
}

/**
 * A value with `digits` digits after the point, as the Swift lines' `%.Nf`
 * prints it: a value exactly halfway between two such numbers rounds to
 * the even one, where `toFixed` takes the larger (3.25 is "3.2", not "3.3").
 */
function fixed(value: number, digits: number): string {
  const rounded = value.toFixed(digits);
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return rounded;
  // The value's exact decimal digits: a tie is the digit 5 with nothing after it.
  const exact = value.toFixed(100);
  const point = exact.indexOf(".");
  const rest = exact.slice(point + 1 + digits);
  if (!/^50*$/.test(rest)) return rounded;
  const truncated = exact.slice(0, digits === 0 ? point : point + 1 + digits);
  const lastDigit = Number(truncated.at(-1));
  return lastDigit % 2 === 0 ? truncated : rounded;
}
