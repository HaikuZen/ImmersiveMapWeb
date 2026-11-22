// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The rank-depth constants of the ground and the roads, and the
 * tile-priority stencil: ports of the Swift `GlobeSurfaceDepthRank`,
 * `RoadRankDepth` and `TileSourceStencilPriority`. Mirrored by tile.wgsl.
 */

export type RoadStructureKind = "tunnel" | "ground" | "automobileGround" | "bridge";
export type RoadPassRole = "shadow" | "casing" | "fill" | "detail" | "overlay";

/** Draw order of the road structure buckets, also the arena's span order. */
export const roadStructureDrawOrder: readonly RoadStructureKind[] = ["tunnel", "ground", "automobileGround", "bridge"];
/** Draw order of the road phases inside one structure, also the arena's span order. */
export const roadPassRoleDrawOrder: readonly RoadPassRole[] = ["shadow", "casing", "fill", "detail", "overlay"];

export const GlobeSurfaceDepthRank = {
  /** One style rank step: a scale of the projection's depth for the flat ground. */
  layerDepthStep: 3.2e-6,
  /** The ribbons class sits one class band nearer than the fills: 256 styles and one step. */
  classDepthBand: 257 * 3.2e-6,
  /** The flat road buckets and the bridge overlay, nearer than both ground bands. */
  flatRoadsDepthOffset: 600 * 3.2e-6,
  /** The layers of the app's data. */
  appLayersRank: 1210,
  /** The labels painted on the map. */
  surfaceLabelsRank: 1220,
  /** The buildings, the models and the trees (`RenderCamera.realDepthScale`). */
  realGeometryRank: 1536,
} as const;

export const RoadRankDepth = (() => {
  const ranksPerBand = 12;
  const structureRoles: readonly RoadPassRole[] = ["shadow", "casing", "fill", "detail"];
  const bridgeOverlayBand = roadStructureDrawOrder.length * structureRoles.length;
  const band = (structureKind: RoadStructureKind, role: RoadPassRole): number => {
    const structure = Math.max(0, roadStructureDrawOrder.indexOf(structureKind));
    const roleIndex = structureRoles.indexOf(role);
    if (roleIndex >= 0) return structure * structureRoles.length + roleIndex;
    return bridgeOverlayBand + 1 + structure;
  };
  const depthOffset = (b: number): number => GlobeSurfaceDepthRank.flatRoadsDepthOffset + b * ranksPerBand * GlobeSurfaceDepthRank.layerDepthStep;
  const layers: { structureKind: RoadStructureKind; role: RoadPassRole; band: number }[] = [];
  for (const structureKind of roadStructureDrawOrder) for (const role of roadPassRoleDrawOrder) layers.push({ structureKind, role, band: band(structureKind, role) });
  layers.sort((a, b) => b.band - a.band);
  return {
    ranksPerBand,
    bridgeOverlayBand,
    bandCount: bridgeOverlayBand + 1 + roadStructureDrawOrder.length,
    band,
    depthOffset,
    /** Every road layer with its band, nearest first: the order the blended roads draw in. */
    layersNearestFirst: layers as readonly { structureKind: RoadStructureKind; role: RoadPassRole; band: number }[],
  };
})();

/**
 * The tile-priority stencil: the placement prepass marks every placement's
 * ground with its source's zoom, and every tile pass tests equal to it.
 */
export const TileSourceStencilPriority = {
  /** The reference of a source, 1 to 17: the cleared stencil (0) is ground nobody was given. */
  reference: (sourceZoom: number): number => Math.min(Math.max(sourceZoom, 0), 16) + 1,
  /** The bits the priority lives in. */
  priorityMask: 0x3f,
  /** A scene model's ground hole. */
  groundHoleBit: 0x40,
  /** The standing surfaces raise it as they draw: nothing lying on the ground paints over them. */
  surfaceMaskBit: 0x80,
} as const;

/** The share of a road's alpha its edge lines draw with. */
export const roadEdgeLineAlpha = 0.5;
