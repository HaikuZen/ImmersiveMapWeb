// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The relief's seams faked for the tests, the stand-ins of the Swift tests'
// Metal device and URL source: textures as plain objects that keep their
// texels, a terrain source whose answers the test hands out, and a clock the
// test moves. Imported by the relief's tests only.

import { defaultTileSettings, resolvedMaximumZoomLevel, type GroundReliefSettings } from "../../../configuration/tile-settings.ts";
import { defaultTerrainOcclusion } from "../../../style/theme.ts";
import { type Tile, tileKey } from "../../tile.ts";
import { GroundReliefFrameState } from "../frame/ground-relief-frame-state.ts";
import { GroundReliefOcclusionKey } from "../store/ground-relief-occlusion.ts";
import { GroundReliefStore, type GroundReliefTextures } from "../store/ground-relief-store.ts";
import type { GroundReliefTerrainResponse, GroundReliefTerrainSource } from "../store/ground-relief-terrain-source.ts";
import type { ReliefTexture } from "../store/ground-relief-tile.ts";
import { halfBitsToFloat, halves } from "../store/half-float.ts";

/** A texture of the fakes: its texels kept as the GPU would hold them. */
export interface FakeReliefTexture extends ReliefTexture {
  readonly size: number;
  readonly texels: Uint16Array;
}

/** Textures as plain objects, every write and release recorded. */
export class FakeReliefTextures implements GroundReliefTextures {
  private nextId = 1;
  readonly made: FakeReliefTexture[] = [];
  readonly released: ReliefTexture[] = [];
  readonly writes: { texture: ReliefTexture; x: number; y: number; width: number; height: number }[] = [];
  readonly occlusions: Tile[] = [];

  heights(size: number, values: Uint16Array): ReliefTexture {
    // A copy, as an upload is: the store's halves change apart from it until a weld is written.
    const texture: FakeReliefTexture = { id: this.nextId++, byteLength: size * size * 2, size, texels: values.slice() };
    this.made.push(texture);
    return texture;
  }

  writeHeights(texture: ReliefTexture, x: number, y: number, width: number, height: number, values: Uint16Array<ArrayBuffer>): void {
    this.writes.push({ texture, x, y, width, height });
    const fake = texture as FakeReliefTexture;
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) fake.texels[(y + row) * fake.size + x + column] = values[row * width + column]!;
    }
  }

  occlusion(tile: Tile, _terrain: unknown, key: GroundReliefOcclusionKey): { texture: ReliefTexture; milliseconds: number } | undefined {
    if (!GroundReliefOcclusionKey.computes(key)) return undefined;
    this.occlusions.push(tile);
    return { texture: { id: this.nextId++, byteLength: key.resolution * key.resolution }, milliseconds: 0.25 };
  }

  release(texture: ReliefTexture): void {
    this.released.push(texture);
  }

  /** A texel of a texture as the GPU holds it, in metres. */
  static metres(texture: ReliefTexture, x: number, y: number): number {
    const fake = texture as FakeReliefTexture;
    return halfBitsToFloat(fake.texels[y * fake.size + x]!);
  }
}

/** What the fake source answers for a tile: heights in metres row by row from the north edge, no such tile, or a failure. */
export type FakeAnswer = { readonly metres: readonly number[] } | "missing" | "fail";

/** A tile of one height, `size` texels a side. */
export function flatAnswer(metres: number, size = 2): FakeAnswer {
  return { metres: new Array<number>(size * size).fill(metres) };
}

/**
 * A terrain source whose loads wait until the test answers them
 * (`answerAll`), by `answer`, which the test may change between answers.
 * Every tile asked for is recorded in order.
 */
export class FakeTerrainSource implements GroundReliefTerrainSource {
  readonly asked: Tile[] = [];
  private pending: { tile: Tile; resolve: (response: GroundReliefTerrainResponse) => void; reject: (error: Error) => void }[] = [];

  constructor(public answer: (tile: Tile) => FakeAnswer) {}

  heights(tile: Tile, _signal: AbortSignal): Promise<GroundReliefTerrainResponse> {
    this.asked.push(tile);
    return new Promise((resolve, reject) => this.pending.push({ tile, resolve, reject }));
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Answers every load waiting now, then lets the store take the answers in. */
  async answerAll(): Promise<void> {
    const waiting = this.pending;
    this.pending = [];
    for (const load of waiting) {
      const answer = this.answer(load.tile);
      if (answer === "fail") load.reject(new Error(`unreachable ${tileKey(load.tile)}`));
      else if (answer === "missing") load.resolve({ kind: "missing" });
      else {
        const size = Math.round(Math.sqrt(answer.metres.length));
        load.resolve({ kind: "heights", heights: { size, halves: halves(answer.metres), minMetres: Math.min(...answer.metres), maxMetres: Math.max(...answer.metres) } });
      }
    }
    await flushMicrotasks();
  }
}

/** Lets every promise already settled run its callbacks. */
export async function flushMicrotasks(): Promise<void> {
  for (let step = 0; step < 4; step++) await Promise.resolve();
}

/** A clock in seconds the test moves by hand. */
export class FakeClock {
  constructor(public seconds = 1000) {}
  readonly now = (): number => this.seconds;
}

/** A relief over a fake store, as the map makes one (`GroundReliefRuntime`), the Swift tests' `makeTestRelief`. */
export interface TestRelief {
  readonly state: GroundReliefFrameState;
  readonly store: GroundReliefStore;
  readonly source: FakeTerrainSource;
  readonly textures: FakeReliefTextures;
  readonly clock: FakeClock;
}

export function makeTestRelief(
  settings: GroundReliefSettings,
  answer: (tile: Tile) => FakeAnswer,
  options: { readonly deepestTileZoom?: number; readonly clock?: FakeClock } = {},
): TestRelief {
  const source = new FakeTerrainSource(answer);
  const textures = new FakeReliefTextures();
  const clock = options.clock ?? new FakeClock();
  const store = new GroundReliefStore(settings, source, textures, GroundReliefOcclusionKey.ofStyle(defaultTerrainOcclusion), clock.now);
  // The occlusion's spread over frames runs at once.
  store.schedule = (step) => step();
  const deepest = options.deepestTileZoom ?? resolvedMaximumZoomLevel(defaultTileSettings.coverage);
  const state = new GroundReliefFrameState(store, settings, deepest);
  return { state, store, source, textures, clock };
}

/**
 * Asks for the tiles and answers their loads, as frames do, until
 * `condition` holds or `rounds` frames went by: whether it held. The
 * store keeps what a frame asks for and no more, so a test's frames ask for
 * every tile it wants at once.
 */
export async function loadUntil(relief: TestRelief, tiles: readonly Tile[], condition: () => boolean, rounds = 12): Promise<boolean> {
  for (let round = 0; round < rounds; round++) {
    relief.store.requestTiles(tiles);
    if (condition()) return true;
    await relief.source.answerAll();
  }
  relief.store.requestTiles(tiles);
  return condition();
}
