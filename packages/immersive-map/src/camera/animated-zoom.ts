// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The animated zoom: the camera's zoom followed over time rather than read,
 * closing half of what is left every half-life
 * (`CameraSettings.animatedZoomHalfLife`). The camera's own zoom is the fact
 * of the frame, and the tiles, the rings and the camera's pose read it as it
 * is. What dresses the frame by the zoom (the styles' zoom fades, the
 * labels' reach) reads this one, and the relief's collapse reads a zoom held
 * through a drag and then followed the same way, so a zoom that jumps in one
 * frame, as it does when the point the camera looks at drops off a ridge
 * onto the plain below and the arm lengthens at once (`CameraTerrainFollow`),
 * dresses the frame over a few frames instead. A camera set outright
 * (`FrameCameraStateResolver.cameraJumpCount`) snaps it, so a teleport
 * across the world is not dressed as a flight.
 */
export class AnimatedZoom {
  /**
   * How close the zoom gets before it is the camera's: a thousandth of a
   * level, under anything a fade could show.
   */
  static readonly settledTolerance = 0.001;

  private currentValue: number | null = null;
  private settling = false;

  /** The zoom as it stands, null before the first frame. */
  get value(): number | null {
    return this.currentValue;
  }

  /**
   * Whether the zoom is still on its way to the camera's: the frames keep
   * coming while it is.
   */
  get isSettling(): boolean {
    return this.settling;
  }

  /**
   * Moves the zoom toward `zoom` by `deltaTime` seconds and returns it.
   * `snap`, a half-life of zero or less, or the first frame set it to `zoom`
   * at once.
   */
  advance(zoom: number, deltaTime: number, halfLife: number, snap = false): number {
    const current = this.currentValue;
    if (current === null || snap || !(halfLife > 0) || !Number.isFinite(zoom)) {
      this.currentValue = zoom;
      this.settling = false;
      return zoom;
    }
    const remaining = zoom - current;
    if (!(Math.abs(remaining) > AnimatedZoom.settledTolerance)) {
      this.currentValue = zoom;
      this.settling = false;
      return zoom;
    }
    const share = deltaTime > 0 ? 1 - 0.5 ** (deltaTime / halfLife) : 0;
    const next = current + remaining * share;
    this.currentValue = next;
    this.settling = Math.abs(zoom - next) > AnimatedZoom.settledTolerance;
    if (!this.settling) {
      this.currentValue = zoom;
      return zoom;
    }
    return next;
  }
}
