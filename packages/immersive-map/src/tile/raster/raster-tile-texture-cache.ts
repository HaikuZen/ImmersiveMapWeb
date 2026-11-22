// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The raster tiles' textures from frame to frame, the bookkeeping of the
 * Swift `RasterTileRenderSubsystem` (`Baked`, `keepTextures`,
 * `freeTexture`, `frameCommitted`), apart from the GPU so it is tested
 * alone. A tile keeps its texture from frame to frame and is drawn into it
 * again only when what the texture shows would change: another tile object
 * in the slot (a new load of it), another size, or another bake signature
 * (`rasterBakeSignature`). A texture is recorded as drawn only once the
 * frame that draws it is committed.
 */

/** One source's ask for a texture this frame. */
export interface RasterTextureRequest<R> {
  readonly key: string;
  /** The tile object drawn: a texture is never another object's, even of the same tile. */
  readonly resident: R;
  readonly size: number;
  readonly signature: number;
}

export interface RasterTextureAssignment<T> {
  readonly texture: T;
  /** The texture must be drawn into this frame. */
  readonly needsBake: boolean;
}

/** A tile's texture as it was last drawn: by which tile object, at which size, from which signature, `undefined` until the draw is committed. */
interface Baked<R, T> {
  readonly resident: R;
  readonly size: number;
  signature: number | undefined;
  readonly texture: T;
}

export class RasterTextureCache<R, T> {
  /**
   * How many free textures a size keeps: the frames of a pan, where the
   * need moves by a few.
   */
  static readonly poolSlack = 16;

  /** The textures of the tiles drawn in raster slots, as last drawn, by `tileKey`. */
  private baked = new Map<string, Baked<R, T>>();
  /** The textures of the tiles that left the raster slots, by size, for the next ones. */
  private readonly free = new Map<number, T[]>();

  constructor(
    private readonly make: (size: number) => T,
    private readonly dispose: (texture: T) => void,
  ) {}

  /**
   * Each request's texture: its own as last drawn when it has one of its
   * size, else a free one (or a new one), drawn into again when anything
   * it shows changed. The textures of the tiles not asked for go free, a
   * size's free textures kept to `poolSlack` and the rest disposed. With no
   * request at all, every texture is disposed.
   */
  assign(requests: readonly RasterTextureRequest<R>[]): RasterTextureAssignment<T>[] {
    const assignments: RasterTextureAssignment<T>[] = [];
    const kept = new Map<string, Baked<R, T>>();
    for (const request of requests) {
      const previous = this.baked.get(request.key);
      let texture: T;
      let needsBake: boolean;
      if (previous && previous.size === request.size) {
        texture = previous.texture;
        needsBake = previous.resident !== request.resident || previous.signature !== request.signature;
      } else {
        texture = this.freeTexture(request.size);
        needsBake = true;
      }
      assignments.push({ texture, needsBake });
      kept.set(request.key, {
        resident: request.resident,
        size: request.size,
        signature: needsBake ? undefined : previous?.signature,
        texture,
      });
    }
    for (const [key, baked] of this.baked) {
      if (kept.get(key)?.texture === baked.texture) continue;
      const free = this.free.get(baked.size) ?? [];
      if (free.length < RasterTextureCache.poolSlack) free.push(baked.texture);
      else this.dispose(baked.texture);
      this.free.set(baked.size, free);
    }
    this.baked = kept;
    // Out of the raster rings, every texture goes.
    if (kept.size === 0) this.disposeFree();
    return assignments;
  }

  /** The frame that drew `texture` for `key` from `signature` is committed: its texture is drawn. */
  drawn(key: string, texture: T, signature: number): void {
    const baked = this.baked.get(key);
    if (baked && baked.texture === texture) baked.signature = signature;
  }

  /** The textures held, drawn and free: what the cache keeps alive. */
  get textureCount(): number {
    let count = this.baked.size;
    for (const free of this.free.values()) count += free.length;
    return count;
  }

  /** Lets go of every texture: the tiles still in raster slots draw theirs again. */
  clear(): void {
    for (const baked of this.baked.values()) this.dispose(baked.texture);
    this.baked.clear();
    this.disposeFree();
  }

  private freeTexture(size: number): T {
    return this.free.get(size)?.pop() ?? this.make(size);
  }

  private disposeFree(): void {
    for (const free of this.free.values()) for (const texture of free) this.dispose(texture);
    this.free.clear();
  }
}
