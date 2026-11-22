// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ViewMode } from "../camera/view-mode.ts";
import type { Rgba } from "../configuration/color.ts";
import type { ImmersiveMapSettings } from "../configuration/immersive-map-settings.ts";
import { airHandover, type PresentationSettings } from "../configuration/presentation-settings.ts";
import { zoomCurveValue } from "../configuration/zoom-curve.ts";
import { GlobeSunDirection } from "../globe/globe-sun-direction.ts";
import type { GlobeUniform } from "../globe/globe-uniform.ts";
import { mat4Invert } from "../math/mat4-invert.ts";
import type { Mat4 } from "../math/matrix.ts";
import type { Vec3 } from "../math/vec.ts";
import { type HorizonEdge, HorizonEdgeMath } from "./horizon-edge-math.ts";

/**
 * What the horizon layer paints this frame, resolved once on the CPU from
 * the settings, the transition and the camera (the Swift `HorizonHaze`).
 * Three things share the edge:
 *
 * - **The atmosphere**, the globe's: a dense band hugging the limb, a wide
 *   faint glow into space, a whitening at the edge, and a narrow rim
 *   decaying inward over the surface. Optional (`AtmosphereSettings`).
 * - **The limb feather**, always on the sphere: a glow a couple of pixels
 *   wide across the analytic limb, half over the mesh edge and half over
 *   space, which hides the tile mesh's chord polygon and the staircase of
 *   the silhouette. Sized in pixels, so it is the same at every zoom.
 * - **The sky**, the flat map's (`FogSettings`): above the horizon line, a
 *   glow of the horizon colour at the line decaying into the sky colour
 *   over a few degrees. Nothing is painted on the ground: the far ground is
 *   the ground fog's (`GroundFogSettings`), drawn by the shaders of what
 *   stands on the map. With the fog off nothing is painted above the line
 *   either.
 *
 * The resting globe wears the first two, and so does the unrolling surface:
 * its edge is the limb of the growing sphere the unroll keeps the surface on
 * (`HorizonEdgeMath`), and the halo rides it, thinning on its own as that
 * limb recedes. Over the air handover (`PresentationSettings.airHandoverStart`
 * to `airHandoverEnd`) the atmosphere and the feather fade out while the flat
 * map's sky fades in under them, so one frame carries both at their shares.
 */
export interface HorizonHaze {
  readonly edge: HorizonEdge;
  /** The current sphere's centre, for the sun's side of the limb. */
  readonly center: Vec3;
  readonly light: Vec3;
  readonly sunInfluence: number;
  readonly skyStrength: number;
  readonly tint: Vec3;
  readonly whitenWeight: number;
  readonly featherStrength: number;
  readonly bandRadians: number;
  readonly glowRadians: number;
  readonly whitenRadians: number;
  readonly featherRadians: number;
  readonly groundBandRadians: number;
  readonly groundGain: number;
  readonly cutoffStartRadians: number;
  readonly cutoffEndRadians: number;
  /** The plane's sky colour away from the line. `tint` is its colour at the line. */
  readonly skyColor: Vec3;
  /** How much of the plane's sky gradient is painted over what nothing painted: 0 on the globe, 1 on the plane with the fog on. */
  readonly skyOpacity: number;
  /** The e-fold width, radians above the line, of the glow of the tint the sky decays out of into the sky colour. */
  readonly skyGradientRadians: number;
  /** Whether the sky-side draw (pixels nothing painted) runs this frame. */
  readonly drawsSky: boolean;
  /** Whether the ground-side draw (painted pixels) runs this frame. */
  readonly drawsGround: boolean;
  /**
   * The band's top station, radians above the edge: where the halo has
   * decayed on the globe, the frame's highest corner plus a margin on the
   * plane, whose sky is opaque all the way up.
   */
  readonly bandTopRadians: number;
}

/** What one frame resolves the haze from. */
export interface HorizonFrameInputs {
  readonly settings: ImmersiveMapSettings;
  /** The style's map colour (`ImmersiveMapBaseColors.map`). */
  readonly mapColor: Rgba;
  /** The semantic transition, the handover's clock. */
  readonly transition: number;
  /** The camera zoom, the halo thickness curve's clock. */
  readonly zoom: number;
  /** The geometry transition and the resting radius. */
  readonly globe: GlobeUniform;
  readonly renderSurfaceMode: ViewMode;
  readonly cameraEye: Vec3;
  /** The CPU projection-view (`FrameCameraMatrices.projectionView`). */
  readonly projectionView: Mat4;
  /** The render camera's vertical field of view, which with the drawable height sizes the feather in pixels. */
  readonly verticalFovRadians: number;
  readonly drawableHeightPx: number;
}

const inverseScratch: Mat4 = new Float64Array(16);

/**
 * The `horizon` folder: the CPU-side model of the surface's visible edge and
 * the air painted around it, the maths and the per-frame decisions, with the
 * shader's edge angle mirrored so tests agree with the picture, and the band
 * mesh, the pipeline, the uniform and the shader that draw it. No tile or
 * style logic, no camera controllers or UI. A port of the Swift
 * `HorizonFrameResolver`.
 */
export const HorizonFrameResolver = {
  /**
   * The atmosphere's widths, in radii of the resting planet, seen from the
   * eye as angle at the limb: the shell is a fixed fraction of the planet,
   * thin from far away, wide when the eye is low over it.
   */
  haloBandRadii: 0.075,
  haloGlowRadii: 0.34,
  haloWhitenRadii: 0.018,
  haloRimRadii: 0.025,
  haloWhitenWeight: 0.5,
  /** The rim over the surface fades out between these many rim widths under the limb and is exactly zero past the second. */
  rimCutoffStartWidths: 3,
  rimCutoffEndWidths: 6,
  /** An eye almost touching the sphere would otherwise blow the halo up to the whole sky. */
  maximumHaloRadians: (45 * Math.PI) / 180,
  /** The e-fold width, radians above the line, of the plane's horizon glow. */
  skyGradientRadians: (2.5 * Math.PI) / 180,
  /** How far past the frame's highest corner the plane's band reaches, so the sky never ends inside the frame. */
  bandTopMarginRadians: (5 * Math.PI) / 180,
  /** The globe's band ends where the glow has decayed to under a percent. */
  bandTopGlowWidths: 5,
  /** The limb feather: its e-fold width in pixels and its peak coverage. */
  featherPixels: 1.5,
  featherPeakStrength: 0.85,
  /** Widths are e-fold denominators in the shader: a zero would divide. */
  minimumRadians: 1e-4,

  /** How much of the atmosphere is left: 1 on the resting globe and up to the air handover, 0 from its end on and on the plane. */
  atmosphereFade(transition: number, presentation: PresentationSettings, renderSurfaceMode: ViewMode): number {
    if (renderSurfaceMode !== "spherical") return 0;
    return 1 - airHandover(presentation, transition);
  },

  /** How much of the flat map's sky is in: 0 up to the air handover, 1 from its end on and on the plane. The two fades sum to one. */
  fogFade(transition: number, presentation: PresentationSettings, renderSurfaceMode: ViewMode): number {
    if (renderSurfaceMode !== "spherical") return 1;
    return airHandover(presentation, transition);
  },

  resolve(input: HorizonFrameInputs): HorizonHaze {
    const R = HorizonFrameResolver;
    const { settings, renderSurfaceMode, cameraEye, globe } = input;
    const atmosphere = settings.scene.atmosphere;
    const isOn = atmosphere.isEnabled;
    const fog = settings.scene.fog;
    const radius = Math.max(globe.radius, 1e-6);
    const curvature = renderSurfaceMode === "spherical" ? Math.max(1 - Math.min(Math.max(globe.transition, 0), 1), 0) / radius : 0;
    const edge = HorizonEdgeMath.edge(cameraEye, curvature);
    const presentation = settings.presentation;
    const atmosphereFade = R.atmosphereFade(input.transition, presentation, renderSurfaceMode);
    const fogFade = R.fogFade(input.transition, presentation, renderSurfaceMode);
    // The halo's width at the camera zoom, floored: a shell of nothing would
    // put the feather and the rim at the same angle.
    const thickness = Math.max(zoomCurveValue(atmosphere.thickness, input.zoom), 0.05);
    const intensity = Math.max(atmosphere.intensity, 0);

    // A shell of `radii` planet radii subtends `radii * R / limbDistance` at
    // the limb. The plane's infinite limb distance gives zero.
    const haloRadians = (radii: number): number => Math.max(Math.min((radii * radius * thickness) / edge.limbDistance, R.maximumHaloRadians), R.minimumRadians);

    const clearColor: Vec3 = [input.mapColor[0], input.mapColor[1], input.mapColor[2]];
    const planeTint = fog.isEnabled ? fog.horizonColor : clearColor;
    const globeTint = isOn ? atmosphere.color : clearColor;
    // The colour at the edge, the halo's turning into the sky's at the line
    // through the handover, so the two meet in one colour.
    const tint: Vec3 = [
      globeTint[0] + (planeTint[0] - globeTint[0]) * fogFade,
      globeTint[1] + (planeTint[1] - globeTint[1]) * fogFade,
      globeTint[2] + (planeTint[2] - globeTint[2]) * fogFade,
    ];

    if (!mat4Invert(inverseScratch, input.projectionView)) inverseScratch.fill(0);
    // The ground side is the globe's alone: the rim of the atmosphere and
    // the limb feather, both fading out through the handover.
    const rimRadians = haloRadians(R.haloRimRadii);
    const featherRadians = Math.max((R.featherPixels * input.verticalFovRadians) / Math.max(input.drawableHeightPx, 1), R.minimumRadians);
    const featherStrength = R.featherPeakStrength * atmosphereFade;
    const groundGain = (isOn ? intensity : 0) * atmosphereFade;
    const groundBandRadians = Math.max(rimRadians, R.minimumRadians);
    const cutoffStartRadians = Math.max(rimRadians * R.rimCutoffStartWidths, R.minimumRadians);
    const cutoffEndRadians = Math.max(rimRadians * R.rimCutoffEndWidths, R.minimumRadians);
    const skyOpacity = fog.isEnabled ? fogFade : 0;

    // The sun the halo brightens toward: the globe's, fixed over its
    // subsolar point and turned with the globe, the flat map's static sun
    // with the globe's light off.
    const globeLight = settings.scene.globeLight;
    const lightDirection = globeLight.isEnabled ? GlobeSunDirection.sunWorldDirection(globeLight, globe) : settings.scene.light.direction;
    const lightLength = Math.hypot(lightDirection[0], lightDirection[1], lightDirection[2]);
    const light: Vec3 = lightLength * lightLength > 1e-12 ? [lightDirection[0] / lightLength, lightDirection[1] / lightLength, lightDirection[2] / lightLength] : [0, 0, 1];

    const reach = Math.max(cutoffEndRadians, featherRadians * 4);
    const cornerAngles = HorizonEdgeMath.cornerDirections(inverseScratch, cameraEye).map((d) => HorizonEdgeMath.angleAboveEdge(d, edge));
    const edgeWithinReach = cornerAngles.some((a) => a >= -reach);
    // The band's top: the plane's sky is opaque to the top of the frame, the
    // globe's halo is done a few glow widths up, a frame of the handover
    // carries both.
    const frameTop = Math.max(...cornerAngles) + R.bandTopMarginRadians;
    const haloTop = haloRadians(R.haloGlowRadii) * R.bandTopGlowWidths;
    const bandTopRadians = skyOpacity > 0 ? Math.max(frameTop, R.skyGradientRadians * R.bandTopGlowWidths, haloTop) : haloTop;
    // Transparent space keeps the sphere unpainted around the planet: no
    // halo there, and the plane's sky arrives with the fade only.
    const transparent = settings.scene.space.isTransparent;
    const drawsHalo = renderSurfaceMode === "spherical" && !transparent && atmosphereFade > 0;
    const haloShare = transparent ? 0 : atmosphereFade;
    const drawsSky = edgeWithinReach && (drawsHalo || skyOpacity > 0);
    const drawsGround = edgeWithinReach && (groundGain > 0 || featherStrength > 0);

    return {
      edge,
      center: curvature > 0 ? [0, 0, -1 / curvature] : [0, 0, -1e6],
      light,
      sunInfluence: isOn ? Math.min(Math.max(atmosphere.sunInfluence, 0), 1) * haloShare : 0,
      skyStrength: isOn ? intensity * haloShare : 0,
      tint,
      whitenWeight: isOn ? R.haloWhitenWeight * atmosphereFade : 0,
      featherStrength,
      bandRadians: haloRadians(R.haloBandRadii),
      glowRadians: haloRadians(R.haloGlowRadii),
      whitenRadians: haloRadians(R.haloWhitenRadii),
      featherRadians,
      groundBandRadians,
      groundGain,
      cutoffStartRadians,
      cutoffEndRadians,
      skyColor: fog.skyColor,
      skyOpacity,
      skyGradientRadians: R.skyGradientRadians,
      drawsSky,
      drawsGround,
      bandTopRadians,
    };
  },

  /**
   * CPU mirror of the shader's ground-side profile (`horizonGroundProfile`),
   * before the feather: how much haze covers a painted pixel this far below
   * the edge.
   */
  groundProfile(belowRadians: number, haze: HorizonHaze): number {
    const amount = Math.min(Math.max(Math.exp(-belowRadians / haze.groundBandRadians) * haze.groundGain, 0), 1);
    const t = Math.min(Math.max((belowRadians - haze.cutoffStartRadians) / Math.max(haze.cutoffEndRadians - haze.cutoffStartRadians, 1e-6), 0), 1);
    return amount * (1 - t * t * (3 - 2 * t));
  },
} as const;

/**
 * The horizon band, a port of the Swift `HorizonBandMath`: the CPU mirror of
 * `horizonBandStationAngle` in horizon.wgsl, the angles above the edge the
 * band's vertices sit at. The band is strung between the rim's far cutoff
 * under the edge and the top the resolver chose, with the edge itself a
 * station and one either side of it at least four feather widths out, so
 * the feather's ramp gets its own quads. A running maximum keeps the
 * stations in order whatever the widths, and every station stays on the
 * sphere of directions: low over the planet the glow reaches its 45 degree
 * cap, and five of those would carry the outer station past the zenith.
 */
export const HorizonBandMath = {
  stationCount: 8,
  /** How many azimuths the band is split into around the local vertical. */
  segmentCount: 128,

  stationAngles(haze: HorizonHaze): number[] {
    const feather = haze.featherRadians * 4;
    const raw = [
      -haze.cutoffEndRadians,
      -haze.cutoffStartRadians,
      -Math.max(haze.groundBandRadians, feather),
      0,
      Math.max(haze.bandRadians, feather),
      haze.bandRadians * 3,
      haze.glowRadians,
      haze.bandTopRadians,
    ];
    const limit = Math.PI / 2 - 1e-3;
    const angles: number[] = [];
    let running = raw[0]!;
    for (const angle of raw) {
      running = Math.max(running, angle);
      angles.push(Math.min(Math.max(running, haze.edge.depression - limit), haze.edge.depression + limit));
    }
    return angles;
  },

  /**
   * The static band geometry (the Swift `HorizonBandMesh`): a grid of
   * azimuths about the eye's local vertical by stations. Every vertex is
   * only the pair `(azimuth, station)`, and the vertex shader turns it into
   * a direction from the frame's edge, so nothing here changes per frame.
   */
  mesh(): { vertices: Float32Array; indices: Uint16Array } {
    const segments = HorizonBandMath.segmentCount;
    const stations = HorizonBandMath.stationCount;
    const vertices = new Float32Array(segments * stations * 2);
    let v = 0;
    for (let segment = 0; segment < segments; segment++) {
      const azimuth = (segment / segments) * 2 * Math.PI;
      for (let station = 0; station < stations; station++) {
        vertices[v++] = azimuth;
        vertices[v++] = station;
      }
    }
    const indices = new Uint16Array(segments * (stations - 1) * 6);
    let i = 0;
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment + 1) % segments;
      for (let station = 0; station < stations - 1; station++) {
        const a = segment * stations + station;
        const b = next * stations + station;
        const c = next * stations + station + 1;
        const d = segment * stations + station + 1;
        indices.set([a, b, c, a, c, d], i);
        i += 6;
      }
    }
    return { vertices, indices };
  },
} as const;
