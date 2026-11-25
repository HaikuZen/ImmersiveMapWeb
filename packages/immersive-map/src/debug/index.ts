// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * `@artembobkin/immersive-map/debug`: the debug panel drawn over the map, kept
 * apart from the engine so a page that imports `@artembobkin/immersive-map` alone
 * carries nothing of it (the Swift `ImmersiveMapDebug` product). The engine
 * holds what the panel reads and drags and the slot it fills
 * (`ImmersiveMapDebugPanel`), and this entry fills it:
 *
 * ```ts
 * import { ImmersiveMap } from "@artembobkin/immersive-map";
 * import { ImmersiveMapDebugPanel } from "@artembobkin/immersive-map/debug";
 *
 * const map = await ImmersiveMap.create({ container, debugPanel: ImmersiveMapDebugPanel.hud });
 * ```
 *
 * `hud/` is the panel's DOM, `panel/` the planners that turn a dragged
 * control into settings and the settings export, `overlay/` the overlay
 * drawn over the map and the HUD's texts, and the runtime wires them to the
 * engine (`ImmersiveMapDebugOverlayRuntime`).
 */

import type { ImmersiveMapDebugPanel as ImmersiveMapDebugPanelValue } from "../ui/immersive-map-debug-panel.ts";
import { ImmersiveMapDebugOverlayRuntime } from "./immersive-map-debug-overlay-runtime.ts";

export type ImmersiveMapDebugPanel = ImmersiveMapDebugPanelValue;

export const ImmersiveMapDebugPanel = {
  /**
   * The debug HUD: the camera's coordinates and the frame's diagnostics,
   * the tile and terrain lists, the overlays (tile borders, the tile grid,
   * the label boxes, the axes) and the controls over the settings,
   * as a rail over the map's leading edge.
   */
  hud: Object.freeze<ImmersiveMapDebugPanelValue>({
    makeRuntime: (host) => new ImmersiveMapDebugOverlayRuntime(host),
  }),
} as const;
