// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import clipDistances from "./shaders/clip-distances.wgsl?raw";
import globe from "./shaders/globe.wgsl?raw";
import { clipDistanceVariant } from "./clip-distance-variant.ts";

/**
 * The source of a module that draws on the globe's surface, for the device:
 * the clip-distances directive first, the globe's projection and light
 * after `before` (the files the globe library does not depend on, such as
 * tile-shading.wgsl), then `main`, in the variant of the unroll's cut the
 * device runs (`clipDistanceVariant`). The order of each module's
 * `// requires:` line.
 */
export function globeModuleSource(hasClipDistances: boolean, before: readonly string[], main: string): string {
  return clipDistanceVariant([clipDistances, ...before, globe, main].join("\n"), hasClipDistances);
}
