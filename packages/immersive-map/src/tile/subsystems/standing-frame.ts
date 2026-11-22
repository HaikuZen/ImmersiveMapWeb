// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * What the buildings and the trees read of a frame: the placements they
 * stand on (the building coverage, `BuildingCoveragePlanner`), the flat
 * map's state and the clock their rise runs by, and their frame group
 * (tile/shaders/standing-frame.wgsl): the camera, the buildings' fog, the
 * shadows, the ground's fog and the trees' frame. The group is built again
 * when a shadow texture is made again (`ShadowGpuResources.generation`).
 */

import type { GroundReliefFrame } from "../relief/frame/ground-relief-frame.ts";
import type { ViewMode } from "../../camera/view-mode.ts";
import type { Mat4 } from "../../math/matrix.ts";
import type { FlatRenderState } from "../../presentation/resolved-presentation-state.ts";
import type { ShadowFrameRuntime } from "../../shadows/shadow-frame-runtime.ts";
import type { FlatResidentTile } from "../drawers/flat-map-surface-drawer.ts";
import type { PlaceTile } from "../placement/place-tile.ts";
import { TreeFrameUniformLayout, type StandingPipelines } from "../pipelines/standing-pipelines.ts";

export interface StandingFrameState {
  /** The building coverage's placements (`TilePlacementState.buildingPlaceTilesContext`). */
  readonly placements: readonly PlaceTile<FlatResidentTile>[];
  readonly renderSurfaceMode: ViewMode;
  readonly flatRenderState: FlatRenderState;
  /** The frame's clock in seconds, the rise's time. */
  readonly timeSeconds: number;
  /** The CPU camera matrix: the quarters out of its view draw nothing (`visibleQuarters`). */
  readonly projectionView: Mat4;
  /** The frame's ground relief, `undefined` on a map without one: the buildings stand on it where the frame is on it. */
  readonly relief?: GroundReliefFrame | undefined;
}

/**
 * The height no building or tree reaches, in the flat world's units: 2 km
 * at the equator, more than any tower at any latitude the map draws.
 */
export function standingCeiling(renderMapSize: number): number {
  return (renderMapSize * 2000) / 40_075_016.686;
}

export class StandingFrame {
  /** The fog the buildings and the trees draw with (`GroundFogUniform.resolveFrame` for buildings). */
  readonly buildingFogBuffer: GPUBuffer;
  /** The trees' frame (`TreeFrameUniformLayout`). */
  readonly treeFrameBuffer: GPUBuffer;
  private group: { generation: number; group: GPUBindGroup } | undefined;

  constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: StandingPipelines,
    /** The frame's camera uniform (`Camera` of standing-frame.wgsl). */
    readonly cameraBuffer: GPUBuffer,
    private readonly groundFogBuffer: GPUBuffer,
    readonly shadows: ShadowFrameRuntime,
    fogByteLength: number,
  ) {
    this.buildingFogBuffer = device.createBuffer({ label: "building fog", size: fogByteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.treeFrameBuffer = device.createBuffer({ label: "tree frame", size: TreeFrameUniformLayout.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** The frame group, built again on a new shadow texture. */
  bindGroup(): GPUBindGroup {
    const resources = this.shadows.resources;
    const generation = resources.generation;
    if (this.group?.generation !== generation) {
      this.group = {
        generation,
        group: this.device.createBindGroup({
          label: "standing frame",
          layout: this.pipelines.standingFrameLayout,
          entries: [
            { binding: 0, resource: { buffer: this.cameraBuffer } },
            { binding: 1, resource: { buffer: this.buildingFogBuffer } },
            { binding: 2, resource: { buffer: resources.shadowUniformBuffer } },
            { binding: 3, resource: resources.shadowMapView },
            { binding: 4, resource: resources.comparisonSampler },
            { binding: 5, resource: { buffer: this.groundFogBuffer } },
            { binding: 6, resource: { buffer: this.treeFrameBuffer } },
          ],
        }),
      };
    }
    return this.group.group;
  }

  destroy(): void {
    this.buildingFogBuffer.destroy();
    this.treeFrameBuffer.destroy();
  }
}

/** Whether two squares share ground: one holds the other, in the same world copy (the rise's hand-over). */
export function squaresOverlap(a: PlaceTile<FlatResidentTile>["placeIn"], b: PlaceTile<FlatResidentTile>["placeIn"]): boolean {
  if (a.worldWrap !== b.worldWrap) return false;
  const [coarse, fine] = a.tile.z <= b.tile.z ? [a.tile, b.tile] : [b.tile, a.tile];
  const shift = fine.z - coarse.z;
  return fine.x >> shift === coarse.x && fine.y >> shift === coarse.y;
}
