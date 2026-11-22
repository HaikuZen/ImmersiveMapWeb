// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapProjection } from "../../../geo/immersive-map-projection.ts";
import type { ClosedRange } from "../../../math/closed-range.ts";
import type { Vec2 } from "../../../math/vec.ts";
import type { Tile } from "../../tile.ts";
import { GroundRelief } from "../lifts/ground-relief.ts";
import type { GroundReliefStatusSnapshot } from "../store/ground-relief-status-snapshot.ts";
import type { GroundReliefStore } from "../store/ground-relief-store.ts";
import type { GroundReliefHillshade } from "./ground-relief-hillshade.ts";

/**
 * What the mountains' shadow in the map is drawn from: the terrain tiles in
 * and their welds (`version`), the rise, the world scale and the datum the
 * ground is drawn from. The map is drawn again when it changes
 * (`ShadowMapReuseController`).
 */
export interface GroundReliefShadowSignature {
  readonly version: number;
  readonly strength: number;
  readonly worldUnitsPerMetre: number;
  readonly datumMetres: number;
}

export interface GroundReliefFrameValues {
  readonly isActive: boolean;
  readonly strength: number;
  readonly standingShare: number;
  readonly datumMetres: number;
  readonly worldUnitsPerMetre: number;
  readonly hillshade: GroundReliefHillshade;
  /** The strength the fills darken by where the terrain hides the sky (x), and whether they draw the occlusion alone (y). */
  readonly occlusionUniform: readonly [number, number, number, number];
  readonly castsShadows: boolean;
  readonly fromTileZoom: number;
  readonly collapseTileZoom: number;
}

/**
 * The ground relief of one frame, as everything of the frame reads it, a
 * port of the Swift `GroundReliefFrame`: the values the frame draws the
 * relief by, settled once (`GroundReliefFrameState.frame`), and the terrain
 * tiles in read through them. Whatever reads it reads one frame's relief
 * throughout.
 *
 * Off the terrain (`isActive` false) every tile and whatever stands on it
 * lies on the plane: no relief is handed out, and every height reads 0.
 */
export class GroundReliefFrame implements GroundReliefFrameValues {
  readonly isActive: boolean;
  readonly strength: number;
  readonly standingShare: number;
  readonly datumMetres: number;
  readonly worldUnitsPerMetre: number;
  readonly hillshade: GroundReliefHillshade;
  readonly occlusionUniform: readonly [number, number, number, number];
  readonly castsShadows: boolean;
  readonly fromTileZoom: number;
  readonly collapseTileZoom: number;

  constructor(
    private readonly store: GroundReliefStore,
    values: GroundReliefFrameValues,
  ) {
    this.isActive = values.isActive;
    this.strength = values.strength;
    this.standingShare = values.standingShare;
    this.datumMetres = values.datumMetres;
    this.worldUnitsPerMetre = values.worldUnitsPerMetre;
    this.hillshade = values.hillshade;
    this.occlusionUniform = values.occlusionUniform;
    this.castsShadows = values.castsShadows;
    this.fromTileZoom = values.fromTileZoom;
    this.collapseTileZoom = values.collapseTileZoom;
  }

  // MARK: The terrain in

  get version(): number {
    return this.store.version;
  }

  get heightRangeMetres(): ClosedRange | undefined {
    return this.store.heightRangeMetres;
  }

  get cameraTerrainZoom(): number {
    return this.store.cameraTerrainZoom;
  }

  terrainZoom(forTargetZoom: number): number {
    return this.store.terrainZoom(forTargetZoom);
  }

  /** What the mountains' shadow is drawn from, `undefined` while they cast nothing. */
  get shadowSignature(): GroundReliefShadowSignature | undefined {
    if (!this.castsShadows) return undefined;
    return { version: this.store.version, strength: this.strength, worldUnitsPerMetre: this.worldUnitsPerMetre, datumMetres: this.datumMetres };
  }

  // MARK: Reading the relief

  /**
   * The relief of a ground tile out of one terrain tile, `source`, the one
   * its placement is bound to (`PlaceTile.terrain`). `undefined` off the
   * terrain, and for a source not in, which includes one the source has not
   * got or does not answer for: the placement bound to it lies flat.
   */
  relief(tile: Tile, source: Tile): GroundRelief | undefined {
    if (!this.isActive || source.z > tile.z) return undefined;
    const found = this.store.terrain(source);
    if (found === undefined) return undefined;
    const placement = GroundRelief.placement(tile, source);
    return new GroundRelief(found.terrain, placement.originX, placement.originY, placement.scale, this.strength, found.occlusion);
  }

  /**
   * The relief under a tile out of the terrain of `terrainZoom` over it, or
   * the finest coarser one in while that is on its way: what the camera and
   * the frame's datum read. It carries no occlusion of the sky.
   */
  reliefOfZoom(tile: Tile, terrainZoom: number, orCoarser = true): GroundRelief | undefined {
    if (!this.isActive) return undefined;
    const found = this.store.finestTerrain(tile, terrainZoom, orCoarser);
    if (found === undefined) return undefined;
    const placement = GroundRelief.placement(tile, found.source);
    return new GroundRelief(found.terrain, placement.originX, placement.originY, placement.scale, this.strength);
  }

  /** The relief under a point of the world, from the terrain tile of `zoom` that holds it or the finest coarser one in, with the point's uv in the tile. */
  private reliefAt(point: Vec2, zoom: number): { relief: GroundRelief; u: number; v: number } | undefined {
    const z = Math.max(0, zoom);
    const count = 2 ** z;
    const x = ImmersiveMapProjection.wrapNormalizedWorldX(point[0]);
    const y = ImmersiveMapProjection.clampNormalizedWorldY(point[1]);
    const column = Math.min(Math.floor(x * count), count - 1);
    const row = Math.min(Math.floor(y * count), count - 1);
    const relief = this.reliefOfZoom({ x: column, y: row, z }, z);
    if (relief === undefined) return undefined;
    return { relief, u: x * count - column, v: y * count - row };
  }

  /** The terrain's height in metres under a point of the world, bilinear as the vertex stage samples it. `undefined` while no terrain over the point is in, zero off the terrain. */
  elevation(point: Vec2, terrainZoom: number): number | undefined {
    if (!this.isActive) return 0;
    const found = this.reliefAt(point, terrainZoom);
    return found === undefined ? undefined : found.relief.metresAtTileUV(found.u, found.v);
  }

  /** How much taller than the terrain the ground under a point of the world is drawn this frame: zero off the terrain, `undefined` while no terrain over the point is in. */
  strengthAt(point: Vec2, terrainZoom: number): number | undefined {
    if (!this.isActive) return 0;
    return this.reliefAt(point, terrainZoom) === undefined ? undefined : this.strength;
  }

  /** The terrain under a point of the world as drawn: the datum plus the height over it at the frame's strength, in metres. */
  drawnMetres(point: Vec2, terrainZoom: number): number | undefined {
    if (!this.isActive) return 0;
    const found = this.reliefAt(point, terrainZoom);
    if (found === undefined) return undefined;
    return this.datumMetres + found.relief.drawnMetresAtTileUV(found.u, found.v, this.datumMetres);
  }

  /** What the store holds and does now with the frame's own values, for the debug panel's relief tab. */
  statusSnapshot(): GroundReliefStatusSnapshot {
    return this.store.statusSnapshot(this.isActive, this.standingShare, this.datumMetres);
  }
}
