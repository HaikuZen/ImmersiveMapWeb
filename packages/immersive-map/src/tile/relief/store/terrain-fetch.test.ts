// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTerrainTile, type TerrainDecode, terrainTileURL } from "./terrain-fetch.ts";

const tile = { x: 3, y: 5, z: 4 };
const signal = new AbortController().signal;
const decoded = { size: 2, halves: new Uint16Array([0, 0x3c00, 0x4000, 0x63d0]), minMetres: 0, maxMetres: 1000 };
const decode: TerrainDecode = () => decoded;
const answering = (status: number, body: BodyInit = new Uint8Array([1, 2, 3])) => () => Promise.resolve(new Response(status === 204 ? null : body, { status }));

describe("a terrain tile fetched and decoded in a worker", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fills the template with the tile's address and resolves a relative one against the page", () => {
    expect(terrainTileURL("https://terrain.example/{z}/{x}/{y}.png", tile, undefined)).toBe("https://terrain.example/4/3/5.png");
    expect(terrainTileURL("terrain/{z}/{x}/{y}.webp", tile, "https://map.example/app/index.html")).toBe("https://map.example/app/terrain/4/3/5.webp");
    expect(terrainTileURL("terrain/{z}/{x}/{y}.webp", tile, undefined)).toBeUndefined();
  });

  it("decodes the bytes of a 2xx answer by the source's encoding", async () => {
    const seen: string[] = [];
    const result = await fetchTerrainTile("https://t.example/4/3/5.png", tile, "mapbox", "a", (bytes, encoding) => {
      seen.push(`${bytes.length} ${encoding}`);
      return decoded;
    }, signal, answering(200));
    expect(seen).toEqual(["3 mapbox"]);
    expect(result).toEqual({ kind: "heights", ...decoded });
  });

  it("takes a 404 for a tile the source does not have", async () => {
    expect(await fetchTerrainTile("https://t.example/x", tile, "terrarium", "b", decode, signal, answering(404))).toEqual({ kind: "missing" });
  });

  it("rejects another status or a request that does not arrive, to be tried again", async () => {
    await expect(fetchTerrainTile("https://t.example/x", tile, "terrarium", "c", decode, signal, answering(503))).rejects.toThrow("HTTP 503");
    await expect(fetchTerrainTile("https://t.example/x", tile, "terrarium", "c", decode, signal, answering(301))).rejects.toThrow("HTTP 301");
    await expect(fetchTerrainTile("https://t.example/x", tile, "terrarium", "c", decode, signal, () => Promise.reject(new TypeError("Failed to fetch")))).rejects.toThrow("Failed to fetch");
  });

  it("takes an image that does not decode for a missing tile, and says so once a source", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refuse: TerrainDecode = () => {
      throw new Error("unreadable image (neither PNG nor WebP)");
    };
    for (let i = 0; i < 3; i++) {
      expect(await fetchTerrainTile("https://t.example/x", tile, "terrarium", "d", refuse, signal, answering(200))).toEqual({ kind: "missing" });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("terrain tile 4/3/5 cannot be decoded (unreadable image (neither PNG nor WebP))");
    await fetchTerrainTile("https://t.example/x", tile, "terrarium", "e", refuse, signal, answering(200));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
