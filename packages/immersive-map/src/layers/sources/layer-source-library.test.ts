// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { geoCoordinate } from "../../geo/geo-coordinate.ts";
import { noMeshCache, testLayerJobs } from "../testing/layer-test-jobs.ts";
import { LayerSourceContent } from "./layer-source-content.ts";
import type { LayerSourceData } from "./layer-source-data.ts";
import { LayerSourceLibrary, type LayerSourceState } from "./layer-source-library.ts";

/** A source of `count` points, told apart by their number. */
function points(count: number): LayerSourceData {
  return { kind: "shapes", polygons: [], polylines: [], points: Array.from({ length: count }, (_, i) => ({ coordinate: geoCoordinate(0, i) })), identity: `${count} points` };
}

/** What ten points take. */
const tenPoints = LayerSourceContent.fromShapes([], [], Array.from({ length: 10 }, (_, i) => ({ coordinate: geoCoordinate(0, i) }))).byteSize;

const libraryOf = (limitBytes: number, documents: Readonly<Record<string, string>> = {}) => new LayerSourceLibrary(limitBytes, noMeshCache(), testLayerJobs(documents));

/** One frame of `client` that draws `drawn` and builds from each. */
function frame(library: LayerSourceLibrary, client: object, drawn: string[]): Map<string, LayerSourceState> {
  return library.states(new Set(drawn), drawn, new Set(drawn), client);
}

/** Draws `drawn` as the frames of `client` do, building from each, until none of them is on its way: a frame for each change the library reports. */
async function settle(library: LayerSourceLibrary, client: object, drawn: string[]): Promise<void> {
  let wake: (() => void) | undefined;
  library.addClient(client, () => wake?.());
  for (;;) {
    const changed = new Promise<void>((resolve) => (wake = resolve));
    if (![...frame(library, client, drawn).values()].some((state) => state.isLoading)) return;
    await changed;
  }
}

describe("LayerSourceLibrary", () => {
  test("a source is read only when a frame draws it", async () => {
    const library = libraryOf(1_000_000);
    const client = {};
    library.register("a", points(10));
    library.register("b", points(10));
    // A registered source costs nothing.
    expect(library.loadedBytes).toBe(0);
    await settle(library, client, ["a"]);
    expect(library.isLoaded("a")).toBe(true);
    // A source no layer draws is not read.
    expect(library.isLoaded("b")).toBe(false);
    expect(library.loadedBytes).toBe(tenPoints);
  });

  test("registering the same data again changes nothing", async () => {
    const library = libraryOf(1_000_000);
    const client = {};
    library.register("a", points(10));
    await settle(library, client, ["a"]);
    const revision = frame(library, client, ["a"]).get("a")?.revision;

    library.register("a", points(10));
    expect(frame(library, client, ["a"]).get("a")?.revision).toBe(revision);
    // The shapes that were read are kept.
    expect(library.isLoaded("a")).toBe(true);

    // Other data is read anew.
    library.register("a", points(11));
    expect(library.isLoaded("a")).toBe(false);
    expect(library.states(new Set(["a"]), [], new Set(), client).get("a")?.revision).not.toBe(revision);
  });

  test("over the limit the source drawn last is refused", async () => {
    const library = libraryOf(1.5 * tenPoints);
    const client = {};
    library.register("first", points(10));
    library.register("second", points(10));
    await settle(library, client, ["first", "second"]);
    expect(library.isLoaded("first")).toBe(true);
    expect(library.isLoaded("second")).toBe(false);
    expect(library.failure("second")).toEqual({ kind: "limitExceeded", bytes: tenPoints, limit: 1.5 * tenPoints });
    expect(library.failure("first")).toBeUndefined();
  });

  test("the shapes nothing needs are let go", async () => {
    const library = libraryOf(1_000_000);
    const client = {};
    library.register("first", points(10));
    library.register("second", points(10));
    await settle(library, client, ["first"]);
    // The frame moves on to the second source.
    await settle(library, client, ["second"]);
    expect(library.isLoaded("second")).toBe(true);
    expect(library.isLoaded("first")).toBe(false);
    // Its mesh is built: the frame draws it and builds from nothing. A drawn layer needs its mesh alone.
    library.states(new Set(["second"]), ["second"], new Set(), client);
    expect(library.isLoaded("second")).toBe(false);
    expect(library.loadedBytes).toBe(0);
  });

  test("the shapes of what is drawn are kept while taps are listened to", async () => {
    const library = libraryOf(1_000_000);
    const client = {};
    library.register("shown", points(10));
    library.shapesWanted = true;
    await settle(library, client, ["shown"]);
    // A tap is tested against the shapes of what is drawn.
    library.states(new Set(["shown"]), ["shown"], new Set(), client);
    expect(library.isLoaded("shown")).toBe(true);
    library.shapesWanted = false;
    library.states(new Set(["shown"]), ["shown"], new Set(), client);
    expect(library.isLoaded("shown")).toBe(false);
  });

  test("a refused source is read again once another stops being drawn", async () => {
    const library = libraryOf(1.5 * tenPoints);
    const client = {};
    library.register("first", points(10));
    library.register("second", points(10));
    await settle(library, client, ["first", "second"]);
    expect(library.failure("second")).toBeDefined();
    await settle(library, client, ["second"]);
    expect(library.isLoaded("second")).toBe(true);
    expect(library.failure("second")).toBeUndefined();
  });

  test("a source is told apart by its URL or by the identity it was given", () => {
    const library = libraryOf(1_000_000);
    const client = {};
    library.register("file", { kind: "geoJSONURL", url: "https://example.invalid/layer.geojson", identity: undefined });
    library.register("memory", { kind: "geoJSON", document: "one", identity: "v1" });
    let states = library.states(new Set(["file", "memory"]), [], new Set(), client);
    expect(states.get("file")?.identity).toEqual({ kind: "url", url: "https://example.invalid/layer.geojson", identity: undefined });
    expect(states.get("memory")?.identity).toEqual({ kind: "named", name: "v1" });
    const revision = states.get("memory")?.revision;

    // The data is never looked into: the same identity is the same data, whatever the bytes, and another identity is other data.
    library.register("memory", { kind: "geoJSON", document: "two", identity: "v1" });
    states = library.states(new Set(["memory"]), [], new Set(), client);
    expect(states.get("memory")?.revision).toBe(revision);
    library.register("memory", { kind: "geoJSON", document: "two", identity: "v2" });
    states = library.states(new Set(["memory"]), [], new Set(), client);
    expect(states.get("memory")?.revision).not.toBe(revision);

    // A URL is the same data under the same identity the app gives it.
    const fileRevision = library.states(new Set(["file"]), [], new Set(), client).get("file")?.revision;
    library.register("file", { kind: "geoJSONURL", url: "https://example.invalid/layer.geojson", identity: "v1" });
    expect(library.states(new Set(["file"]), [], new Set(), client).get("file")?.revision).not.toBe(fileRevision);
  });

  test("an unreadable document and a bad document are reported", async () => {
    const library = libraryOf(1_000_000);
    const client = {};
    const failures: [string, string][] = [];
    library.setFailureHandler((name, error) => failures.push([name, error.kind]));
    library.register("missing", { kind: "geoJSONURL", url: "https://example.invalid/missing.geojson", identity: undefined });
    library.register("bad", { kind: "geoJSON", document: "not json", identity: "bad" });
    await settle(library, client, ["missing", "bad"]);
    expect(library.failure("missing")?.kind).toBe("unreadableFile");
    expect(library.failure("bad")).toEqual({ kind: "invalidGeoJSON", error: { kind: "invalidJSON" } });
    expect(failures.sort()).toEqual([
      ["bad", "invalidGeoJSON"],
      ["missing", "unreadableFile"],
    ]);
  });

  test("a GeoJSON document is read into its shapes, at a URL, as text, as bytes and as an object", async () => {
    const point = '{"type": "Point", "coordinates": [37.6, 55.7]}';
    const library = libraryOf(1_000_000, { "https://example.invalid/point.geojson": point });
    const client = {};
    library.register("url", { kind: "geoJSONURL", url: "https://example.invalid/point.geojson", identity: undefined });
    library.register("text", { kind: "geoJSON", document: point, identity: "point" });
    library.register("bytes", { kind: "geoJSON", document: new TextEncoder().encode(point), identity: "point" });
    library.register("object", { kind: "geoJSON", document: JSON.parse(point) as object, identity: "point" });
    const names = ["url", "text", "bytes", "object"];
    await settle(library, client, names);
    for (const name of names) {
      const content = frame(library, client, names).get(name)?.content;
      expect(content?.pointCount).toBe(1);
      expect(content?.pointCoordinate(0)).toEqual(geoCoordinate(55.7, 37.6));
    }
  });
});
