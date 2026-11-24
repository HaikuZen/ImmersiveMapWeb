// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The `configuration` folder: the public settings and the small planner that
// classifies a settings change into the domains it touches. It describes
// intent and performs no runtime side effect: no controllers mutating render,
// tile, camera or UI state, no networking or secrets, no WebGPU, no tile
// parsing or label decisions. Defaults here are safe to publish.

import { defaultMapStyle, nightMapStyle } from "../style/theme.ts";
import type { ProtomapsBasemapMapStyle } from "../style/theme.ts";
import { ImmersiveMapAttribution } from "./attribution.ts";
import { defaultAttributionSettings } from "./attribution-settings.ts";
import type { AttributionSettings } from "./attribution-settings.ts";
import type { ImmersiveMapByteCount } from "./byte-count.ts";
import { cameraBounds, controlZoneSettings, defaultCameraSettings, globeBearingLimit, globeUprightPull } from "./camera-settings.ts";
import type { CameraBounds, CameraBoundsOptions, CameraSettings, GlobeBearingLimit, GlobeUprightPull } from "./camera-settings.ts";
import type { Vector3 } from "./color.ts";
import { deepEqual, deepFreeze, mergeOptions } from "./deep.ts";
import type { DeepMutable, Options } from "./deep.ts";
import { LabelLanguage, defaultLabelSettings } from "./label-settings.ts";
import type { LabelSettings } from "./label-settings.ts";
import { clampedModelDepthBias, defaultModelArchiveSettings, withModelArchiveOptions } from "./model-archive-settings.ts";
import type { ModelArchiveSettings } from "./model-archive-settings.ts";
import { defaultPinSettings } from "./pin-settings.ts";
import type { PinSettings } from "./pin-settings.ts";
import { defaultPresentationSettings } from "./presentation-settings.ts";
import type { PresentationSettings } from "./presentation-settings.ts";
import {
  defaultExtrusionSettings,
  defaultFogSettings,
  defaultSceneSettings,
  groundFogCurveFields,
  nightFogSettings,
  shadowCurveFields,
} from "./scene-settings.ts";
import type {
  AtmosphereSettings,
  FogSettings,
  GlobeLightSettings,
  GroundFogCurveField,
  GroundFogSettings,
  SceneSettings,
  ShadowSettings,
} from "./scene-settings.ts";
import type { ImmersiveMapTerrainSource } from "./terrain-source.ts";
import { defaultTileSettings, groundReliefCredit, withTerrainSurroundings } from "./tile-settings.ts";
import type { CacheSettings, GroundReliefSettings, TerrainSurroundingsSettings, TileSettings } from "./tile-settings.ts";
import { defaultTileGridSettings, tileGridSettings } from "./tile-grid-settings.ts";
import type { TileGridSettings } from "./tile-grid-settings.ts";
import { ImmersiveMapTilesService } from "./tiles-service.ts";
import {
  defaultControlsSettings,
  defaultDebugSettings,
  defaultPostProcessingSettings,
  defaultRenderLoopSettings,
  defaultViewReuseSettings,
} from "./view-settings.ts";
import type { ControlsSettings, DebugSettings, PostProcessingSettings, RenderLoopSettings, ViewReuseSettings } from "./view-settings.ts";
import { zoomCurve } from "./zoom-curve.ts";
import type { ZoomCurveInput } from "./zoom-curve.ts";

/**
 * The map's whole configuration as plain data: what crosses to a Web
 * Worker by structured clone and to disk by JSON. An `ImmersiveMapSettings`
 * is this data with the modifiers on it, and `new ImmersiveMapSettings(data)`
 * (or `ImmersiveMapSettings.from(data)`) turns the data back into one.
 */
export interface ImmersiveMapSettingsData {
  readonly renderLoop: RenderLoopSettings;
  readonly camera: CameraSettings;
  readonly presentation: PresentationSettings;
  /** How the tiles are parsed and drawn: the built-in style in its theme. */
  readonly mapStyle: ProtomapsBasemapMapStyle;
  readonly tiles: TileSettings;
  readonly labels: LabelSettings;
  readonly scene: SceneSettings;
  readonly pins: PinSettings;
  readonly attribution: AttributionSettings;
  readonly postProcessing: PostProcessingSettings;
  readonly viewReuse: ViewReuseSettings;
  readonly debug: DebugSettings;
  /** The controls drawn over the map, see `ControlsSettings`. */
  readonly controls: ControlsSettings;
  /**
   * The archive the map loads building models from by tile, and how the
   * models load and draw. The hosted archive by default
   * (`ModelArchiveSettings.archiveURL`), null for none, and then no models.
   * See `ModelArchiveSettings`.
   */
  readonly modelArchive: ModelArchiveSettings;
  /**
   * The grid of tiles an app's user picks tiles on, shown while an
   * `ImmersiveMapTileGridController` is attached (`ImmersiveMap.tileGrid`).
   * See `TileGridSettings`.
   */
  readonly tileGrid: TileGridSettings;
}

/** The options of the ground relief's modifier (`ImmersiveMapSettings.groundRelief`). */
export type GroundReliefOptions = Options<
  Pick<
    GroundReliefSettings,
    | "isEnabled"
    | "exaggeration"
    | "appearZoom"
    | "collapseZoom"
    | "collapsesWhereTerrainIsMissing"
    | "transitionSeconds"
    | "cameraTerrainZoom"
    | "displacementMaximumZoom"
    | "maximumConcurrentLoads"
    | "releasedCacheBytes"
    | "cameraClearanceMetres"
    | "castsShadows"
  >
>;

/** The options of the ground fog's modifiers (`groundFog`, `mountainGroundFog`). */
export type GroundFogOptions = Options<GroundFogSettings, GroundFogCurveField>;

/** The options of the shadows' modifier (`ImmersiveMapSettings.shadows`). */
export type ShadowOptions = Options<ShadowSettings, "strength" | "nearCoverageMeters" | "farCoverageMeters">;

/** The options of `tileSettings`: whole tile groups, and the cache's fields one by one. */
export type TileSettingsOptions = Options<TileSettings> & Options<CacheSettings>;

const cacheFieldNames = Object.freeze([
  "clearDiskCachesOnLaunch",
  "preparedTileCacheEnabled",
  "preparedDiskCompressionEnabled",
  "preparedDiskTimeToLive",
  "preparedDiskCacheSizeInBytes",
] as const);

const curveField = (value: ZoomCurveInput) => zoomCurve(value);

/** The data with the invariants the Swift value keeps by itself (a property observer, a clamp) restored, and frozen. */
function normalized(data: ImmersiveMapSettingsData): ImmersiveMapSettingsData {
  const depthBias = clampedModelDepthBias(data.modelArchive.depthBias);
  const modelArchive = deepEqual(depthBias, data.modelArchive.depthBias) ? data.modelArchive : { ...data.modelArchive, depthBias };
  // Settings written before the grid was a setting carry none: the defaults.
  return deepFreeze({ ...data, modelArchive, tileGrid: data.tileGrid ?? defaultTileGridSettings });
}

/**
 * The map's configuration: every tunable value of the map, each with a
 * default and a doc comment, in groups. A settings value is immutable, and
 * every modifier returns a new one with the values it is given and every
 * other one as configured:
 *
 * ```ts
 * const settings = ImmersiveMapSettings.default
 *   .night()
 *   .shadows({ strength: 0.6 })
 *   .trees({ isEnabled: false });
 * ```
 *
 * An option left `undefined` keeps its value, so `.shadows({ strength: 0.6 })`
 * changes the strength and nothing else. The camera position, the markers
 * and the controllers are not settings: they stay on the map.
 *
 * The value itself is plain data (`settings.data`: no class instance
 * inside, no function), structured-cloneable and JSON-serializable: it is
 * sent to the workers as it is, `JSON.stringify(settings)` writes it, and
 * `ImmersiveMapSettings.from(data)` takes it back. The groups are read on
 * the data, and through getters of the same names on the settings, but for
 * the four whose names are modifiers too (`mapStyle`, `labels`, `viewReuse`,
 * `modelArchive`), which are read on `settings.data` alone.
 */
export class ImmersiveMapSettings {
  /**
   * The settings as plain data: what is sent to a worker (`postMessage(settings.data)`)
   * and written as JSON. The groups whose names are also modifiers
   * (`mapStyle`, `labels`, `viewReuse`, `modelArchive`) are read here, the
   * others also through the getters below.
   */
  readonly data: ImmersiveMapSettingsData;

  /** The settings of plain data, as `data` gives it or a worker received it. */
  constructor(data: ImmersiveMapSettingsData) {
    this.data = normalized(data);
    Object.freeze(this);
  }

  get renderLoop(): RenderLoopSettings {
    return this.data.renderLoop;
  }

  get camera(): CameraSettings {
    return this.data.camera;
  }

  get presentation(): PresentationSettings {
    return this.data.presentation;
  }

  get tiles(): TileSettings {
    return this.data.tiles;
  }

  get scene(): SceneSettings {
    return this.data.scene;
  }

  get pins(): PinSettings {
    return this.data.pins;
  }

  get attribution(): AttributionSettings {
    return this.data.attribution;
  }

  get postProcessing(): PostProcessingSettings {
    return this.data.postProcessing;
  }

  get debug(): DebugSettings {
    return this.data.debug;
  }

  get controls(): ControlsSettings {
    return this.data.controls;
  }

  get tileGrid(): TileGridSettings {
    return this.data.tileGrid;
  }

  /** The map's defaults: the hosted tiles and models, the built-in style, the globe at low zoom. */
  static readonly default: ImmersiveMapSettings = new ImmersiveMapSettings({
    renderLoop: defaultRenderLoopSettings,
    camera: defaultCameraSettings,
    presentation: defaultPresentationSettings,
    mapStyle: defaultMapStyle,
    tiles: defaultTileSettings,
    labels: defaultLabelSettings,
    scene: defaultSceneSettings,
    pins: defaultPinSettings,
    attribution: defaultAttributionSettings,
    postProcessing: defaultPostProcessingSettings,
    viewReuse: defaultViewReuseSettings,
    debug: defaultDebugSettings,
    controls: defaultControlsSettings,
    modelArchive: defaultModelArchiveSettings,
    tileGrid: defaultTileGridSettings,
  });

  /** The settings of plain data, or the settings themselves. */
  static from(data: ImmersiveMapSettingsData | ImmersiveMapSettings): ImmersiveMapSettings {
    return data instanceof ImmersiveMapSettings ? data : new ImmersiveMapSettings(data);
  }

  /** The settings as plain data (`data`). */
  toData(): ImmersiveMapSettingsData {
    return this.data;
  }

  /** The plain data, so `JSON.stringify(settings)` writes the settings and nothing else. */
  toJSON(): ImmersiveMapSettingsData {
    return this.data;
  }

  /** Whether the two settings are equal in every value. */
  equals(other: ImmersiveMapSettingsData | ImmersiveMapSettings): boolean {
    return deepEqual(this.data, other instanceof ImmersiveMapSettings ? other.data : other);
  }

  /**
   * The settings with the changes the function makes to a draft of their
   * data, for a value no modifier sets:
   * `settings.edit((s) => { s.scene.shadows.mapResolution = 512 })`. The
   * draft is a copy, so the settings it came from are untouched.
   */
  edit(change: (draft: DeepMutable<ImmersiveMapSettingsData>) => void): ImmersiveMapSettings {
    const draft = structuredClone(this.data) as DeepMutable<ImmersiveMapSettingsData>;
    change(draft);
    return new ImmersiveMapSettings(draft as ImmersiveMapSettingsData);
  }

  private with(patch: Partial<ImmersiveMapSettingsData>): ImmersiveMapSettings {
    return new ImmersiveMapSettings({ ...this.data, ...patch });
  }

  private withCamera(patch: Partial<CameraSettings>): ImmersiveMapSettings {
    return this.with({ camera: { ...this.data.camera, ...patch } });
  }

  private withTiles(patch: Partial<TileSettings>): ImmersiveMapSettings {
    return this.with({ tiles: { ...this.data.tiles, ...patch } });
  }

  private withScene(patch: Partial<SceneSettings>): ImmersiveMapSettings {
    return this.with({ scene: { ...this.data.scene, ...patch } });
  }

  // MARK: The render loop and the camera

  /** The render loop's values given, the rest as configured. A full `RenderLoopSettings` replaces the group. */
  renderLoopSettings(renderLoop: Options<RenderLoopSettings>): ImmersiveMapSettings {
    return this.with({ renderLoop: mergeOptions(this.data.renderLoop, renderLoop) });
  }

  /** The camera's values given, the rest as configured. A full `CameraSettings` replaces the group. */
  cameraSettings(camera: Options<CameraSettings>): ImmersiveMapSettings {
    return this.with({ camera: mergeOptions(this.data.camera, camera) });
  }

  /**
   * Restricts the zoom levels the camera can reach. Gestures, zoom commands
   * and camera flights are all clamped to the range, so a minimum above the
   * globe-to-flat transition keeps the map flat for good. An omitted bound
   * is left as configured.
   *
   * ```ts
   * settings.zoomRange({ minimum: 3, maximum: 18 });
   * ```
   */
  zoomRange(options: { readonly minimum?: number | undefined; readonly maximum?: number | undefined }): ImmersiveMapSettings {
    return this.withCamera({
      minimumZoom: options.minimum ?? this.data.camera.minimumZoom,
      maximumZoom: options.maximum ?? this.data.camera.maximumZoom,
    });
  }

  /**
   * Restricts the tilt angles the camera can reach, in radians from straight
   * down. Gestures, camera commands and flights are all clamped to the range
   * on both surfaces alike. A minimum above the maximum yields to it. An
   * omitted bound is left as configured.
   *
   * ```ts
   * settings.pitchRange({ minimum: 0.3, maximum: 1.1 });
   * ```
   */
  pitchRange(options: { readonly minimum?: number | undefined; readonly maximum?: number | undefined }): ImmersiveMapSettings {
    return this.withCamera({
      minimumPitch: options.minimum ?? this.data.camera.minimumPitch,
      maximumPitch: options.maximum ?? this.data.camera.maximumPitch,
    });
  }

  /**
   * Caps how far the camera may rotate away from north, in radians,
   * symmetric around it, on both surfaces. Null leaves rotation unbounded.
   * With a `globeBearingLimit` the cap becomes the widest the globe's window
   * opens instead of the full half turn.
   *
   * ```ts
   * settings.bearingLimit(Math.PI / 2); // at most a quarter turn from north
   * settings.bearingLimit(null);        // unbounded again
   * ```
   */
  bearingLimit(maximumAbsoluteBearing: number | null): ImmersiveMapSettings {
    return this.withCamera({ maximumAbsoluteBearing });
  }

  /**
   * Narrows how far a zoomed-out globe may rotate away from north: at zoom 0
   * at most `minimum` radians, opening linearly to the `bearingLimit` (or the
   * half turn) at `unlockZoom`. Off by default, so the globe turns as freely
   * as the flat map. Given a limit, or null to clear it, sets the window
   * whole.
   *
   * ```ts
   * settings.globeBearingLimit(Math.PI / 12, 6);
   * settings.globeBearingLimit(null);
   * ```
   */
  globeBearingLimit(limit: GlobeBearingLimit | null): ImmersiveMapSettings;
  globeBearingLimit(minimum: number, unlockZoom: number): ImmersiveMapSettings;
  globeBearingLimit(limitOrMinimum: GlobeBearingLimit | number | null, unlockZoom?: number): ImmersiveMapSettings {
    const limit =
      typeof limitOrMinimum === "number" ? globeBearingLimit(limitOrMinimum, unlockZoom ?? 0) : limitOrMinimum;
    return this.withCamera({ globeBearingLimit: limit });
  }

  /**
   * Tunes the pull that keeps a zoomed-out globe upright, north up and seen
   * from straight above. It is on by default. Across `zoomRange` (3 to 6
   * unless given) the bearing and the pitch the camera may rest at close in,
   * from the camera's own limits at the upper bound to upright at the lower
   * bound and below it. A camera outside that is eased back, halving what is
   * left every `halfLife` seconds (0.2 unless given): zooming out
   * straightens the globe on the way, and a rotation past the allowed
   * bearing springs back when the fingers let go. Null turns it off: the
   * globe then keeps any bearing and pitch at every zoom.
   *
   * ```ts
   * settings.globeUprightPull({ zoomRange: { lowerBound: 2, upperBound: 5 }, halfLife: 0.3 });
   * settings.globeUprightPull(null);
   * ```
   */
  globeUprightPull(pull: Options<GlobeUprightPull> | null = {}): ImmersiveMapSettings {
    return this.withCamera({ globeUprightPull: pull === null ? null : globeUprightPull(pull) });
  }

  /**
   * Holds the camera to a geographic region while keeping the globe. Up to
   * the lower bound of `pullZoomRange` (1 to 2 unless given) the whole world
   * is open, so the zoomed-out globe turns freely. Across the range the area
   * the map center belongs in closes in on the region along `pullCurve`
   * (ease-in-out unless given), and from the upper bound it is the region
   * itself. With the default elastic `edgeBehavior` the camera may leave the
   * area, and a pull that grows with the distance draws it back all the
   * time, during a gesture too. `CameraBoundsEdgeBehavior.hard` makes the
   * edge a wall that gestures, camera commands and flights all stop at.
   * Flights always land inside the area. A west longitude greater than the
   * east one spans the antimeridian. Null clears the region: the whole
   * world.
   *
   * ```ts
   * settings.cameraBounds({
   *   southWest: { latitude: 55.57, longitude: 37.36 },
   *   northEast: { latitude: 55.92, longitude: 37.86 },
   *   pullCurve: PullCurve.make(0.2, 0.8, 0.4, 1),
   *   edgeBehavior: CameraBoundsEdgeBehavior.elastic({ maximumStretch: 150, pullHalfLife: 0.3 }),
   * });
   * ```
   */
  cameraBounds(bounds: CameraBoundsOptions | CameraBounds | null): ImmersiveMapSettings {
    return this.withCamera({ bounds: bounds === null ? null : cameraBounds(bounds) });
  }

  /**
   * Sets how fast a tilt drag tilts, and which way: the multiple of the pitch
   * range that a drag across the full view height sweeps. Applies to the
   * two-finger vertical drag on touch input and to the tilt drag (right
   * button, or Alt-drag) with a mouse. Positive tilts as the fingers pull
   * down, negative inverts the drag so pulling up tilts instead, and zero
   * leaves the drag without effect. The default is 2: half the view height
   * covers the whole pitch range.
   */
  tiltGestureSensitivity(sensitivity: number): ImmersiveMapSettings {
    return this.withCamera({ tiltGestureSensitivity: sensitivity });
  }

  /**
   * The invisible one-thumb camera drag zones in the bottom corners:
   * dragging in the bottom leading corner tilts the camera, dragging in the
   * bottom trailing one zooms. Both are on by default, and a zone not given
   * here is on. A zone captures the drags that would otherwise pan the map
   * there and nothing on screen announces it, so turn one off where the
   * corner holds the app's own controls. Touch input only. Wheel and
   * trackpad zoom are independent of these zones.
   *
   * ```ts
   * settings.cameraControlZones({ pitch: false });              // zoom only
   * settings.cameraControlZones({ pitch: false, zoom: false }); // neither
   * ```
   */
  cameraControlZones(options: { readonly pitch?: boolean | undefined; readonly zoom?: boolean | undefined } = {}): ImmersiveMapSettings {
    return this.withCamera({
      controlZones: controlZoneSettings({ isPitchZoneEnabled: options.pitch ?? true, isZoomZoneEnabled: options.zoom ?? true }),
    });
  }

  /**
   * Turns the double tap zoom on or off: the double tap, or the double
   * click with a mouse, that zooms the map in by one level toward the
   * point. On by default. While it is on, a single tap waits for the double
   * tap interval before it acts, and two quick taps on one place are the
   * zoom and not two taps. Turn it off where a tap must act at once and a
   * second tap on the same place must count: on a tile grid, the first tap
   * then selects a tile immediately and the next deselects it.
   *
   * ```ts
   * map.settings = map.settings.doubleTapZoom(false);
   * ```
   *
   * The map still zooms by the pinch, the wheel and the zoom control.
   * Applies live.
   */
  doubleTapZoom(isEnabled: boolean): ImmersiveMapSettings {
    return this.withCamera({ isDoubleTapZoomEnabled: isEnabled });
  }

  /**
   * Sets how far the cursor may move between the press and the release of
   * a mouse button and still make a click, in points. A drag of the map
   * begins only past it, so a click made with a moving hand picks what is
   * under it and does not shift the map. The default is 4. Raise it for a
   * mouse that slips under a click, lower it for a drag that answers
   * sooner. Applies live.
   */
  tapMovementTolerance(points: number): ImmersiveMapSettings {
    return this.withCamera({ tapMovementTolerancePoints: Math.max(points, 0) });
  }

  /**
   * How fast the animated zoom follows the camera's: the seconds in which it
   * closes half of what is left of the way
   * (`CameraSettings.animatedZoomHalfLife`). Zero makes the two one.
   */
  animatedZoom(options: { readonly halfLife: number }): ImmersiveMapSettings {
    return this.withCamera({ animatedZoomHalfLife: options.halfLife });
  }

  // MARK: The presentation

  /** The presentation's values given, the rest as configured. A full `PresentationSettings` replaces the group. */
  presentationSettings(presentation: Options<PresentationSettings>): ImmersiveMapSettings {
    return this.with({ presentation: mergeOptions(this.data.presentation, presentation) });
  }

  /**
   * Whether the map is a globe at low zoom, on unless `isEnabled` says
   * otherwise: the world is a sphere until the camera zooms in and unrolls
   * it into the plane. Off, the world is the Mercator plane at every zoom,
   * with no sphere, no morph and no stars, and the flat map's sky and haze
   * from zoom 0 up. Applies live. Stills and video exports of the same
   * settings come out flat too.
   *
   * `airHandoverStart` and `airHandoverEnd` are where in the unroll, as
   * fractions `0...1` of the transition window, the globe's air (the
   * atmosphere over space and the stars) gives way to the plane's (the sky
   * over the map's colour, the world tile under the far ground): 0.7 to 0.9
   * by default, the end where the unroll's geometry is a finished plane. An
   * omitted value is left as configured.
   */
  globe(
    options: {
      readonly isEnabled?: boolean | undefined;
      readonly airHandoverStart?: number | undefined;
      readonly airHandoverEnd?: number | undefined;
    } = {},
  ): ImmersiveMapSettings {
    return this.with({
      presentation: {
        ...this.data.presentation,
        isGlobeEnabled: options.isEnabled ?? true,
        airHandoverStart: options.airHandoverStart ?? this.data.presentation.airHandoverStart,
        airHandoverEnd: options.airHandoverEnd ?? this.data.presentation.airHandoverEnd,
      },
    });
  }

  /** The reuse's values given, the rest as configured. */
  viewReuseSettings(viewReuse: Options<ViewReuseSettings>): ImmersiveMapSettings {
    return this.with({ viewReuse: mergeOptions(this.data.viewReuse, viewReuse) });
  }

  /**
   * Controls reuse of dismantled maps (on by default). When the screen with
   * this map goes away, its renderer (GPU tile cache, text atlases) is
   * parked briefly and the next map adopts it warm, so switching between
   * map screens skips the first-frame rebuild. An adopted map keeps its
   * previous camera unless the new map provides an explicit camera position
   * or an attached camera controller.
   */
  viewReuse(isEnabled = true): ImmersiveMapSettings {
    return this.with({ viewReuse: { ...this.data.viewReuse, isEnabled } });
  }

  // MARK: The tile source and the style

  /**
   * Points the map at a PMTiles archive such as
   * `https://tiles.example.com/planet.pmtiles`: one file of MVT tiles
   * (PMTiles v3, gzip or uncompressed), read over HTTP range requests, so
   * any static host serves it. The query string is sent as written, so a
   * key can live in the URL. Credentials that travel as headers go in
   * `headers`, added to every archive request.
   *
   * The source is only where bytes come from. How they are parsed and drawn
   * is configured separately by `mapStyle(...)`, and the zoom coverage
   * through `tileMaximumZoomLevel(...)`. An archive may be replaced under the
   * same URL: the engine notices by the ETag the host gives the file, checked
   * once a session, and loads again the tiles it kept from the older upload.
   * A host that sends no ETag needs a new URL for a new archive. The map
   * reads how deep the archive goes from its header, and asks for no tile
   * deeper. The archive's data credit is stated with `attributionSettings`.
   */
  tileArchive(archiveURL: string, headers: Readonly<Record<string, string>> = {}): ImmersiveMapSettings {
    return this.withTiles({ network: { ...this.data.tiles.network, tileArchiveURL: archiveURL, tileRequestHeaders: headers } });
  }

  /**
   * How the tiles are parsed and drawn: the built-in style in a theme
   * (`protomapsBasemapMapStyle(theme)`, `defaultMapStyle`, `nightMapStyle`).
   * A change of style re-prepares the tiles, but for the theme's values
   * drawn at frame time (the hillshade, the terrain occlusion, the labels'
   * opacity, the trees' palette), which apply live.
   */
  mapStyle(mapStyle: ProtomapsBasemapMapStyle): ImmersiveMapSettings {
    return this.with({ mapStyle });
  }

  /**
   * The map of a night: the night palette (`nightTheme`, the land a deep
   * blue-grey, the water a navy, the labels a light grey) with the night's
   * air (`nightFogSettings`, a navy sky and horizon the ground fog follows).
   * `night(false)` is the day again: the built-in style and the day's air.
   * Both are live switches, and the change of palette re-prepares the tiles
   * as any change of style does. For a night of your own,
   * `.mapStyle(protomapsBasemapMapStyle(applyTheme(nightTheme, ...)))` and
   * `.fogSettings(...)` set the two apart.
   */
  night(isEnabled = true): ImmersiveMapSettings {
    return this.with({
      mapStyle: isEnabled ? nightMapStyle : defaultMapStyle,
      scene: {
        ...this.data.scene,
        fog: isEnabled ? nightFogSettings : defaultFogSettings,
        groundFog: { ...this.data.scene.groundFog, color: null },
      },
    });
  }

  /**
   * Points the map at an archive of model tiles, null for no models, keeping
   * how the models load and draw as set (`modelArchiveSettings`), whichever
   * order the two are written in. The hosted archive
   * (`ImmersiveMapTilesService.modelArchiveURL`) by default. The archive is
   * one PMTiles v3 file whose zoom 14 tiles hold models ready for the GPU. It
   * is read over HTTP range requests like the map's archive, and apart from
   * it: the models of the tiles in view are requested as the camera moves,
   * kept on disk once loaded, and released from memory when the camera has
   * left them and the budget is passed. `headers` are added to every
   * request.
   *
   * A model stands in for the map's own building: the building is drawn
   * until its model is loaded, and left out from that frame on, so the map is
   * never missing either. The models show on the flat map, wherever the map
   * draws tiles of the archive's zoom or deeper.
   */
  modelArchive(archiveURL: string | null, headers: Readonly<Record<string, string>> = {}): ImmersiveMapSettings {
    return this.with({ modelArchive: { ...this.data.modelArchive, archiveURL, requestHeaders: headers } });
  }

  /**
   * How the models of the model archive load and draw, an omitted value
   * left as configured, and the values hold whichever archive
   * `modelArchive(...)` names, before or after it. A full
   * `ModelArchiveSettings` replaces the group.
   *
   * `memoryBudgetInBytes` is the GPU memory the loaded model tiles may hold
   * and `diskCacheSizeInBytes` the quota of those kept on disk. `depthBias`
   * draws the models nearer in depth than they stand, by a share of their
   * distance from the camera, by the camera zoom, so a model covers the
   * map's own building it stands in for where the map could not leave it
   * out, and a building well in front of it still covers the model: by
   * default 0.05 at zoom 14 and 0.01 from zoom 15.5, and it applies live.
   * `minimumZoom` is the camera zoom the models draw from, 14 by default.
   */
  modelArchiveSettings(options: Options<ModelArchiveSettings, "depthBias">): ImmersiveMapSettings {
    return this.with({ modelArchive: withModelArchiveOptions(this.data.modelArchive, options) });
  }

  // MARK: The tiles

  /**
   * The tile groups given (`coverage`, `network`, `cache`, ...) replaced,
   * then the cache's fields given (`clearDiskCachesOnLaunch`,
   * `preparedDiskTimeToLive`, ...) set in place, the rest as configured. A
   * full `TileSettings` replaces the group.
   */
  tileSettings(options: TileSettingsOptions): ImmersiveMapSettings {
    const tiles = mergeOptions(this.data.tiles, options);
    const cacheOptions: Record<string, unknown> = {};
    for (const name of cacheFieldNames) {
      cacheOptions[name] = options[name];
    }
    return this.with({ tiles: { ...tiles, cache: mergeOptions(tiles.cache, cacheOptions) } });
  }

  /**
   * The flattened ground: from `fromTileZoom` on a tile's ground fills are
   * one layer of triangles that do not overlap, cut to a grid of `grid`
   * cells a side, instead of the layers a coarser tile stacks. Nothing of
   * such a ground has to be ordered in depth, which keeps the near ground
   * whole when the camera stands in the street with the tiles blown up to
   * many screens, and the mesh is ready for a heightmap. The default is the
   * tileset's deepest zoom (`tileMaximumZoomLevel(...)`, 15 for the hosted
   * archive), on a grid of 16. `gridByTileZoom` gives a zoom a grid of its
   * own, over `grid` (`defaultGridByTileZoom`). `isEnabled` false keeps every
   * tile's layers at every zoom. An omitted value is left as configured, and
   * `fromTileZoom: null` takes the tileset's deepest zoom again.
   *
   * ```ts
   * settings.groundFlattening({ fromTileZoom: 15, grid: 32, gridByTileZoom: { 12: 128, 13: 96, 14: 64 } });
   * ```
   *
   * Baked into the prepared tiles, so a change re-parses them.
   */
  groundFlattening(
    options: Options<Pick<TileSettings["groundFlattening"], "isEnabled" | "fromTileZoom" | "grid" | "gridByTileZoom">>,
  ): ImmersiveMapSettings {
    return this.withTiles({ groundFlattening: mergeOptions(this.data.tiles.groundFlattening, options) });
  }

  /**
   * The flattened ground raised by a heightmap
   * (`GroundReliefSettings`, where each value is described), an omitted
   * value left as configured. The relief rises out of the plane when the
   * camera zoom crosses `appearZoom` (10 by default) and collapses into it
   * when the zoom crosses `collapseZoom` (13.7), each a short animation over
   * `transitionSeconds` (0.3), everywhere alike, and never a scaling with
   * the zoom. Off by default: `isEnabled: true` raises the ground on the
   * terrain of `terrain(...)`, Mapterhorn's open terrain unless the map
   * names another. `releasedCacheBytes` and `transitionSeconds` are held to
   * zero and up, `maximumConcurrentLoads` to one and up,
   * `cameraTerrainZoom` and `displacementMaximumZoom` to zero and up.
   *
   * ```ts
   * settings.groundFlattening({ grid: 64 }).groundRelief({ isEnabled: true, exaggeration: 2, appearZoom: 11 });
   * ```
   */
  groundRelief(options: GroundReliefOptions): ImmersiveMapSettings {
    const relief = mergeOptions(this.data.tiles.groundRelief, options, {
      releasedCacheBytes: (value: number) => Math.max(0, value),
      maximumConcurrentLoads: (value: number) => Math.max(1, value),
      cameraTerrainZoom: (value: number) => Math.max(0, value),
      displacementMaximumZoom: (value: number) => Math.max(0, value),
      transitionSeconds: (value: number) => Math.max(value, 0),
    });
    return this.withTiles({ groundRelief: relief });
  }

  /**
   * Where the ground relief reads its heights from: terrain tiles at a URL
   * template, in an encoding, with the credit their license asks for.
   * Mapterhorn's open terrain by default. The source alone: the relief is
   * turned on and drawn by `groundRelief(...)`, whichever order the two are
   * written in.
   */
  terrain(source: ImmersiveMapTerrainSource): ImmersiveMapSettings {
    return this.withTiles({ groundRelief: { ...this.data.tiles.groundRelief, source } });
  }

  /**
   * How the country around the point the camera looks at is read as
   * mountains or a plain (`TerrainSurroundingsSettings`): the radius of the
   * disc of terrain read around the point, the spans of its heights under
   * which it is a plain and from which it is mountains (the band between them
   * the kind's hysteresis), and how long the reading takes to follow a move.
   * An omitted value is left as configured. The radius is held to 1 and up,
   * the rest to 0 and up.
   */
  terrainSurroundings(options: Options<TerrainSurroundingsSettings>): ImmersiveMapSettings {
    const surroundings = withTerrainSurroundings(this.data.tiles.groundRelief.surroundings, options);
    return this.withTiles({ groundRelief: { ...this.data.tiles.groundRelief, surroundings } });
  }

  /**
   * The tiles drawn from a texture (`RasterizationSettings`):
   * `maximumAnisotropy` is the textures' anisotropic filtering (1 to 16) and
   * `mipLevelBias` how soft the far ground is (above 0 softer, below 0
   * sharper). An omitted value is left as configured.
   */
  tileRasterization(options: Options<TileSettings["rasterization"]>): ImmersiveMapSettings {
    return this.withTiles({ rasterization: mergeOptions(this.data.tiles.rasterization, options) });
  }

  /**
   * The overview of the globe the engine ships, on or off: hand-drawn biomes
   * laid into the tiles of zooms 0 to 7 under the tile source's
   * raster-derived land cover, which the built-in style paints and draws the
   * land cover over. On by default. Off, the overview zooms draw the tile
   * source's own land cover: for a source in another schema whose style has
   * no use for the layers. Part of the prepared tiles' identity, so a change
   * re-parses them. `creditMaximumZoom` is the camera zoom the overview's
   * credit stays on the attribution line up to, 8 by default, where the
   * built-in style has faded the biomes out. An omitted value is left as
   * configured.
   */
  overviewTiles(options: Options<TileSettings["overview"]>): ImmersiveMapSettings {
    return this.withTiles({ overview: mergeOptions(this.data.tiles.overview, options) });
  }

  /**
   * How many tiles are parsed at once, 4 by default
   * (`ParsingSettings.maximumConcurrentParses`), at least one. Lower it when
   * a fast zoom crowds a small device, raise it on a machine with cores to
   * spare. An omitted value is left as configured.
   */
  tileParsing(options: { readonly maximumConcurrentParses?: number | undefined } = {}): ImmersiveMapSettings {
    return this.withTiles({
      parsing: mergeOptions(this.data.tiles.parsing, options, { maximumConcurrentParses: (value: number) => Math.max(1, value) }),
    });
  }

  /**
   * How far past the visible ground the flat map's far texture bands ask for
   * their tiles, as a share of the footprint's reach from the camera
   * (`CoverageSettings.rasterBandMarginShare`), at least 0: a turn of the
   * camera then finds the far tiles in already. 0.25 by default, 0 for none.
   * Applies live.
   */
  tileCoverage(options: { readonly rasterBandMarginShare: number }): ImmersiveMapSettings {
    return this.withTiles({
      coverage: { ...this.data.tiles.coverage, rasterBandMarginShare: Math.max(options.rasterBandMarginShare, 0) },
    });
  }

  /**
   * A cap on the tile zoom the map asks the archive for. Without one, the
   * default, the map reads how deep the archive goes from its header and
   * asks for every zoom it has, so an archive needs nothing stated about its
   * depth. A cap under the archive's depth leaves its deepest zooms unread,
   * which saves the downloads and the parses of the finest tiles, and null
   * takes the cap off. Past the deepest zoom read the camera keeps zooming
   * and those tiles are stretched.
   */
  tileMaximumZoomLevel(maximumZoomLevel: number | null): ImmersiveMapSettings {
    return this.withTiles({ coverage: { ...this.data.tiles.coverage, maximumZoomLevel } });
  }

  /**
   * The settings with the archive's depth as last read from its header,
   * which `resolvedMaximumZoomLevel` plans by, null while it was never read.
   * Every path that builds a map from settings passes them through here.
   */
  resolvingArchiveDepth(archiveMaximumZoomLevel: number | null): ImmersiveMapSettings {
    return this.withTiles({ coverage: { ...this.data.tiles.coverage, archiveMaximumZoomLevel } });
  }

  /**
   * The size of the prepared tile cache on disk: parsed and tessellated
   * tiles, which is where every tile the camera has already looked at comes
   * back from. The default is 2 GiB (`defaultPreparedDiskCacheSizeInBytes`).
   * Tiles stay in GPU memory only while a frame draws them, so this quota
   * decides how much of a revisited area returns without a re-download and
   * re-parse: a looped tour wants it to hold every tile of a lap, an app
   * short on storage lowers it. The quota is shared by every map of the
   * origin, and the most recently created map's value is the active policy.
   * Entries older than `preparedDiskTimeToLive` leave regardless of it.
   *
   * ```ts
   * settings.preparedTileDiskCacheSize(ImmersiveMapByteCount.gigabytes(4));
   * ```
   */
  preparedTileDiskCacheSize(size: ImmersiveMapByteCount): ImmersiveMapSettings {
    return this.withTiles({ cache: { ...this.data.tiles.cache, preparedDiskCacheSizeInBytes: size.bytes } });
  }

  // MARK: The labels

  /**
   * The labels' values given, the rest as configured: most often the
   * language the labels are written in (a `LabelLanguage` or its code), and
   * what a label shows when a feature has no name in it. A full
   * `LabelSettings` replaces the group. Every label value is baked into the
   * prepared tiles, so a change re-prepares them.
   *
   * ```ts
   * settings.labelSettings({ language: "ru" });
   * ```
   */
  labelSettings(
    options: Omit<Options<LabelSettings>, "language"> & { readonly language?: LabelLanguage | string | undefined },
  ): ImmersiveMapSettings {
    const { language, ...rest } = options;
    const labels = mergeOptions(this.data.labels, rest);
    return this.with({
      labels:
        language === undefined
          ? labels
          : { ...labels, language: typeof language === "string" ? LabelLanguage.make(language) : LabelLanguage.make(language.code) },
    });
  }

  /**
   * Labels on or off: place names, points of interest, house numbers and
   * road names alike, on unless `isEnabled` says otherwise. Off skips the
   * label layer and the placement and collision work behind it, and the
   * parser bakes no text, so the switch re-prepares the tiles like every
   * other label value. On by default.
   */
  labels(options: { readonly isEnabled?: boolean | undefined } = {}): ImmersiveMapSettings {
    return this.with({ labels: { ...this.data.labels, isEnabled: options.isEnabled ?? true } });
  }

  // MARK: The scene

  /** The scene's groups given, the rest as configured. A full `SceneSettings` replaces the group. */
  sceneSettings(scene: Options<SceneSettings>): ImmersiveMapSettings {
    return this.with({ scene: mergeOptions(this.data.scene, scene) });
  }

  /**
   * Leaves the area outside the globe unpainted: the space background and
   * the stars are not drawn, and the map's canvas becomes transparent there,
   * so the page's own background shows through and around the globe. A
   * marker hanging off the limb no longer needs the map clipped to a circle.
   */
  transparentSpace(isTransparent = true): ImmersiveMapSettings {
    return this.withScene({ space: { ...this.data.scene.space, isTransparent } });
  }

  /**
   * World-space direction pointing towards the static sun (+X east, +Y
   * north, +Z up). Defines where buildings and scene models cast their
   * shadows.
   */
  sceneLight(options: { readonly direction: Vector3 }): ImmersiveMapSettings {
    return this.withScene({ light: { ...this.data.scene.light, direction: options.direction } });
  }

  /**
   * Directional shadows cast by buildings and scene models in the flat
   * presentation, the values given, the rest as configured. A full
   * `ShadowSettings` replaces the group.
   */
  shadowSettings(shadows: ShadowOptions): ImmersiveMapSettings {
    return this.withScene({ shadows: mergeOptions(this.data.scene.shadows, shadows, shadowCurveFields) });
  }

  /**
   * The globe's atmosphere: the halo of scattered light around the planet's
   * limb and the glow on the surface toward it, the values given, the rest
   * as configured. Globe presentation only. It fades into the flat map's fog
   * band through the morph. On by default.
   */
  atmosphereSettings(atmosphere: Options<AtmosphereSettings, "thickness">): ImmersiveMapSettings {
    return this.withScene({ atmosphere: mergeOptions(this.data.scene.atmosphere, atmosphere, { thickness: curveField }) });
  }

  /** The sun on the globe (`GlobeLightSettings`), the values given, the rest as configured. Applies live. */
  globeLightSettings(globeLight: Options<GlobeLightSettings, "strength">): ImmersiveMapSettings {
    return this.withScene({ globeLight: mergeOptions(this.data.scene.globeLight, globeLight, { strength: curveField }) });
  }

  /**
   * The sun on the globe: the planet's surface shaded by the sphere against
   * a sun fixed over the subsolar point (`subsolarLatitudeDegrees`,
   * `subsolarLongitudeDegrees`), the night side drawn toward `nightColor`,
   * `strength` by the camera zoom and the terminator `terminatorSoftness`
   * wide. On unless `isEnabled` says otherwise. An omitted value is left as
   * configured. Applies live.
   *
   * ```ts
   * settings.globeLight({ subsolarLongitudeDegrees: 30, strength: { 2: 0.8, 6: 0.2 } });
   * ```
   */
  globeLight(options: Options<GlobeLightSettings, "strength"> = {}): ImmersiveMapSettings {
    const globeLight = mergeOptions(this.data.scene.globeLight, options, { strength: curveField });
    return this.withScene({ globeLight: { ...globeLight, isEnabled: options.isEnabled ?? true } });
  }

  /**
   * Turns the globe's atmosphere on or off, on unless `isEnabled` says
   * otherwise. Off leaves the planet bare against space, apart from the thin
   * glow at the limb that hides the tile mesh's edge. The flat map's fog
   * band is not affected.
   */
  atmosphere(options: { readonly isEnabled?: boolean | undefined } = {}): ImmersiveMapSettings {
    return this.withScene({ atmosphere: { ...this.data.scene.atmosphere, isEnabled: options.isEnabled ?? true } });
  }

  /**
   * The sky of the flat presentation (`FogSettings`), the values given, the
   * rest as configured: a sky gradient above the horizon line and a thin band
   * whitening the ground into the horizon colour at the line. The far ground
   * is the ground fog's (`groundFog(...)`). Applies live.
   */
  fogSettings(fog: Options<FogSettings>): ImmersiveMapSettings {
    return this.withScene({ fog: mergeOptions(this.data.scene.fog, fog) });
  }

  /**
   * The flat map's sky on or off, on unless `isEnabled` says otherwise. Off
   * leaves the sky the map's clear colour and keeps only a thin band at the
   * horizon line that hides the seam between the far ground and the sky.
   * The ground fog has its own switch.
   */
  fog(options: { readonly isEnabled?: boolean | undefined } = {}): ImmersiveMapSettings {
    return this.withScene({ fog: { ...this.data.scene.fog, isEnabled: options.isEnabled ?? true } });
  }

  /** The flat map's ground fog (`GroundFogSettings`), the values given, the rest as configured. `groundFog(...)` also switches it on. */
  groundFogSettings(groundFog: GroundFogOptions): ImmersiveMapSettings {
    return this.withScene({ groundFog: mergeOptions(this.data.scene.groundFog, groundFog, groundFogCurveFields) });
  }

  /**
   * The fog on the ground of the flat map: thickest at the ground, thinning
   * upward, gathered along the view past a distance from the camera, so the
   * far ground and its detail sink in it while the near ground and the tops
   * of tall buildings stay clear. On unless `isEnabled` says otherwise, and
   * every other value an omission leaves as configured. The values are
   * `GroundFogSettings`'s, where each is described. Every value but the
   * colour is a value or a curve over the camera zoom, so the fog never
   * changes at a step. Applies live.
   *
   * ```ts
   * settings.groundFog({
   *   heightMeters: 120,
   *   startDistanceMeters: { 12: 3000, 16: 400 },
   *   startSoftnessMeters: { 12: 20_000, 16: 800 },
   *   maximumOpacity: { 18: 1, 19: 0 },
   * });
   * ```
   */
  groundFog(options: GroundFogOptions = {}): ImmersiveMapSettings {
    const groundFog = mergeOptions(this.data.scene.groundFog, options, groundFogCurveFields);
    return this.withScene({ groundFog: { ...groundFog, isEnabled: options.isEnabled ?? true } });
  }

  /**
   * The air over the mountains, the same values as `groundFog(...)`: the
   * frame draws the air between the plain's (`groundFog`) and this one by how
   * mountainous the country around the camera reads (tuned with
   * `terrainSurroundings(...)`), so a pan from a plain into a range fades
   * one air into the other. The values start from the mountain air set so
   * far, or from a copy of the plain's, on unless `isEnabled` says
   * otherwise, and an omitted value is left as it is. Null is one air
   * everywhere. Applies live.
   *
   * ```ts
   * settings.mountainGroundFog({
   *   densityPerKilometer: { 7: 0.02, 12: 0.02, 16: 1.4, 22: 6 },
   *   heightMeters: { 7: 2500, 12: 2500, 16: 150, 22: 60 },
   *   baseAltitudeMeters: 1500,
   * });
   * ```
   */
  mountainGroundFog(options: GroundFogOptions | null = {}): ImmersiveMapSettings {
    if (options === null) {
      return this.withScene({ mountainGroundFog: null });
    }
    const start = this.data.scene.mountainGroundFog ?? this.data.scene.groundFog;
    const fog = mergeOptions(start, options, groundFogCurveFields);
    return this.withScene({ mountainGroundFog: { ...fog, isEnabled: options.isEnabled ?? true } });
  }

  /**
   * The extruded buildings and the models of a model archive: the camera
   * zoom the buildings draw from, how long a layer takes to rise out of the
   * ground when the camera reaches its zoom (held to zero and up), and
   * whether it rises at all (`ExtrusionSettings`). `risesFromTheGround` is
   * the rise's switch, read after `riseSeconds`: off, a layer stands up at
   * once, and on, it takes the configured time, or the default 0.6 seconds
   * when the configured time is zero. An omitted value is left as
   * configured. Applies live.
   */
  buildingExtrusion(
    options: {
      readonly buildingsMinimumZoom?: number | undefined;
      readonly riseSeconds?: number | undefined;
      readonly risesFromTheGround?: boolean | undefined;
    } = {},
  ): ImmersiveMapSettings {
    const buildingsMinimumZoom = options.buildingsMinimumZoom ?? this.data.scene.extrusion.buildingsMinimumZoom;
    let riseSeconds = options.riseSeconds === undefined ? this.data.scene.extrusion.riseSeconds : Math.max(options.riseSeconds, 0);
    if (options.risesFromTheGround === true && riseSeconds <= 0) {
      riseSeconds = defaultExtrusionSettings.riseSeconds;
    } else if (options.risesFromTheGround === false) {
      riseSeconds = 0;
    }
    return this.withScene({ extrusion: { buildingsMinimumZoom, riseSeconds } });
  }

  /**
   * The trees that stand on the woods and the parks of the flat map
   * (`TreeSettings`): whether they draw, the camera zoom they draw from, the
   * zoom from which every tree of a tile draws (thinned below it), the zoom
   * from which they draw in their near detail, and the most a tile keeps
   * (held to zero and up). An omitted value is left as configured.
   * `isEnabled` and `maximumPerTile` are baked into the prepared tiles, the
   * rest applies live.
   *
   * ```ts
   * settings.trees({ minimumZoom: 14, fullDensityZoom: 17 }); // thinned until zoom 17
   * settings.trees({ isEnabled: false });
   * ```
   */
  trees(options: Options<SceneSettings["trees"]>): ImmersiveMapSettings {
    return this.withScene({
      trees: mergeOptions(this.data.scene.trees, options, { maximumPerTile: (value: number) => Math.max(value, 0) }),
    });
  }

  /**
   * Directional shadows cast by the buildings and the scene models in the
   * flat presentation, on unless `isEnabled` says otherwise, with any of
   * their values set in place. An omitted value is left as configured, so a
   * value set here never resets the others. The values are
   * `ShadowSettings`'s, where each is described. `strength`,
   * `nearCoverageMeters` and `farCoverageMeters` are curves over the camera
   * zoom (a single value being the same at every zoom). Applies live.
   *
   * ```ts
   * settings.shadows({ nearCoverageMeters: { 14: 4000, 18: 300 } });
   * ```
   */
  shadows(options: ShadowOptions = {}): ImmersiveMapSettings {
    const shadows = mergeOptions(this.data.scene.shadows, options, shadowCurveFields);
    return this.withScene({ shadows: { ...shadows, isEnabled: options.isEnabled ?? true } });
  }

  // MARK: The tile grid

  /**
   * Which tiles the grid of `ImmersiveMap.tileGrid` shows, how it looks and
   * what a tap may select, the values given, the rest as configured:
   *
   * ```ts
   * settings.tileGridSettings({ zoomRange: [12, 15], lineWidthPoints: 2 });
   * ```
   *
   * - `zoomRange`: the zooms whose tiles the grid shows: the tiles of the
   *   camera's zoom clamped into the range, so `[15, 15]` shows the zoom 15
   *   tiles alone at any camera zoom. Every zoom by default.
   * - `minimumTileScreenPoints`: the grid hides while a tile is narrower on
   *   screen than this, and the far tiles under a tilted camera fade by it.
   * - `labelMinimumTileScreenPoints`: the texts hide while a tile is
   *   narrower on screen than this.
   * - `maximumDrawnTiles`: the most tiles drawn in a frame, the nearest to
   *   where the camera looks first.
   * - `lineColor`, `lineWidthPoints`, `labelColor`, `labelHaloColor`,
   *   `labelHaloWidthPoints`, `selectedFillColor`: the look.
   * - `labelFormat`: what is written inside a tile: `"zxy"`, `"xyz"` or
   *   `"hidden"`. `ImmersiveMapTileGridController.labelProvider` takes its
   *   place.
   * - `labelMaximumWidthShare`, `labelMaximumHeightShare`: the text is sized
   *   to the tile, within these shares of its width and height.
   * - `isTapSelectionEnabled`: whether the user can select and deselect
   *   tiles on the map at all.
   * - `selectionGesture`: `"tap"`, `"doubleTap"` (the double tap then does
   *   not zoom the map) or `"secondaryTap"` (the right button, a long press
   *   on a touch screen).
   * - `selectionMode`: `"multiple"` for any number of selected tiles,
   *   `"single"` for one, which the gesture on another tile moves.
   * - `selectionLimit`, `selectableBounds`: see `tileGridSelection`.
   *
   * Applies live.
   */
  tileGridSettings(options: Options<TileGridSettings>): ImmersiveMapSettings {
    return this.with({ tileGrid: tileGridSettings(options, this.data.tileGrid) });
  }

  /**
   * What a tap on the grid of `ImmersiveMap.tileGrid` may select: at most
   * `limit` tiles, and only tiles that share an area with
   * `selectableBounds`. Both are set as given, since null is a value here:
   * no limit, the whole map. A tap past the limit or outside the area
   * selects nothing and is reported to
   * `ImmersiveMapTileGridController.onTapRejected`. A selected tile can
   * always be deselected. A selection made from code is the app's own and
   * is held to neither rule.
   *
   * ```ts
   * settings.tileGridSelection({ limit: 20, selectableBounds: city });
   * ```
   *
   * Applies live.
   */
  tileGridSelection(options: { readonly limit: number | null; readonly selectableBounds: TileGridSettings["selectableBounds"] }): ImmersiveMapSettings {
    return this.with({ tileGrid: tileGridSettings({ selectionLimit: options.limit, selectableBounds: options.selectableBounds }, this.data.tileGrid) });
  }

  // MARK: The pins and the attribution

  /** The pins' values given, the rest as configured. A full `PinSettings` replaces the group. A change rebuilds the renderer. */
  pinSettings(options: Options<PinSettings>): ImmersiveMapSettings {
    return this.with({ pins: mergeOptions(this.data.pins, options) });
  }

  /**
   * Restyles the attribution badge, the values given, the rest as
   * configured. A full `AttributionSettings` replaces the group, and a
   * `textColor` of null takes the default white back.
   * `respectsBottomSafeArea: true` keeps a bottom badge above the home
   * indicator of a map that runs under the safe area. By default it sits at
   * the very bottom.
   *
   * ```ts
   * settings.attributionSettings({ size: "large", position: "topLeading" });
   * ```
   */
  attributionSettings(options: Options<AttributionSettings>): ImmersiveMapSettings {
    return this.with({ attribution: mergeOptions(this.data.attribution, options) });
  }

  /**
   * Declares that the app shows the data credit itself (its own overlay, an
   * about screen), so hiding the badge stops logging the attribution
   * warning. The license obligation stays with the app: the credit has to
   * stay visible on or next to the map, on every screen that shows one.
   */
  attributionProvidedExternally(isProvidedExternally = true): ImmersiveMapSettings {
    return this.with({ attribution: { ...this.data.attribution, isProvidedExternally } });
  }

  /**
   * What the badge actually shows: the app override, or, when absent, the
   * hosted service's credit, which is what the default source requires, and
   * after either the credit of the overview the engine lays into the tiles
   * while it is on (at the zooms up to `OverviewSettings.creditMaximumZoom`),
   * then the credit of the terrain's source at the zooms the relief rises at
   * (`groundReliefCredit`). The engine's own credit opens the line while
   * `showsEngineCredit` holds. An app that points the map at its own data
   * owns the credit of that data and states it with `attributionSettings`.
   * An empty override is the app taking the whole credit, the overview's and
   * the terrain's with it, off the badge: the badge stays empty and the
   * hidden-attribution warning stands.
   */
  get resolvedAttribution(): ImmersiveMapAttribution {
    let resolved = this.data.attribution.attributionOverride ?? ImmersiveMapTilesService.attribution;
    if (ImmersiveMapAttribution.isEmpty(resolved)) {
      return resolved;
    }
    if (this.data.tiles.overview.isEnabled) {
      resolved = ImmersiveMapAttribution.appending(resolved, ImmersiveMapAttribution.overviewCredit(this.data.tiles.overview.creditMaximumZoom));
    }
    const reliefCredit = groundReliefCredit(this.data.tiles.groundRelief);
    if (reliefCredit !== null) {
      resolved = ImmersiveMapAttribution.appending(resolved, reliefCredit);
    }
    if (this.data.attribution.showsEngineCredit) {
      resolved = ImmersiveMapAttribution.make([ImmersiveMapAttribution.engineCredit, ...resolved.credits], resolved.linkURL);
    }
    return resolved;
  }

  // MARK: Post-processing, debugging and the controls

  /** The post-processing's values given, the rest as configured. A full `PostProcessingSettings` replaces the group. */
  postProcessingSettings(postProcessing: Options<PostProcessingSettings>): ImmersiveMapSettings {
    return this.with({ postProcessing: mergeOptions(this.data.postProcessing, postProcessing) });
  }

  /**
   * FXAA over the finished frame, applied as the last pass, on unless
   * `isEnabled` says otherwise. Off by default: the map's own lines are
   * antialiased analytically, and FXAA adds the optional smoothing of
   * geometry silhouettes (building edges most visibly) at the price of one
   * fullscreen pass.
   */
  fxaa(options: { readonly isEnabled?: boolean | undefined } = {}): ImmersiveMapSettings {
    return this.with({ postProcessing: { ...this.data.postProcessing, fxaaEnabled: options.isEnabled ?? true } });
  }

  /**
   * MSAA 4x on the world pass, or back to one sample per pixel with
   * `isEnabled: false`. Off by default: four depth and colour samples per
   * pixel clean geometry silhouettes (buildings, models most visibly) at a
   * real cost in memory bandwidth, while the map's own lines are antialiased
   * analytically either way. Falls back to what the device supports.
   * Changing it recreates the renderer. See
   * `PostProcessingSettings.multisampleCount` for other counts.
   */
  msaa(options: { readonly isEnabled?: boolean | undefined } = {}): ImmersiveMapSettings {
    return this.with({ postProcessing: { ...this.data.postProcessing, multisampleCount: (options.isEnabled ?? true) ? 4 : 1 } });
  }

  /** The debug values given, the rest as configured. A full `DebugSettings` replaces the group. */
  debugSettings(debug: Options<DebugSettings>): ImmersiveMapSettings {
    return this.with({ debug: mergeOptions(this.data.debug, debug) });
  }

  /**
   * The debug panel on or off (`DebugSettings.enableDebugPanel`), and its
   * zoom badge in the map's top trailing corner, the camera's zoom and the
   * planning zoom (`DebugSettings.showsZoomBadge`, on by default), an
   * omitted `zoomBadge` left as configured.
   */
  debugPanel(isEnabled = true, options: { readonly zoomBadge?: boolean | undefined } = {}): ImmersiveMapSettings {
    return this.with({
      debug: { ...this.data.debug, enableDebugPanel: isEnabled, showsZoomBadge: options.zoomBadge ?? this.data.debug.showsZoomBadge },
    });
  }

  /**
   * Hides every control drawn over the map at once, for a clean frame: the
   * debug panel, the camera's on-screen controls and the control zones. Each
   * keeps its configuration and the debug panel the values dragged in it, so
   * `controlsHidden(false)` brings them back as they were, without rebuilding
   * the renderer. The attribution stays, as the map data's license requires.
   */
  controlsHidden(isHidden = true): ImmersiveMapSettings {
    return this.with({ controls: { ...this.data.controls, isHidden } });
  }
}

/** `ImmersiveMapSettings.default`, by the name the camera's and the presentation's code read it. */
export const defaultImmersiveMapSettings: ImmersiveMapSettings = ImmersiveMapSettings.default;

/** `settings.globe({ isEnabled })`: the settings with the globe switched on or off, everything else kept. */
export function withGlobeEnabled(settings: ImmersiveMapSettings, isEnabled: boolean): ImmersiveMapSettings {
  return settings.globe({ isEnabled });
}
