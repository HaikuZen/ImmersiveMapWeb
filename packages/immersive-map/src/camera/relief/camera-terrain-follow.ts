// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { ImmersiveMapProjection } from "../../geo/immersive-map-projection.ts";
import type { ClosedRange } from "../../math/closed-range.ts";
import type { Vec2 } from "../../math/vec.ts";

/**
 * The camera's relief (`camera/relief`). The camera over a terrain: the
 * point it looks at lies on the terrain, raised by the terrain under it, so
 * a zoom closes in on the ground and the camera turns about a point on it. A
 * pan moves the eye over the map and keeps its altitude, and the point is
 * where its view ray meets the relief: the zoom, the arm to the point, takes
 * up the terrain's rise and fall (`CameraStateController.followTerrain`). A
 * zoom moves the eye along the ray and finds the point the same way
 * (`CameraStateController.followTerrainZoom`), so a crossing onto another
 * terrain map moves the point, not the eye. The eye rises only where the
 * terrain under the point, or under the eye itself, would otherwise come
 * nearer than the clearance.
 *
 * The render world scales with the zoom (`PresentationStateResolver`) and
 * the eye sits about one unit from the point it looks at
 * (`RenderCameraPoseResolver`), so where the eye stands in metres is a
 * function of the zoom, the pitch, the bearing and the latitude: what the
 * pan and the zoom's limit are solved from.
 *
 * Ported with the camera state controller, which reads it. The relief that
 * builds one (the terrain store and its heights) is a later stage.
 */
export class CameraTerrainFollow {
  /**
   * The terrain's height in metres under a point of the world (normalized
   * world Mercator), as drawn (the exaggeration in it), null where it is not
   * known yet.
   */
  readonly terrainMetres: (point: Vec2) => number | null;
  /**
   * The height the eye keeps over a ridge under it, the terrain between the
   * eye and the point that rises over the point (`clearanceMargin`).
   */
  readonly clearanceMetres: number;
  /** `PresentationSettings.globeRadiusScale`, the render world's scale. */
  readonly globeRadiusScale: number;
  /**
   * One texel of the terrain the camera reads, in normalized world units: the
   * step the view ray is marched by (`CameraStateController`), so a ridge is
   * found or not by the eye's place alone, never by the zoom's. Zero where
   * unknown, which marches finely anyway.
   */
  readonly sampleStepWorld: number;

  constructor(init: {
    readonly terrainMetres: (point: Vec2) => number | null;
    readonly clearanceMetres: number;
    readonly globeRadiusScale: number;
    readonly sampleStepWorld?: number;
  }) {
    this.terrainMetres = init.terrainMetres;
    this.clearanceMetres = init.clearanceMetres;
    this.globeRadiusScale = init.globeRadiusScale;
    this.sampleStepWorld = init.sampleStepWorld ?? 0;
  }

  /**
   * The margin the eye keeps over the terrain under it, by how far that
   * terrain rises over the point the eye looks at: nothing where it lies
   * level with the point or under it, so the eye comes down on the point as
   * far as the zoom's own limit lets it, growing smoothly to the clearance
   * over a ridge a clearance higher than the point.
   */
  static clearanceMargin(rise: number, clearance: number): number {
    if (!(clearance > 0) || !(rise > 0)) {
      return 0;
    }
    const t = Math.min(rise / clearance, 1);
    return clearance * t * t * (3 - 2 * t);
  }

  /** The eye's height in metres over the point it looks at, for a pose on the flat map. */
  eyeHeightMetres(zoom: number, pitch: number, latitude: number): number {
    return CameraTerrainFollow.eyeDistanceMetres(zoom, latitude, this.globeRadiusScale) * Math.cos(pitch);
  }

  /** How far the eye stands from the point it looks at along the ground, in metres, for a pose on the flat map. */
  eyeReachMetres(zoom: number, pitch: number, latitude: number): number {
    return CameraTerrainFollow.eyeDistanceMetres(zoom, latitude, this.globeRadiusScale) * Math.sin(pitch);
  }

  /**
   * Where the eye stands on the ground, in normalized world Mercator, for a
   * pose on the flat map looking at `center`: behind it along the bearing by
   * the reach of the pose.
   */
  eyeGround(center: Vec2, zoom: number, pitch: number, bearing: number, latitude: number): Vec2 {
    const metresPerWorld = ImmersiveMapProjection.earthCircumferenceMeters * Math.max(Math.cos(latitude), 1e-6);
    const forward = CameraTerrainFollow.forward(bearing);
    const reach = this.eyeReachMetres(zoom, pitch, latitude) / metresPerWorld;
    return [center[0] - forward[0] * reach, center[1] - forward[1] * reach];
  }

  /**
   * The zoom at which the eye stands `metres` over the point it looks at,
   * within `range`: the height falls with the zoom without a step, so the
   * zoom is found by bisection. The answer is the side of the last halving
   * whose height is not under `metres`: a zoom read for a clearance clears
   * it, instead of missing it by the float.
   */
  zoomForEyeHeightMetres(metres: number, pitch: number, latitude: number, range: ClosedRange): number {
    let low = range.lowerBound;
    let high = range.upperBound;
    if (!(this.eyeHeightMetres(low, pitch, latitude) > metres)) {
      return low;
    }
    if (!(this.eyeHeightMetres(high, pitch, latitude) < metres)) {
      return high;
    }
    for (let iteration = 0; iteration < 40; iteration++) {
      const middle = (low + high) * 0.5;
      if (this.eyeHeightMetres(middle, pitch, latitude) > metres) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return low;
  }

  /**
   * Whether the eye of the pose keeps its margin over the terrain under
   * itself (`clearanceMargin`). The point is on the terrain, so the eye
   * stands the pose's height over it, plus the terrain's height over the
   * plane. Terrain not known yet counts as the plane: nothing stops a zoom
   * over ground that has not arrived.
   */
  isClear(center: Vec2, zoom: number, pitch: number, bearing: number): boolean {
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(center[1]);
    const height = this.eyeHeightMetres(zoom, pitch, latitude);
    const ground = this.eyeGround(center, zoom, pitch, bearing, latitude);
    const rise = (this.terrainMetres(ground) ?? 0) - (this.terrainMetres(center) ?? 0);
    return height >= rise + CameraTerrainFollow.clearanceMargin(rise, this.clearanceMetres);
  }

  /**
   * `zoom` where the eye keeps the clearance there, else the zoom below it
   * in `range` where it does: the eye backs off along its view ray, by the
   * arm, until it clears the terrain under it. A zoom deeper than `zoom` is
   * never answered, though the eye might be clear there too, in front of a
   * ridge: the zoom would pass through the ridge on its way. The zoom is read
   * off the terrain straight: the height the eye needs over the point is the
   * ridge's rise over the point plus the margin, and the zoom is the one with
   * that height. Backing off moves the eye over other ground, so the reading
   * is taken again from there, a few times, each time only ever lower. Never
   * a bisection over the zoom: the ground under a backing eye is not
   * monotone, over a crest it rises and then falls, and a bisection settles
   * on any of several boundaries, a different one from frame to frame.
   */
  clearZoom(zoom: number, center: Vec2, pitch: number, bearing: number, range: ClosedRange): number {
    let cleared = Math.min(Math.max(zoom, range.lowerBound), range.upperBound);
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(center[1]);
    const pointMetres = this.terrainMetres(center) ?? 0;
    for (let iteration = 0; iteration < 4; iteration++) {
      const height = this.eyeHeightMetres(cleared, pitch, latitude);
      const ground = this.eyeGround(center, cleared, pitch, bearing, latitude);
      const rise = (this.terrainMetres(ground) ?? 0) - pointMetres;
      const needed = rise + CameraTerrainFollow.clearanceMargin(rise, this.clearanceMetres);
      if (!(height < needed)) {
        return cleared;
      }
      const lower = this.zoomForEyeHeightMetres(needed, pitch, latitude, range);
      if (!(lower < cleared)) {
        return cleared;
      }
      cleared = lower;
    }
    return cleared;
  }

  /**
   * The eye's distance from the point it looks at, in metres: the pose's
   * distance in render units (`RenderCameraPoseResolver`, the flat map's
   * proximity being 1) over the render units a metre spans at the latitude,
   * the world being `2^floor(zoom)` times its base scale
   * (`PresentationStateResolver`).
   */
  static eyeDistanceMetres(zoom: number, latitude: number, globeRadiusScale: number): number {
    const fraction = zoom % 1.0;
    const distanceUnits = 1.0 - fraction * 0.5;
    const renderMapSize = 2.0 * Math.PI * globeRadiusScale * 2.0 ** Math.floor(zoom);
    const unitsPerMetre = ImmersiveMapProjection.worldUnitsPerMeter(latitude, renderMapSize);
    return distanceUnits / unitsPerMetre;
  }

  /** The direction the camera looks along the ground, in normalized world Mercator (x east, y south), for a bearing. */
  static forward(bearing: number): Vec2 {
    return [-Math.sin(bearing), -Math.cos(bearing)];
  }
}
