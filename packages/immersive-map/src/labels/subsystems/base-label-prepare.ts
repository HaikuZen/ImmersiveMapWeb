// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The frame's label decisions on the CPU: which base and road labels show,
 * and how far each has faded (the Swift `BaseLabelPrepareSubsystem`).
 *
 * The working set (the labels of the frame's tiles) is packed when the tiles
 * change and reused since: the base labels as one span in tile order
 * (`BaseLabelCache`), the road label instances as another
 * (`RoadLabelCache`), and the per-label state of a tile that stays is
 * carried by copying its run. A frame with a moving camera projects the base
 * labels' anchors, lays the road glyphs along their roads
 * (`RoadLabelPlacer`), solves the collisions of base labels and road
 * instances together in one pass (`LabelCollisionSolver`), the copies of one
 * feature that several tiles brought left out of it but one, advances the
 * fades in place and writes the records the label shaders read. A frame with
 * a still camera and no fade in flight does none of that. Nothing is asked of
 * the GPU: the decision for a pose is made in the frame that renders it, from
 * the numbers that frame draws.
 *
 * On the ground relief the anchors and the road paths ride the ground of
 * their tile (`GroundReliefTileLift`, the terrain its placement is bound
 * to).
 *
 * For the debug panel, behind two opt-in switches a map without the panel
 * never sets: the frame's label boxes (`debugBoxes`, read back from
 * `lastDebugBoxes`) and one base label trace line a frame while a recording
 * runs (`traceRecorder`).
 */

import type { GroundReliefFrame } from "../../tile/relief/frame/ground-relief-frame.ts";
import { GroundReliefTileLift } from "../../tile/relief/lifts/ground-relief-tile-lift.ts";
import { PlaceTilesContext } from "../../tile/placement/place-tiles-context.ts";
import { type Tile, tileKey } from "../../tile/tile.ts";
import type { RoadLabelPointLifts } from "../road/road-label-placer.ts";
import type { FlatLabelProjectionFrame } from "../base/tile-point-screen-projector.ts";
import type { ImmersiveMapCameraState } from "../../camera/immersive-map-camera-state.ts";
import type { ViewMode } from "../../camera/view-mode.ts";
import type { BaseLabelTraceRecorder } from "../../render/debug/base-label-trace-recorder.ts";
import type { LabelSettings } from "../../configuration/label-settings.ts";
import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { GlobeUniform } from "../../globe/globe-uniform.ts";
import type { Mat4 } from "../../math/matrix.ts";
import type { Vec2, Vec3 } from "../../math/vec.ts";
import type { FlatRenderState, ScreenSpaceProjectionMode } from "../../presentation/resolved-presentation-state.ts";
import type { BuildingRiseCoverage } from "../../tile/placement/building-rise-coverage.ts";
import type { PlaceTile, VisibleTile } from "../../tile/placement/place-tile.ts";
import { BaseLabelCache, type LabelSourceTile, LabelFrameRecordLayout } from "../base/base-label-cache.ts";
import { BaseLabelFadeState } from "../base/base-label-fade-state.ts";
import { type BaseLabelSourceEntry, buildBaseLabelSourceEntries, sameSourceEntries } from "../base/base-label-source-entry.ts";
import { BaseLabelVisibilityResolver, showsAtZoom } from "../base/base-label-visibility-resolver.ts";
import { LabelActiveSpans } from "../base/label-active-spans.ts";
import { type LabelDistanceRule, LabelDistanceRules } from "../base/label-distance-rules.ts";
import { projectFlatLabels, projectGlobeLabels } from "../base/tile-point-screen-projector.ts";
import { LabelCollisionRoadItems, LabelCollisionSolver, ROAD_ITEM_STRIDE } from "../collisions/label-collision-solver.ts";
import { overviewFadeAlpha } from "../common/label-text-style.ts";
import type { LabelWorkingSetChange } from "../common/label-working-set-change.ts";
import { RoadLabelCache, type RoadLabelTileRecord } from "../road/road-label-cache.ts";
import { RoadLabelNearCameraFilter } from "../road/road-label-near-camera-filter.ts";
import { RoadBoxBuffer, RoadGlyphLayout, RoadLabelPlacer } from "../road/road-label-placer.ts";

/** What the label decisions read of a frame. */
export interface LabelFrameInput {
  readonly placements: readonly PlaceTile<LabelSourceTile>[];
  readonly renderSurfaceMode: ViewMode;
  readonly screenSpaceProjectionMode: ScreenSpaceProjectionMode;
  /** The CPU's projection-view, column-major. */
  readonly projectionView: Mat4;
  readonly cameraEye: Vec3;
  readonly cameraState: ImmersiveMapCameraState;
  readonly drawWidth: number;
  readonly drawHeight: number;
  /** The zoom the tiles are planned by, which the labels answer too. */
  readonly planningZoom: number;
  readonly pixelsPerPoint: number;
  readonly timeSeconds: number;
  readonly flatRenderState: FlatRenderState;
  readonly globe: GlobeUniform;
  /** The globe's composed frame constants, needed on the globe's projection only. */
  readonly globeConstants: { readonly sphereWorld: Mat4; readonly mapSize: number; readonly panMercatorY: number } | undefined;
  /** The look-at point in the normalized Mercator world. */
  readonly centerWorldMercator: Vec2;
  /** The frame's tile zoom, what a road tile's underzoom is counted from. */
  readonly tileZoomLevel: number;
  /** How far the buildings drawn over each point have risen: what a label on a roof rises by. */
  readonly buildingRise: BuildingRiseCoverage;
  /** Changes whenever the rise does, so the labels on the roofs are placed again. */
  readonly buildingRiseSignature: number;
  /** The frame's ground relief, `undefined` on a map without one: the labels ride it where the frame is on it. */
  readonly relief?: GroundReliefFrame | undefined;
  /** The frame's number, for the base label trace. Without it the trace counts the frames itself. */
  readonly frameIndex?: number | undefined;
  /**
   * The debug panel's drags over the settings (`DebugOverlayControlState`):
   * the labels' reach by camera zoom, the local detail's distance in metres
   * and the shrink floor. Each left out keeps the settings' own.
   */
  readonly debugReach?:
    | {
        readonly distanceRules?: readonly LabelDistanceRule[] | undefined;
        readonly localDetailMaximumDistanceMeters?: number | undefined;
        readonly perspectiveMinimumScale?: number | undefined;
      }
    | undefined;
}

/**
 * One label's frame for the debug overlay (the Swift `BaseLabelDebugBox`):
 * its collision box on screen, in drawable pixels with the origin at the
 * top left and y down, and whether it shows. Labels hidden by the collision
 * or the horizon still take part in the frame and are listed too.
 */
export interface LabelDebugBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly isVisible: boolean;
}

/**
 * The frame's label boxes for the debug overlay (the Swift
 * `BaseLabelDebugBoxesState`): the base labels' and, apart, the road glyphs'
 * (one box per glyph), so the two can be drawn in their own colours.
 */
export interface LabelDebugBoxesState {
  readonly boxes: readonly LabelDebugBox[];
  readonly roadBoxes: readonly LabelDebugBox[];
}

export const emptyLabelDebugBoxes: LabelDebugBoxesState = Object.freeze({ boxes: Object.freeze([]), roadBoxes: Object.freeze([]) });

/** Which label boxes the debug panel wants this frame (its two toggles). */
export interface LabelDebugBoxesRequest {
  readonly base: boolean;
  readonly road: boolean;
}

/** One road tile's glyphs to draw: its record and its first glyph in the frame's glyph records. */
export interface RoadLabelDraw {
  readonly record: RoadLabelTileRecord;
  readonly glyphShift: number;
}

/** The road glyph record the road label vertex stage reads: placement x, y, angle, alpha, then the glyph's centre and the label's vertical centre. */
export const RoadGlyphRecordLayout = { floats: 8, bytes: 32 } as const;

const ROAD_PRIORITY_BASE = 1_000_000_000;

export class BaseLabelPrepare {
  readonly baseCache = new BaseLabelCache();
  readonly roadCache: RoadLabelCache;
  private readonly solver = new LabelCollisionSolver();
  private readonly baseFade = new BaseLabelFadeState();
  private readonly roadFade = new BaseLabelFadeState();
  private readonly activeSpans = new LabelActiveSpans();
  private sourceEntries: BaseLabelSourceEntry<LabelSourceTile>[] = [];
  private hasSourceEntries = false;

  private readonly fadeInSeconds: number;
  private readonly fadeOutSeconds: number;
  private readonly maxGlyphTurnRadians: number;
  private readonly collisionGridCellSizePoints: number;
  /** Half of the collision spacing: what every base label's box grows by on each side, so two kept labels never touch. */
  private readonly collisionMarginPoints: number;
  private readonly perspectiveMinimumScale: number;
  private readonly localDetailMaximumDistanceMeters: number;

  private readonly cameraFingerprint = new Float64Array(17);
  private projectedFingerprint: Float64Array | undefined;
  private solvedFingerprint: Float64Array | undefined;
  private projectedDistanceScale: number | undefined;
  private solvedPixelsPerPoint = 0;

  // Index-aligned with the base set, sized at a topology change.
  private baseHorizonVisible = new Uint8Array(0);
  private baseLocalSuppressed = new Uint8Array(0);
  private baseAnchors = new Float32Array(0);
  private basePerspectiveScales = new Float32Array(0);
  private baseCenters = new Float32Array(0);
  private baseHalfSizesPx = new Float32Array(0);
  private baseScaledHalfSizesPx = new Float32Array(0);
  private baseReservesSpace = new Uint8Array(0);
  private baseCollisionVisible = new Uint8Array(0);
  private baseTargetVisible = new Uint8Array(0);
  private slotOrigins = new Float64Array(0);

  // Index-aligned with the road instance set.
  private roadCollisionVisible = new Uint8Array(0);
  private roadTargetVisible = new Uint8Array(0);
  /** Per road record: whether it is near enough for its names. */
  private roadRecordActive: boolean[] = [];
  private readonly roadItems = new LabelCollisionRoadItems();
  private readonly roadBoxes = new RoadBoxBuffer();

  /** The base labels' state for the draw: whether any fade is in flight this frame. */
  baseFadesActive = false;
  /** The road glyph records of the frame (`RoadGlyphRecordLayout`), `roadGlyphCount` of them. */
  roadGlyphRecords = new Float32Array(1024);
  roadGlyphCount = 0;
  roadDraws: RoadLabelDraw[] = [];
  roadFadesActive = false;

  /**
   * Which label boxes the frame collects for the debug overlay, undefined
   * (the default) for none: the frame sets it only while the panel shows
   * label bounds, and a frame without it builds nothing.
   */
  debugBoxes: LabelDebugBoxesRequest | undefined;
  /** The base label trace, undefined (the default) without the panel: a frame writes a line only while it records. */
  traceRecorder: BaseLabelTraceRecorder | undefined;
  private debugBoxesState: LabelDebugBoxesState = emptyLabelDebugBoxes;
  private traceFrameCount = 0;

  /**
   * `reliefSubdivisionStep` is the grid a flattened tile of a zoom rises on,
   * in tile units, `undefined` off the relief: the road names' paths are cut
   * at it, as the road is (the Swift `TileParseOptions.reliefSubdivisionStep`).
   */
  constructor(settings: LabelSettings, reliefSubdivisionStep: (tileZoom: number) => number | undefined = () => undefined) {
    this.roadCache = new RoadLabelCache(reliefSubdivisionStep);
    this.fadeInSeconds = settings.base.fadeInSeconds;
    this.fadeOutSeconds = settings.base.fadeOutSeconds;
    this.maxGlyphTurnRadians = settings.road.maxGlyphTurnRadians;
    this.collisionGridCellSizePoints = Math.max(4, settings.base.gridCellSizePoints);
    this.collisionMarginPoints = Math.max(0, settings.base.collisionSpacingPoints) * 0.5;
    this.perspectiveMinimumScale = Math.min(Math.max(settings.base.perspectiveMinimumScale, 0), 1);
    this.localDetailMaximumDistanceMeters = settings.base.localDetailMaximumDistanceMeters;
  }

  /** Whether any label fade runs: the render loop's label fade activity. */
  get hasActiveFadeAnimations(): boolean {
    return this.baseFadesActive || this.roadFadesActive;
  }

  /** Whether the frame has labels to draw: the overlay's label layer. */
  get hasRenderableLabels(): boolean {
    return this.baseCache.labelCount > 0 || this.roadDraws.length > 0;
  }

  /** The frame's spans of the base set (start and end pairs): the labels it works on. */
  get spans(): readonly number[] {
    return this.activeSpans.spans;
  }

  /** The base labels the frame's collision solve kept, index-aligned with the set. */
  get baseCollisionVisibility(): Uint8Array {
    return this.baseCollisionVisible;
  }

  /** The road instances the frame's collision solve kept, index-aligned with the road instance set. */
  get roadCollisionVisibility(): Uint8Array {
    return this.roadCollisionVisible;
  }

  /** The road instances' fades, index-aligned with the road instance set. */
  get roadAlphas(): Float32Array {
    return this.roadFade.currentAlphas;
  }

  /** The base labels' fades, index-aligned with the base set. */
  get baseAlphas(): Float32Array {
    return this.baseFade.currentAlphas;
  }

  /** The last frame's label boxes for the debug overlay, empty while `debugBoxes` is off. */
  get lastDebugBoxes(): LabelDebugBoxesState {
    return this.debugBoxesState;
  }

  /**
   * The road label tiles whose names are near enough to take part in the
   * frame (the Swift `RoadLabelState.activeRoadLabelTiles`), for the debug
   * overlay's road label tiles. Built when asked, so a frame pays nothing.
   */
  get activeRoadLabelTiles(): VisibleTile[] {
    const records = this.roadCache.orderedRecords;
    if (this.roadRecordActive.length !== records.length) return records.map((record) => record.ownerKey);
    const tiles: VisibleTile[] = [];
    records.forEach((record, index) => {
      if (this.roadRecordActive[index]) tiles.push(record.ownerKey);
    });
    return tiles;
  }

  /** Forgets every label: the next frame starts from nothing. */
  reset(): void {
    this.baseCache.reset();
    this.roadCache.evict();
    this.baseFade.reset();
    this.roadFade.reset();
    this.activeSpans.reset();
    this.sourceEntries = [];
    this.hasSourceEntries = false;
    this.projectedFingerprint = undefined;
    this.solvedFingerprint = undefined;
    this.projectedDistanceScale = undefined;
    this.solvedPixelsPerPoint = 0;
    this.debugBoxesState = emptyLabelDebugBoxes;
    this.roadDraws = [];
    this.roadGlyphCount = 0;
    this.baseFadesActive = false;
    this.roadFadesActive = false;
    this.solver.rebindBase(new Int32Array(0), new Int32Array(0));
  }

  /** One frame's decisions. */
  update(frame: LabelFrameInput): void {
    // A placement whose rules draw no labels offers none: a tile keeps its
    // labels while any placement of it draws them.
    const entries = buildBaseLabelSourceEntries(frame.placements.filter((p) => p.rules.drawsLabels));
    this.writeCameraFingerprint(frame);
    const topologyChanged = !this.hasSourceEntries || !sameSourceEntries(entries, this.sourceEntries);
    if (topologyChanged) {
      this.sourceEntries = entries;
      this.hasSourceEntries = true;
      const baseChange = this.baseCache.repack(entries);
      const roadChange = this.roadCache.synchronize(entries);
      this.rebindWorkingSet(baseChange, roadChange, frame.timeSeconds);
      this.projectedFingerprint = undefined;
      this.solvedFingerprint = undefined;
    }

    // The labels the camera's zoom shows, and those still fading out: every
    // pass below works on them alone.
    const cameraZoom = frame.planningZoom;
    this.activeSpans.resolve(this.baseCache.presentation.minCameraZoom, this.baseFade.currentAlphas, cameraZoom);
    const spans = this.activeSpans.spans;

    const distanceScale = LabelDistanceRules.scale(frame.debugReach?.distanceRules ?? LabelDistanceRules.default, frame.planningZoom);
    const cameraChanged = !sameFingerprint(this.projectedFingerprint, this.cameraFingerprint) || this.projectedDistanceScale !== distanceScale;
    let localDetailChanged = false;
    if (cameraChanged || topologyChanged) {
      this.projectBaseLabels(frame, distanceScale, spans);
      this.placeRoadLabels(frame, distanceScale);
      this.projectedFingerprint = Float64Array.from(this.cameraFingerprint);
      this.projectedDistanceScale = distanceScale;
      localDetailChanged = this.resolveLocalDetail(frame, spans);
    }

    if (frame.pixelsPerPoint !== this.solvedPixelsPerPoint) this.rescaleBaseHalfSizes(frame.pixelsPerPoint);
    // The solve depends on the pose, the set and the fades (a label fading
    // out keeps its space): a frame with none of them changing keeps the
    // previous decision.
    const needsSolve = cameraChanged || topologyChanged || this.baseFadesActive || this.roadFadesActive || localDetailChanged || this.solvedFingerprint === undefined;
    if (needsSolve) {
      this.solveCollisions(frame, spans);
      this.solvedFingerprint = Float64Array.from(this.cameraFingerprint);
      this.solvedPixelsPerPoint = frame.pixelsPerPoint;
    }

    const presentation = this.baseCache.presentation;
    BaseLabelVisibilityResolver.targetVisibility(presentation, this.baseCollisionVisible, this.baseHorizonVisible, this.baseLocalSuppressed, cameraZoom, spans, this.baseTargetVisible);
    this.baseFadesActive = this.baseFade.advance(this.baseTargetVisible, frame.timeSeconds, this.fadeInSeconds, this.fadeOutSeconds, spans);
    const overviewAlpha = overviewFadeAlpha(frame.planningZoom);
    this.baseCache.updateFadeAlphas(this.baseFade.currentAlphas, overviewAlpha, spans);
    this.activeSpans.updateLitEnds(this.baseFade.currentAlphas, this.baseTargetVisible);

    this.traceFrameCount += 1;
    if (this.traceRecorder?.isRecordingActive === true) this.recordTraceFrame(frame, entries.length, topologyChanged, overviewAlpha);
    this.debugBoxesState = this.debugBoxes === undefined ? emptyLabelDebugBoxes : this.makeDebugBoxesState(frame, this.debugBoxes, spans);

    this.buildRoadLabelState(frame);
  }

  // MARK: The working set

  /**
   * Sizes everything index-aligned with the new base and road sets and
   * carries the fades to their new places, the surviving tiles' by run and
   * the swapped tiles' lit labels by key, then hands each copy's fade to the
   * copy the set keeps.
   */
  private rebindWorkingSet(base: LabelWorkingSetChange, road: LabelWorkingSetChange, time: number): void {
    const seeded = base.seeded(this.baseFade.currentAlphas, BaseLabelVisibilityResolver.activeAlphaThreshold);
    const count = seeded.count;
    this.baseFade.rebind(seeded, time);
    // One feature draws once: a copy hands its fade to the kept one and goes out at once.
    const copyOf = this.baseCache.labelCopyOf;
    for (const index of this.baseCache.copyIndices) this.baseFade.transfer(index, copyOf[index]!);
    this.activeSpans.rebind(this.baseCache.tileRuns);
    this.solver.rebindBase(this.baseCache.ranks.priority, this.baseCache.rankOrder);
    this.baseHalfSizesPx = new Float32Array(count * 2);
    this.baseScaledHalfSizesPx = new Float32Array(count * 2);
    this.solvedPixelsPerPoint = 0;
    this.basePerspectiveScales = new Float32Array(count).fill(1);
    this.baseHorizonVisible = new Uint8Array(count);
    this.baseLocalSuppressed = new Uint8Array(count);
    this.baseAnchors = new Float32Array(count * 3);
    this.baseCenters = new Float32Array(count * 2);
    this.baseReservesSpace = new Uint8Array(count);
    this.baseCollisionVisible = new Uint8Array(count);
    this.baseTargetVisible = new Uint8Array(count);
    this.roadFade.rebind(road, time);
    this.roadCollisionVisible = new Uint8Array(road.count);
    this.roadTargetVisible = new Uint8Array(road.count);
    this.roadRecordActive = this.roadCache.orderedRecords.map(() => true);
  }

  private rescaleBaseHalfSizes(pixelsPerPoint: number): void {
    const margin = this.collisionMarginPoints;
    const halves = this.baseCache.halfSizes;
    const count = Math.min(halves.length, this.baseHalfSizesPx.length);
    for (let i = 0; i < count; i++) this.baseHalfSizesPx[i] = (halves[i]! + margin) * pixelsPerPoint;
  }

  // MARK: Projection

  /** Each base tile slot's origin and size on the flat map, three per slot. */
  private writeSlotOrigins(frame: LabelFrameInput): Float64Array {
    const records = this.baseCache.tileRecords;
    if (this.slotOrigins.length !== records.length * 3) this.slotOrigins = new Float64Array(records.length * 3);
    const { pan, renderMapSize } = frame.flatRenderState;
    records.forEach((record, slot) => {
      const t = record.ownerKey.tile;
      const [x, y, size] = ImmersiveMapProjection.flatTileOriginAndSize(t.x, t.y, t.z, record.ownerKey.worldWrap, pan, renderMapSize);
      this.slotOrigins[slot * 3] = x;
      this.slotOrigins[slot * 3 + 1] = y;
      this.slotOrigins[slot * 3 + 2] = size;
    });
    return this.slotOrigins;
  }

  /** The base anchors on screen for this camera, written in place into the records the shaders read. */
  private projectBaseLabels(frame: LabelFrameInput, distanceScale: number, spans: readonly number[]): void {
    const cache = this.baseCache;
    if (cache.labelCount === 0) return;
    const out = { horizonVisible: this.baseHorizonVisible, perspectiveScales: this.basePerspectiveScales, anchors: this.baseAnchors };
    const common = {
      projectionView: frame.projectionView,
      eye: frame.cameraEye,
      viewportWidth: frame.drawWidth,
      viewportHeight: frame.drawHeight,
      minimumPerspectiveScale: frame.debugReach?.perspectiveMinimumScale ?? this.perspectiveMinimumScale,
      maximumDistanceScale: distanceScale,
    };
    if (frame.screenSpaceProjectionMode === "flat" || frame.globeConstants === undefined) {
      projectFlatLabels(cache, { ...common, slotOrigins: this.writeSlotOrigins(frame), buildingRise: frame.buildingRise, groundLift: this.groundLift(frame) }, spans, out);
    } else {
      projectGlobeLabels(cache, { ...common, globe: frame.globe, ...frame.globeConstants }, spans, out);
    }
    const L = LabelFrameRecordLayout;
    const records = cache.frameRecords;
    const count = Math.min(cache.labelCount, this.baseCenters.length / 2);
    for (let s = 0; s + 1 < spans.length; s += 2) {
      const end = Math.min(spans[s + 1]!, count);
      for (let index = spans[s]!; index < end; index++) {
        this.baseCenters[index * 2] = records[index * L.floats + L.screenX]!;
        this.baseCenters[index * 2 + 1] = records[index * L.floats + L.screenY]!;
      }
    }
    cache.updatePerspectiveScales(this.basePerspectiveScales, spans);
  }

  /**
   * Which local labels are out of reach this frame: outside the three by
   * three tiles around the look-at point, or farther from the camera than
   * the setting, measured to where the label draws. Only on the flat map is
   * the distance measured: on the globe the tiles alone decide.
   */
  private resolveLocalDetail(frame: LabelFrameInput, spans: readonly number[]): boolean {
    let unitsPerMeter: number | undefined;
    if (frame.screenSpaceProjectionMode === "flat") {
      const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(frame.centerWorldMercator[1]);
      const units = ImmersiveMapProjection.worldUnitsPerMeter(latitude, frame.flatRenderState.renderMapSize);
      if (units > 0 && Number.isFinite(units)) unitsPerMeter = units;
    }
    return BaseLabelVisibilityResolver.localSuppression(
      this.baseCache.presentation,
      this.baseCache.tiles,
      this.baseAnchors,
      frame.centerWorldMercator,
      { eye: frame.cameraEye, unitsPerMeter, maximumDistanceMeters: frame.debugReach?.localDetailMaximumDistanceMeters ?? this.localDetailMaximumDistanceMeters },
      spans,
      this.baseLocalSuppressed,
    );
  }

  // MARK: Road placement

  /**
   * Lays every near road tile's glyphs along their roads for this camera, on
   * the flat map. A tile too far or too flat on screen for its names keeps
   * its last placement and offers nothing to the solve, so its names fade
   * out where they were.
   */
  private placeRoadLabels(frame: LabelFrameInput, distanceScale: number): void {
    const records = this.roadCache.orderedRecords;
    if (frame.renderSurfaceMode !== "flat" || records.length === 0) return;
    if (this.roadRecordActive.length !== records.length) this.roadRecordActive = records.map(() => true);
    const m = frame.projectionView;
    // The reach is measured as the base labels' is: in multiples of the camera's depth of the point it looks at.
    const maximumDepth = m[15]! * Math.max(distanceScale, 0);
    const { pan, renderMapSize } = frame.flatRenderState;
    const relief = frame.relief?.isActive === true ? frame.relief : undefined;
    const displacements = relief === undefined ? new Map<string, Tile>() : PlaceTilesContext.displacementBySource(frame.placements);
    records.forEach((record, index) => {
      const t = record.ownerKey.tile;
      const origin = ImmersiveMapProjection.flatTileOriginAndSize(t.x, t.y, t.z, record.ownerKey.worldWrap, pan, renderMapSize);
      const corners = RoadLabelNearCameraFilter.flatTileClipCorners(m, origin[0], origin[1], origin[2]);
      if (!RoadLabelNearCameraFilter.shouldKeepTile(corners, frame.drawWidth, frame.drawHeight, frame.pixelsPerPoint, Math.max(0, frame.tileZoomLevel - t.z))) {
        this.roadRecordActive[index] = false;
        return;
      }
      this.roadRecordActive[index] = true;
      if (record.glyphCount === 0) {
        record.placement.hideAll();
        return;
      }
      // The names ride the ground relief of their tile, where its terrain is in.
      let lifts: RoadLabelPointLifts | undefined;
      if (relief !== undefined) {
        const lift = GroundReliefTileLift.make(relief, record.resident.tile, displacements.get(tileKey(record.resident.tile)));
        if (lift !== undefined) lifts = { metres: record.reliefMetres(lift.relief), datumMetres: lift.datumMetres, unitsPerMetre: lift.relief.strength * lift.unitsPerMetre };
      }
      RoadLabelPlacer.place(record.geometry, origin, m, frame.drawWidth, frame.drawHeight, frame.pixelsPerPoint, maximumDepth, record.placement, lifts);
    });
  }

  /**
   * The ground relief's lift under a label's point, by its tile, `undefined`
   * on the plane: the terrain each source's ground rises by is its
   * placements' (`PlaceTile.displacement`), looked up once per tile.
   */
  private groundLift(frame: LabelFrameInput): FlatLabelProjectionFrame["groundLift"] {
    const relief = frame.relief?.isActive === true ? frame.relief : undefined;
    if (relief === undefined) return undefined;
    const displacements = PlaceTilesContext.displacementBySource(frame.placements);
    const lifts = new Map<string, GroundReliefTileLift | undefined>();
    return (z, x, y, u, v) => {
      const key = `${z}/${x}/${y}`;
      let lift = lifts.get(key);
      if (lift === undefined && !lifts.has(key)) {
        lift = GroundReliefTileLift.make(relief, { x, y, z }, displacements.get(key));
        lifts.set(key, lift);
      }
      return lift === undefined ? 0 : lift.worldUnits(u, v);
    };
  }

  /**
   * The road instances for the solve from the frame's placement: an instance
   * whose glyphs all sit on the road, none past an end, none turning too
   * sharply against its neighbour, offered with its glyph boxes as one.
   */
  private prepareRoadInstances(frame: LabelFrameInput): void {
    this.roadItems.clear();
    this.roadBoxes.count = 0;
    if (frame.renderSurfaceMode !== "flat") return;
    this.roadCache.orderedRecords.forEach((record, recordIndex) => {
      if (!this.roadRecordActive[recordIndex]) return;
      const ranges = record.geometry.instanceGlyphRanges;
      for (let local = 0; local < record.instanceCount; local++) {
        const boxStart = this.roadBoxes.count;
        if (!RoadLabelPlacer.appendInstanceBoxes(ranges[local * 2]!, ranges[local * 2 + 1]!, record.placement, this.maxGlyphTurnRadians, this.roadBoxes)) continue;
        const ordinal = record.instanceAnchorOrdinals[local]!;
        this.roadItems.push(
          ROAD_PRIORITY_BASE,
          record.sourcePriority * 1024 + ordinal,
          ordinal,
          recordIndex,
          record.instanceKeyHalves[local * 2]!,
          record.instanceKeyHalves[local * 2 + 1]!,
          boxStart,
          this.roadBoxes.count,
          record.instanceStart + local,
        );
      }
    });
  }

  // MARK: Collisions

  private solveCollisions(frame: LabelFrameInput, spans: readonly number[]): void {
    const cache = this.baseCache;
    const L = LabelFrameRecordLayout;
    const screenVisible = this.screenVisibleColumn();
    BaseLabelVisibilityResolver.reservesSpace(cache.presentation, screenVisible, this.baseHorizonVisible, this.baseLocalSuppressed, this.baseFade.currentAlphas, frame.planningZoom, spans, this.baseReservesSpace);
    this.prepareRoadInstances(frame);
    this.roadCollisionVisible.fill(0);
    // The box shrinks with the label, the spacing between two labels does not: the margin is added after the scale.
    const marginPx = this.collisionMarginPoints * frame.pixelsPerPoint;
    const scaledCount = Math.min(this.baseHalfSizesPx.length / 2, this.basePerspectiveScales.length);
    for (let s = 0; s + 1 < spans.length; s += 2) {
      const end = Math.min(spans[s + 1]!, scaledCount);
      for (let index = spans[s]!; index < end; index++) {
        const scale = cache.frameRecords[index * L.floats + L.perspectiveScale]!;
        this.baseScaledHalfSizesPx[index * 2] = (this.baseHalfSizesPx[index * 2]! - marginPx) * scale + marginPx;
        this.baseScaledHalfSizesPx[index * 2 + 1] = (this.baseHalfSizesPx[index * 2 + 1]! - marginPx) * scale + marginPx;
      }
    }
    this.solver.solve(
      {
        viewportWidth: frame.drawWidth,
        viewportHeight: frame.drawHeight,
        cellSizePx: this.collisionGridCellSizePoints * frame.pixelsPerPoint,
        baseCenters: this.baseCenters,
        baseHalfSizes: this.baseScaledHalfSizesPx,
        baseEnabled: this.baseReservesSpace,
        roadItems: this.roadItems,
        roadCenters: this.roadBoxes.centers,
        roadHalfSizes: this.roadBoxes.halfSizes,
        roadBoxCount: this.roadBoxes.count,
      },
      this.baseCollisionVisible,
      this.roadCollisionVisible,
    );
  }

  private screenVisibleScratch = new Uint8Array(0);

  /** The records' drawable flags as a column, for the visibility rules. */
  private screenVisibleColumn(): Uint8Array {
    const cache = this.baseCache;
    const L = LabelFrameRecordLayout;
    if (this.screenVisibleScratch.length !== cache.labelCount) this.screenVisibleScratch = new Uint8Array(cache.labelCount);
    const records = cache.frameRecords;
    const spans = this.activeSpans.spans;
    for (let s = 0; s + 1 < spans.length; s += 2) {
      for (let index = spans[s]!; index < spans[s + 1]!; index++) this.screenVisibleScratch[index] = records[index * L.floats + L.visible] !== 0 ? 1 : 0;
    }
    return this.screenVisibleScratch;
  }

  private writeCameraFingerprint(frame: LabelFrameInput): void {
    const f = this.cameraFingerprint;
    const state = frame.cameraState;
    f[0] = state.centerWorldMercator[0];
    f[1] = state.centerWorldMercator[1];
    f[2] = state.zoom;
    f[3] = state.bearing;
    f[4] = state.pitch;
    f[5] = Math.round(frame.drawWidth);
    f[6] = Math.round(frame.drawHeight);
    f[7] = frame.renderSurfaceMode === "flat" ? 1 : 0;
    f[8] = frame.screenSpaceProjectionMode === "flat" ? 1 : 0;
    // The projection also depends on the globe (transition, radius, pan),
    // which can change with an unchanged camera.
    f[9] = frame.globe.transition;
    f[10] = frame.globe.radius;
    f[11] = frame.globe.panX;
    f[12] = frame.globe.panY;
    // The labels on the roofs rise with the buildings.
    f[13] = frame.buildingRiseSignature;
    // The labels on the relief are placed again when its terrain changes,
    // when the datum moves and as it rises or collapses.
    const relief = frame.relief?.isActive === true ? frame.relief : undefined;
    f[14] = relief?.version ?? -1;
    f[15] = relief?.datumMetres ?? 0;
    f[16] = relief?.strength ?? 0;
  }

  // MARK: Debug

  /**
   * The frames of the labels for the debug overlay (the Swift
   * `makeDebugBoxesState`): the base labels on screen at the camera's zoom,
   * green or red by their fade, and the road glyphs offered to the last
   * solve, by that solve's decision. A label beyond the horizon has no point
   * and no frame. A label outside its camera zooms is left out: red means
   * lost the collision, not not grown to the zoom yet.
   */
  private makeDebugBoxesState(frame: LabelFrameInput, request: LabelDebugBoxesRequest, spans: readonly number[]): LabelDebugBoxesState {
    if (!request.base && !request.road) return emptyLabelDebugBoxes;
    const height = frame.drawHeight;
    const boxes: LabelDebugBox[] = [];
    if (request.base) {
      const cache = this.baseCache;
      const L = LabelFrameRecordLayout;
      const records = cache.frameRecords;
      const halves = cache.halfSizes;
      const alphas = this.baseFade.currentAlphas;
      const presentation = cache.presentation;
      const ppp = frame.pixelsPerPoint;
      const count = Math.min(cache.labelCount, halves.length / 2);
      for (let s = 0; s + 1 < spans.length; s += 2) {
        const end = Math.min(spans[s + 1]!, count);
        for (let index = spans[s]!; index < end; index++) {
          const r = index * L.floats;
          if (records[r + L.visible] === 0 || !showsAtZoom(presentation, index, frame.planningZoom)) continue;
          const cx = records[r + L.screenX]!;
          const cy = height - records[r + L.screenY]!;
          const hx = halves[index * 2]! * ppp;
          const hy = halves[index * 2 + 1]! * ppp;
          boxes.push({ minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy, isVisible: (alphas[index] ?? 0) > 0.01 });
        }
      }
    }
    const roadBoxes: LabelDebugBox[] = [];
    if (request.road) {
      const items = this.roadItems.items;
      const centers = this.roadBoxes.centers;
      const halves = this.roadBoxes.halfSizes;
      const boxCount = this.roadBoxes.count;
      for (let o = 0; o < items.length; o += ROAD_ITEM_STRIDE) {
        const target = items[o + 8]!;
        const isVisible = target < this.roadCollisionVisible.length && this.roadCollisionVisible[target] === 1;
        const end = Math.min(items[o + 7]!, boxCount);
        for (let box = items[o + 6]!; box < end; box++) {
          const cx = centers[box * 2]!;
          const cy = height - centers[box * 2 + 1]!;
          const hx = halves[box * 2]!;
          const hy = halves[box * 2 + 1]!;
          roadBoxes.push({ minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy, isVisible });
        }
      }
    }
    return { boxes, roadBoxes };
  }

  /** One base label trace line for the frame (the Swift `recordBaseLabelTraceFrame`). The web has no projection index, so the projection never changes. */
  private recordTraceFrame(frame: LabelFrameInput, sourceTileCount: number, trackedTilesChanged: boolean, overviewAlpha: number): void {
    const cache = this.baseCache;
    this.traceRecorder?.recordBaseLabelFrame({
      frameIndex: frame.frameIndex ?? this.traceFrameCount,
      zoom: frame.cameraState.zoom,
      pitch: frame.cameraState.pitch,
      bearing: frame.cameraState.bearing,
      sourceTileCount,
      trackedTilesChanged,
      projectionChanged: false,
      labelCount: cache.labelCount,
      keys: cache.keys,
      copyOf: cache.labelCopyOf,
      collisionVisible: this.baseCollisionVisible,
      targetVisible: this.baseTargetVisible,
      horizonVisible: this.baseHorizonVisible,
      fadeAlphas: this.baseFade.currentAlphas,
      overviewFadeAlpha: overviewAlpha,
      screenRecords: cache.frameRecords,
      screenLayout: LabelFrameRecordLayout,
      halfSizes: cache.halfSizes,
      pixelsPerPoint: frame.pixelsPerPoint,
      priorities: cache.ranks.priority,
    });
  }

  // MARK: Road label state

  /**
   * Advances the road fades and writes the frame's glyph records: every
   * record's placement and its instances' fades, one draw per record.
   */
  private buildRoadLabelState(frame: LabelFrameInput): void {
    const records = this.roadCache.orderedRecords;
    const instanceCount = this.roadCache.instanceCount;
    if (frame.renderSurfaceMode !== "flat" || instanceCount === 0) {
      this.roadDraws = [];
      this.roadGlyphCount = 0;
      this.roadFadesActive = false;
      return;
    }
    if (this.roadTargetVisible.length !== instanceCount) this.roadTargetVisible = new Uint8Array(instanceCount);
    this.roadTargetVisible.fill(0);
    this.roadTargetVisible.set(this.roadCollisionVisible.subarray(0, Math.min(instanceCount, this.roadCollisionVisible.length)));
    this.roadFadesActive = this.roadFade.advance(this.roadTargetVisible, frame.timeSeconds, this.fadeInSeconds, this.fadeOutSeconds);
    const alphas = this.roadFade.currentAlphas;
    let totalGlyphs = 0;
    for (const record of records) totalGlyphs += record.glyphCount;
    const floats = RoadGlyphRecordLayout.floats;
    if (this.roadGlyphRecords.length < totalGlyphs * floats) this.roadGlyphRecords = new Float32Array(Math.max(totalGlyphs * floats, this.roadGlyphRecords.length * 2));
    const out = this.roadGlyphRecords;
    const draws: RoadLabelDraw[] = [];
    let shift = 0;
    let anyVisible = false;
    const G = RoadGlyphLayout;
    for (const record of records) {
      const glyphs = record.geometry.glyphs;
      const instances = record.geometry.glyphInstances;
      const placements = record.placement.placements;
      for (let glyph = 0; glyph < record.glyphCount; glyph++) {
        const instance = record.instanceStart + instances[glyph]!;
        const alpha = instance < alphas.length ? alphas[instance]! : 0;
        if (alpha > 0.0001) anyVisible = true;
        const o = (shift + glyph) * floats;
        // A dark glyph is hidden by its alpha alone: the rest of its record is never read.
        if (!(alpha > 0) || placements[glyph * 4 + 3] === 0) {
          out[o + 3] = 0;
          continue;
        }
        out[o] = placements[glyph * 4]!;
        out[o + 1] = placements[glyph * 4 + 1]!;
        out[o + 2] = placements[glyph * 4 + 2]!;
        out[o + 3] = alpha;
        out[o + 4] = glyphs[glyph * G.floats + G.center]!;
        out[o + 5] = glyphs[glyph * G.floats + G.labelCenterY]!;
        out[o + 6] = 0;
        out[o + 7] = 0;
      }
      if (record.hasRenderableGlyphs) draws.push({ record, glyphShift: shift });
      shift += record.glyphCount;
    }
    if (!this.roadFadesActive && !anyVisible) {
      this.roadDraws = [];
      this.roadGlyphCount = 0;
      return;
    }
    this.roadDraws = draws;
    this.roadGlyphCount = shift;
  }
}

function sameFingerprint(a: Float64Array | undefined, b: Float64Array): boolean {
  if (a === undefined) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
