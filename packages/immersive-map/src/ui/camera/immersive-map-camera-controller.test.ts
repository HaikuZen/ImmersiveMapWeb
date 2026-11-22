// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapCameraPosition } from "../../camera/immersive-map-camera-position.ts";
import { ImmersiveMapCameraController } from "./immersive-map-camera-controller.ts";
import { ImmersiveMapCameraAngleLimits, ImmersiveMapCameraBearingLimits, ImmersiveMapCameraSnapshot } from "./immersive-map-camera-snapshot.ts";

/** Swift `ImmersiveMapCameraControllerTests`. */
describe("ImmersiveMapCameraController", () => {
  test("notifying a snapshot stores and publishes it", () => {
    const controller = new ImmersiveMapCameraController();
    const position = ImmersiveMapCameraPosition.make(55, 37, 6, 0.2, 0.3);
    const snapshot = new ImmersiveMapCameraSnapshot(position, new ImmersiveMapCameraBearingLimits(1), new ImmersiveMapCameraAngleLimits(0, 0.8), false);
    let received: ImmersiveMapCameraSnapshot | null = null;
    controller.onCameraSnapshotChanged = (value) => {
      received = value;
    };
    controller.notifyCameraSnapshotChanged(snapshot);
    expect(controller.currentCameraSnapshot()).toBe(snapshot);
    expect(received).toBe(snapshot);
  });

  test("user interaction observers are told and can be removed", () => {
    const controller = new ImmersiveMapCameraController();
    let publicCalls = 0;
    let observerCalls = 0;
    controller.onUserInteractionBegan = () => {
      publicCalls += 1;
    };
    const token = controller.addUserInteractionObserver(() => {
      observerCalls += 1;
    });
    controller.notifyUserInteractionBegan();
    controller.removeUserInteractionObserver(token);
    controller.notifyUserInteractionBegan();
    expect(publicCalls).toBe(2);
    expect(observerCalls).toBe(1);
  });

  test("snapshot observers run beside the public callback and stop once removed", () => {
    const controller = new ImmersiveMapCameraController();
    const snapshot = new ImmersiveMapCameraSnapshot(
      ImmersiveMapCameraPosition.make(10, 20, 5, 0.5, 0.2),
      new ImmersiveMapCameraBearingLimits(Math.PI),
      new ImmersiveMapCameraAngleLimits(0, 1),
      false,
    );
    const publicSnapshots: ImmersiveMapCameraSnapshot[] = [];
    const observedSnapshots: ImmersiveMapCameraSnapshot[] = [];
    controller.onCameraSnapshotChanged = (value) => {
      publicSnapshots.push(value);
    };
    const token = controller.addCameraSnapshotObserver((value) => {
      observedSnapshots.push(value);
    });
    controller.notifyCameraSnapshotChanged(snapshot);
    controller.removeCameraSnapshotObserver(token);
    controller.notifyCameraSnapshotChanged(snapshot);
    expect(publicSnapshots).toEqual([snapshot, snapshot]);
    expect(observedSnapshots).toEqual([snapshot]);
    expect(controller.currentCameraSnapshot()).toBe(snapshot);
  });
});

/**
 * Swift `ImmersiveMapControllerReattachTests`, the camera part. A new map
 * may take a controller before the old one is torn down: detaching must be
 * strictly by owner, so tearing a stale map down does not erase the new
 * attachment.
 */
describe("ImmersiveMapCameraController reattach", () => {
  test("a stale detach keeps the new attachment and the position cache", () => {
    const camera = new ImmersiveMapCameraController();
    const oldOwner = {};
    const newOwner = {};
    let oldHandled = 0;
    let newHandled = 0;
    camera.attachRuntime(oldOwner, () => {
      oldHandled += 1;
    });
    camera.attachRuntime(newOwner, () => {
      newHandled += 1;
    });
    camera.updateCurrentCameraPosition(ImmersiveMapCameraPosition.make(25, -30, 1.7));

    // The old map's teardown arrives after the new one attaches.
    camera.detachRuntime(oldOwner);

    camera.jump(ImmersiveMapCameraPosition.make(35.6595, 139.7005, 4));
    expect(newHandled, "The command must reach the new owner").toBe(1);
    expect(oldHandled).toBe(0);
    expect(camera.currentCameraPosition(), "Tearing a stale map down must not clear the cached position").not.toBeNull();
  });

  test("an owned detach clears the handler and queues commands for replay", () => {
    const camera = new ImmersiveMapCameraController();
    const owner = {};
    let handledBeforeDetach = 0;
    camera.attachRuntime(owner, () => {
      handledBeforeDetach += 1;
    });
    camera.detachRuntime(owner);
    camera.jump(ImmersiveMapCameraPosition.make(1, 2, 3));
    expect(handledBeforeDetach, "Once detached from its owner, commands queue up instead of running").toBe(0);

    let replayed = 0;
    camera.attachRuntime(owner, () => {
      replayed += 1;
    });
    expect(replayed, "Reattaching replays the queued commands").toBe(1);
  });
});
