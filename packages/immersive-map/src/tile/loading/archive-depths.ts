// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The deepest zoom of every archive the map has read, kept across sessions
 * (a port of the Swift `TileArchiveDepths`, which keeps one file per archive
 * in the caches directory; here one `localStorage` entry per archive). A map
 * plans its coverage by the depth it kept (`ImmersiveMapSettings
 * .resolvingArchiveDepth`), and the tile workers read the header once a
 * session: an archive that turns out deeper or shallower is recorded, and
 * the map rebuilds what the depth decides.
 */

/** Where the depths are kept: `localStorage` in a page, a map in a test. */
export interface DepthStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = "immersive-map/archive-depth/";

export class TileArchiveDepths {
  private readonly depths = new Map<string, number>();

  constructor(private readonly storage: DepthStorage | undefined = globalThis.localStorage) {}

  /** The deepest zoom of the archive, `null` when it was never read. */
  maximumZoom(sourceRevision: string): number | null {
    const known = this.depths.get(sourceRevision);
    if (known !== undefined) return known;
    let text: string | null = null;
    try {
      text = this.storage?.getItem(PREFIX + sourceRevision) ?? null;
    } catch {
      // Storage blocked by the page's policy: nothing was kept.
    }
    const depth = text === null ? Number.NaN : Number.parseInt(text, 10);
    if (!Number.isInteger(depth) || depth < 0) return null;
    this.depths.set(sourceRevision, depth);
    return depth;
  }

  /** Records a depth read from the header. True when it differs from the one kept. */
  observe(maximumZoom: number, sourceRevision: string): boolean {
    if (this.maximumZoom(sourceRevision) === maximumZoom) return false;
    this.depths.set(sourceRevision, maximumZoom);
    try {
      this.storage?.setItem(PREFIX + sourceRevision, String(maximumZoom));
    } catch {
      // Kept for this session only.
    }
    return true;
  }
}
