// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { ImmersiveMapSceneModel, ImmersiveMapSceneModelSource, resolveSceneModelSource, sceneModelFormatOfURL, sceneModelSourceKey } from "./immersive-map-scene-model.ts";

const page = "https://example.test/app/index.html";

describe("ImmersiveMapSceneModel", () => {
  test("the maker applies the Swift defaults", () => {
    const model = ImmersiveMapSceneModel.make({ id: 4, source: "models/tower.glb", coordinate: { latitude: 1, longitude: 2 } });
    expect(model).toEqual({
      id: 4,
      source: { url: "models/tower.glb" },
      coordinate: { latitude: 1, longitude: 2 },
      altitudeMeters: 0,
      headingDegrees: 0,
      pitchDegrees: 0,
      rollDegrees: 0,
      scale: 1,
      fitDiameterMeters: null,
      cutsIntoGround: false,
    });
    expect(Object.isFrozen(model)).toBe(true);
  });

  test("an id that is not a safe integer is refused", () => {
    expect(() => ImmersiveMapSceneModel.make({ id: 1.5, source: "a.glb", coordinate: { latitude: 0, longitude: 0 } })).toThrow(RangeError);
  });

  test("with copies the values given and keeps the id", () => {
    const model = ImmersiveMapSceneModel.make({ id: 1, source: "a.glb", coordinate: { latitude: 0, longitude: 0 } });
    const scaled = ImmersiveMapSceneModel.with(model, { scale: 3 });
    expect(scaled.scale).toBe(3);
    expect(scaled.id).toBe(1);
    expect(model.scale).toBe(1);
  });
});

describe("scene model sources", () => {
  test("the format comes from the extension, past the query and the fragment", () => {
    expect(sceneModelFormatOfURL(new URL("https://a.test/x/model.GLTF?v=2#n"))).toBe("gltf");
    expect(sceneModelFormatOfURL(new URL("https://a.test/model.glb"))).toBe("glb");
    expect(sceneModelFormatOfURL(new URL("https://a.test/model.obj"))).toBe("obj");
    expect(sceneModelFormatOfURL(new URL("https://a.test/model.usdz"))).toBeNull();
    expect(sceneModelFormatOfURL(new URL("https://a.test/models.d/model"))).toBeNull();
  });

  test("a data URL's media type names its format", () => {
    expect(sceneModelFormatOfURL(new URL("data:model/gltf-binary;base64,AAAA"))).toBe("glb");
    expect(sceneModelFormatOfURL(new URL("data:model/gltf+json,%7B%7D"))).toBe("gltf");
  });

  test("the source's own format wins over the URL", () => {
    const resolved = resolveSceneModelSource(ImmersiveMapSceneModelSource.make("blob:https://example.test/1234", "glb"), page);
    expect(resolved.format).toBe("glb");
    expect(resolveSceneModelSource({ url: "download?id=3" }, page).format).toBeNull();
  });

  test("relative and absolute spellings of one asset share a key, and the format splits it", () => {
    const relative = sceneModelSourceKey({ url: "../models/tower.glb" }, page);
    const absolute = sceneModelSourceKey({ url: "https://example.test/models/tower.glb" }, page);
    expect(relative).toBe(absolute);
    expect(resolveSceneModelSource({ url: "../models/tower.glb" }, page).url).toBe("https://example.test/models/tower.glb");
    expect(sceneModelSourceKey({ url: "https://example.test/models/tower.glb", format: "gltf" }, page)).not.toBe(absolute);
  });
});
