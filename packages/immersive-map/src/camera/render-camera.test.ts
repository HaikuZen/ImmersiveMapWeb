// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { mat4TransformVec4 } from "../math/matrix.ts";
import { defaultCameraPresentationSettings } from "../presentation/camera-presentation-settings.ts";
import { CAMERA_UNIFORM_BYTE_LENGTH, writeCameraUniform, writeGpuCameraUniform } from "./camera-uniform.ts";
import { FrameCameraStateResolver } from "./frame-camera-state-resolver.ts";
import { ImmersiveMapCameraState } from "./immersive-map-camera-state.ts";
import { RenderCamera } from "./render-camera.ts";
import { RenderCameraPoseResolver } from "./render-camera-pose-resolver.ts";

function expectClose(actual: number, expected: number, accuracy: number): void {
  expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(accuracy);
}

function posedCamera(zoom: number, bearing: number, pitch: number): RenderCamera {
  const camera = new RenderCamera();
  camera.recalculateProjection(4 / 3);
  new RenderCameraPoseResolver().updateIfNeeded(camera, ImmersiveMapCameraState.make([0.5, 0.5], zoom, bearing, pitch), 1);
  return camera;
}

/** The render camera and what the frame takes from it: the pose, the frustum and the uniform. */
describe("RenderCamera", () => {
  test("the pose looks at the origin from the zoom's arm", () => {
    const camera = posedCamera(10.5, 0, 0);
    expectClose(camera.eye[2], 0.75, 1e-12);
    // The view centre lands on the screen centre.
    const clip = mat4TransformVec4(camera.cameraMatrix!, [0, 0, 0, 1]);
    expectClose(clip[0] / clip[3], 0, 1e-12);
    expectClose(clip[1] / clip[3], 0, 1e-12);
  });

  test("a pitched camera stands south of the point at bearing 0 and turns with the bearing", () => {
    const north = posedCamera(10, 0, Math.PI / 4);
    expect(north.eye[1]).toBeLessThan(0);
    expectClose(north.eye[0], 0, 1e-12);
    const east = posedCamera(10, Math.PI / 2, Math.PI / 4);
    expect(east.eye[0]).toBeGreaterThan(0);
    expectClose(east.eye[1], 0, 1e-12);
  });

  test("the frustum holds the view centre and drops what is behind the eye", () => {
    const camera = posedCamera(10, 0, 0);
    const frustum = camera.frustum!;
    expect(frustum.isSphereVisible([0, 0, 0], 0.01)).toBe(true);
    expect(frustum.containsSphere([0, 0, 0], 0.001)).toBe(true);
    expect(frustum.isSphereVisible([0, 0, 5], 0.1)).toBe(false);
    expect(frustum.isBoxVisible([-0.1, -0.1, -0.1, 1], [0.1, 0.1, 0.1, 1])).toBe(true);
    expect(frustum.isBoxVisibleXYZ(100, 100, -1, 101, 101, 0)).toBe(false);
  });

  test("the GPU depth adjustment moves the far plane and leaves x, y and w alone", () => {
    const camera = posedCamera(10, 0, 0);
    const point = [0.1, 0.05, 0, 1] as const;
    const cpu = mat4TransformVec4(camera.cameraMatrix!, point);
    const gpu = mat4TransformVec4(RenderCamera.gpuClipDepthAdjustment, cpu);
    expect(gpu[0]).toBe(cpu[0]);
    expect(gpu[1]).toBe(cpu[1]);
    expect(gpu[3]).toBe(cpu[3]);
    expect(gpu[2] / gpu[3]).not.toBe(cpu[2] / cpu[3]);
    expectClose(RenderCamera.realDepthScale, 1 - 1536 * 3.2e-6, 1e-15);
  });

  test("the uniform is the matrix column-major, the eye and a zero pad", () => {
    const camera = posedCamera(10, 0.3, 0.6);
    const staging = new Float32Array(CAMERA_UNIFORM_BYTE_LENGTH / 4 + 4).fill(7);
    writeCameraUniform(staging, 16, camera.cameraMatrix!, camera.eye);
    expect(staging[0]).toBe(7);
    for (let index = 0; index < 16; index++) {
      expect(staging[4 + index]).toBe(Math.fround(camera.cameraMatrix![index]!));
    }
    expect(staging[20]).toBe(Math.fround(camera.eye[0]));
    expect(staging[22]).toBe(Math.fround(camera.eye[2]));
    expect(staging[23]).toBe(0);
    writeGpuCameraUniform(staging, 16, camera.cameraMatrix!, camera.eye);
    expect(staging[14]).not.toBe(Math.fround(camera.cameraMatrix![10]!));
    expect(() => writeCameraUniform(staging, 32, camera.cameraMatrix!, camera.eye)).toThrow(RangeError);
  });

  test("the frame state is one object, rewritten in place", () => {
    const resolver = new FrameCameraStateResolver(defaultCameraPresentationSettings);
    resolver.setCameraState(ImmersiveMapCameraState.make([0.3, 0.4], 12, 0, 0.5));
    const first = resolver.makeFrameState(800, 600, 1);
    const matrix = first!.cameraMatrices.projectionView.slice();
    resolver.setCameraState(ImmersiveMapCameraState.make([0.3, 0.4], 13.5, 0.2, 0.5));
    const second = resolver.makeFrameState(800, 600, 1);
    expect(second).toBe(first);
    expect(second!.cameraMatrices.projectionView).not.toEqual(matrix);
    expect(second!.mapCameraState.zoom).toBe(13.5);
    expect(resolver.cameraJumpCount).toBe(2);
    expect(resolver.makeFrameState(0, 600)).toBeNull();
    expect(resolver.lastSkipReason).toBe("zeroDrawableSize");
  });
});
