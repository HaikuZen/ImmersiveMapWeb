// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The transport: one PMTiles archive, read by `PMTilesArchiveClient`, and
 * the archive's answers translated into the loader's download vocabulary.
 * A port of the Swift `TileDownloader`. Runs in a tile worker.
 */

import { ArchiveFailure, type PMTilesArchiveClient } from "./archive-client.ts";
import type { DownloadFailure } from "./download-failure.ts";
import type { Tile } from "../tile.ts";

export type DownloadResult = { ok: true; bytes: Uint8Array<ArrayBuffer>; etag: string | undefined } | { ok: false; failure: DownloadFailure };

/**
 * Throttles a per-tile warning to one line per interval: a blocked viewport
 * is thirty tiles refused at once, all carrying the same news.
 */
export class NoticeThrottle {
  static readonly interval = 60;
  static readonly rateLimit = new NoticeThrottle();
  static readonly authorization = new NoticeThrottle();
  static readonly archiveDepth = new NoticeThrottle();
  static readonly archiveUnreadable = new NoticeThrottle();
  static readonly overviewUnreadable = new NoticeThrottle();
  private lastLoggedAt: number | undefined;

  shouldLog(now = performance.now() / 1000): boolean {
    if (this.lastLoggedAt !== undefined && now - this.lastLoggedAt < NoticeThrottle.interval) return false;
    this.lastLoggedAt = now;
    return true;
  }

  reset(): void {
    this.lastLoggedAt = undefined;
  }
}

function serverMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "message" in parsed && typeof parsed.message === "string" && parsed.message.length > 0) return parsed.message;
  } catch {
    // Not JSON: no message.
  }
  return undefined;
}

/** The sentence to show comes from the tile service: the engine ships frozen inside someone's app, the service is a config reload away. */
export function rateLimitMessage(body: string): string {
  const message = serverMessage(body);
  return message
    ? `ImmersiveMap: tile requests are being rate limited. ${message}`
    : "ImmersiveMap: tile requests are being rate limited (HTTP 429), so tiles will be missing until the limit clears.";
}

export function authorizationFailureMessage(statusCode: number, url: string, body: string): string {
  const reason = statusCode === 401 ? "unauthorized" : "forbidden";
  let host: string | undefined;
  try {
    host = new URL(url).host;
  } catch {
    host = undefined;
  }
  let message = `ImmersiveMap: the tile archive server${host ? ` at ${host}` : ""} returned HTTP ${statusCode} (${reason}).`;
  if (host?.endsWith("immersivemap.dev")) {
    message += " The hosted archive is public and needs no credential, so check that the tile source sends no stale Authorization header.";
  } else {
    message += " Check the credential the tile source sends: a key in the archive URL's query, or an Authorization header in the tile source's headers.";
  }
  message += " Tiles will be missing until the credential is fixed.";
  const fromServer = serverMessage(body);
  if (fromServer) message += ` The server says: ${fromServer}`;
  return message;
}

export class TileDownloader {
  constructor(private readonly archive: PMTilesArchiveClient) {}

  archiveETag(): Promise<string | undefined> {
    return this.archive.archiveETag();
  }

  archiveMaximumZoom(): Promise<number> {
    return this.archive.maximumZoom();
  }

  async download(tile: Tile, signal?: AbortSignal): Promise<DownloadResult> {
    try {
      const outcome = await this.archive.tileBytes(tile.z, tile.x, tile.y, signal);
      switch (outcome.kind) {
        case "tile":
          if (outcome.bytes.length === 0) return { ok: false, failure: { kind: "emptyBody" } };
          return { ok: true, bytes: outcome.bytes, etag: outcome.etag };
        case "missing":
          // Absent from the directory: known empty, with the long cooldown of a 404.
          return { ok: false, failure: { kind: "notFound" } };
        case "outsideZoomRange":
          if (NoticeThrottle.archiveDepth.shouldLog()) {
            console.warn(`ImmersiveMap: tile ${tile.z}/${tile.x}/${tile.y} is outside the zoom range of the tile archive, so it renders empty. Set the tile maximum zoom level to the archive's depth.`);
          }
          return { ok: false, failure: { kind: "notFound" } };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ArchiveFailure) return { ok: false, failure: this.failure(error) };
      return { ok: false, failure: { kind: "network" } };
    }
  }

  /** A status on the archive URL maps like the same status on a tile URL did, except 404 and 410: the archive going missing. */
  private failure(error: ArchiveFailure): DownloadFailure {
    const failure = error.failure;
    const url = typeof this.archive.source === "string" ? this.archive.source : "a local file";
    switch (failure.kind) {
      case "http": {
        const status = failure.statusCode;
        if (status === 401 || status === 403) {
          if (NoticeThrottle.authorization.shouldLog()) console.warn(authorizationFailureMessage(status, url, failure.body));
          return { kind: status === 401 ? "unauthorized" : "forbidden" };
        }
        if (status === 404 || status === 410) {
          if (NoticeThrottle.archiveUnreadable.shouldLog()) {
            console.warn(`ImmersiveMap: the tile archive at ${url} answered HTTP ${status}. Tiles will be missing until the archive is reachable at that URL.`);
          }
          return { kind: "archiveUnavailable" };
        }
        if (status === 429) {
          if (NoticeThrottle.rateLimit.shouldLog()) console.warn(rateLimitMessage(failure.body));
          return { kind: "rateLimited", retryAfter: failure.retryAfter };
        }
        if (status >= 500 && status <= 599) return { kind: "server", statusCode: status };
        return { kind: "client", statusCode: status };
      }
      case "archiveUnreadable":
        if (NoticeThrottle.archiveUnreadable.shouldLog()) {
          console.warn(`ImmersiveMap: the tile archive at ${url} could not be read (${failure.reason}). Check that it is a PMTiles v3 archive of gzip or uncompressed MVT tiles.`);
        }
        return { kind: "archiveUnavailable" };
      case "nonHTTPResponse":
        return { kind: "nonHTTPResponse" };
      case "network":
        return { kind: "network" };
    }
  }
}
