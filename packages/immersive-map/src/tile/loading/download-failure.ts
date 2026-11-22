// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** The loader's download vocabulary (the Swift `TileDownloader.DownloadFailure`). */
export type DownloadFailure =
  | { kind: "missingAuthorizationToken" }
  | { kind: "nonHTTPResponse" }
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "notFound" }
  | { kind: "gone" }
  | { kind: "rateLimited"; retryAfter: number | undefined }
  | { kind: "server"; statusCode: number }
  | { kind: "client"; statusCode: number }
  | { kind: "emptyBody" }
  | { kind: "network" }
  /**
   * The archive itself cannot be read: not at its URL (404 or 410 on the
   * archive), or not a PMTiles archive the client understands. Distinct
   * from `notFound`, one tile the archive does not carry: a missing archive
   * must back off and retry, never be remembered as a planet of empty tiles.
   */
  | { kind: "archiveUnavailable" };

/** Why a load failed, for the retry policy (the Swift `TileRetryFailureReason`). */
export type TileRetryFailureReason =
  | { kind: "download"; failure: DownloadFailure }
  | { kind: "parseFailed" }
  /** The prepared tile could not become GPU state. Transient: backed off like a network error. */
  | { kind: "materializeFailed" }
  /** The watchdog retired the load: a stage held its slot past its deadline. */
  | { kind: "stalled"; stage: string };

export function downloadFailureDescription(failure: DownloadFailure): string {
  switch (failure.kind) {
    case "missingAuthorizationToken":
      return "missing_authorization_token";
    case "nonHTTPResponse":
      return "non_http_response";
    case "notFound":
      return "not_found";
    case "rateLimited":
      return failure.retryAfter !== undefined ? `rate_limited(retry_after:${failure.retryAfter})` : "rate_limited";
    case "server":
      return `server(${failure.statusCode})`;
    case "client":
      return `client(${failure.statusCode})`;
    case "emptyBody":
      return "empty_body";
    case "archiveUnavailable":
      return "archive_unavailable";
    default:
      return failure.kind;
  }
}

export function retryFailureDescription(reason: TileRetryFailureReason): string {
  switch (reason.kind) {
    case "parseFailed":
      return "parse_failed";
    case "materializeFailed":
      return "materialize_failed";
    case "stalled":
      return `stalled_${reason.stage}`;
    case "download":
      return downloadFailureDescription(reason.failure);
  }
}
