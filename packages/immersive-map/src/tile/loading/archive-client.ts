// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Reads tiles out of one PMTiles archive over HTTP range requests, or out of
 * a `Blob` (a file the user picked, an archive the app fetched whole) for an
 * offline map. A port of the Swift `PMTilesArchiveClient`: the header and
 * the root directory are fetched once (they share the first 16 KiB), the
 * leaf directories the client needed are kept in an LRU (in the Wasm
 * `Archive`), and a tile is one range request. Concurrent lookups on a cold
 * client share one header request and one request per leaf.
 *
 * One deviation, forced by CORS: the Swift client sends `If-Match` with the
 * index's ETag, which a host's CORS policy usually does not allow (the
 * hosted archive allows `range` only). The replacement of the archive is
 * caught the same way without it: a 206 or 200 whose ETag differs from the
 * index's, or a 412 or 416, resets the index and retries the tile once.
 */

import type { Archive as WasmArchive } from "../../wasm/worker_wasm/worker_wasm.js";

/** What the client needs of the Wasm module, injected so the module is loaded once per worker. */
export interface ArchiveModule {
  Archive: new (headerBytes: Uint8Array) => WasmArchive;
  LocateKind: { readonly Tile: number; readonly NeedLeaf: number; readonly Missing: number };
  tileId(z: number, x: number, y: number): number;
}

export type ArchiveOutcome =
  | { kind: "tile"; bytes: Uint8Array<ArrayBuffer>; etag: string }
  | { kind: "missing" }
  | { kind: "outsideZoomRange" };

export class ArchiveFailure extends Error {
  constructor(
    readonly failure:
      | { kind: "http"; statusCode: number; body: string; retryAfter: number | undefined }
      | { kind: "network"; description: string }
      | { kind: "nonHTTPResponse" }
      | { kind: "archiveUnreadable"; reason: string },
  ) {
    super(failure.kind === "archiveUnreadable" ? failure.reason : failure.kind);
  }
}

const INITIAL_FETCH_BYTES = 16_384;
const HEADER_BYTES = 127;
const ARCHIVE_REPLACED = "archive replaced";
const COMPRESSION_NONE = 1;
const COMPRESSION_GZIP = 2;

interface Index {
  archive: WasmArchive;
  etag: string | undefined;
  minZoom: number;
  maxZoom: number;
}

/** A weak validator (`W/"..."`) proves nothing about the bytes, so it is not an ETag here. */
export function normalizedETag(raw: string | null | undefined): string | undefined {
  if (!raw || raw.startsWith("W/")) return undefined;
  return raw;
}

/** "bytes 0-16383/123456" to 0. */
export function rangeStart(contentRange: string): number | undefined {
  const bytes = contentRange.split(" ").pop();
  const start = bytes?.split("-")[0];
  const value = start === undefined ? NaN : Number(start);
  return Number.isFinite(value) ? value : undefined;
}

export async function inflate(bytes: Uint8Array<ArrayBuffer>, compression: number): Promise<Uint8Array<ArrayBuffer>> {
  if (compression === COMPRESSION_NONE || compression === 0) return bytes;
  if (compression !== COMPRESSION_GZIP) throw new Error(`compression ${compression} is not supported`);
  // Fed through the writer, not Blob.stream(): 35% faster.
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

export class PMTilesArchiveClient {
  private index: Index | undefined;
  private indexPromise: Promise<Index> | undefined;
  private readonly leafPromises = new Map<number, Promise<void>>();

  constructor(
    private readonly module: ArchiveModule,
    readonly source: string | Blob,
    private readonly requestHeaders: Readonly<Record<string, string>> = {},
  ) {}

  /** The bytes of tile z/x/y, decompressed, or the reason there are none. */
  async tileBytes(z: number, x: number, y: number, signal?: AbortSignal): Promise<ArchiveOutcome> {
    try {
      return await this.lookup(z, x, y, signal);
    } catch (error) {
      if (error instanceof ArchiveFailure && error.failure.kind === "archiveUnreadable" && error.failure.reason === ARCHIVE_REPLACED) {
        // The archive was replaced under us: reload the index once.
        this.resetIndex();
        return this.lookup(z, x, y, signal);
      }
      throw error;
    }
  }

  /** The ETag the header was read under: what tells one upload of the archive from the next. */
  async archiveETag(): Promise<string | undefined> {
    return (await this.loadIndex()).etag;
  }

  async maximumZoom(): Promise<number> {
    return (await this.loadIndex()).maxZoom;
  }

  private async lookup(z: number, x: number, y: number, signal?: AbortSignal): Promise<ArchiveOutcome> {
    const index = await this.loadIndex();
    if (z < index.minZoom || z > index.maxZoom) return { kind: "outsideZoomRange" };
    const { LocateKind } = this.module;
    for (let depth = 0; ; depth++) {
      const located = index.archive.locate(z, x, y);
      const { kind, offset, length } = located;
      located.free();
      if (kind === LocateKind.Missing) return { kind: "missing" };
      if (kind === LocateKind.Tile) {
        const body = await this.fetch(offset, length, index.etag, signal);
        let bytes: Uint8Array<ArrayBuffer>;
        try {
          bytes = await inflate(body.bytes, index.archive.tileCompression);
        } catch (error) {
          throw new ArchiveFailure({ kind: "archiveUnreadable", reason: `tile ${z}/${x}/${y}: ${String(error)}` });
        }
        return { kind: "tile", bytes, etag: `${index.etag ?? "-"}/${this.module.tileId(z, x, y)}` };
      }
      if (depth >= 3) throw new ArchiveFailure({ kind: "archiveUnreadable", reason: "leaf directories nested deeper than three levels" });
      await this.loadLeaf(index, offset, length);
    }
  }

  private loadIndex(): Promise<Index> {
    if (this.index) return Promise.resolve(this.index);
    if (!this.indexPromise) {
      const started = this.fetchIndex().then(
        (index) => {
          if (this.indexPromise === started) {
            this.index = index;
            this.indexPromise = undefined;
          }
          return index;
        },
        (error: unknown) => {
          if (this.indexPromise === started) this.indexPromise = undefined;
          throw error;
        },
      );
      this.indexPromise = started;
    }
    return this.indexPromise;
  }

  private async fetchIndex(): Promise<Index> {
    const head = await this.fetch(0, INITIAL_FETCH_BYTES, undefined, undefined, true);
    let archive: WasmArchive;
    try {
      archive = new this.module.Archive(head.bytes.subarray(0, HEADER_BYTES));
    } catch (error) {
      throw new ArchiveFailure({ kind: "archiveUnreadable", reason: `header: ${String(error)}` });
    }
    const rootStart = archive.rootOffset;
    const rootEnd = rootStart + archive.rootLength;
    // A root directory past the first 16 KiB breaks the specification's
    // promise, but the archive is still readable with one more request.
    const rootBytes = rootEnd <= head.bytes.length ? head.bytes.subarray(rootStart, rootEnd) : (await this.fetch(rootStart, archive.rootLength, head.etag)).bytes;
    try {
      archive.setRoot(await inflate(rootBytes, archive.internalCompression));
    } catch (error) {
      throw new ArchiveFailure({ kind: "archiveUnreadable", reason: `root directory: ${String(error)}` });
    }
    return { archive, etag: head.etag, minZoom: archive.minZoom, maxZoom: archive.maxZoom };
  }

  private loadLeaf(index: Index, offset: number, length: number): Promise<void> {
    let pending = this.leafPromises.get(offset);
    if (!pending) {
      pending = (async () => {
        const body = await this.fetch(offset, length, index.etag);
        try {
          index.archive.addLeaf(offset, await inflate(body.bytes, index.archive.internalCompression));
        } catch (error) {
          throw new ArchiveFailure({ kind: "archiveUnreadable", reason: `leaf directory at ${offset}: ${String(error)}` });
        }
      })().finally(() => this.leafPromises.delete(offset));
      this.leafPromises.set(offset, pending);
    }
    return pending;
  }

  private resetIndex(): void {
    this.index?.archive.free();
    this.index = undefined;
    this.indexPromise = undefined;
    this.leafPromises.clear();
  }

  /**
   * One range request, checked: a 206 whose body is the range, a 200 the
   * server answered with the whole file (sliced), or the signal that the
   * archive changed (412, 416, or an ETag other than the index's).
   */
  private async fetch(
    offset: number,
    length: number,
    expectedETag: string | undefined,
    signal?: AbortSignal,
    allowShort = false,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; etag: string | undefined }> {
    if (typeof this.source !== "string") {
      // A Blob answers like a server without an ETag. A range past the end
      // comes back short, as the initial fetch of a small archive expects.
      const bytes = new Uint8Array(await this.source.slice(offset, offset + length).arrayBuffer());
      return { bytes, etag: undefined };
    }
    let response: Response;
    try {
      response = await fetch(this.source, {
        headers: { ...this.requestHeaders, Range: `bytes=${offset}-${offset + length - 1}` },
        // Range responses must see the live archive: no HTTP cache.
        cache: "no-store",
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ArchiveFailure({ kind: "network", description: String(error) });
    }
    const etag = normalizedETag(response.headers.get("ETag"));
    if (response.status === 206) {
      if (expectedETag && etag && etag !== expectedETag) throw new ArchiveFailure({ kind: "archiveUnreadable", reason: ARCHIVE_REPLACED });
      const contentRange = response.headers.get("Content-Range");
      const start = contentRange ? rangeStart(contentRange) : undefined;
      if (start !== undefined && start !== offset) {
        throw new ArchiveFailure({ kind: "archiveUnreadable", reason: `range request answered from byte ${start}, asked for ${offset}` });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!allowShort && bytes.length < length) throw new ArchiveFailure({ kind: "archiveUnreadable", reason: "short range response" });
      return { bytes: bytes.length > length ? bytes.subarray(0, length) : bytes, etag };
    }
    if (response.status === 200) {
      if (expectedETag && etag && etag !== expectedETag) throw new ArchiveFailure({ kind: "archiveUnreadable", reason: ARCHIVE_REPLACED });
      const whole = new Uint8Array(await response.arrayBuffer());
      if (whole.length < offset) throw new ArchiveFailure({ kind: "archiveUnreadable", reason: "range request ignored and the body is shorter than the range" });
      return { bytes: whole.subarray(offset, Math.min(whole.length, offset + length)), etag };
    }
    if (response.status === 412 || response.status === 416) throw new ArchiveFailure({ kind: "archiveUnreadable", reason: ARCHIVE_REPLACED });
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfter = retryAfterHeader !== null && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) : undefined;
    throw new ArchiveFailure({ kind: "http", statusCode: response.status, body: await response.text().catch(() => ""), retryAfter });
  }
}
