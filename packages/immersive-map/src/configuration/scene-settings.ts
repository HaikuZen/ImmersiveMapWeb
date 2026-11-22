// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgb, Rgba, Vector3 } from "./color.ts";
import { deepFreeze, mergeOptions } from "./deep.ts";
import type { Options } from "./deep.ts";
import { zoomCurve, zoomCurveStops, zoomCurveValue } from "./zoom-curve.ts";
import type { ImmersiveMapZoomCurve, ZoomCurveInput } from "./zoom-curve.ts";

/** The normalizing transform of a zoom curve field, for `mergeOptions`. */
const curve = (value: ZoomCurveInput): ImmersiveMapZoomCurve => zoomCurve(value);

export interface SpaceSettings {
  /** The colour of space behind the globe and the stars, RGBA in 0...1. */
  readonly clearColor: Rgba;
  /**
   * Leaves everything outside the globe unpainted, so whatever the page puts
   * behind the map shows through: the frame is cleared to a fully
   * transparent pixel and the starfield layer (space background, stars and
   * the visible Sun) is not drawn at all. `clearColor` is ignored. The globe
   * surface itself stays opaque, and the map of the flat presentation still
   * covers the viewport with the style's map colour (the base colours of the
   * theme).
   */
  readonly isTransparent: boolean;
}

export const defaultSpaceSettings: SpaceSettings = deepFreeze({
  clearColor: [0.008, 0.012, 0.032, 1.0],
  isTransparent: false,
});

export function spaceSettings(options: Options<SpaceSettings> = {}): SpaceSettings {
  return deepFreeze(mergeOptions(defaultSpaceSettings, options));
}

export interface StarfieldSettings {
  readonly starCount: number;
  readonly sizeMin: number;
  readonly sizeMax: number;
  readonly brightnessMin: number;
  readonly brightnessMax: number;
  readonly near: number;
  readonly far: number;
  readonly radiusScale: number;
}

export const defaultStarfieldSettings: StarfieldSettings = Object.freeze({
  starCount: 3400,
  sizeMin: 0.9,
  sizeMax: 5.2,
  brightnessMin: 0.16,
  brightnessMax: 1.05,
  near: 0.1,
  far: 6000,
  radiusScale: 10.5,
});

export function starfieldSettings(options: Options<StarfieldSettings> = {}): StarfieldSettings {
  return deepFreeze(mergeOptions(defaultStarfieldSettings, options));
}

/**
 * The static sun of the flat presentation: its direction defines where
 * buildings and scene models cast their shadow-map shadows (there is no
 * analytic surface shading: faces darken only via the shadow map).
 */
export interface SceneLightSettings {
  /**
   * World-space direction pointing towards the light in the flat basis (+X
   * east, +Y north, +Z up). Normalized before use. (-0.4, -0.6, 1) by
   * default.
   */
  readonly direction: Vector3;
}

export const defaultSceneLightSettings: SceneLightSettings = deepFreeze({ direction: [-0.4, -0.6, 1.0] });

export function sceneLightSettings(options: Options<SceneLightSettings> = {}): SceneLightSettings {
  return deepFreeze(mergeOptions(defaultSceneLightSettings, options));
}

/**
 * Directional shadows cast by extruded buildings and scene models onto the
 * flat map, other buildings and models. Flat presentation only.
 */
export interface ShadowSettings {
  readonly isEnabled: boolean;
  /**
   * How dark the shadows are, 0 to 1, by the camera zoom: nothing up to zoom
   * 14, the buildings' zoom (`ExtrusionSettings.buildingsMinimumZoom`), and
   * 0.22 from zoom 15 on by default, rising smoothly between the two stops
   * so the shadows never appear at one frame. Where the curve is zero no
   * shadow pass runs. From an overview the shadows of the mountains and the
   * buildings read as stains on the map, and the hillshade carries the
   * relief on its own. Put the first stop lower for a map that wants the
   * mountains' shadows from afar (the relief draws from
   * `GroundReliefSettings.appearZoom`, 10 by default), higher for shadows in
   * street views alone. Read at the animated zoom, so a zoom gesture plays
   * the change.
   */
  readonly strength: ImmersiveMapZoomCurve;
  /** Square shadow map side in pixels. Clamped to `256...4096` at render time. */
  readonly mapResolution: number;
  /**
   * Coverage radius of the shadow map's near window, in metres on the ground
   * around the point the camera looks at, by the camera zoom: 24 km at zoom
   * 12, 6 km at 14, 1.5 km at 16 and 500 m at 18 by default, halving with
   * every zoom between the stops as the map's scale does (the curve runs
   * geometrically). One slice of the map is stretched over the radius, so
   * raising it coarsens every shadow in the window in proportion, and
   * `mapResolution` is what buys the density back. The window is fitted to
   * the visible ground inside the radius, so metres the camera cannot see
   * cost nothing. Clamped to `5...1_000_000` m. Over the outer quarter of the
   * radius the near window hands over to the far one (`farCoverageMeters`),
   * or the shadows fade out without it, so the window's edge is never
   * visible as a circle at any coverage. A few metres are a debugging aid:
   * they wind the window down onto the point the camera looks at, which is
   * how the shadow map's texel grid is looked at up close. In metres rather
   * than camera distances, like the ground fog's lengths, so the same curve
   * means the same ground on every screen and at every pitch.
   */
  readonly nearCoverageMeters: ImmersiveMapZoomCurve;
  /**
   * Coverage radius of the shadow map's far window, in the same metres by
   * the zoom: the second slice of the map, as many texels over a wider disc
   * and so coarser, for the shadows beyond the near window, the mountains
   * casting across a valley from kilometres away. Four times the near
   * coverage by default (96 km at zoom 12 down to 1.5 km at 18). A receiver
   * reads the near window where it reaches and the far one past it, and the
   * shadows fade out over the outer quarter of this radius. The far window
   * is fitted only when its fade band starts where the near window ends or
   * beyond, at four thirds of the near coverage or more: under that the
   * setting is off at that zoom, the frame has the near window alone and
   * pays for one. Raise it to shadow farther ground, lower it for sharper far
   * shadows, and set it under the near coverage for the one window of a city
   * map without a relief.
   */
  readonly farCoverageMeters: ImmersiveMapZoomCurve;
  /**
   * Tallest building the shadow window is fitted for, in meters. Expected
   * range: `10...500`, clamped at render time.
   *
   * The window has to reach beyond its own disc by `height * |L.xy| / L.z`,
   * which is how far a caster of that height throws its shadow into the
   * disc: under a midday sun about 0.72 of the height. That margin is added
   * to the window whether or not a building that tall is anywhere in sight,
   * and it is spent on texels. At a street camera with a 1000 m limit it was
   * three quarters of the window, which is why coverage seemed to do nothing
   * to the sharpness of a shadow's edge: it was moving the other quarter.
   *
   * Set it to the tallest building actually around, and the texels go to
   * the shadows on screen. Set it too low and a building above it stops
   * casting into the window at all.
   *
   * The default is the range's ceiling: every building casts its whole
   * shadow into the window, a tower at the edge of the visible ground
   * included, and the texels it costs are paid back by the 4K shadow map and
   * the window's floor in meters. A map of low buildings can lower it to the
   * tallest one around for sharper shadows in a street view, where the
   * margin is pure cost: the window is fitted to the visible ground anyway,
   * and a taller limit only widens the rim that a caster standing at the
   * window's edge would need.
   */
  readonly maxCasterHeightMeters: number;
  /**
   * How far a receiver's shadow lookup steps off its own surface, along the
   * surface normal, measured in shadow-map texels. Expected range: `0...8`,
   * clamped at render time.
   *
   * This is the only defence against shadow acne (the striped self-shadowing
   * on walls turned away from the sun), and it is a two-sided trade. Too
   * little and grazing walls stripe. Too much and the lookup steps out past
   * real occluders, so a wall stops being shadowed by anything closer to it
   * than the offset, which is what makes narrow alleys and light wells lose
   * their shadows as the camera pulls back. The offset is stated in texels
   * rather than in meters on purpose: the amount of acne to cover is
   * proportional to how coarse the map is, so a texel-relative offset stays
   * correct at every zoom and coverage.
   */
  readonly normalOffsetTexels: number;
  /**
   * How soft the edge of a shadow is: the factor the sampling kernel's four
   * taps are pushed out by. Expected range: `1...2.5`, clamped at render
   * time. `1` is the plain 3x3 tent, and every step up widens the ramp in
   * proportion.
   *
   * The default sits a step above the plain tent, which is where a shadow's
   * edge stops reading as a hard cut without the contact under a building
   * going soft.
   *
   * It costs nothing: the kernel is the same four hardware compares at any
   * softness. And it cannot move a shadow, because the kernel stays
   * symmetric about the point being shaded, which puts the half-lit contour
   * on the true edge whatever the width. Only the ramp around it gets
   * longer.
   *
   * What it is not is a way to sharpen a stepped edge. The steps in a
   * shadow's outline are one texel of the shadow map, and a wider kernel
   * rounds their corners rather than removing them. The texel is what
   * `mapResolution`, the coverages and `maxCasterHeightMeters` decide between
   * them. Raising softness far also softens the contact where a building
   * meets the ground, which is what makes it read as standing on it.
   */
  readonly softness: number;
  /**
   * The cast of the shadowed light, as an RGB multiplier applied on top of
   * `strength` where a surface is fully in shadow: white keeps the neutral
   * darkening, and the default cool tint gives shadows the bluish cast of
   * light arriving only from the sky, which is what keeps a shadowed street
   * reading as daylight rather than as a grey stain. Components run `0...1`.
   * A partially shadowed fragment takes on the tint in proportion.
   */
  readonly tint: Rgb;
}

export const shadowCurveFields = Object.freeze({ strength: curve, nearCoverageMeters: curve, farCoverageMeters: curve });

export const defaultShadowSettings: ShadowSettings = deepFreeze({
  isEnabled: true,
  strength: zoomCurve({ 14: 0, 15: 0.22 }),
  mapResolution: 4096,
  nearCoverageMeters: zoomCurve({ 12: 24_000, 14: 6000, 16: 1500, 18: 500 }),
  farCoverageMeters: zoomCurve({ 12: 96_000, 14: 24_000, 16: 6000, 18: 1500 }),
  maxCasterHeightMeters: 500,
  normalOffsetTexels: 2.5,
  softness: 1.5,
  tint: [0.88, 0.92, 1.0],
});

export function shadowSettings(
  options: Options<ShadowSettings, "strength" | "nearCoverageMeters" | "farCoverageMeters"> = {},
): ShadowSettings {
  return deepFreeze(mergeOptions(defaultShadowSettings, options, shadowCurveFields));
}

/** The strength at a camera zoom, 0 to 1. */
export function shadowStrength(shadows: ShadowSettings, zoom: number): number {
  return Math.min(Math.max(zoomCurveValue(shadows.strength, zoom), 0), 1);
}

/** The near window's coverage at a camera zoom, in metres: the curve runs geometrically, as a length on the ground does. */
export function shadowNearCoverageMeters(shadows: ShadowSettings, zoom: number): number {
  return zoomCurveValue(shadows.nearCoverageMeters, zoom, "geometric");
}

/** The far window's coverage at a camera zoom, in metres. */
export function shadowFarCoverageMeters(shadows: ShadowSettings, zoom: number): number {
  return zoomCurveValue(shadows.farCoverageMeters, zoom, "geometric");
}

/**
 * The globe's atmosphere: a halo of scattered light around the planet's
 * limb and a matching glow on the surface toward it. The globe's, on the
 * resting sphere and along the edge of the unrolling surface alike. Over the
 * last stretch of the globe-to-flat morph
 * (`PresentationSettings.airHandoverStart` to `airHandoverEnd`) it hands
 * over to the flat map's sky (`FogSettings`), and the flat map has no
 * atmosphere. A thin glow at the limb that hides the tile mesh's edge stays
 * even with the atmosphere off.
 */
export interface AtmosphereSettings {
  readonly isEnabled: boolean;
  /**
   * The color of the scattered light, RGB in `0...1`. A deep blue by
   * default. The very edge of the halo whitens toward the limb on its own.
   */
  readonly color: Rgb;
  /**
   * Brightness multiplier of the halo and of the surface glow. Expected
   * range: `0...2`. 1 is the designed look, 0 leaves the sphere bare while
   * keeping the layer on. 1.2 by default.
   */
  readonly intensity: number;
  /**
   * Width multiplier of the halo, relative to the globe radius, by the
   * camera zoom: 1 is the full shell, 0.25 a thin bright ring hugging the
   * limb, 3 three times the full shell. The halo scales with the globe on
   * screen, so at one zoom it looks the same from every side, and the curve
   * lets it be a wide glow around the whole planet from afar and a thin ring
   * as the camera comes down to the surface. By default 3 up to zoom 2, down
   * to 0.25 by zoom 6, where the globe unrolls. A single value states the
   * same at every zoom.
   */
  readonly thickness: ImmersiveMapZoomCurve;
  /**
   * How much the scene light (`SceneLightSettings.direction`, the sun the
   * buildings cast their shadows from) shapes the halo, `0...1`: at 1 the
   * halo is full where the limb faces the light and dims to a residual glow
   * opposite it. At 0 it is the same brightness all the way around. 0.69 by
   * default.
   */
  readonly sunInfluence: number;
}

export const defaultAtmosphereSettings: AtmosphereSettings = deepFreeze({
  isEnabled: true,
  color: [0.008, 0.18, 0.482],
  intensity: 1.2,
  thickness: zoomCurve({ 2: 3, 6: 0.25 }),
  sunInfluence: 0.69,
});

export function atmosphereSettings(options: Options<AtmosphereSettings, "thickness"> = {}): AtmosphereSettings {
  return deepFreeze(mergeOptions(defaultAtmosphereSettings, options, { thickness: curve }));
}

/**
 * The sky of the flat presentation: above the horizon line the sky, a short
 * pale glow at the line that gives way to the sky colour within a few
 * degrees. On by default. Off, nothing is painted above the line (the sky
 * is the map's clear colour). Nothing is painted on the ground under the
 * line: the far ground is veiled by the ground fog (`GroundFogSettings`), by
 * its distance, which takes its colour from `horizonColor`. The globe has
 * its own treatment, `AtmosphereSettings`. Over the last stretch of the
 * globe-to-flat morph (`PresentationSettings.airHandoverStart` to
 * `airHandoverEnd`) the atmosphere hands over to this.
 */
export interface FogSettings {
  readonly isEnabled: boolean;
  /** The sky's colour away from the horizon, RGB in `0...1`. */
  readonly skyColor: Rgb;
  /**
   * The colour at the horizon: the glow the sky brightens into over its last
   * degrees coming down and, unless it states its own, the ground fog, so
   * the two meet at the line in one colour. White by default, the way a hazy
   * day's sky whitens toward the ground.
   */
  readonly horizonColor: Rgb;
}

export const defaultFogSettings: FogSettings = deepFreeze({
  isEnabled: true,
  skyColor: [0.4, 0.66, 1.0],
  horizonColor: [0.97, 0.97, 0.98],
});

export function fogSettings(options: Options<FogSettings> = {}): FogSettings {
  return deepFreeze(mergeOptions(defaultFogSettings, options));
}

/**
 * The air of a night, for the night palette (`nightTheme`): the sky a deep
 * navy, the horizon a shade lighter in the hue of the palette's water, so
 * the far city sinks into the night and the ground fog, which takes the
 * horizon's colour unless it states its own, meets the sky at the line.
 */
export const nightFogSettings: FogSettings = fogSettings({ skyColor: [0.03, 0.05, 0.11], horizonColor: [0.09, 0.12, 0.22] });

/** When the extruded buildings and the models of a model archive stand up out of the flat map. */
export interface ExtrusionSettings {
  /**
   * The camera zoom the extruded buildings draw from. Below it the map is
   * flat, and reaching it they rise out of the ground. 14 by default.
   */
  readonly buildingsMinimumZoom: number;
  /**
   * How long a layer takes to rise out of the ground when the camera reaches
   * its zoom, in seconds, 0.6 by default. Zero stands it up at once. Leaving
   * the zoom, the layer is gone at once. The extruded buildings grow from
   * the ground to their height, the models of a model archive come up out of
   * it whole, from `ModelArchiveSettings.minimumZoom`.
   */
  readonly riseSeconds: number;
}

export const defaultExtrusionSettings: ExtrusionSettings = Object.freeze({ buildingsMinimumZoom: 14, riseSeconds: 0.6 });

export function extrusionSettings(options: Options<ExtrusionSettings> = {}): ExtrusionSettings {
  return deepFreeze(mergeOptions(defaultExtrusionSettings, options));
}

/**
 * The trees that stand on the woods and the parks of the flat map. Which
 * fills grow them, how far apart and how tall is the style's (`TreeStyles`
 * of the theme): this is when and how many. The trees draw from the tiles
 * the buildings draw from and rise out of the ground with them
 * (`ExtrusionSettings.riseSeconds`). They stand on the plane, since at
 * their zooms the ground relief is not drawn. Each lays a soft disc of
 * shadow on the ground under its crown, away from the sun, with the
 * darkening of `ShadowSettings` and none while the shadows are off. On by
 * default.
 */
export interface TreeSettings {
  readonly isEnabled: boolean;
  /**
   * The camera zoom the trees draw from. Below it there are none. Read per
   * frame: the tiles carry their trees from the buildings' zoom whatever this
   * says. 14 by default, the buildings' zoom, so the trees stand up with
   * them.
   */
  readonly minimumZoom: number;
  /**
   * The camera zoom from which every tree of a tile draws. Below it the
   * trees thin out, halving with every zoom away from it, so a wood at the
   * first zoom is a scattering that fills in as the camera comes closer, and
   * the trees a far zoom shows are among the ones a near zoom shows. 14 by
   * default, the trees' own zoom, so every tree draws from the first: raise
   * it on a map whose woods cost too much at the far zooms.
   */
  readonly fullDensityZoom: number;
  /**
   * The camera zoom from which the trees draw in their near detail (the
   * model's first level), the far level below it. 16.5 by default.
   */
  readonly nearDetailZoom: number;
  /**
   * The most trees a tile keeps, the first by priority, so a dense wood
   * never costs more than this many per tile. Part of the prepared tiles'
   * identity. 4000 by default, at least 0.
   */
  readonly maximumPerTile: number;
}

export const defaultTreeSettings: TreeSettings = Object.freeze({
  isEnabled: true,
  minimumZoom: 14,
  fullDensityZoom: 14,
  nearDetailZoom: 16.5,
  maximumPerTile: 4000,
});

export function treeSettings(options: Options<TreeSettings> = {}): TreeSettings {
  return deepFreeze(mergeOptions(defaultTreeSettings, options, { maximumPerTile: (value: number) => Math.max(value, 0) }));
}

/**
 * The fog that lies on the ground of the flat map and thins upward:
 * thickest at the ground, its density falling by a factor of e every
 * `heightMeters`, gathered along each view ray past `startDistanceMeters`
 * from the camera. A far point low on the ground sinks in it, the near
 * ground and everything high stays clear, and a tall building rises out of
 * it. It veils the ground, the roads, the labels painted on the map, the
 * buildings and the models (`veilsBuildings`), so it hides the far detail
 * and its shimmer and draws the eye to the near ground. On by default. The
 * horizon's sky (`FogSettings`) is the horizon's own: either can be on
 * without the other. The globe has none.
 *
 * Every length is in meters on the ground, so a fog layer 60 m high is 60 m
 * high at every zoom, and a fog that begins 400 m from the camera begins
 * there however close the camera is.
 *
 * Every value but the colour follows the camera zoom, so the fog changes as
 * the camera zooms rather than at a step. The lengths and the density run
 * between their stops geometrically, the same ratio for every step of zoom,
 * the way the map's own scale changes, so two stops a few zooms apart follow
 * the map in between. A curve holds its first stop's value below it, so a
 * fog meant to keep its look while the camera pulls away needs a stop at the
 * lowest zoom it shows at, its lengths there scaled by two per zoom. The
 * defaults: no fog up to zoom 8, coming in by zoom 10. From zoom 7 to 12 the
 * zoom 12 look at the map's scale: at zoom 12 a thin haze from 40 km out,
 * complete only toward the horizon some 200 km away, so the view still
 * reaches far, and at zoom 7, 32 times as far, the same haze. At zoom 16 a
 * fog from 400 m that is complete by 1.2 km, at the edge past which the
 * buildings are drawn flat, 150 m high so the near towers rise out of it. At
 * zoom 22, at the camera's feet, a low layer from 250 m, 60 m high: the
 * street ahead is clear and the far bases sink softly into it. A single
 * value states the same at every zoom.
 *
 * On a map with the globe the fog comes in over a tenth of the transition
 * span (`PresentationSettings.automaticTransitionSpan`) past the zoom the
 * globe's morph into the plane ends at, so it never appears at one frame.
 * Applies live.
 *
 * On the ground relief the fog is the air over the mountains: its height is
 * measured from sea level (`heightsFromSeaLevel`), so a valley lies deeper
 * in it than the summit over it, and the far ridges stand out of the hazed
 * valleys behind them, each lighter than the one before.
 * `baseAltitudeMeters` is the altitude the density is stated at. The debug
 * panel's Air tab drags all of it.
 */
export interface GroundFogSettings {
  readonly isEnabled: boolean;
  /**
   * How thick the fog is at the ground, per kilometer: the share of light it
   * takes over one kilometer there is about `1 - e^-density`. Raise it for a
   * thicker fog, lower it for a veil. Past the start's softness the fog is
   * complete within about `3 / density` kilometers along the ground.
   */
  readonly densityPerKilometer: ImmersiveMapZoomCurve;
  /**
   * How high the fog rises, in meters: its density falls by a factor of e
   * every this many meters above the ground. Low, a layer the buildings
   * stand out of. High, a haze that fills the view.
   */
  readonly heightMeters: ImmersiveMapZoomCurve;
  /** How far from the camera the fog begins, in meters: nearer than this the view is clear. */
  readonly startDistanceMeters: ImmersiveMapZoomCurve;
  /**
   * How far past `startDistanceMeters` the fog takes to come in, in meters:
   * its density rises smoothly from nothing to full over this stretch, so
   * the veil has no edge where it begins. 0 starts it at full density at
   * once. Widen it for a softer, longer transition from the clear near
   * ground into the fog.
   */
  readonly startSoftnessMeters: ImmersiveMapZoomCurve;
  /**
   * The fog's colour, RGB in `0...1`. Null takes the horizon's colour
   * (`FogSettings.horizonColor`), so the fog meets the sky at the line in one
   * colour.
   */
  readonly color: Rgb | null;
  /**
   * The most the fog veils anything, `0...1`: under 1 the farthest ground
   * still shows through, and at 0 there is no fog. The value to bring the fog
   * in or out with the zoom.
   */
  readonly maximumOpacity: ImmersiveMapZoomCurve;
  /**
   * Whether the fog veils the extruded buildings and the models with the
   * ground. On (the default) a far building sinks into the fog from its base
   * up, standing in it as the ground does. Off they draw in their own
   * colour, crisp, and seem to float over the fogged ground at their feet.
   */
  readonly veilsBuildings: boolean;
  /**
   * Whether the fog takes the sky's colour above the horizon line, in the
   * direction of the view, where the horizon paints a sky
   * (`FogSettings.isEnabled`). Off (the default) the fog is one colour
   * everywhere, and a far building fades toward it as into a haze. On, a
   * building veiled in full is the sky behind it, which reads as the
   * building turning see-through.
   */
  readonly takesSkyColor: boolean;
  /**
   * On the ground relief, whether the fog's height is measured from sea
   * level, the terrain's own metres (on, the default), or from the plane the
   * ground is drawn from, the terrain under the point the camera looks at.
   * From sea level, the density falls with the altitude of the ground
   * itself: the floor of a valley at 1500 m is in denser air than a ridge at
   * 3000 m whatever the camera looks at, which is what layers the ridges.
   * From the plane, the ground under the camera's point is always at the
   * full density, and the fog follows the camera up and down the slopes. Off
   * the relief the two are one and the same.
   */
  readonly heightsFromSeaLevel: boolean;
  /**
   * The altitude the density is stated at, in meters: at and below it the
   * fog is `densityPerKilometer` thick, above it the density falls by a
   * factor of e every `heightMeters`. 0 by default, sea level. Raise it to
   * the valleys' floor for mountains whose air is meant to be thick in the
   * valleys and thin on the summits, at a smaller `heightMeters`. Read only
   * with `heightsFromSeaLevel`.
   */
  readonly baseAltitudeMeters: number;
}

/** The fields of the ground fog that are zoom curves. */
export type GroundFogCurveField =
  | "densityPerKilometer"
  | "heightMeters"
  | "startDistanceMeters"
  | "startSoftnessMeters"
  | "maximumOpacity";

export const groundFogCurveFields = Object.freeze({
  densityPerKilometer: curve,
  heightMeters: curve,
  startDistanceMeters: curve,
  startSoftnessMeters: curve,
  maximumOpacity: curve,
});

export const defaultGroundFogSettings: GroundFogSettings = deepFreeze({
  isEnabled: true,
  densityPerKilometer: zoomCurve({ 7: 0.0019, 12: 0.06, 16: 1.4, 22: 6 }),
  heightMeters: zoomCurve({ 7: 256_000, 12: 8000, 16: 150, 22: 60 }),
  startDistanceMeters: zoomCurve({ 7: 1_280_000, 12: 40_000, 16: 400, 22: 250 }),
  startSoftnessMeters: zoomCurve({ 7: 4_800_000, 12: 150_000, 16: 800, 22: 950 }),
  color: null,
  maximumOpacity: zoomCurve({ 8: 0, 10: 1 }),
  veilsBuildings: true,
  takesSkyColor: false,
  heightsFromSeaLevel: true,
  baseAltitudeMeters: 0,
});

export function groundFogSettings(options: Options<GroundFogSettings, GroundFogCurveField> = {}): GroundFogSettings {
  return deepFreeze(mergeOptions(defaultGroundFogSettings, options, groundFogCurveFields));
}

/** The zooms the overview's stops of the shipping curves sit at, the relief's zooms and below: 0 to 13. */
export const overviewStopZooms = Object.freeze({ lowerBound: 0, upperBound: 13 });

/**
 * `curve` with every stop up to zoom 13 dropped and one value put at zooms 7
 * and 12 in their place: the overview reads it, and the stops past it are
 * the curve's own.
 */
export function replacingOverviewStops(curveValue: ImmersiveMapZoomCurve, value: number): ImmersiveMapZoomCurve {
  const out: Record<number, number> = {};
  for (const stop of zoomCurveStops(curveValue)) {
    if (stop.zoom < overviewStopZooms.lowerBound || stop.zoom > overviewStopZooms.upperBound) {
      out[stop.zoom] = stop.value;
    }
  }
  out[7] = value;
  out[12] = value;
  return zoomCurve(out);
}

/**
 * The air over mountains to start from, made of a plain's air
 * (`SceneSettings.mountainGroundFog`, its default over the default plain
 * air): the haze from the camera on with no clear stretch, thin (half the
 * light gone in some 35 km), a 2.5 km layer that is thickest up to the
 * valleys' floor at 1500 m and thins over the summits, in the plain air's
 * own colour (the horizon's white by default). The stops at zooms 7 and 12
 * are replaced, the street zooms' (16 and 22) kept, so the city's fog stays
 * as the app has it.
 */
export function mountainAir(plain: GroundFogSettings): GroundFogSettings {
  return deepFreeze({
    ...plain,
    isEnabled: true,
    heightsFromSeaLevel: true,
    baseAltitudeMeters: 1500,
    densityPerKilometer: replacingOverviewStops(plain.densityPerKilometer, 0.02),
    heightMeters: replacingOverviewStops(plain.heightMeters, 2500),
    // Geometric curves cannot hold a zero: ten metres is no clear stretch to
    // speak of.
    startDistanceMeters: replacingOverviewStops(plain.startDistanceMeters, 10),
    startSoftnessMeters: replacingOverviewStops(plain.startSoftnessMeters, 3000),
  });
}

/**
 * The sun on the globe: the planet's surface shaded by the sphere's normal
 * against a sun fixed to the Earth, over the subsolar point
 * (`subsolarLatitudeDegrees`, `subsolarLongitudeDegrees`), the day side as
 * the style paints it and the night side drawn toward a night colour, with
 * a soft terminator between. The terminator lies on one part of the planet
 * whichever way the globe is turned, and the atmosphere's halo brightens
 * toward the same sun. Without it the sphere is lit the same all over and
 * reads flat. Globe presentation only: through the morph into the plane the
 * shading fades out with the atmosphere, and the flat map has its own
 * static sun (`SceneLightSettings.direction`), the hillshade and the
 * shadows.
 */
export interface GlobeLightSettings {
  readonly isEnabled: boolean;
  /**
   * Where the sun stands overhead, in degrees: the latitude north positive.
   * Over the Atlantic off West Africa by default (10, -15), which lights
   * Europe and Africa from the south-west and puts the night over Asia and
   * the Pacific. The sun stays there as the globe turns.
   */
  readonly subsolarLatitudeDegrees: number;
  /** The longitude the sun stands overhead at, in degrees, east positive. -15 by default. */
  readonly subsolarLongitudeDegrees: number;
  /**
   * How far the night side goes toward `nightColor`, 0 to 1, by the camera
   * zoom: 1 draws the night side in the night colour outright, 0 leaves the
   * surface as it is. By default 0.6 at zoom 0, gone by zoom 1: the
   * terminator shows on the whole planet, and past it the shading would only
   * darken the map in view. A single value states the same at every zoom.
   */
  readonly strength: ImmersiveMapZoomCurve;
  /**
   * The width of the terminator, as the cosine of the sun's angle to the
   * surface: the shading runs from day to night over
   * `-terminatorSoftness...terminatorSoftness` of it. 0.25 by default, the
   * halo's own dusk. Smaller is a sharper line, 1 a dusk over the whole lit
   * half.
   */
  readonly terminatorSoftness: number;
  /** The colour the night side is drawn toward, RGB in `0...1`: a deep blue by default, the planet's night under a blue sky. */
  readonly nightColor: Rgb;
}

export const defaultGlobeLightSettings: GlobeLightSettings = deepFreeze({
  isEnabled: true,
  subsolarLatitudeDegrees: 10,
  subsolarLongitudeDegrees: -15,
  strength: zoomCurve({ 0: 0.6, 1: 0 }),
  terminatorSoftness: 0.25,
  nightColor: [0.05, 0.08, 0.18],
});

export function globeLightSettings(options: Options<GlobeLightSettings, "strength"> = {}): GlobeLightSettings {
  return deepFreeze(mergeOptions(defaultGlobeLightSettings, options, { strength: curve }));
}

export interface SceneSettings {
  readonly space: SpaceSettings;
  readonly starfield: StarfieldSettings;
  readonly light: SceneLightSettings;
  readonly shadows: ShadowSettings;
  readonly atmosphere: AtmosphereSettings;
  readonly globeLight: GlobeLightSettings;
  readonly fog: FogSettings;
  /** The air over the flat map, and over a plain where `mountainGroundFog` is set. */
  readonly groundFog: GroundFogSettings;
  /**
   * The air over the mountains: by default the mountain air made of the
   * default plain air (`mountainAir`), null for one air everywhere. Set, the
   * frame draws the air between this and `groundFog` by how mountainous the
   * country around the camera reads (tuned with
   * `TerrainSurroundingsSettings`): every value of the two airs is read at
   * the zoom and mixed, so a pan from a plain into a range fades one air into
   * the other. Read only with the relief on and the frame on the terrain,
   * where the country can be read: off it the air is `groundFog`.
   */
  readonly mountainGroundFog: GroundFogSettings | null;
  readonly extrusion: ExtrusionSettings;
  /** The trees of the woods and the parks (`TreeSettings`). */
  readonly trees: TreeSettings;
}

export const defaultSceneSettings: SceneSettings = deepFreeze({
  space: defaultSpaceSettings,
  starfield: defaultStarfieldSettings,
  light: defaultSceneLightSettings,
  shadows: defaultShadowSettings,
  atmosphere: defaultAtmosphereSettings,
  globeLight: defaultGlobeLightSettings,
  fog: defaultFogSettings,
  groundFog: defaultGroundFogSettings,
  mountainGroundFog: mountainAir(defaultGroundFogSettings),
  extrusion: defaultExtrusionSettings,
  trees: defaultTreeSettings,
});

export function sceneSettings(options: Options<SceneSettings> = {}): SceneSettings {
  return deepFreeze(mergeOptions(defaultSceneSettings, options));
}
