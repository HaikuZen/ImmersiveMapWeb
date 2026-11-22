// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Which upload of the tile archive the map is reading, by the ETag the host
 * gives it, so an archive overwritten under the same URL is noticed. A port
 * of the Swift `TileArchiveVersion`.
 *
 * A prepared tile remembers the ETag it was parsed under (the archive's ETag
 * and the tile's id). The disk stage asks this class which ETag a tile must
 * carry, and an entry of another upload is passed over. The ETag is known
 * without a request: the last one seen is remembered and read at creation.
 * One header request per session then checks it, and every downloaded tile
 * confirms it. While the archive cannot be reached nothing is passed over:
 * a tile of an older upload is better than no tile. A host that sends no
 * ETag, and a local archive, are not checked at all.
 */

export class TileArchiveVersion {
  private isUnreachable = false;
  private hasStartedCheck = false;

  constructor(
    private archiveETag: string | undefined,
    private readonly tileId: (z: number, x: number, y: number) => number,
    private readonly remember: (etag: string | undefined) => void,
  ) {}

  /** The source ETag an entry must carry to answer a load now, `undefined` when any will do. */
  expectedSourceETag(z: number, x: number, y: number): string | undefined {
    if (this.isUnreachable || this.archiveETag === undefined) return undefined;
    const id = this.tileId(z, x, y);
    return id < 0 ? undefined : `${this.archiveETag}/${id}`;
  }

  /** True once: the caller then asks the archive for its ETag and reports the answer. */
  beginCheck(): boolean {
    if (this.hasStartedCheck) return false;
    this.hasStartedCheck = true;
    return true;
  }

  /** The archive answered with `etag` (from the header or a tile's source ETag). */
  recordArchiveETag(etag: string | undefined): void {
    this.isUnreachable = false;
    if (etag === this.archiveETag) return;
    this.archiveETag = etag;
    this.remember(etag);
  }

  /** A tile's source ETag carries the archive's before its last slash. */
  recordSourceETag(sourceETag: string | undefined): void {
    if (!sourceETag) return;
    const slash = sourceETag.lastIndexOf("/");
    if (slash < 0) return;
    const archive = sourceETag.slice(0, slash);
    this.recordArchiveETag(archive === "-" ? undefined : archive);
  }

  recordUnreachable(): void {
    this.isUnreachable = true;
  }
}
