// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ViewMode } from "../camera/view-mode.ts";
import { type SceneSettings, shadowFarCoverageMeters, shadowNearCoverageMeters, shadowStrength } from "../configuration/scene-settings.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import { mat4Invert } from "../math/mat4-invert.ts";
import { type Mat4, Matrix, mat4Multiply } from "../math/matrix.ts";
import type { Vec2, Vec3 } from "../math/vec.ts";
import type { ShadowCascadeSlot } from "./shadow-cascade-atlas.ts";
import type { ShadowFrameState } from "./shadow-frame-state.ts";
import { type ShadowCascadeUniform, ShadowCascadeUniform as CascadeUniform, type ShadowUniform } from "./shadow-uniform.ts";

/**
 * Fits the directional light's camera and produces the frame's
 * `ShadowFrameState`, a port of the Swift `ShadowFrameStateResolver`. Pure
 * input to output, once a frame.
 *
 * There are two shadow windows, each fitted the same way to the ground the
 * camera sees inside a disc around it: the near one to
 * `nearCoverageMeters` at the camera zoom, sharp, and the far one to
 * `farCoverageMeters`, coarse, for the mountains casting across a valley
 * from beyond the near window. A disc's radius is metres on the ground by
 * the zoom, which does not depend on the pitch or the bearing. Shadows end
 * at the far window's radius (the near one's without a far window), and the
 * fade hides that edge. The far window is fitted only when its fade band
 * starts where the near window ends or beyond (`fadeStartShare`).
 *
 * Casters outside a disc are captured by extending the near plane towards
 * the light by `maxCasterHeight / L.z`: any caster occluding a receiver `r`
 * lies on the ray `r + t L`, which projects to the same light-space XY as `r`.
 *
 * The texel grid is stabilized so shadow edges do not crawl while the camera
 * moves: window sizes are quantized in steps of the square root of two, and
 * window centres snap to whole texels in pan-anchored coordinates, since
 * `flatRenderState.pan` re-centres the world around the camera every frame
 * and the grid has to translate with the map's content.
 *
 * Swift computes the frame in `Float` and the snap in `Double`. Every number
 * here is a JS double, which only adds precision: the uniforms are rounded
 * to f32 once, when they are written for the GPU.
 */

/**
 * The fitted window in pan-anchored light-space coordinates: the pieces that
 * stay glued to the map's content while the pan re-centres the world, so a
 * fit can outlive the frame it was computed on (`ShadowMapReuseController`).
 */
export interface ShadowCascadeAnchoredFit {
  readonly anchoredCenterX: number;
  readonly anchoredCenterY: number;
  /** Quantized square window side in world units. */
  readonly extent: number;
  /** The fitted depth window in pan-anchored light-space depth, the caster extension and the far slack included. */
  readonly anchoredNearDepth: number;
  readonly anchoredFarDepth: number;
}

/** A fitted window in pan-anchored form, with the inputs it is only valid for. */
export interface ShadowAnchoredFit {
  readonly lightDirection: Vec3;
  readonly mapResolution: number;
  readonly window: ShadowCascadeAnchoredFit;
}

export interface ShadowCascadeSpec {
  readonly radius: number;
  readonly maxCasterHeight: number;
}

/** One window's inputs: its spec and the visible ground it covers, in flat world XY, clamped to its radius. */
export interface ShadowCascadeInputs {
  readonly spec: ShadowCascadeSpec;
  readonly footprint: readonly Vec2[];
}

/** Everything the fit and the materialization derive from the frame, resolved once. */
export interface ShadowFitInputs {
  readonly lightDirection: Vec3;
  readonly lightView: Mat4;
  readonly cameraEye: Vec3;
  readonly unitsPerMeter: number;
  readonly mapResolution: number;
  readonly near: ShadowCascadeInputs;
  /** The far window, when its coverage reaches past the near one. */
  readonly far: ShadowCascadeInputs | undefined;
  /** How far the ground falls and rises about the plane, in world units: the relief's heights, `[0, 0]` without it. */
  readonly groundHeights: readonly [number, number];
  readonly normalOffsetTexels: number;
  readonly softness: number;
  readonly panShift: Vec3;
  readonly strength: number;
  readonly tint: Vec3;
}

export interface ShadowCascadeExtremes {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minDepth: number;
  readonly maxDepth: number;
}

/** What a frame's shadows are resolved from. */
export interface ShadowFrameInput {
  readonly renderSurfaceMode: ViewMode;
  /** The CPU camera matrix (not the GPU-adjusted one). */
  readonly projectionView: Mat4;
  readonly cameraEye: Vec3;
  readonly centerWorldMercator: Vec2;
  readonly flatRenderPan: Vec2;
  readonly renderMapSize: number;
  /** The relief's heights over the frame's datum, in world units, `undefined` on the plane. */
  readonly groundHeights?: readonly [number, number] | undefined;
  /** The zoom the strength and the coverages are read at. */
  readonly zoom: number;
  readonly scene: SceneSettings;
}

export interface MaterializedShadowWindow {
  readonly lightProjectionView: Mat4;
  readonly uniform: ShadowCascadeUniform;
}

const clamp = (value: number, lower: number, upper: number): number => Math.min(Math.max(value, lower), upper);

function cascadeOf(inputs: ShadowFitInputs, slot: ShadowCascadeSlot): ShadowCascadeInputs | undefined {
  return slot === "near" ? inputs.near : inputs.far;
}

/** Light-space pan projections: how the pan shift reads along each light-view axis. */
function panProjections(lightView: Mat4, panShift: Vec3): { x: number; y: number; depth: number } {
  const [px, py, pz] = panShift;
  return {
    x: lightView[0]! * px + lightView[4]! * py + lightView[8]! * pz,
    y: lightView[1]! * px + lightView[5]! * py + lightView[9]! * pz,
    // depth = -view.z, so the depth axis is the negated view-z row.
    depth: -(lightView[2]! * px + lightView[6]! * py + lightView[10]! * pz),
  };
}

function sameDirection(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export const ShadowFrameStateResolver = {
  /** Below this light elevation (z of the normalized direction) shadows are dropped. */
  minimumLightDirectionZ: 0.05,
  /** The range `ShadowSettings.maxCasterHeightMeters` is clamped to. */
  maxCasterHeightRange: Object.freeze([10, 500] as const),
  /** ...and never taller than this many window radii, so coverage means what it says at every zoom. */
  maxCasterHeightWindowRadii: 10,
  /** Constant receiver bias, in shadow-map texels of depth slope. */
  receiverBiasTexels: 1.0,
  /** Floor for the bias at near-vertical light, in texels of depth. */
  receiverBiasFloorTexels: 0.15,
  /** The range `ShadowSettings.normalOffsetTexels` is clamped to. */
  normalOffsetTexelsRange: Object.freeze([0, 8] as const),
  /** Grazing-wall cutoff of the geometric self-shadow test, in N.L, mirrored by shadow.wgsl. */
  geometricCutoffStart: 0.18,
  geometricCutoffEnd: 0.35,
  /** The range `ShadowSettings.softness` is clamped to: the tent's tap spread. */
  softnessRange: Object.freeze([1, 2.5] as const),
  /** Sampling-rectangle inset in texels: keeps the tent's taps inside the window at the widest spread. */
  uvInsetTexels: 4.0,
  mapResolutionRange: Object.freeze([256, 4096] as const),
  /** The range a coverage is clamped to, in metres. */
  coverageMetersRange: Object.freeze([5, 1_000_000] as const),
  /** Where a window's fade band starts, as a share of its radius. */
  fadeStartShare: 0.75,

  /** The window a frame asks for: a disc of `radiusMeters` on the ground, clamped, with the caster cap in world units. */
  windowSpec(radiusMeters: number, unitsPerMeter: number, maxCasterHeightMeters: number): ShadowCascadeSpec {
    const R = ShadowFrameStateResolver;
    const meters = Number.isFinite(radiusMeters) ? clamp(radiusMeters, R.coverageMetersRange[0], R.coverageMetersRange[1]) : R.coverageMetersRange[0];
    const radius = meters * unitsPerMeter;
    const limit = clamp(maxCasterHeightMeters, R.maxCasterHeightRange[0], R.maxCasterHeightRange[1]);
    return { radius, maxCasterHeight: Math.min(limit * unitsPerMeter, R.maxCasterHeightWindowRadii * radius) };
  },

  /** Where shadows finish fading out, and where the band before it starts: the outer quarter of the window's disc. */
  fadeDistances(farRadius: number): { start: number; end: number } {
    return { start: farRadius * ShadowFrameStateResolver.fadeStartShare, end: farRadius };
  },

  /** Whether a far window is worth fitting next to a near one: its band starts where the near window ends or beyond. */
  farWindowReaches(farRadius: number, nearRadius: number): boolean {
    return farRadius * ShadowFrameStateResolver.fadeStartShare >= nearRadius;
  },

  /** The frame's inputs, `undefined` when it has no shadows. */
  resolveInputs(input: ShadowFrameInput): ShadowFitInputs | undefined {
    const R = ShadowFrameStateResolver;
    const shadows = input.scene.shadows;
    const strength = shadowStrength(shadows, input.zoom);
    if (input.renderSurfaceMode !== "flat" || !shadows.isEnabled || !(strength > 0)) return undefined;

    const requested = input.scene.light.direction;
    const lengthSquared = requested[0] * requested[0] + requested[1] * requested[1] + requested[2] * requested[2];
    if (!(lengthSquared > 1e-8)) return undefined;
    const length = Math.sqrt(lengthSquared);
    const lightDirection: Vec3 = [requested[0] / length, requested[1] / length, requested[2] / length];
    if (!lightDirection.every(Number.isFinite) || lightDirection[2] < R.minimumLightDirectionZ) return undefined;

    const eye = input.cameraEye;
    const cameraDistance = Math.hypot(eye[0], eye[1], eye[2]);
    if (!(cameraDistance > 1e-4) || !Number.isFinite(cameraDistance)) return undefined;

    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(input.centerWorldMercator[1]);
    const unitsPerMeter = ImmersiveMapProjection.worldUnitsPerMeter(latitude, input.renderMapSize);
    if (!(unitsPerMeter > 0) || !Number.isFinite(unitsPerMeter)) return undefined;

    const mapResolution = clamp(Math.trunc(shadows.mapResolution), R.mapResolutionRange[0], R.mapResolutionRange[1]);

    // Anchored at the world origin: the basis and the translation depend on
    // the light alone, so light-space coordinates of fixed content stay
    // coherent from frame to frame for the texel snap.
    const up: Vec3 = Math.abs(lightDirection[2]) > 0.99 ? [0, 1, 0] : [0, 0, 1];
    const lightView = Matrix.lookAt(new Float64Array(16), lightDirection, [0, 0, 0], up);

    const nearSpec = R.windowSpec(shadowNearCoverageMeters(shadows, input.zoom), unitsPerMeter, shadows.maxCasterHeightMeters);
    const farSpec = R.windowSpec(shadowFarCoverageMeters(shadows, input.zoom), unitsPerMeter, shadows.maxCasterHeightMeters);

    const halfMapSize = input.renderMapSize * 0.5;
    const panShift: Vec3 = [input.flatRenderPan[0] * halfMapSize, -input.flatRenderPan[1] * halfMapSize, 0];

    const inverse = new Float64Array(16);
    if (!mat4Invert(inverse, input.projectionView)) return undefined;
    const nearFootprint = R.visibleGroundFootprint(inverse, eye, nearSpec.radius);
    if (nearFootprint.length === 0) return undefined;
    let far: ShadowCascadeInputs | undefined;
    if (R.farWindowReaches(farSpec.radius, nearSpec.radius)) {
      const farFootprint = R.visibleGroundFootprint(inverse, eye, farSpec.radius);
      if (farFootprint.length > 0) far = { spec: farSpec, footprint: farFootprint };
    }

    const heights = input.groundHeights;
    const groundHeights: readonly [number, number] = heights === undefined ? [0, 0] : [Math.min(heights[0], 0), Math.max(heights[1], 0)];
    const tint = shadows.tint;
    return {
      lightDirection,
      lightView,
      cameraEye: eye,
      unitsPerMeter,
      mapResolution,
      near: { spec: nearSpec, footprint: nearFootprint },
      far,
      groundHeights,
      normalOffsetTexels: clamp(shadows.normalOffsetTexels, R.normalOffsetTexelsRange[0], R.normalOffsetTexelsRange[1]),
      softness: clamp(shadows.softness, R.softnessRange[0], R.softnessRange[1]),
      panShift,
      strength,
      tint: [clamp(tint[0], 0, 1), clamp(tint[1], 0, 1), clamp(tint[2], 0, 1)],
    };
  },

  /** The frame's shadow state fitted exactly to the frame (no reuse margin). */
  resolve(input: ShadowFrameInput): ShadowFrameState | undefined {
    const R = ShadowFrameStateResolver;
    const inputs = R.resolveInputs(input);
    if (inputs === undefined) return undefined;
    const fits = new Map<ShadowCascadeSlot, ShadowAnchoredFit>();
    for (const slot of R.slots(inputs)) {
      const fit = R.resolveAnchoredFit(inputs, slot, 1.0);
      if (fit === undefined) {
        if (slot === "near") return undefined;
        continue;
      }
      fits.set(slot, fit);
    }
    return R.materialize(fits, inputs);
  },

  /** The windows the frame fits. */
  slots(inputs: ShadowFitInputs): ShadowCascadeSlot[] {
    return inputs.far === undefined ? ["near"] : ["near", "far"];
  },

  /**
   * The ground the camera can see, in flat world XY: corner and edge rays of
   * the view frustum intersected with z = 0, every point clamped to
   * `maxDistance` horizontally from the camera. A ray above the horizon takes
   * the coverage circle in the direction it was heading.
   */
  visibleGroundFootprint(inverseProjectionView: Mat4, cameraEye: Vec3, maxDistance: number): Vec2[] {
    if (!(maxDistance > 0) || !Number.isFinite(maxDistance)) return [];
    const cameraGround: Vec2 = [cameraEye[0], cameraEye[1]];
    const points: Vec2[] = [];
    // The NDC boundary, sampled rather than just cornered: clamping turns
    // the far edge into an arc, whose extremes are not at the corners.
    const samplesPerEdge = 4;
    const edges: [Vec2, Vec2][] = [
      [[-1, -1], [1, -1]],
      [[1, -1], [1, 1]],
      [[1, 1], [-1, 1]],
      [[-1, 1], [-1, -1]],
    ];
    for (const [from, to] of edges) {
      for (let step = 0; step < samplesPerEdge; step++) {
        const t = step / samplesPerEdge;
        const ndc: Vec2 = [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
        const ground = groundPoint(ndc, inverseProjectionView, cameraGround, maxDistance);
        if (ground !== undefined) points.push(ground);
      }
    }
    return points;
  },

  /** Raw light-space extremes of the receiver volume: the footprint at the ground and lifted to the caster cap. */
  cascadeExtremes(footprint: readonly Vec2[], maxCasterHeight: number, groundHeights: readonly [number, number], lightView: Mat4): ShadowCascadeExtremes | undefined {
    if (footprint.length === 0 || !(maxCasterHeight > 0) || !Number.isFinite(maxCasterHeight)) return undefined;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minDepth = Infinity;
    let maxDepth = -Infinity;
    const m = lightView;
    for (const [px, py] of footprint) {
      for (const z of [groundHeights[0], groundHeights[1] + maxCasterHeight]) {
        const vx = m[0]! * px + m[4]! * py + m[8]! * z + m[12]!;
        const vy = m[1]! * px + m[5]! * py + m[9]! * z + m[13]!;
        const vz = m[2]! * px + m[6]! * py + m[10]! * z + m[14]!;
        minX = Math.min(minX, vx);
        maxX = Math.max(maxX, vx);
        minY = Math.min(minY, vy);
        maxY = Math.max(maxY, vy);
        minDepth = Math.min(minDepth, -vz);
        maxDepth = Math.max(maxDepth, -vz);
      }
    }
    if (!(maxX - minX > 1e-6) || !(maxY - minY > 1e-6)) return undefined;
    if (![minX, maxX, minY, maxY, minDepth, maxDepth].every(Number.isFinite)) return undefined;
    return { minX, maxX, minY, maxY, minDepth, maxDepth };
  },

  /** The footprint inflated about the camera: the travel slack the reuse controller spends. */
  inflated(footprint: readonly Vec2[], cameraGround: Vec2, margin: number): readonly Vec2[] {
    if (margin === 1) return footprint;
    return footprint.map((p): Vec2 => [cameraGround[0] + (p[0] - cameraGround[0]) * margin, cameraGround[1] + (p[1] - cameraGround[1]) * margin]);
  },

  /**
   * Fits one window in pan-anchored form, `undefined` for a window the frame
   * has not got. `radiusMargin` inflates the receiver footprint before the
   * fit: the slack lets a rendered map live on while the camera travels.
   */
  /**
   * The slack a margined fit keeps on every side of its footprint, in world
   * units: the margin's share of the window's radius (10% of it at the reuse
   * controller's 1.1), none for a frame-exact fit. The camera may turn as far
   * as it may pan before the window is fitted again. Not in Swift, whose fit
   * scales the footprint about the camera alone (docs/STATUS.md, stage 4).
   */
  travelPadding(radius: number, radiusMargin: number): number {
    return Math.max(radiusMargin - 1, 0) * radius;
  },

  resolveAnchoredFit(inputs: ShadowFitInputs, slot: ShadowCascadeSlot, radiusMargin: number): ShadowAnchoredFit | undefined {
    const R = ShadowFrameStateResolver;
    const cascade = cascadeOf(inputs, slot);
    if (cascade === undefined) return undefined;
    const pan = panProjections(inputs.lightView, inputs.panShift);
    const cameraGround: Vec2 = [inputs.cameraEye[0], inputs.cameraEye[1]];
    const spec = cascade.spec;
    const inflatedExtremes = R.cascadeExtremes(R.inflated(cascade.footprint, cameraGround, radiusMargin), spec.maxCasterHeight, inputs.groundHeights, inputs.lightView);
    const exact = R.cascadeExtremes(cascade.footprint, spec.maxCasterHeight, inputs.groundHeights, inputs.lightView);
    if (inflatedExtremes === undefined || exact === undefined) return undefined;
    const extremes = { ...inflatedExtremes };
    // The depth planes take the exact footprint in too: inflated about the
    // camera, the point nearest the light can move away from it, and the
    // fit would not cover the very frame it was made for.
    const minDepth = Math.min(extremes.minDepth, exact.minDepth);
    const maxDepth = Math.max(extremes.maxDepth, exact.maxDepth);
    // The travel slack on every side, a share of the window's radius
    // (`travelPadding`): scaled about the camera alone, a footprint has
    // almost no slack across the view near the camera, and a turn of a
    // fraction of a degree left the window.
    const pad = R.travelPadding(spec.radius, radiusMargin);
    extremes.minX -= pad;
    extremes.maxX += pad;
    extremes.minY -= pad;
    extremes.maxY += pad;

    // Square window quantized in steps of the square root of two, with a
    // margin of the two 4-texel insets and a texel for the centre snap.
    const neededExtent = Math.max(extremes.maxX - extremes.minX, extremes.maxY - extremes.minY) * (1.0 + 10.0 / inputs.mapResolution);
    if (!(neededExtent > 0) || !Number.isFinite(neededExtent)) return undefined;
    const extent = 2 ** (Math.ceil(Math.log2(neededExtent) * 2.0) / 2.0);
    const texelWorldSize = extent / inputs.mapResolution;

    // The centre snapped to whole texels in pan-anchored space.
    const snap = (centre: number, panShiftLight: number): number => Math.round((centre - panShiftLight) / texelWorldSize) * texelWorldSize;
    const anchoredCenterX = snap((extremes.minX + extremes.maxX) * 0.5, pan.x);
    const anchoredCenterY = snap((extremes.minY + extremes.maxY) * 0.5, pan.y);

    // The depth planes keep the travel slack too: a zoom changes the caster
    // height's world units and a tilt the footprint's depths every frame.
    const near = minDepth - spec.maxCasterHeight / inputs.lightDirection[2] - pad;
    // Slack in proportion to the scale.
    const far = maxDepth + Math.max(0.01, 2.0 * texelWorldSize) + pad;
    return {
      lightDirection: inputs.lightDirection,
      mapResolution: inputs.mapResolution,
      window: { anchoredCenterX, anchoredCenterY, extent, anchoredNearDepth: near - pan.depth, anchoredFarDepth: far - pan.depth },
    };
  },

  /**
   * Whether a cached fit still serves the frame: the same light and
   * resolution, the receiver volume inside the fitted window (with the
   * inset the taps need), and the window no coarser than a fresh fit by more
   * than one quantization step.
   */
  fitCovers(fit: ShadowAnchoredFit, inputs: ShadowFitInputs, slot: ShadowCascadeSlot, radiusMargin: number): boolean {
    const R = ShadowFrameStateResolver;
    const cascade = cascadeOf(inputs, slot);
    if (cascade === undefined || !sameDirection(fit.lightDirection, inputs.lightDirection) || fit.mapResolution !== inputs.mapResolution) return false;
    const pan = panProjections(inputs.lightView, inputs.panShift);
    const resolution = fit.mapResolution;
    const spec = cascade.spec;
    const extremes = R.cascadeExtremes(cascade.footprint, spec.maxCasterHeight, inputs.groundHeights, inputs.lightView);
    if (extremes === undefined) return false;
    const window = fit.window;
    const texelWorldSize = window.extent / resolution;
    const usableHalfExtent = window.extent * 0.5 - (R.uvInsetTexels + 1.0) * texelWorldSize;
    const centerX = window.anchoredCenterX + pan.x;
    const centerY = window.anchoredCenterY + pan.y;
    if (
      extremes.minX < centerX - usableHalfExtent ||
      extremes.maxX > centerX + usableHalfExtent ||
      extremes.minY < centerY - usableHalfExtent ||
      extremes.maxY > centerY + usableHalfExtent
    ) {
      return false;
    }
    const near = window.anchoredNearDepth + pan.depth;
    const far = window.anchoredFarDepth + pan.depth;
    const requiredNear = extremes.minDepth - spec.maxCasterHeight / inputs.lightDirection[2];
    // The planes went through the pan-anchored form and back: a fit is held
    // to cover its own frame within that round trip's rounding, which Swift's
    // single-precision planes absorb by rounding both sides alike.
    const slack = 1e-9 * Math.max(1, Math.abs(near), Math.abs(far));
    if (requiredNear < near - slack || extremes.maxDepth > far + slack) return false;
    const pad = R.travelPadding(spec.radius, radiusMargin);
    const neededExtent = (Math.max(extremes.maxX - extremes.minX, extremes.maxY - extremes.minY) * radiusMargin + 2 * pad) * (1.0 + 10.0 / resolution);
    return window.extent <= neededExtent * Math.SQRT2 * 1.001;
  },

  /**
   * The frame's world-space matrices and sampling uniform rebuilt from the
   * windows' pan-anchored fits (the near one required). A far window without
   * a fit is disabled in the uniform and the near window's fade ends the shadows.
   */
  materialize(fits: ReadonlyMap<ShadowCascadeSlot, ShadowAnchoredFit>, inputs: ShadowFitInputs): ShadowFrameState | undefined {
    const R = ShadowFrameStateResolver;
    const nearFit = fits.get("near");
    if (nearFit === undefined) return undefined;
    const near = R.materializeWindow(nearFit, inputs, inputs.near);
    if (near === undefined) return undefined;
    let far: MaterializedShadowWindow | undefined;
    const farFit = fits.get("far");
    if (inputs.far !== undefined && farFit !== undefined) far = R.materializeWindow(farFit, inputs, inputs.far);
    const shadowUniform: ShadowUniform = {
      near: near.uniform,
      far: far?.uniform ?? CascadeUniform.disabled,
      eye: inputs.cameraEye,
      strength: inputs.strength,
      lightDirection: inputs.lightDirection,
      tint: inputs.tint,
      // The footprints are clamped to circles around the camera, the only
      // window edges a viewer can reach: the fades are measured from there.
      fadeCenter: [inputs.cameraEye[0], inputs.cameraEye[1]],
    };
    return { lightProjectionView: near.lightProjectionView, farLightProjectionView: far?.lightProjectionView, shadowUniform, mapResolution: nearFit.mapResolution };
  },

  /** One window materialized: its light matrix for the caster pass and its sampling parameters. */
  materializeWindow(fit: ShadowAnchoredFit, inputs: ShadowFitInputs, cascade: ShadowCascadeInputs): MaterializedShadowWindow | undefined {
    const R = ShadowFrameStateResolver;
    if (!sameDirection(fit.lightDirection, inputs.lightDirection) || fit.mapResolution !== inputs.mapResolution) return undefined;
    const pan = panProjections(inputs.lightView, inputs.panShift);
    const resolution = fit.mapResolution;
    const window = fit.window;
    const extent = window.extent;
    const texelWorldSize = extent / resolution;
    const centerX = window.anchoredCenterX + pan.x;
    const centerY = window.anchoredCenterY + pan.y;
    const halfExtent = extent * 0.5;
    const near = window.anchoredNearDepth + pan.depth;
    const far = window.anchoredFarDepth + pan.depth;

    const lightProjection = Matrix.metalOrthographicMatrix(new Float64Array(16), centerX - halfExtent, centerX + halfExtent, centerY - halfExtent, centerY + halfExtent, near, far);
    const lightProjectionView = mat4Multiply(new Float64Array(16), lightProjection, inputs.lightView);

    // NDC to the shadow map: u = 0.5x + 0.5, v = -0.5y + 0.5 (the texture's
    // origin is top-left), z passed through as the comparison depth.
    const uvBias = new Float64Array([0.5, 0, 0, 0, 0, -0.5, 0, 0, 0, 0, 1, 0, 0.5, 0.5, 0, 1]);

    // The receiver bias, normalized by the depth window and scaled by the
    // steeper of the two slopes the light makes with the ground.
    const depthWindow = Math.max(far - near, 1e-6);
    const light = inputs.lightDirection;
    const horizontalSlope = Math.hypot(light[0], light[1]) / light[2];
    const steepestSlope = Math.max(horizontalSlope, 1.0 / Math.max(horizontalSlope, 1e-3));
    const depthBias = ((R.receiverBiasTexels * Math.min(steepestSlope, 2.0) + R.receiverBiasFloorTexels) * texelWorldSize) / depthWindow;

    const texel = 1.0 / resolution;
    const inset = R.uvInsetTexels * texel;
    const fade = R.fadeDistances(cascade.spec.radius);
    return {
      lightProjectionView,
      uniform: {
        worldToShadowTexture: mat4Multiply(new Float64Array(16), uvBias, lightProjectionView),
        tentSpread: inputs.softness,
        fadeStartDistance: fade.start,
        depthBias,
        fadeEndDistance: fade.end,
        uvMinimum: [inset, inset],
        uvMaximum: [1 - inset, 1 - inset],
        normalOffsetWorld: inputs.normalOffsetTexels * texelWorldSize,
        texelSizeUV: [texel, texel],
      },
    };
  },
} as const;

/** One NDC point's ground position, clamped into the coverage circle. */
function groundPoint(ndc: Vec2, inverseProjectionView: Mat4, cameraGround: Vec2, maxDistance: number): Vec2 | undefined {
  const m = inverseProjectionView;
  const unproject = (depth: number): Vec3 | undefined => {
    const x = m[0]! * ndc[0] + m[4]! * ndc[1] + m[8]! * depth + m[12]!;
    const y = m[1]! * ndc[0] + m[5]! * ndc[1] + m[9]! * depth + m[13]!;
    const z = m[2]! * ndc[0] + m[6]! * ndc[1] + m[10]! * depth + m[14]!;
    const w = m[3]! * ndc[0] + m[7]! * ndc[1] + m[11]! * depth + m[15]!;
    if (!(Math.abs(w) > 1e-9)) return undefined;
    return [x / w, y / w, z / w];
  };
  const near = unproject(0);
  const far = unproject(1);
  if (near === undefined || far === undefined) return undefined;
  const dx = far[0] - near[0];
  const dy = far[1] - near[1];
  const dz = far[2] - near[2];
  const horizontal = Math.hypot(dx, dy);
  if (!(horizontal * horizontal > 1e-20)) return undefined;
  let hit: [number, number] = [cameraGround[0] + (dx / horizontal) * maxDistance, cameraGround[1] + (dy / horizontal) * maxDistance];
  if (Math.abs(dz) > 1e-9) {
    const t = -near[2] / dz;
    if (t > 0 && t <= 1) hit = [near[0] + dx * t, near[1] + dy * t];
  }
  const ox = hit[0] - cameraGround[0];
  const oy = hit[1] - cameraGround[1];
  const distance = Math.hypot(ox, oy);
  if (distance > maxDistance && distance > 1e-9) hit = [cameraGround[0] + ox * (maxDistance / distance), cameraGround[1] + oy * (maxDistance / distance)];
  if (!Number.isFinite(hit[0]) || !Number.isFinite(hit[1])) return undefined;
  return hit;
}
