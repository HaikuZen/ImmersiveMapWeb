// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ViewMode } from "../../camera/view-mode.ts";
import { airHandover, type PresentationSettings } from "../../configuration/presentation-settings.ts";
import type { Vec2 } from "../../math/vec.ts";
import { BuildingCoveragePlanner, type BuildingSourceTile } from "../placement/building-coverage-planner.ts";
import { inOwnSlot, makePlaceTile, type PlaceTile, type ResidentTile, type TileDrawRules, type VisibleTile, visibleTileKey } from "../placement/place-tile.ts";
import { PlaceTilesContext } from "../placement/place-tiles-context.ts";
import { buildPlacements } from "../placement/tile-placement-planner.ts";
import { type Tile, tileKey } from "../tile.ts";
import type { TileDiagnostics } from "../visibility/tile-diagnostics.ts";
import { TileDemandPriorityMath } from "../visibility/tile-demand-priority-math.ts";
import type { VisibleContentState } from "../visibility/visible-content-state.ts";
import { pinnedWorldCoverMaxZoomLevel, type TileWorkingSetStore } from "./tile-working-set-store.ts";

/** What the working set needs of a resident tile past its identity and its buildings. */
export interface WorkingSetTile extends BuildingSourceTile {
  /**
   * Whether the tile's ground was flattened into one layer of triangles
   * (the Swift engine's `tileBuffers.ground.isFlattened`). A tile parsed in
   * layers, one coarser than the relief's zoom, cannot rise as geometry
   * (`TileWorkingSet.drawingOnTheRelief`).
   */
  readonly groundIsFlattened: boolean;
}

/** The loader as the working set drives it: `TileLoader` is one. */
export interface TileDemandLoader {
  /** The tiles to load, in priority order: what is not in the list is no longer wanted. */
  request(tiles: readonly Tile[]): void;
  /** Stops every load, for a memory warning and an eviction. */
  cancelAll(): void;
}

/** What the terrain demand is told once a frame (`GroundReliefTerrainDemand.request`). */
export interface TerrainDemandRequest<R extends ResidentTile> {
  readonly onFlatMap: boolean;
  readonly tileZoom: number;
  readonly targets: readonly VisibleTile[];
  /** The planner's placements, the horizon backdrop left out. */
  readonly shown: readonly PlaceTile<R>[];
  /** The terrain tiles the last plan wanted and found out. */
  readonly missing: readonly Tile[];
  readonly centerWorldMercator: Vec2;
}

/**
 * The terrain store as the planner sees it: which terrain tile a placement
 * rises by, whether it is in, the frame's demand, and the memory it lets go.
 * The planner hands over what it planned and the relief works out which
 * terrain that needs: nothing of the rings' terrain zooms, the relief's
 * zooms or its collapse reaches the planner. The relief's frame (how the
 * terrain is drawn) is the implementation's own to hold.
 */
export interface GroundReliefTerrainDemand<R extends ResidentTile> {
  /** Grows with every change to the terrain in: the placements are planned again when it moves. */
  readonly version: number;
  /** Whether a wanted terrain tile is still to come. */
  readonly hasLoadsPending: boolean;
  /** The terrain tile a source drawn in a ring of `targetZoom` shades its slopes by (`PlaceTile.terrain`). */
  terrainSource(tile: Tile, targetZoom: number): Tile;
  /** The terrain tile a source drawn in a ring of `targetZoom` displaces its grid by (`PlaceTile.displacement`). */
  displacementSource(tile: Tile, targetZoom: number): Tile;
  /** Whether a terrain tile is in, or counts as in because it cannot come. */
  isResident(tile: Tile): boolean;
  /**
   * The frame's terrain demand, once a frame: what the relief loads and
   * keeps, worked out from the frame's targets, the placements shown, the
   * terrain the planner found missing and the point the camera looks at.
   */
  request(request: TerrainDemandRequest<R>): void;
  /** Releases every terrain tile, for a memory warning. */
  removeAll(): void;
}

/** The frame as the working set reads it. */
export interface TileWorkingSetFrame {
  /** The coverage (`TileCulling`, `FrameVisibilityResolver`). */
  readonly visibleContent: VisibleContentState;
  readonly renderSurfaceMode: ViewMode;
  /** The frame's semantic globe-to-plane transition (`ResolvedPresentationState.transition`). */
  readonly transition: number;
  readonly presentation: PresentationSettings;
  /** Whether the ground relief draws this frame (`GroundReliefFrame.isActive`), false without one. */
  readonly reliefActive: boolean;
  readonly frameIndex?: number;
  readonly diagnostics?: TileDiagnostics | undefined;
}

/** What the working set published for the frame: the placements the drawers draw and the counts. */
export interface TilePlacementState<R extends ResidentTile> {
  /** The planner's placements, then the horizon backdrops. */
  readonly placeTilesContext: PlaceTilesContext<R>;
  /**
   * The tiles that draw their buildings this frame, each in its own place,
   * with no overlaps (`BuildingCoveragePlanner`). Empty on the globe.
   */
  readonly buildingPlaceTilesContext: PlaceTilesContext<R>;
  /** Moves whenever the placements were planned anew. */
  readonly placementVersion: number;
  readonly visibleTilesCount: number;
  readonly readyTilesCount: number;
  readonly requestedTilesCount: number;
  readonly renderedTilesCount: number;
}

/** What the working set did in a frame, for a tile trace. */
export interface TileDemandUpdateTrace {
  readonly frameIndex: number | undefined;
  readonly visible: number;
  readonly demanded: number;
  readonly ready: number;
  readonly requested: number;
  readonly rendered: number;
  readonly placementChanged: boolean;
  readonly placementVersion: number;
  readonly surface: "globe" | "flat";
  readonly inOwnSlot: number;
  readonly standIns: number;
}

export interface TileWorkingSetOptions<R extends WorkingSetTile> {
  readonly store: TileWorkingSetStore<R>;
  readonly loader: TileDemandLoader;
  /** The terrain store as the planner sees it, `undefined` while the relief is off. */
  readonly terrainDemand?: GroundReliefTerrainDemand<R> | undefined;
  /** The tile zoom the buildings draw from (`BuildingCoveragePlanner.minimumDrawZoom`): no coarser frame plans them. */
  readonly buildingsMinimumTileZoom?: number;
  readonly trace?: ((update: TileDemandUpdateTrace) => void) | undefined;
}

/** The world tile, the flat map's horizon backdrop (`pinnedWorldCoverMaxZoomLevel`). */
const horizonBackdropTile: Tile = Object.freeze({ x: 0, y: 0, z: pinnedWorldCoverMaxZoomLevel });
const horizonBackdropKey = tileKey(horizonBackdropTile);
/** The texture the backdrop draws its ground from: the smallest, the backdrop is the far ground under the haze. */
const horizonBackdropRasterSize = 64;
const horizonBackdropRules: TileDrawRules = Object.freeze({ drawsLines: false, drawsLabels: false, raster: Object.freeze({ size: horizonBackdropRasterSize }) });
/**
 * The texture's size a tile parsed in layers draws at on the relief
 * (`drawingOnTheRelief`): a stand-in near the camera, for the moments its
 * slot's own tile loads.
 */
const layeredTileRasterSize = 512;
const layeredTileRaster = Object.freeze({ size: layeredTileRasterSize });

/**
 * Keeps the tiles' working set in step with the frame's coverage, the
 * demand side of the Swift engine's `TileWorkingSetSubsystem`. The walk
 * (`TileCulling`) says which tiles the frame wants, this turns that into
 * what the frame can have: it orders the wanted tiles from the store nearest
 * first and lets go of the rest, hands the loader what is missing, plans
 * what draws in a wanted tile's place while it loads (`buildPlacements`,
 * `BuildingCoveragePlanner`, over what is resident this frame), and
 * publishes the placements and the counts. One gate keeps it idle when
 * neither the coverage nor the store's contents changed.
 *
 * A raster target (`VisibleContentState.rasterTiles`) is a target like any
 * other: its tile is demanded, kept and placed as a vector tile, and the
 * frame draws the placement through a texture.
 *
 * On the ground relief a tile is placed with its terrain or not at all: the
 * terrain tile its ground rises by in its slot is demanded with the tile and
 * has to be in before the planner places it (`buildPlacements`), and what
 * stood on the ground stands on meanwhile, by the terrain it was placed
 * with. The terrain lives as long as a placement rises by it or a target
 * asks for it, and goes with the tile.
 *
 * The GPU is the caller's: the resident tiles are `R`, made and drawn
 * elsewhere, and this only decides which are kept and where they draw.
 */
export class TileWorkingSet<R extends WorkingSetTile> {
  static readonly horizonBackdropTile = horizonBackdropTile;
  static readonly horizonBackdropRasterSize = horizonBackdropRasterSize;
  static readonly layeredTileRasterSize = layeredTileRasterSize;

  private readonly store: TileWorkingSetStore<R>;
  private readonly loader: TileDemandLoader;
  private readonly terrainDemand: GroundReliefTerrainDemand<R> | undefined;
  private readonly buildingsMinimumTileZoom: number;
  private readonly trace: ((update: TileDemandUpdateTrace) => void) | undefined;

  private placeTilesContext: PlaceTilesContext<R> = PlaceTilesContext.empty();
  /**
   * The planner's placements alone, without the horizon backdrop: what the
   * next plan remembers as the last frame's ground, and what the buildings
   * and the terrain are planned from.
   */
  private plannedPlacements: readonly PlaceTile<R>[] = [];
  private buildingPlaceTilesContext: PlaceTilesContext<R> = PlaceTilesContext.empty();
  private placementVersion = 0;
  /** The coverage and the working set the last placements were planned over, `undefined` until the first plan. */
  private plannedCoverageVersion: number | undefined;
  private plannedContentVersion: number | undefined;
  private plannedReliefVersion: number | undefined;
  /** Whether the frame was on the terrain when the placements were last planned: a tile parsed in layers draws differently on it. */
  private plannedReliefActive: boolean | undefined;
  /** The terrain tiles the last plan wanted and found out: asked for with the frame's demand until a plan no longer wants them. */
  private plannedMissingTerrain: readonly Tile[] = [];
  private latestRequestedTilesCount = 0;
  private latestCounts = { visible: 0, demanded: 0, ready: 0 };
  private state: TilePlacementState<R>;

  /** Scratch kept across frames, so the steady state allocates no collection for them. */
  private readonly shownScratch = new Set<string>();
  private readonly requestScratch: Tile[] = [];

  constructor(options: TileWorkingSetOptions<R>) {
    this.store = options.store;
    this.loader = options.loader;
    this.terrainDemand = options.terrainDemand;
    this.buildingsMinimumTileZoom = options.buildingsMinimumTileZoom ?? BuildingCoveragePlanner.minimumSourceZoom;
    this.trace = options.trace;
    this.state = this.makeState(0, 0, 0);
  }

  /** What the last `update` published. */
  get placementState(): TilePlacementState<R> {
    return this.state;
  }

  /**
   * The flat map's horizon backdrop: the world tile placed under every
   * placement, once per world copy the targets stand in, flat on the plane,
   * a 64-texel texture without lines or labels (`PlaceTile.isHorizonBackdrop`).
   * The rules' bands end somewhere, and from a tilted camera the ground
   * beyond the last band showed the clear colour under the sky, an edge the
   * haze drew over: the backdrop is the ground there, the same at every zoom
   * and whatever the rules. Its mark has the lowest priority of all, so every
   * other placement paints over it. Nothing while the world tile is not
   * resident yet.
   *
   * Laid from the air handover of the unroll on (`drawsHorizonBackdrop`),
   * through the sphere's path like every placement: the limb of the
   * flattening surface runs out past the coverage's reach there, and the
   * backdrop is the ground up to the line before the surface switch, so the
   * switch changes nothing under it.
   */
  static horizonBackdrops<T extends ResidentTile>(targets: readonly VisibleTile[], resident: ReadonlyMap<string, T>): PlaceTile<T>[] {
    const cover = resident.get(horizonBackdropKey);
    if (cover === undefined) return [];
    const worldWraps = [...new Set(targets.map((target) => target.worldWrap))].sort((lhs, rhs) => lhs - rhs);
    return worldWraps.map((worldWrap) =>
      makePlaceTile(cover, { tile: horizonBackdropTile, worldWrap }, { rules: horizonBackdropRules, isHorizonBackdrop: true }),
    );
  }

  /**
   * Whether the frame lays the horizon backdrop: on the plane, and on the
   * sphere's path once the air handover of the unroll has begun
   * (`airHandover`).
   */
  static drawsHorizonBackdrop(renderSurfaceMode: ViewMode, transition: number, presentation: PresentationSettings): boolean {
    return renderSurfaceMode === "flat" || airHandover(presentation, transition) > 0;
  }

  /**
   * A placement as it draws on the relief. A tile parsed in layers, one
   * coarser than the relief's zoom (`GroundReliefSettings.appearZoom`),
   * cannot rise as geometry: placed to draw as geometry (a stand-in for a
   * slot still loading, a ring the rules draw as geometry), it draws its
   * ground from a texture on the raster tiles' raised grid instead, and
   * leaves its lines out, which could not rise either. Every other placement
   * is as planned.
   *
   * One exception, the planner's own principle carried to the look: a
   * stand-in that was shown as geometry in the last frame (`shownAsGeometry`,
   * by `tileKey`, the tiles of the last plan's geometry placements) and rises
   * by no terrain goes on as geometry, flat on the plane, with its lines,
   * until its slot's own tile lands. The camera crossing onto the relief
   * turns the tiles of the zoom before into stand-ins for the relief's first
   * targets, which arrive with their terrain some frames later, and a
   * texture of them in between is a flash of blur without roads over the
   * whole view, where the same tiles drawn as they were show nothing
   * changing. A tile in its own slot is not a stand-in and draws as a
   * texture as before: a ring the rules draw as geometry below the relief's
   * zoom is a raised texture on it, not a sheet lying flat among the
   * mountains for as long as it is shown. A stand-in bound to a terrain is
   * placed anew this frame, its square marked raised, and draws raised, from
   * a texture.
   */
  static drawingOnTheRelief<T extends WorkingSetTile>(placement: PlaceTile<T>, shownAsGeometry: ReadonlySet<string>): PlaceTile<T> {
    if (placement.rules.raster !== undefined || placement.resident.groundIsFlattened) return placement;
    if (!inOwnSlot(placement) && placement.displacement === undefined && shownAsGeometry.has(tileKey(placement.resident.tile))) return placement;
    return makePlaceTile(placement.resident, placement.placeIn, {
      slot: placement.slot,
      rules: { drawsLines: false, drawsLabels: placement.rules.drawsLabels, raster: layeredTileRaster },
      terrain: placement.terrain,
      displacement: placement.displacement,
    });
  }

  update(frame: TileWorkingSetFrame): TilePlacementState<R> {
    // The coverage: the frame's targets, every tile at the zoom its place on
    // screen wants (`TileCulling`).
    const visibleContent = frame.visibleContent;
    const targets = visibleContent.visibleTiles;
    const tileZoomLevel = visibleContent.tileZoomLevel;
    const onFlatMap = frame.renderSurfaceMode === "flat";

    // The gate: the demand, the loads and the placements depend on the
    // coverage (its version moves when the targets change), on the working
    // set's contents (its version moves when a tile lands and when memory
    // pressure releases one, the releases the demand itself causes touch
    // only tiles it stopped asking about) and on the terrain in (its version
    // moves when a terrain tile lands, goes, or turns out not to come, and a
    // placement waits for its terrain as it waits for its tile), on nothing
    // else. All as they were when the placements were last planned, and no
    // tile in flight, map or terrain: nothing to do. A tile in flight keeps
    // the per-frame request going, which the loaders' retries rely on.
    const coverageVersion = visibleContent.coverageVersion;
    const terrainDemand = this.terrainDemand;
    const reliefActive = frame.reliefActive;
    const reliefVersion = terrainDemand?.version;
    const terrainInFlight = terrainDemand?.hasLoadsPending ?? false;
    if (
      coverageVersion === this.plannedCoverageVersion &&
      this.store.contentVersion === this.plannedContentVersion &&
      reliefActive === this.plannedReliefActive &&
      reliefVersion === this.plannedReliefVersion &&
      this.latestRequestedTilesCount === 0 &&
      !terrainInFlight
    ) {
      return this.publish(frame, this.latestCounts.visible, this.latestCounts.ready, 0);
    }

    // Under the horizon backdrop the world cover's zoom is the floor of the
    // planner's stand-ins: a target still loading is never covered by the
    // pinned world tile, which at a street zoom is a plain of one colour
    // with nothing on it, and the backdrop paints the hole anyway. The globe
    // keeps its cover as a stand-in.
    const drawsBackdrop = TileWorkingSet.drawsHorizonBackdrop(frame.renderSurfaceMode, frame.transition, frame.presentation);
    const backdropZoomLevel = drawsBackdrop ? pinnedWorldCoverMaxZoomLevel : undefined;
    // The demand is the targets, nothing else: no stand-in is asked for.
    // What covers a loading target is what is resident already (the working
    // set keeps the tiles that stand in for one, see `TileWorkingSetStore`),
    // and beneath it the pinned world cover. `VisibleTile` includes
    // `worldWrap`, so flat-mode wrapped copies share one content tile
    // (`Tile`): the list is deduplicated. Demand order is network and
    // parsing priority: tiles closest to the camera start first.
    const prioritizedTargets = TileDemandPriorityMath.sortedByCameraProximity(targets, visibleContent.centerWorldMercator, frame.renderSurfaceMode);
    const demandedCount = TileWorkingSet.uniqueSourceTiles(targets).length;
    const demand = TileWorkingSet.uniqueSourceTiles(prioritizedTargets);
    // The store keeps the demand and what the last frame showed, and
    // releases the rest.
    const shown = this.shownScratch;
    shown.clear();
    for (const placement of this.placeTilesContext.tilePlacements) shown.add(tileKey(placement.resident.tile));
    // A frame with the backdrop asks for the world tile too, last
    // (`horizonBackdrops`), pinned once it lands.
    if (drawsBackdrop && !demand.some((tile) => tileKey(tile) === horizonBackdropKey)) demand.push(horizonBackdropTile);
    const request = this.requestTiles(demand, shown);
    const contentVersion = this.store.contentVersion;

    // The placement is a function of the targets and of what is resident
    // now (the stand-ins included, which are never demanded): replanned from
    // scratch when either moved, kept otherwise.
    const placementChanged =
      coverageVersion !== this.plannedCoverageVersion ||
      contentVersion !== this.plannedContentVersion ||
      reliefVersion !== this.plannedReliefVersion ||
      reliefActive !== this.plannedReliefActive;
    if (placementChanged) {
      const resident = this.store.residentTiles();
      // The terrain the plan asks about and finds out: a stand-in's, which
      // no target demands. Asked for with the frame's demand.
      const missingTerrain: Tile[] = [];
      const missingTerrainSeen = new Set<string>();
      const reliefOnTheFlatMap = reliefActive && onFlatMap;
      const planned = buildPlacements<R>({
        targets,
        resident,
        backdropZoomLevel,
        previous: this.plannedPlacements,
        slotRules: (slot) => {
          const key = visibleTileKey(slot);
          return {
            drawsLines: !visibleContent.linelessTiles.has(key),
            drawsLabels: !visibleContent.unlabelledTiles.has(key),
            raster: visibleContent.rasterTiles.get(key),
          };
        },
        // On the relief a tile is placed with the terrain of its slot's
        // ring, once that is in.
        terrain: (tile, slotZoom) => {
          if (!reliefOnTheFlatMap || terrainDemand === undefined) return undefined;
          return { terrain: terrainDemand.terrainSource(tile, slotZoom), displacement: terrainDemand.displacementSource(tile, slotZoom) };
        },
        terrainResident: (tile) => {
          const isIn = terrainDemand?.isResident(tile) ?? false;
          if (!isIn) {
            const key = tileKey(tile);
            if (!missingTerrainSeen.has(key)) {
              missingTerrainSeen.add(key);
              missingTerrain.push(tile);
            }
          }
          return isIn;
        },
      });
      this.plannedMissingTerrain = missingTerrain;
      if (reliefActive && onFlatMap) {
        // What the last frame drew as geometry keeps its look while it stands
        // in (`drawingOnTheRelief`).
        const shownAsGeometry = new Set<string>();
        for (const placement of this.plannedPlacements) {
          if (placement.rules.raster === undefined) shownAsGeometry.add(tileKey(placement.resident.tile));
        }
        this.plannedPlacements = planned.map((placement) => TileWorkingSet.drawingOnTheRelief(placement, shownAsGeometry));
      } else {
        this.plannedPlacements = planned;
      }
      // The horizon backdrop under the plan, on the flat map and through the
      // unroll's air handover.
      const backdrops = drawsBackdrop ? TileWorkingSet.horizonBackdrops(targets, resident) : [];
      this.placeTilesContext = { tilePlacements: backdrops.length > 0 ? [...this.plannedPlacements, ...backdrops] : this.plannedPlacements };
      // The buildings: the tiles the ground shows, from the buildings' zoom
      // on (see the planner).
      this.buildingPlaceTilesContext = BuildingCoveragePlanner.plan(this.plannedPlacements, onFlatMap, this.buildingsMinimumTileZoom);
      this.placementVersion += 1;
      this.plannedCoverageVersion = coverageVersion;
      this.plannedContentVersion = contentVersion;
      this.plannedReliefVersion = reliefVersion;
      this.plannedReliefActive = reliefActive;
    }

    // The terrain the frame reads, asked for once a frame, as the map tiles
    // are: what the camera reads moves with it between replans. Which
    // terrain that is, is the relief's own business.
    terrainDemand?.request({
      onFlatMap,
      tileZoom: tileZoomLevel,
      targets,
      shown: this.plannedPlacements,
      missing: this.plannedMissingTerrain,
      centerWorldMercator: visibleContent.centerWorldMercator,
    });

    const visibleTilesCount = targets.length;
    if (this.trace !== undefined) {
      const placements = this.placeTilesContext.tilePlacements;
      let inOwnSlotCount = 0;
      for (const placement of placements) if (inOwnSlot(placement)) inOwnSlotCount += 1;
      this.trace({
        frameIndex: frame.frameIndex,
        visible: visibleTilesCount,
        demanded: demandedCount,
        ready: request.ready,
        requested: request.requested,
        rendered: placements.length,
        placementChanged,
        placementVersion: this.placementVersion,
        surface: onFlatMap ? "flat" : "globe",
        inOwnSlot: inOwnSlotCount,
        standIns: placements.length - inOwnSlotCount,
      });
    }

    this.latestRequestedTilesCount = request.requested;
    this.latestCounts = { visible: visibleTilesCount, demanded: demandedCount, ready: request.ready };
    return this.publish(frame, visibleTilesCount, request.ready, request.requested);
  }

  /**
   * The memory-warning response: stops the loads and hands back what the
   * frame does not draw (`TileWorkingSetStore.releaseUndemandedTiles`). The
   * terrain goes too: the placements bound to it are planned again when it
   * is back. The placement contexts are kept and hold their tiles, and the
   * store keeps the demanded set, so the map does not go blank. The next
   * frame replans from scratch.
   */
  handleMemoryWarning(): void {
    this.loader.cancelAll();
    this.store.releaseUndemandedTiles();
    this.terrainDemand?.removeAll();
    this.plannedCoverageVersion = undefined;
    this.plannedContentVersion = undefined;
    this.placementVersion += 1;
  }

  /** Lets go of everything: the loads, the resident tiles, the terrain and the placements. */
  evict(): void {
    this.loader.cancelAll();
    this.store.removeAll();
    this.terrainDemand?.removeAll();
    this.placeTilesContext = PlaceTilesContext.empty();
    this.buildingPlaceTilesContext = PlaceTilesContext.empty();
    this.plannedCoverageVersion = undefined;
    this.plannedContentVersion = undefined;
    this.placementVersion += 1;
  }

  /**
   * The demand handed to the store and the loader (the Swift engine's
   * `TileRenderStore.requestTiles`): the store keeps the demand and what was
   * shown and releases the rest, and every demanded tile not resident goes
   * to the loader, in the demand's order.
   */
  private requestTiles(tiles: readonly Tile[], shown: ReadonlySet<string>): { ready: number; requested: number } {
    this.store.updateDemandedTiles(tiles, shown);
    const request = this.requestScratch;
    request.length = 0;
    let ready = 0;
    for (const tile of tiles) {
      if (this.store.contains(tile)) ready += 1;
      else request.push(tile);
    }
    this.loader.request(request);
    return { ready, requested: request.length };
  }

  /** The content tiles of the targets, first occurrence first. */
  private static uniqueSourceTiles(targets: readonly VisibleTile[]): Tile[] {
    const seen = new Set<string>();
    const tiles: Tile[] = [];
    for (const target of targets) {
      const key = tileKey(target.tile);
      if (seen.has(key)) continue;
      seen.add(key);
      tiles.push(target.tile);
    }
    return tiles;
  }

  private publish(frame: TileWorkingSetFrame, visibleTilesCount: number, readyTilesCount: number, requestedTilesCount: number): TilePlacementState<R> {
    const state = this.state;
    if (
      state.placeTilesContext !== this.placeTilesContext ||
      state.buildingPlaceTilesContext !== this.buildingPlaceTilesContext ||
      state.placementVersion !== this.placementVersion ||
      state.visibleTilesCount !== visibleTilesCount ||
      state.readyTilesCount !== readyTilesCount ||
      state.requestedTilesCount !== requestedTilesCount
    ) {
      this.state = this.makeState(visibleTilesCount, readyTilesCount, requestedTilesCount);
    }
    const diagnostics = frame.diagnostics;
    if (diagnostics !== undefined) {
      diagnostics.setCounter("visibleTiles", visibleTilesCount);
      diagnostics.setCounter("readyTiles", readyTilesCount);
      diagnostics.setCounter("requestedTiles", requestedTilesCount);
      diagnostics.setCounter("renderedTiles", this.state.renderedTilesCount);
    }
    return this.state;
  }

  private makeState(visibleTilesCount: number, readyTilesCount: number, requestedTilesCount: number): TilePlacementState<R> {
    return {
      placeTilesContext: this.placeTilesContext,
      buildingPlaceTilesContext: this.buildingPlaceTilesContext,
      placementVersion: this.placementVersion,
      visibleTilesCount,
      readyTilesCount,
      requestedTilesCount,
      renderedTilesCount: this.placeTilesContext.tilePlacements.length,
    };
  }
}
