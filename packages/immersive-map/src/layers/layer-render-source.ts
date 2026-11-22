// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { ImmersiveMapLayer } from "./immersive-map-layer.ts";
import type { ImmersiveMapLayersController } from "./immersive-map-layers-controller.ts";
import type { LayerSourceLibrary } from "./sources/layer-source-library.ts";

/**
 * The one seam between the layers' drawing and whoever holds the app's
 * layers, the Swift `LayerRenderSource`: the map over the app's controller,
 * an export over the layers it was handed. The frame reads it once.
 */
export interface LayerRenderSource {
  /** The layers to draw, in the order they draw. */
  readonly currentLayers: readonly ImmersiveMapLayer[];
  /** Where the layers' sources are registered and read, `undefined` when there are no layers. */
  readonly sourceLibrary: LayerSourceLibrary | undefined;
}

/**
 * Layers that do not change: what a picture or a video is made with. The
 * layers are the controller's as they are when this is made. Their sources
 * stay the controller's own.
 */
export class FixedLayerRenderSource implements LayerRenderSource {
  readonly currentLayers: readonly ImmersiveMapLayer[];
  readonly sourceLibrary: LayerSourceLibrary | undefined;

  constructor(controller?: ImmersiveMapLayersController) {
    this.currentLayers = controller?.layers ?? [];
    this.sourceLibrary = controller?.library;
  }
}

/** The layers of the controller as they are at each frame: the map's own source. */
export class ControllerLayerRenderSource implements LayerRenderSource {
  constructor(private readonly controller: ImmersiveMapLayersController) {}

  get currentLayers(): readonly ImmersiveMapLayer[] {
    return this.controller.layers;
  }

  get sourceLibrary(): LayerSourceLibrary {
    return this.controller.library;
  }
}
