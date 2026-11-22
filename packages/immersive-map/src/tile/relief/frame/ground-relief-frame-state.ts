// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { CameraTerrainFollow } from "../../../camera/relief/camera-terrain-follow.ts";
import { groundReliefTileZoom, type GroundReliefSettings } from "../../../configuration/tile-settings.ts";
import type { Vec2, Vec3 } from "../../../math/vec.ts";
import { defaultHillshade, defaultTerrainOcclusion, type ImmersiveMapHillshade, type ImmersiveMapTerrainOcclusion } from "../../../style/theme.ts";
import type { FlatRingBand } from "../../visibility/flat-ring-rules.ts";
import { TileCoverageZoomPolicy } from "../../visibility/tile-coverage-zoom-policy.ts";
import { GroundReliefOcclusionKey } from "../store/ground-relief-occlusion.ts";
import { GroundReliefStore } from "../store/ground-relief-store.ts";
import { GroundReliefFrame } from "./ground-relief-frame.ts";
import { GroundReliefHillshade, type GroundReliefHillshadeAmounts, type GroundReliefHillshadeFade } from "./ground-relief-hillshade.ts";
import { GroundReliefUniform } from "./ground-relief-uniform.ts";

/**
 * The ground relief's state across frames, which the frame sets once a
 * frame and reads as a value (`frame`, `GroundReliefFrame`), a port of the
 * Swift `GroundReliefFrameState`: how far the relief has risen and its rise
 * and collapse over the zooms, the world units a metre rises by, the light
 * the slopes are shaded by, the darkening where the terrain hides the sky,
 * whether the mountains cast shadows, whether the frame is on the terrain
 * and the datum it is drawn from. The terrain tiles are the store's
 * (`store`), which this state tells only the frame's ring bands and the key
 * the tiles' occlusion is computed with.
 *
 * The frame sets it in order: the frame's start first (`beginFrame`), the
 * zoom (`setFrame`), then the world scale, the light, the occlusion and the
 * shadows, then the bands and whether the frame is on the terrain, and last
 * the datum, read off the terrain as the frame now draws it. Everything
 * after reads `frame`.
 */
export class GroundReliefFrameState {
  private readonly configuredExaggeration: number;
  private readonly appearZoom: number;
  private readonly collapseZoom: number;
  private readonly collapsesWhereTerrainIsMissing: boolean;
  private readonly deepestTileZoom: number;
  private readonly transitionSeconds: number;
  /**
   * The frame's tile zoom the ground rises from, the tile zoom of
   * `GroundReliefSettings.appearZoom`: a frame of coarser tiles, and
   * whatever stands on them, lies on the plane, and so does the camera.
   */
  readonly fromTileZoom: number;
  /** The least height the camera keeps over the relief under it. */
  readonly cameraClearanceMetres: number;

  private hillshadeStyle: ImmersiveMapHillshade;
  private occlusionStyle: ImmersiveMapTerrainOcclusion;
  private occlusion: ImmersiveMapTerrainOcclusion;
  private occlusionDebugView = false;

  /**
   * How much of the relief stands: 1 standing, 0 lying in the plane,
   * between them on its way over `transitionSeconds`. Never a function of
   * the zoom itself: a relief scaled with the zoom breathes with every drag
   * over the terrain, whose slopes move the zoom.
   */
  private standing = 1;
  private risenShare = 1;
  private strength: number;
  private frameZoom = 0;
  private terrainIsMissing = false;
  private lightDirection: Vec3 = [-0.4, -0.6, 1.0];
  private cameraEye: Vec3 = [0, 0, 1];
  private hillshadeFade: GroundReliefHillshadeFade | undefined;
  private hillshadeAmounts: GroundReliefHillshadeAmounts | undefined;
  private hillshade: GroundReliefHillshade = GroundReliefHillshade.none;
  private castsShadowsEnabled = false;
  private worldUnitsPerMetre = 0;
  private active = true;
  private datumMetres = 0;
  private settledFrame: GroundReliefFrame | undefined;

  /**
   * `deepestTileZoom` is the tileset's deepest zoom, which with the relief's
   * collapse bounds the tiles the relief is drawn on (`fromTileZoom`). The
   * store's tiles are computed with the occlusion's key from here on.
   */
  constructor(
    readonly store: GroundReliefStore,
    settings: GroundReliefSettings,
    deepestTileZoom = 15,
    hillshade: ImmersiveMapHillshade = defaultHillshade,
    occlusion: ImmersiveMapTerrainOcclusion = defaultTerrainOcclusion,
  ) {
    this.configuredExaggeration = settings.exaggeration;
    this.appearZoom = settings.appearZoom;
    this.collapseZoom = settings.collapseZoom;
    this.collapsesWhereTerrainIsMissing = settings.collapsesWhereTerrainIsMissing;
    this.deepestTileZoom = deepestTileZoom;
    this.transitionSeconds = Math.max(settings.transitionSeconds, 0);
    this.fromTileZoom = groundReliefTileZoom(settings, deepestTileZoom);
    this.cameraClearanceMetres = Math.max(0, settings.cameraClearanceMetres);
    this.hillshadeStyle = hillshade;
    this.occlusionStyle = occlusion;
    this.occlusion = occlusion;
    // Until the first frame: the relief as configured, standing.
    this.strength = settings.exaggeration;
    store.setOcclusionKey(GroundReliefOcclusionKey.ofStyle(occlusion));
    this.resolveHillshade();
    this.publishDemandFrame();
  }

  /** The relief as the frame draws it, settled by the setters before it. */
  get frame(): GroundReliefFrame {
    this.settledFrame ??= new GroundReliefFrame(this.store, {
      isActive: this.active,
      strength: this.strength,
      standingShare: this.standing,
      datumMetres: this.datumMetres,
      worldUnitsPerMetre: this.worldUnitsPerMetre,
      hillshade: this.hillshade,
      occlusionUniform: this.occlusionUniform,
      castsShadows: this.castsShadowsEnabled && this.active && this.strength > 0,
      fromTileZoom: this.fromTileZoom,
      collapseTileZoom: this.collapseTileZoom,
    });
    return this.settledFrame;
  }

  /** How much of the relief stands. */
  get standingShare(): number {
    return this.standing;
  }

  /** Whether the frame is on the terrain (`setActive`). */
  get isActive(): boolean {
    return this.active;
  }

  // MARK: The frame's start

  /** The frame's start, before the frame's commands: the terrain tiles' edges welded since the last frame are written (`GroundReliefStore.applyPendingWelds`). */
  beginFrame(): void {
    this.store.applyPendingWelds();
  }

  /** The wanted terrain tiles still on their way: what a still capture waits for. */
  get pendingTerrainTileCount(): number {
    return this.store.pendingWantedCount;
  }

  // MARK: The rise and the collapse

  /**
   * The frame's zoom, once a frame, before anything of the frame reads the
   * relief. The relief moves toward standing when the zoom is within its
   * zooms and toward the plane when it is not, by `deltaTime` over
   * `transitionSeconds`, or at once with `snap`. Without a `deltaTime` it is
   * settled where the zoom puts it. `centerWorldMercator` is the point the
   * camera looks at: where the source has no terrain at the zoom the near
   * ring reads it under that point, the relief moves toward the plane as
   * past `collapseZoom`.
   */
  setFrame(zoom: number, centerWorldMercator?: Vec2, deltaTime?: number, snap = false): void {
    this.frameZoom = zoom;
    if (this.collapsesWhereTerrainIsMissing && centerWorldMercator !== undefined) {
      const tileZoom = TileCoverageZoomPolicy.resolve(zoom, "flat", this.deepestTileZoom).baseZoom;
      this.terrainIsMissing = this.store.ringTerrainIsMissing(centerWorldMercator, tileZoom);
    } else {
      this.terrainIsMissing = false;
    }
    const target = this.stands(zoom) ? 1 : 0;
    if (deltaTime !== undefined && !snap && this.transitionSeconds > 0) {
      const step = Math.max(deltaTime, 0) / this.transitionSeconds;
      this.standing = target > this.standing ? Math.min(this.standing + step, target) : Math.max(this.standing - step, target);
    } else {
      this.standing = target;
    }
    const share = this.standing;
    const eased = share * share * (3 - 2 * share);
    this.risenShare = eased;
    this.strength = this.configuredExaggeration * eased;
    this.resolveHillshade();
    this.changed();
  }

  /** Whether the rise or the collapse is under way this frame: the frames keep coming while it is. */
  get isTransitioning(): boolean {
    return this.standing > 0 && this.standing < 1;
  }

  /** Whether the relief stands at a zoom: from `appearZoom` up to `collapseZoom`, and not where the source has no terrain for the near ring. */
  stands(zoom: number): boolean {
    return zoom >= this.appearZoom && zoom < this.collapseZoom && !this.terrainIsMissing;
  }

  /** Whether anything of the relief stands at a zoom: within its zooms, or still on its way into the plane. */
  isVisible(zoom: number): boolean {
    return this.stands(zoom) || this.standing > 0;
  }

  /** The tile zoom of the collapse zoom: the deepest tile zoom whose frames the relief stands on. */
  get collapseTileZoom(): number {
    return Number.isFinite(this.collapseZoom) ? Math.floor(Math.max(this.collapseZoom, 0)) : Number.MAX_SAFE_INTEGER;
  }

  // MARK: The frame's world and light

  /**
   * The frame's world units a metre of terrain rises by, at the latitude of
   * `centerWorldMercator`, on a map `renderMapSize` across. One for every
   * tile and everything on them, so neighbours meet with the same heights
   * at the same rise.
   */
  setWorldScale(centerWorldMercator: Vec2, renderMapSize: number): void {
    this.worldUnitsPerMetre = GroundReliefUniform.worldUnitsPerMetre(centerWorldMercator[1], renderMapSize);
    this.resolveHillshade();
    this.changed();
  }

  /**
   * The map style's shading and occlusion, applied live with a new style:
   * the next `setLight` and `setOcclusion` read them.
   */
  setStyle(hillshade: ImmersiveMapHillshade, occlusion: ImmersiveMapTerrainOcclusion): void {
    this.hillshadeStyle = hillshade;
    this.occlusionStyle = occlusion;
  }

  /** The scene's light this frame (toward the light), which the slopes are shaded by, and the eye they fade with the distance from. */
  setLight(direction: Vec3, cameraEye: Vec3, fade?: GroundReliefHillshadeFade, amounts?: GroundReliefHillshadeAmounts): void {
    this.lightDirection = direction;
    this.cameraEye = cameraEye;
    this.hillshadeFade = fade;
    this.hillshadeAmounts = amounts;
    this.resolveHillshade();
    this.changed();
  }

  private resolveHillshade(): void {
    this.hillshade = GroundReliefHillshade.resolve({
      style: this.hillshadeStyle,
      lightDirection: this.lightDirection,
      risenShare: this.risenShare,
      cameraEye: this.cameraEye,
      zoom: this.frameZoom,
      unitsPerMetre: this.worldUnitsPerMetre,
      fade: this.hillshadeFade,
      amounts: this.hillshadeAmounts,
    });
  }

  /**
   * How the ground is darkened this frame: `style` replaces the map style's,
   * `undefined` keeps it. `debugView` draws the occlusion alone. A change to
   * what the tiles' occlusion is computed with computes every tile in again.
   */
  setOcclusion(style: ImmersiveMapTerrainOcclusion | undefined, debugView: boolean): void {
    const resolved = style ?? this.occlusionStyle;
    this.occlusionDebugView = debugView;
    this.changed();
    const current = this.occlusion;
    if (
      resolved.isEnabled === current.isEnabled &&
      resolved.strength === current.strength &&
      resolved.radiusMeters === current.radiusMeters &&
      resolved.directions === current.directions &&
      resolved.resolution === current.resolution
    ) {
      return;
    }
    this.occlusion = resolved;
    this.store.setOcclusionKey(GroundReliefOcclusionKey.ofStyle(resolved));
  }

  /** The strength the fills darken by this frame and whether they draw the occlusion alone. */
  private get occlusionUniform(): [number, number, number, number] {
    const strength = this.occlusion.isEnabled ? Math.min(Math.max(this.occlusion.strength, 0), 1) * this.risenShare : 0;
    return [strength, this.occlusionDebugView ? 1 : 0, 0, 0];
  }

  /** Whether the mountains may cast their shadows this frame. */
  setCastsShadows(isEnabled: boolean): void {
    this.castsShadowsEnabled = isEnabled;
    this.changed();
  }

  // MARK: On the terrain

  /** The frame's ring bands, which the store reads its rings' terrain by. */
  setBands(bands: readonly FlatRingBand[]): void {
    this.store.setBands(bands);
  }

  /**
   * Whether the frame is on the terrain: the flat map with tiles of the
   * relief's zoom or deeper, at a zoom within the relief's zooms or on its
   * way out of them (`isVisible`).
   */
  setActive(isActive: boolean): void {
    this.active = isActive;
    this.changed();
  }

  /**
   * The frame's datum (`GroundReliefCameraLift.datumMetres`). The ground,
   * the buildings and the labels rise by their terrain's height over it, so
   * the point the camera looks at lies at the world's origin, on the ground.
   */
  setDatum(metres: number): void {
    this.datumMetres = metres;
    this.changed();
  }

  // MARK: The camera

  /**
   * The camera's terrain (`CameraTerrainFollow`): one map at every zoom,
   * the terrain tiles of `cameraTerrainZoom`, read as drawn, at the
   * strength of each place, off the last frame's relief. The camera over
   * tiles coarser than the relief's zoom is over the plane, like the tiles.
   */
  makeTerrainFollow(tileZoom: (cameraZoom: number) => number, globeRadiusScale: number, cameraZoom: () => number): CameraTerrainFollow {
    const cameraTerrainZoom = this.store.cameraTerrainZoom;
    return new CameraTerrainFollow({
      terrainMetres: (point) => {
        if (tileZoom(cameraZoom()) < this.fromTileZoom) return 0;
        return this.frame.drawnMetres(point, cameraTerrainZoom) ?? null;
      },
      clearanceMetres: this.cameraClearanceMetres,
      globeRadiusScale,
      sampleStepWorld: 1 / (2 ** cameraTerrainZoom * GroundReliefStore.nominalTerrainTileSize),
    });
  }

  private changed(): void {
    this.settledFrame = undefined;
    this.publishDemandFrame();
  }

  /** What the store's demand reads of the frame (`GroundReliefStore.request`). */
  private publishDemandFrame(): void {
    this.store.demandFrame = { isActive: this.active, fromTileZoom: this.fromTileZoom, collapseTileZoom: this.collapseTileZoom };
  }
}
