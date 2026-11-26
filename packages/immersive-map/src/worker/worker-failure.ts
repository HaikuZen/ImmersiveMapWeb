// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The error a worker's `error` event is: what its script threw, or, for a
 * script the browser could not load (it names no cause then), why that
 * happens. The usual cause is a bundle whose bundler wrote the worker's
 * path from the site's root while the bundle is served from a folder:
 * Vite's `build.lib` does so with its default `base` ("/").
 */
export function workerFailure(worker: string, event: Event): Error {
  const message = "message" in event && typeof event.message === "string" ? event.message : "";
  if (message !== "") return new Error(`ImmersiveMap: the ${worker} failed: ${message}`);
  return new Error(
    `ImmersiveMap: the ${worker}'s script did not load. The page's bundle names it at a path the server does not serve, ` +
      `as Vite's build.lib writes its workers' paths from the site's root with the default base ("/"): ` +
      `build the bundle with base set to the folder it is served from.`,
  );
}
