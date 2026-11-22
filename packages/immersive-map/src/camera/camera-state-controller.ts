// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type CameraSettings, clampPitch, clampZoom } from "../configuration/camera-settings.ts";
import { ImmersiveMapProjection } from "../geo/immersive-map-projection.ts";
import type { ClosedRange } from "../math/closed-range.ts";
import type { Vec2 } from "../math/vec.ts";
import { CameraBoundsConstraint } from "./camera-bounds-constraint.ts";
import type { CameraBearingConstraint, CameraPitchConstraint } from "./camera-constraint-resolver.ts";
import { GlobeCameraProximity } from "./globe-camera-proximity.ts";
import type { ImmersiveMapCameraPosition } from "./immersive-map-camera-position.ts";
import { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";
import { PinchZoomMath } from "./pinch-zoom-math.ts";
import { CameraTerrainFollow } from "./relief/camera-terrain-follow.ts";
import { SurfaceScaleMath } from "./surface-scale-math.ts";

/**
 * How the camera's last move over the terrain was settled
 * (`CameraStateController.lastTerrainFollowReport`), for the debug panel:
 * whether the view ray met the terrain or the move fell back to the plain
 * pan, the arm the settle answered with, and how far the clearance over the
 * ridge under the eye lowered that zoom afterwards.
 */
export interface TerrainFollowReport {
  readonly path: "hit" | "fallback";
  /** The eye's distance from the point it looks at, in metres. */
  readonly armMetres: number;
  /** The zoom after the clearance less the zoom the settle answered, zero or negative. */
  readonly clearedZoomDelta: number;
}

/** A settled move over the terrain: the point looked at and the zoom that puts the eye where it belongs. */
export interface TerrainFollowResult {
  readonly center: Vec2;
  readonly zoom: number;
}

/**
 * The horizontal latitude pan compensation ramps in as the camera zooms in:
 * below start there is none, above end it is full.
 */
const horizontalPanCompensationStartZoom = 2.5;
const horizontalPanCompensationEndZoom = 5.0;

/**
 * The fastest the elastic pull gets, as a multiple of its rate at the edge:
 * a center far out, after a jump or a deep zoom, still glides in over a few
 * tenths of a second instead of teleporting.
 */
const maximumPullGrowth = 16.0;

/**
 * The one funnel every camera change goes through (gestures, commands,
 * flights): it holds the camera state and applies the zoom and pitch ranges,
 * the region bounds and the terrain follow to every change.
 */
export class CameraStateController {
  /**
   * The most samples the march takes along the ray: a reach far past what
   * the texel's step covers in that many is marched coarser.
   */
  static readonly marchSampleLimit = 1024;
  /** How far under the terrain the eye may be read and still be over it (`settleOnTerrain`). */
  static readonly eyeOverGroundToleranceMetres = 1.0;

  private state: ImmersiveMapCameraState = ImmersiveMapCameraState.default;
  private settings: CameraSettings;
  private boundsConstraint: CameraBoundsConstraint | null;
  /**
   * The terrain the camera looks at (`CameraTerrainFollow`), null on a map
   * without a relief: a pan keeps the eye's height by the zoom, and the zoom
   * stops at the clearance over the terrain.
   */
  terrainFollow: CameraTerrainFollow | null = null;
  private terrainFollowReport: TerrainFollowReport | null = null;
  /** Which path the last settle took (`settleOnTerrain`). */
  private lastSettlePath: TerrainFollowReport["path"] = "hit";
  private planningZoomValue: number = ImmersiveMapCameraState.default.zoom;
  /**
   * The zoom a drag over the terrain moves the map by: the camera's zoom at
   * the drag's start, held to its end (`endPan`), null between drags. The
   * camera's zoom follows the ground through the drag, and a drag moved by
   * the zoom of the moment would slow on the way up a slope and hurry on the
   * way down.
   */
  private dragZoom: number | null = null;

  constructor(settings: CameraSettings) {
    this.settings = settings;
    this.boundsConstraint = settings.bounds === null ? null : new CameraBoundsConstraint(settings.bounds);
    // The default state starts at zoom 0 and pitch 0. A configured
    // minimumZoom, minimumPitch or region must hold from the very first
    // frame, not from the first gesture.
    const zoom = clampZoom(settings, this.state.zoom);
    this.planningZoomValue = clampZoom(settings, this.planningZoomValue);
    this.state = { ...this.state, zoom, pitch: clampPitch(settings, this.state.pitch, zoom) };
    this.constrainCenterToBounds();
  }

  /** The camera state, an immutable value: every change replaces it. */
  get cameraState(): ImmersiveMapCameraState {
    return this.state;
  }

  /** How the last move over the terrain was settled, for the debug panel. Null before any, or off the terrain. */
  get lastTerrainFollowReport(): TerrainFollowReport | null {
    return this.terrainFollowReport;
  }

  /**
   * The zoom the map is planned by: the zoom of the coverage's target tiles
   * and the ring rules and of the relief's thresholds. It moves only when
   * the zoom is set on purpose, and then takes the camera's zoom as it comes
   * out: a zoom gesture, or a zoom set outright (`setZoom`,
   * `setCameraPosition`, `setCameraState`). Over the terrain the camera's
   * zoom also follows the ground the camera looks at (`followTerrain`),
   * deeper up a slope and shallower down one, and backs off over a ridge
   * (`clearedZoom`), and none of that moves this zoom: a map planned by the
   * zoom of the moment would reshuffle its rings with every slope a drag
   * crosses, and a relief faded by it would breathe. The two zooms part by
   * the terrain climbed since the last zoom and meet again at the next: not
   * by a delta, which would carry the climb along and leave the map planned
   * levels away from what the camera sees after a zoom back.
   */
  get planningZoom(): number {
    return this.planningZoomValue;
  }

  get globePan(): Vec2 {
    return ImmersiveMapProjection.globePan(this.state.centerWorldMercator);
  }

  get flatPan(): Vec2 {
    return ImmersiveMapProjection.flatPan(this.state.centerWorldMercator);
  }

  get yaw(): number {
    return this.state.bearing;
  }

  get pitch(): number {
    return this.state.pitch;
  }

  get zoom(): number {
    return this.state.zoom;
  }

  apply(settings: CameraSettings): void {
    this.settings = settings;
    this.boundsConstraint = settings.bounds === null ? null : new CameraBoundsConstraint(settings.bounds);
    const zoom = clampZoom(settings, this.state.zoom);
    this.planningZoomValue = clampZoom(settings, this.planningZoomValue);
    this.state = { ...this.state, zoom, pitch: clampPitch(settings, this.state.pitch, zoom) };
    this.constrainCenterToBounds();
  }

  /**
   * Shifts the map center by the gesture delta. `transition` is the
   * globe-to-flat phase (0 = globe, 1 = flat). On the sphere a screen point
   * covers `1 / cos(latitude)` more Mercator than on the plane at the same
   * camera distance, and the camera's globe proximity
   * (`GlobeCameraProximity`) moves in by the same scale: the Mercator delta
   * per point is the proximity factor over the surface scale, which is 1
   * once the proximity is fully in, and the old `1 / cos` below its
   * activation.
   *
   * Vertically the compensation is full at any zoom. Horizontally, near a
   * pole a swipe is a rotation around the view axis: at low zooms (the whole
   * globe is visible) full compensation turns it into uncontrollable
   * spinning, so the horizontal factor is ramped in smoothly by zoom.
   */
  pan(deltaX: number, deltaY: number, transition: number): void {
    const yaw = this.state.bearing;
    const zoom = this.state.zoom;
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(this.state.centerWorldMercator[1]);
    const surfaceScale = SurfaceScaleMath.surfaceScale(latitude, transition);
    const proximity = GlobeCameraProximity.distanceFactor(latitude, transition, zoom);
    const terrainFollow = this.terrainFollow;
    const onTerrain = transition >= 1 && terrainFollow !== null;
    let panZoom: number;
    if (onTerrain) {
      panZoom = this.dragZoom ?? zoom;
      this.dragZoom = panZoom;
    } else {
      panZoom = zoom;
    }
    const sensitivity = this.settings.worldPanSensitivity / 2.0 ** panZoom;

    // forward = rotate((0, 1), -yaw), right = -perpendicular(forward).
    const cosYaw = Math.cos(-yaw);
    const sinYaw = Math.sin(-yaw);
    const forwardX = -sinYaw;
    const forwardY = cosYaw;
    const rightX = forwardY;
    const rightY = -forwardX;

    const speed = this.settings.worldPanSpeed;
    const panDeltaX = sensitivity * (forwardX * deltaY * speed + rightX * deltaX * speed);
    const panDeltaY = sensitivity * (forwardY * deltaY * speed + rightY * deltaX * speed);
    const verticalCompensation = proximity / surfaceScale;
    const horizontalCompensation = 1.0 + (verticalCompensation - 1.0) * horizontalCompensationRamp(zoom);
    const center = this.state.centerWorldMercator;
    const proposedCenter: Vec2 = [center[0] - 0.5 * panDeltaX * horizontalCompensation, center[1] - 0.5 * panDeltaY * verticalCompensation];

    const maximumStretchPoints = this.elasticMaximumStretchPoints;
    if (this.boundsConstraint !== null && maximumStretchPoints !== null) {
      this.state = {
        ...this.state,
        centerWorldMercator: this.boundsConstraint.resist(center, proposedCenter, zoom, maximumStretchPoints * this.worldPerPoint),
      };
      return;
    }
    if (transition >= 1 && terrainFollow !== null) {
      const followed = this.followTerrain(center, proposedCenter, terrainFollow);
      this.state = { ...this.state, zoom: this.clearedZoom(followed.zoom, followed.center, terrainFollow) };
      this.recordTerrainFollow(followed.zoom, followed.center, terrainFollow);
      this.setCenterWorldMercator(followed.center);
      return;
    }
    this.setCenterWorldMercator(proposedCenter);
  }

  /**
   * The zoom, or the shallower one that keeps the eye its clearance over the
   * terrain under it (`CameraTerrainFollow.clearZoom`): over a ridge between
   * the eye and the point the eye backs off along its view ray, by the arm,
   * rather than being lifted off its pose. The zoom does not come back on its
   * own past the ridge, so the camera's own motion is all the eye ever feels.
   */
  private clearedZoom(zoom: number, center: Vec2, follow: CameraTerrainFollow): number {
    return follow.clearZoom(zoom, center, this.state.pitch, this.state.bearing, {
      lowerBound: this.settings.minimumZoom,
      upperBound: this.settings.maximumZoom,
    });
  }

  /** The drag ended: the next one moves the map by the zoom it starts at (`dragZoom`). */
  endPan(): void {
    this.dragZoom = null;
  }

  /**
   * The report of a move just settled: the path the settle took, the arm at
   * the zoom it answered, and how far the clearance lowered that zoom
   * (`clearedZoom`, applied to the camera's zoom already).
   */
  private recordTerrainFollow(followedZoom: number, center: Vec2, follow: CameraTerrainFollow): void {
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(center[1]);
    const arm = CameraTerrainFollow.eyeDistanceMetres(followedZoom, latitude, follow.globeRadiusScale);
    this.terrainFollowReport = { path: this.lastSettlePath, armMetres: arm, clearedZoomDelta: this.state.zoom - followedZoom };
  }

  /**
   * A pan over the terrain: the eye moves over the map by the pan, from over
   * `from` to over `to` as the plain pan would move the point it looks at,
   * and keeps its altitude. The point it looks at is where its view ray,
   * pitched as the pose is, meets the terrain from there: the zoom is the arm
   * to that point, deeper up a slope and shallower down one, never under the
   * clearance. Moving the point by the pan instead would move the eye by the
   * pan less the arm's change along the view, a drag that drifts with the
   * ground's rise and fall under a pitched camera. The ray's meeting with the
   * terrain is found by marching along it and bisecting the first crossing,
   * which settles on any slope, steeper than the ray included. Where the
   * terrain along the ray is not known yet, or the ray meets none within
   * reach (the eye under the terrain, or the ground fallen out of the zoom's
   * range), the point goes where the pan puts it and the zoom keeps the
   * altitude as far as it can.
   */
  followTerrain(from: Vec2, to: Vec2, follow: CameraTerrainFollow): TerrainFollowResult {
    const heightFrom = follow.terrainMetres(from);
    if (heightFrom === null) {
      return { center: to, zoom: this.state.zoom };
    }
    const pitch = this.state.pitch;
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(from[1]);
    const eyeAltitude = heightFrom + follow.eyeHeightMetres(this.state.zoom, pitch, latitude);
    const reach = follow.eyeReachMetres(this.state.zoom, pitch, latitude);
    const metresPerWorld = ImmersiveMapProjection.earthCircumferenceMeters * Math.max(Math.cos(latitude), 1e-6);
    const forward = CameraTerrainFollow.forward(this.state.bearing);
    const back = reach / metresPerWorld;
    const eyeGround: Vec2 = [to[0] - forward[0] * back, to[1] - forward[1] * back];
    return this.settleOnTerrain(eyeAltitude, eyeGround, reach, to, follow);
  }

  /**
   * A zoom over the terrain, by the same rule as a pan: the eye moves along
   * its view ray by the zoom, nearer the point it looks at or farther from
   * it, and from where it lands the point is where the ray meets the
   * terrain. The terrain the ray meets is the terrain the new zoom reads,
   * which at a zoom crossing is another map, one level coarser or finer:
   * read where the point was, it stands higher or lower than the old one
   * did, and were the point kept and the relief redrawn from under it, the
   * eye would jump with the difference, a bump at every crossing of a fast
   * zoom. The eye stays where the zoom put it, the point moves along the ray
   * by the difference and the zoom, the arm, takes it up. Nothing moves when
   * the terrain under the point reads as before.
   */
  followTerrainZoom(previousZoom: number, heightBefore: number, follow: CameraTerrainFollow): TerrainFollowResult {
    const center = this.state.centerWorldMercator;
    const zoom = this.state.zoom;
    const heightAfter = follow.terrainMetres(center);
    if (heightAfter === null || !(Math.abs(heightAfter - heightBefore) > 1e-3)) {
      return { center, zoom };
    }
    const pitch = this.state.pitch;
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(center[1]);
    const eyeAltitude = heightBefore + follow.eyeHeightMetres(zoom, pitch, latitude);
    const reach = follow.eyeReachMetres(zoom, pitch, latitude);
    const metresPerWorld = ImmersiveMapProjection.earthCircumferenceMeters * Math.max(Math.cos(latitude), 1e-6);
    const forward = CameraTerrainFollow.forward(this.state.bearing);
    const back = reach / metresPerWorld;
    const eyeGround: Vec2 = [center[0] - forward[0] * back, center[1] - forward[1] * back];
    // The march steps by a part of the old reach, as the pan's does.
    const oldReach = follow.eyeReachMetres(previousZoom, pitch, latitude);
    return this.settleOnTerrain(eyeAltitude, eyeGround, Math.max(reach, oldReach), center, follow);
  }

  /**
   * Where the view ray of an eye `eyeAltitude` metres up over `eyeGround`,
   * pitched and turned as the pose is, meets the terrain, and the zoom that
   * puts the eye there: the ray is marched in steps of a part of `reach` and
   * its first crossing bisected, which settles on any slope, steeper than
   * the ray included. Where the terrain along the ray is not known yet, or
   * the ray meets none within reach, the point is `fallbackCenter` and the
   * zoom keeps the altitude over it as far as it can.
   */
  private settleOnTerrain(eyeAltitude: number, eyeGround: Vec2, reach: number, to: Vec2, follow: CameraTerrainFollow): TerrainFollowResult {
    const pitch = this.state.pitch;
    const zoomRange: ClosedRange = { lowerBound: Math.max(this.settings.minimumZoom, 0), upperBound: this.settings.maximumZoom };
    const latitude = ImmersiveMapProjection.latitudeFromNormalizedWorldY(to[1]);
    const metresPerWorld = ImmersiveMapProjection.earthCircumferenceMeters * Math.max(Math.cos(latitude), 1e-6);
    const forward = CameraTerrainFollow.forward(this.state.bearing);
    const tanPitch = Math.tan(pitch);
    // How far past the ray the terrain is at `r` metres ahead of the eye:
    // the ray at that reach is `r / tan(pitch)` under the eye, and it has met
    // the terrain once the terrain is at least that far under it, that is,
    // once r >= (altitude - terrain) * tan. Null where the terrain is not
    // known.
    const crossing = (r: number): number | null => {
      const ahead = r / metresPerWorld;
      const height = follow.terrainMetres([eyeGround[0] + forward[0] * ahead, eyeGround[1] + forward[1] * ahead]);
      return height === null ? null : r - (eyeAltitude - height) * tanPitch;
    };
    // The fallback keeps the arm: the point goes where the pan puts it and
    // the zoom stays, so a frame the ray cannot be settled on (the eye under
    // the terrain, the terrain not known, no ground within reach) moves the
    // camera the plain way and changes nothing else. A zoom read off the
    // ground under the point instead jumped: an eye a hair under a crest
    // read a height of nothing over the crest's own top and the zoom went to
    // its limit.
    const fallback = (): TerrainFollowResult => {
      this.lastSettlePath = "fallback";
      return { center: to, zoom: this.state.zoom };
    };
    // The eye is over the terrain under it, to within a metre: an eye
    // skimming a crest at a clearance of nothing is a hair over or under it
    // from frame to frame, and the hair must not pick the path.
    const start = crossing(0);
    if (start === null || !(start <= tanPitch * CameraStateController.eyeOverGroundToleranceMetres)) {
      return fallback();
    }
    this.lastSettlePath = "hit";
    // The march: the ray is tried further and further ahead, one terrain
    // texel at a time (`CameraTerrainFollow.sampleStepWorld`), as far as
    // eight times the old reach, which is where the ground would have fallen
    // out of the zoom's range anyway. By the texel, not by the zoom: a step
    // that grew with the reach found a ridge at one zoom and stepped over it
    // at the next, and the camera shook between the two answers. A far reach
    // caps the samples and coarsens the step instead. The march always takes
    // its first sample: a camera looking straight down has no reach, and a
    // march that went nowhere fell back to the plain pan, so the eye rode the
    // hills it looked down on.
    const texelStep = Math.max(follow.sampleStepWorld * metresPerWorld, 0.5);
    const farthest = Math.max(reach * 8, texelStep);
    const step = Math.max(texelStep, farthest / CameraStateController.marchSampleLimit);
    let lowReach = 0.0;
    let highReach: number | null = null;
    let r = step;
    while (r <= farthest) {
      const value = crossing(r);
      if (value === null) {
        return fallback();
      }
      if (value >= 0) {
        highReach = r;
        break;
      }
      lowReach = r;
      r += step;
    }
    if (highReach === null) {
      return fallback();
    }
    let high = highReach;
    // The crossing, to within a tenth of a metre.
    for (let iteration = 0; iteration < 24 && high - lowReach > 0.1; iteration++) {
      const middle = (lowReach + high) * 0.5;
      const value = crossing(middle);
      if (value === null) {
        return fallback();
      }
      if (value >= 0) {
        high = middle;
      } else {
        lowReach = middle;
      }
    }
    const ahead = high / metresPerWorld;
    const center: Vec2 = [eyeGround[0] + forward[0] * ahead, eyeGround[1] + forward[1] * ahead];
    const heightTo = follow.terrainMetres(center);
    if (heightTo === null) {
      return fallback();
    }
    const latitudeTo = ImmersiveMapProjection.latitudeFromNormalizedWorldY(center[1]);
    const height = Math.max(eyeAltitude - heightTo, follow.clearanceMetres);
    return { center, zoom: follow.zoomForEyeHeightMetres(height, pitch, latitudeTo, zoomRange) };
  }

  /**
   * One frame of the elastic edge's pull: moves the center toward the area
   * by the share of the way the pull covers in `deltaTime` at the center's
   * distance (see the elastic `CameraBoundsEdgeBehavior`), and snaps it in
   * once it is within a twentieth of a screen point. Returns whether the
   * center is still outside, false at once for a center inside the area, a
   * hard edge or no bounds.
   */
  advanceBoundsPull(deltaTime: number): boolean {
    const boundsConstraint = this.boundsConstraint;
    const edge = this.settings.bounds?.edgeBehavior;
    if (boundsConstraint === null || edge === undefined || edge.kind !== "elastic") {
      return false;
    }

    const zoom = this.state.zoom;
    const center = this.state.centerWorldMercator;
    const worldPerPoint = this.worldPerPoint;
    const distancePoints = boundsConstraint.distanceOutside(center, zoom) / worldPerPoint;
    let growth: number;
    if (edge.maximumStretch > 0 && edge.pullProgression > 0) {
      growth = Math.min((1 + distancePoints / edge.maximumStretch) ** edge.pullProgression, maximumPullGrowth);
    } else {
      growth = 1;
    }
    const rate = edge.pullHalfLife > 0 ? (Math.log(2.0) / edge.pullHalfLife) * growth : Number.POSITIVE_INFINITY;
    const fraction = 1 - Math.exp(-rate * Math.max(deltaTime, 0));
    const step = boundsConstraint.returnStep(center, zoom, Number.isFinite(fraction) ? fraction : 1);
    if (!(step.remainingDistance > worldPerPoint * 0.05)) {
      const settled = boundsConstraint.apply(this.state.centerWorldMercator, zoom);
      if (settled[0] !== center[0] || settled[1] !== center[1]) {
        this.state = { ...this.state, centerWorldMercator: settled };
      }
      return false;
    }

    this.state = { ...this.state, centerWorldMercator: step.center };
    return true;
  }

  /**
   * How far a screen point of drag moves the center at the current zoom: the
   * pan's sensitivity chain before the surface compensation, which is close
   * enough for the elastic edge's reach and its settling distance.
   */
  private get worldPerPoint(): number {
    const settings = this.settings;
    return Math.abs(0.5 * settings.worldPanSensitivity * settings.worldPanSpeed * settings.gesturePanTranslationScale) / 2.0 ** this.state.zoom;
  }

  /** The elastic edge's reach in screen points, null for a hard edge or no bounds. */
  private get elasticMaximumStretchPoints(): number | null {
    const edge = this.settings.bounds?.edgeBehavior;
    if (edge === undefined || edge.kind !== "elastic") {
      return null;
    }
    return Number.isFinite(edge.maximumStretch) ? Math.max(edge.maximumStretch, 0) : 0;
  }

  setZoom(zoom: number): void {
    this.applyZoomDelta(zoom - this.state.zoom);
  }

  setCenterWorldMercator(centerWorldMercator: Vec2): void {
    this.state = {
      ...this.state,
      centerWorldMercator: [
        ImmersiveMapProjection.wrapNormalizedWorldX(centerWorldMercator[0]),
        ImmersiveMapProjection.clampNormalizedWorldY(centerWorldMercator[1]),
      ],
    };
    this.constrainCenterToBounds();
  }

  /**
   * The center moved by a zoom's anchor compensation, the shift that keeps
   * the world point under the cursor under it: over the terrain the move is
   * a pan's (`followTerrain`). The point slides over the ground at every
   * step of an anchored zoom, and the terrain under it, the datum the relief
   * is drawn from, rises and falls with the ground it slides over. Set
   * plainly, the whole relief would be redrawn from the new height under the
   * eye, which rode every bump of the slide. The eye instead keeps the
   * altitude the zoom gave it, the point is where its view ray meets the
   * terrain, and the difference goes into the zoom, the arm. Off the terrain
   * it is the plain set.
   */
  setCenterWorldMercatorOverTerrain(centerWorldMercator: Vec2): void {
    const terrainFollow = this.terrainFollow;
    if (terrainFollow === null) {
      this.setCenterWorldMercator(centerWorldMercator);
      return;
    }
    const followed = this.followTerrain(this.state.centerWorldMercator, centerWorldMercator, terrainFollow);
    this.state = { ...this.state, zoom: this.clearedZoom(followed.zoom, followed.center, terrainFollow) };
    this.setCenterWorldMercator(followed.center);
  }

  /**
   * A hard edge holds the center after every change of the center or the
   * zoom, since the area closes in as the zoom grows. An elastic edge leaves
   * it: the pan resists on its own, and the animation runtime brings the
   * camera back once nothing moves it.
   */
  private constrainCenterToBounds(): void {
    if (this.boundsConstraint === null || this.settings.bounds?.edgeBehavior.kind !== "hard") {
      return;
    }
    this.state = { ...this.state, centerWorldMercator: this.boundsConstraint.apply(this.state.centerWorldMercator, this.state.zoom) };
  }

  setLatLonDeg(latDeg: number, lonDeg: number): void {
    if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) {
      throw new RangeError("Latitude/longitude must be finite.");
    }
    const maxLatitudeDeg = ImmersiveMapProjection.maxMercatorLatitude * (180.0 / Math.PI);
    if (!(Math.abs(latDeg) <= maxLatitudeDeg)) {
      throw new RangeError(`Latitude out of range for Mercator: ${latDeg}`);
    }
    const globeLat = (latDeg / 180.0) * Math.PI;
    const longitude = (lonDeg / 180.0) * Math.PI;
    this.setCenterWorldMercator(ImmersiveMapProjection.worldMercator(globeLat, longitude));
  }

  /** The center's latitude and longitude in radians. */
  getLatLonRad(): { latRad: number; lonRad: number } {
    const center = this.state.centerWorldMercator;
    return {
      latRad: ImmersiveMapProjection.latitudeFromNormalizedWorldY(center[1]),
      lonRad: ImmersiveMapProjection.longitudeFromNormalizedWorldX(center[0]),
    };
  }

  /** The center's latitude and longitude in degrees. */
  getLatLonDeg(): { latDeg: number; lonDeg: number } {
    const latLon = this.getLatLonRad();
    return { latDeg: latLon.latRad * (180.0 / Math.PI), lonDeg: latLon.lonRad * (180.0 / Math.PI) };
  }

  rotateYaw(delta: number): void {
    this.state = { ...this.state, bearing: this.state.bearing + delta };
  }

  setBearing(bearing: number): void {
    this.state = { ...this.state, bearing };
  }

  clampBearing(constraint: CameraBearingConstraint): void {
    const constrainedBearing = constraint.apply(this.state.bearing);
    if (constrainedBearing === this.state.bearing) {
      return;
    }
    this.state = { ...this.state, bearing: constrainedBearing };
  }

  clampPitch(constraint: CameraPitchConstraint): void {
    const constrainedPitch = constraint.apply(this.state.pitch);
    if (constrainedPitch === this.state.pitch) {
      return;
    }
    this.state = { ...this.state, pitch: constrainedPitch };
  }

  setPitch(pitch: number): void {
    this.state = { ...this.state, pitch: clampPitch(this.settings, pitch, this.state.zoom) };
  }

  /** A pinch: the zoom the pinch's scale and velocity ask for (`PinchZoomMath`). */
  zoomByScale(scale: number, velocity = 0): void {
    const settings = this.settings;
    this.applyZoomDelta(
      PinchZoomMath.zoomDelta(scale, velocity, settings.pinchZoomFactor, settings.pinchZoomVelocityFactor, settings.pinchZoomVelocityLimit),
    );
  }

  zoomByDelta(delta: number): void {
    this.applyZoomDelta(delta);
  }

  setCameraPosition(cameraPosition: ImmersiveMapCameraPosition): void {
    if (
      !Number.isFinite(cameraPosition.latitudeDegrees) ||
      !Number.isFinite(cameraPosition.longitudeDegrees) ||
      !Number.isFinite(cameraPosition.zoom) ||
      !Number.isFinite(cameraPosition.bearing) ||
      !Number.isFinite(cameraPosition.pitch)
    ) {
      throw new RangeError("Camera position values must be finite.");
    }
    const maxLatitudeDeg = ImmersiveMapProjection.maxMercatorLatitude * (180.0 / Math.PI);
    if (!(Math.abs(cameraPosition.latitudeDegrees) <= maxLatitudeDeg)) {
      throw new RangeError(`Latitude out of range for Mercator: ${cameraPosition.latitudeDegrees}`);
    }

    const latitudeRadians = (cameraPosition.latitudeDegrees / 180.0) * Math.PI;
    const longitudeRadians = (cameraPosition.longitudeDegrees / 180.0) * Math.PI;
    const zoom = clampZoom(this.settings, cameraPosition.zoom);
    this.state = {
      centerWorldMercator: ImmersiveMapProjection.worldMercator(latitudeRadians, longitudeRadians),
      zoom,
      bearing: cameraPosition.bearing,
      pitch: clampPitch(this.settings, cameraPosition.pitch, zoom),
    };
    this.planningZoomValue = zoom;
    this.constrainCenterToBounds();
  }

  currentCameraState(): ImmersiveMapCameraState {
    return this.state;
  }

  setCameraState(cameraState: ImmersiveMapCameraState): void {
    const clampedZoom = clampZoom(this.settings, cameraState.zoom);
    this.state = ImmersiveMapCameraState.make(
      cameraState.centerWorldMercator,
      clampedZoom,
      cameraState.bearing,
      clampPitch(this.settings, cameraState.pitch, clampedZoom),
    );
    this.planningZoomValue = clampedZoom;
    this.constrainCenterToBounds();
  }

  private applyZoomDelta(delta: number): void {
    if (!Number.isFinite(delta)) {
      return;
    }

    const previousZoom = this.state.zoom;
    const terrainFollow = this.terrainFollow;
    // The terrain under the point as the old zoom reads it, before the new
    // one reads another map (`followTerrainZoom`): the same map at every
    // zoom, so nothing moves unless the zoom crosses onto the plane.
    const heightBefore = terrainFollow?.terrainMetres(this.state.centerWorldMercator) ?? null;
    this.state = { ...this.state, zoom: clampZoom(this.settings, this.state.zoom + delta) };
    if (terrainFollow !== null) {
      if (heightBefore !== null) {
        const followed = this.followTerrainZoom(previousZoom, heightBefore, terrainFollow);
        this.state = { ...this.state, zoom: followed.zoom, centerWorldMercator: followed.center };
      }
      // Over a terrain the zoom stops where the eye would come nearer than
      // the clearance to the ground under it.
      const followedZoom = this.state.zoom;
      this.state = { ...this.state, zoom: this.clearedZoom(this.state.zoom, this.state.centerWorldMercator, terrainFollow) };
      this.recordTerrainFollow(followedZoom, this.state.centerWorldMercator, terrainFollow);
    }
    // A zoom on purpose: the map is planned by what the camera sees.
    this.planningZoomValue = this.state.zoom;
    this.constrainCenterToBounds();
  }
}

function horizontalCompensationRamp(zoom: number): number {
  const progress = Math.min(Math.max((zoom - horizontalPanCompensationStartZoom) / (horizontalPanCompensationEndZoom - horizontalPanCompensationStartZoom), 0.0), 1.0);
  return progress * progress * (3.0 - 2.0 * progress);
}
