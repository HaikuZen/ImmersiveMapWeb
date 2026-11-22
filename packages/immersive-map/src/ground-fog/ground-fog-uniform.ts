// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ViewMode } from "../camera/view-mode.ts";
import type { Rgb } from "../configuration/color.ts";
import type { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import type { PresentationSettings } from "../configuration/presentation-settings.ts";
import type { FogSettings, GroundFogSettings } from "../configuration/scene-settings.ts";
import { type ImmersiveMapZoomCurve, zoomCurveValue } from "../configuration/zoom-curve.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import type { Vec3, Vec4 } from "../math/vec.ts";
import type { SceneFrameState } from "../render/scene-frame-state.ts";

/**
 * The fog on the ground of the flat map (`GroundFogSettings`) as the shaders
 * read it (ground-fog.wgsl), its zoom curves resolved at the frame's camera
 * zoom, a port of the Swift `GroundFogUniform`. The feature owns the fog's
 * settings and its math and draws nothing of its own: every subsystem that
 * draws something standing on the map binds this uniform and its fragment
 * shader mixes its colour toward the fog's (`applyGroundFog`). The globe has
 * no fog: there and with the fog off the strength is zero and the shaders
 * leave every colour.
 */
export interface GroundFogUniform {
  readonly colorAndDensity: Vec4;
  /** The eye in render world units and the meters one unit spans. */
  readonly eyeAndMetersPerUnit: Vec4;
  /** The height and the start distance in meters, the most it veils, the strength. */
  readonly parameters: Vec4;
  /** The sky's colour away from the line and the e-fold of the horizon's glow in radians, 0 where no sky is painted. */
  readonly skyColorAndGradient: Vec4;
  /**
   * The start's softness in meters, the altitude of the plane the ground is
   * drawn from (0 off the relief or with the heights from the plane), the
   * altitude the density is stated at, and padding.
   */
  readonly startSoftness: Vec4;
}

/**
 * One air at a zoom, as numbers: every curve read there and every switch a
 * share, 0 or 1, so two airs mix into one that the uniform is built from.
 */
export interface GroundFogAir {
  /** 1 with the fog on, 0 off. */
  readonly isOn: number;
  readonly densityPerMeter: number;
  readonly heightMeters: number;
  readonly startDistanceMeters: number;
  readonly startSoftnessMeters: number;
  readonly maximumOpacity: number;
  readonly color: Vec3;
  /** The e-fold of the horizon's glow where the fog takes the sky's colour, 0 where it keeps its own. */
  readonly skyGradient: number;
  /** 1 with the heights from sea level, the datum's share. */
  readonly datumShare: number;
  /** The altitude the density is stated at, 0 with the heights from the plane. */
  readonly baseAltitudeMeters: number;
  /** 1 where the fog veils the buildings and the models. */
  readonly veilsBuildings: number;
}

export interface GroundFogResolveInput {
  readonly settings: ImmersiveMapSettings;
  readonly renderSurfaceMode: ViewMode;
  readonly cameraEye: Vec3;
  readonly worldUnitsPerMeter: number;
  readonly zoom: number;
  readonly onGroundRelief?: boolean;
  /** The altitude of the plane the ground is drawn from on the relief. */
  readonly datumMetres?: number;
  /** How mountainous the country around the camera reads, 0 off the terrain. */
  readonly mountainousness?: number;
  /** The fog the buildings and the models draw with. */
  readonly forBuildings?: boolean;
}

/** The plane's sky glow width, `HorizonFrameResolver.skyGradientRadians`, which the fog takes above the line. */
const skyGradientRadians = (2.5 * Math.PI) / 180;

export const GroundFogUniform = {
  /** The uniform's byte length: five `vec4f`. */
  byteLength: 80,

  /**
   * The share of the presentation's transition span, in zoom, the fog comes
   * in over past the zoom the globe's morph ends at. The sphere's shaders
   * draw no fog, so the plane's first frame would otherwise show it at once.
   */
  morphFadeSpanShare: 0.1,

  disabled: Object.freeze<GroundFogUniform>({
    colorAndDensity: [0, 0, 0, 0],
    eyeAndMetersPerUnit: [0, 0, 1, 1],
    parameters: [1, 0, 0, 0],
    skyColorAndGradient: [0, 0, 0, 0],
    startSoftness: [0, 0, 0, 0],
  }),

  /** One air's values at `zoom`, the lengths and the density read geometrically between their stops. */
  air(fog: GroundFogSettings, sky: FogSettings, zoom: number, onGroundRelief: boolean): GroundFogAir {
    const length = (curve: ImmersiveMapZoomCurve): number => Math.max(zoomCurveValue(curve, zoom, "geometric"), 0);
    // On the ground relief the fog keeps its own colour everywhere: the line
    // is the plane's, not the terrain's, and a hill crossing it would turn
    // from the fog's colour to the sky's along that line.
    const takesSky = fog.takesSkyColor && sky.isEnabled && !onGroundRelief;
    const color: Rgb = fog.color ?? sky.horizonColor;
    return {
      isOn: fog.isEnabled ? 1 : 0,
      // The settings state the density per kilometer, the shader per meter.
      densityPerMeter: length(fog.densityPerKilometer) / 1000,
      heightMeters: length(fog.heightMeters),
      startDistanceMeters: length(fog.startDistanceMeters),
      startSoftnessMeters: length(fog.startSoftnessMeters),
      maximumOpacity: zoomCurveValue(fog.maximumOpacity, zoom),
      color: [color[0], color[1], color[2]],
      skyGradient: takesSky ? skyGradientRadians : 0,
      datumShare: fog.heightsFromSeaLevel ? 1 : 0,
      baseAltitudeMeters: fog.heightsFromSeaLevel ? fog.baseAltitudeMeters : 0,
      veilsBuildings: fog.veilsBuildings ? 1 : 0,
    };
  },

  /** The air `share` of the way from `a` to `b`, every number alike. */
  mixAir(a: GroundFogAir, b: GroundFogAir, share: number): GroundFogAir {
    const t = Math.min(Math.max(share, 0), 1);
    const blend = (x: number, y: number): number => x + (y - x) * t;
    return {
      isOn: blend(a.isOn, b.isOn),
      densityPerMeter: blend(a.densityPerMeter, b.densityPerMeter),
      heightMeters: blend(a.heightMeters, b.heightMeters),
      startDistanceMeters: blend(a.startDistanceMeters, b.startDistanceMeters),
      startSoftnessMeters: blend(a.startSoftnessMeters, b.startSoftnessMeters),
      maximumOpacity: blend(a.maximumOpacity, b.maximumOpacity),
      color: [blend(a.color[0], b.color[0]), blend(a.color[1], b.color[1]), blend(a.color[2], b.color[2])],
      skyGradient: blend(a.skyGradient, b.skyGradient),
      datumShare: blend(a.datumShare, b.datumShare),
      baseAltitudeMeters: blend(a.baseAltitudeMeters, b.baseAltitudeMeters),
      veilsBuildings: blend(a.veilsBuildings, b.veilsBuildings),
    };
  },

  /**
   * The fog a frame draws with, every zoom curve read at the camera zoom.
   * Every length is in meters, and `worldUnitsPerMeter` turns the render
   * world into them. Only the plane is fogged, and on a map with the globe
   * the fog comes in over `morphFadeSpanShare` of the transition span past
   * the zoom the morph ends at. With an air over the mountains set, the
   * frame draws the air `mountainousness` of the way from the plain's to it.
   * `forBuildings` asks for the share of the fog that veils the buildings
   * and the models.
   */
  resolve(input: GroundFogResolveInput): GroundFogUniform {
    const { settings, zoom } = input;
    const onGroundRelief = input.onGroundRelief ?? false;
    const mountainousness = input.mountainousness ?? 0;
    const sky = settings.scene.fog;
    let air = GroundFogUniform.air(settings.scene.groundFog, sky, zoom, onGroundRelief);
    const mountainFog = settings.scene.mountainGroundFog;
    if (mountainFog !== null && mountainousness > 0) {
      air = GroundFogUniform.mixAir(air, GroundFogUniform.air(mountainFog, sky, zoom, onGroundRelief), Math.min(mountainousness, 1));
    }
    let strength = GroundFogUniform.morphFade(settings.presentation, zoom) * air.isOn;
    if (input.forBuildings === true) strength *= air.veilsBuildings;
    const maximumOpacity = Math.min(Math.max(air.maximumOpacity, 0), 1);
    const unitsPerMeter = input.worldUnitsPerMeter;
    if (input.renderSurfaceMode !== "flat" || !(strength > 0) || !(maximumOpacity > 0) || !(unitsPerMeter > 0) || !Number.isFinite(unitsPerMeter)) {
      return GroundFogUniform.disabled;
    }
    const eye = input.cameraEye;
    return {
      colorAndDensity: [air.color[0], air.color[1], air.color[2], air.densityPerMeter],
      eyeAndMetersPerUnit: [eye[0], eye[1], eye[2], 1 / unitsPerMeter],
      parameters: [Math.max(air.heightMeters, 1e-3), air.startDistanceMeters, maximumOpacity, strength],
      skyColorAndGradient: [sky.skyColor[0], sky.skyColor[1], sky.skyColor[2], air.skyGradient],
      startSoftness: [air.startSoftnessMeters, air.datumShare * (input.datumMetres ?? 0), air.baseAltitudeMeters, 0],
    };
  },

  /**
   * The frame's fog from the scene state, as the Swift
   * `GroundFogUniform.resolve(frameContext:)` builds it. The air reads the
   * planning zoom: over the terrain the camera's own zoom follows the ground
   * under the point it looks at, and the air is the same air whichever the
   * camera settles on. On the relief the plane's altitude is the datum, the
   * terrain under the point the camera looks at, and the air is mixed
   * toward the mountains' by how mountainous the country around reads.
   */
  resolveFrame(scene: SceneFrameState, forBuildings = false): GroundFogUniform {
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(scene.cameraFrame.mapCameraState.centerWorldMercator[1]);
    const onGroundRelief = scene.groundRelief?.isActive ?? false;
    return GroundFogUniform.resolve({
      settings: scene.settings,
      renderSurfaceMode: scene.presentation.renderSurfaceMode,
      cameraEye: scene.cameraFrame.cameraEye,
      worldUnitsPerMeter: ImmersiveMapProjection.worldUnitsPerMeter(latitude, scene.presentation.flatRenderState.renderMapSize),
      zoom: scene.cameraFrame.planningZoom,
      onGroundRelief,
      datumMetres: onGroundRelief ? (scene.groundRelief?.datumMetres ?? 0) : 0,
      mountainousness: scene.mountainousness ?? 0,
      forBuildings,
    });
  },

  /**
   * How much of the fog is in at a camera zoom, by the globe's morph: 1 on a
   * map without the globe, else a smoothstep from 0 at the zoom the morph
   * ends at to 1 a `morphFadeSpanShare` of its span on.
   */
  morphFade(presentation: PresentationSettings, zoom: number): number {
    if (!presentation.isGlobeEnabled) return 1;
    const span = Math.max(presentation.automaticTransitionSpan, 0);
    const planeZoom = presentation.automaticTransitionStartZoom + span;
    const width = Math.max(span * GroundFogUniform.morphFadeSpanShare, 1e-6);
    const t = Math.min(Math.max((zoom - planeZoom) / width, 0), 1);
    return t * t * (3 - 2 * t);
  },

  /** CPU mirror of the shader's `groundFogColor`: the fog's colour in a direction `elevation` radians above the horizon line. */
  color(uniform: GroundFogUniform, elevation: number): Vec3 {
    const [r, g, b] = uniform.colorAndDensity;
    const [sr, sg, sb, gradient] = uniform.skyColorAndGradient;
    if (!(gradient > 0) || !(elevation > 0)) return [r, g, b];
    const t = 1 - Math.exp(-elevation / gradient);
    return [r + (sr - r) * t, g + (sg - g) * t, b + (sb - b) * t];
  },

  /** Writes the uniform into `target` at float index `offset`, in the layout of `GroundFog` in ground-fog.wgsl. */
  write(target: Float32Array, offset: number, uniform: GroundFogUniform): void {
    target.set(uniform.colorAndDensity, offset);
    target.set(uniform.eyeAndMetersPerUnit, offset + 4);
    target.set(uniform.parameters, offset + 8);
    target.set(uniform.skyColorAndGradient, offset + 12);
    target.set(uniform.startSoftness, offset + 16);
  },
} as const;
