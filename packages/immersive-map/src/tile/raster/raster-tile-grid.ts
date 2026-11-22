// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The surface a raster tile is drawn on, a port of the Swift
 * `RasterTileGrid`: a square grid over the tile's extent, in tile-local
 * units (0 to 4096, y up, the parser's render space), counter-clockwise
 * like every tile triangle. One grid per cell count serves every tile: the
 * draw places it by the tile's matrix on the plane (and by the tile's uv
 * on the sphere), and the texture coordinate is the vertex position itself.
 *
 * A grid, not a quad, on both surfaces. On the sphere the cells bend the
 * tile around the globe as the subdivided geometry of a vector tile does
 * (`GroundGeometrySubdivider`), and on the plane they are where the ground
 * relief lifts the ground.
 */

import { step as subdivisionStep } from "../ground-subdivision.ts";
import type { PlaceTile, ResidentTile } from "../placement/place-tile.ts";
import { tileKey } from "../tile.ts";

/** The vertices and indices of a grid, ready for upload. */
export interface RasterTileGridGeometry {
  /** x, y per vertex, row by row from the tile's south edge. */
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
}

/**
 * What the relief grid needs of a tile's relief (the Swift `GroundRelief`):
 * the terrain's heights a side and the share of them over the tile.
 */
export interface RasterTileRelief {
  readonly terrain: { readonly size: number };
  readonly scale: number;
}

export const RasterTileGrid = {
  /** The cells a side of the plane's grid and of the sphere's deep tiles: enough for a heightmap to shape a tile. */
  minimumCells: 16,
  /**
   * The most cells a side: the flattening grid's ceiling
   * (`GroundFlatteningSettings`), so the raster ground and the placement
   * marks lie on the vector ground's lines at every zoom. A side of 257
   * vertices is past 16-bit indices, so such a grid takes 32-bit ones.
   */
  maximumCells: 256,
  /** The most cells a side 16-bit indices reach: a side of 256 vertices. */
  maximumCellsWith16BitIndices: 255,

  /**
   * The cells a side of a tile of zoom `zoom`: the vector ground's split
   * where the sphere needs one, so the raster tile bends as its geometry
   * would, and `minimumCells` where it does not.
   */
  cells(forTileZoom: number): number {
    const step = subdivisionStep(forTileZoom);
    if (step === undefined) return RasterTileGrid.minimumCells;
    return Math.max(RasterTileGrid.minimumCells, Math.trunc(4096 / step));
  },

  /**
   * The cells a side of a raster tile's grid on the relief: the zoom's
   * flattening grid (`gridCells`), but never finer than the terrain under
   * the tile has heights a side, as a vertex between two heights shows
   * nothing new, nor than a cell to two texels of the tile's raster of
   * `rasterSize`, the detail the ring was given. The raster tile's draw and
   * its placement's stencil mark take the same, so the mark lies where the
   * ground does.
   */
  reliefCells(gridCells: number, relief: RasterTileRelief, rasterSize: number): number {
    const terrainTexels = Math.floor(relief.terrain.size * relief.scale);
    return Math.max(1, Math.min(gridCells, terrainTexels, Math.trunc(rasterSize / 2)));
  },

  /**
   * The raster size each source of a frame's placements draws its ground at:
   * the largest of its raster placements, and none for a source drawn as
   * geometry anywhere, which covers its raster slots with its geometry. By
   * `tileKey` of the source.
   */
  rasterSizesBySource(placements: readonly PlaceTile<ResidentTile>[]): Map<string, number> {
    const vectorTiles = new Set<string>();
    for (const p of placements) if (p.rules.raster === undefined) vectorTiles.add(tileKey(p.resident.tile));
    const sizes = new Map<string, number>();
    for (const p of placements) {
      const raster = p.rules.raster;
      const key = tileKey(p.resident.tile);
      if (raster === undefined || vectorTiles.has(key)) continue;
      sizes.set(key, Math.max(sizes.get(key) ?? 0, raster.size));
    }
    return sizes;
  },

  /**
   * The grid of `cells` cells a side (clamped to 1 to `maximumCells`): the
   * vertices row by row from the tile's south edge, two counter-clockwise
   * triangles per cell, 16-bit indices up to `maximumCellsWith16BitIndices`.
   */
  geometry(cells: number): RasterTileGridGeometry {
    const n = Math.min(Math.max(Math.trunc(cells), 1), RasterTileGrid.maximumCells);
    const side = n + 1;
    const vertices = new Float32Array(side * side * 2);
    let v = 0;
    for (let row = 0; row <= n; row++) {
      for (let column = 0; column <= n; column++) {
        vertices[v++] = (column / n) * 4096;
        vertices[v++] = (row / n) * 4096;
      }
    }
    const indices = n <= RasterTileGrid.maximumCellsWith16BitIndices ? new Uint16Array(n * n * 6) : new Uint32Array(n * n * 6);
    let i = 0;
    for (let row = 0; row < n; row++) {
      for (let column = 0; column < n; column++) {
        const southWest = row * side + column;
        const southEast = southWest + 1;
        const northWest = southWest + side;
        const northEast = northWest + 1;
        indices[i++] = southWest;
        indices[i++] = southEast;
        indices[i++] = northEast;
        indices[i++] = southWest;
        indices[i++] = northEast;
        indices[i++] = northWest;
      }
    }
    return { vertices, indices };
  },
} as const;

/** One grid on the GPU. */
export interface RasterTileGridMesh {
  readonly vertices: GPUBuffer;
  readonly indices: GPUBuffer;
  readonly indexCount: number;
  readonly indexFormat: GPUIndexFormat;
}

/** The grids on the GPU, each built the first time it is asked for. */
export class RasterTileGridMeshes {
  private readonly meshesByCells = new Map<number, RasterTileGridMesh>();

  constructor(private readonly device: GPUDevice) {}

  /**
   * The grid of a tile of zoom `zoom`, of at least `cells` cells a side: on
   * the relief, the zoom's flattening grid (`RasterTileGrid.reliefCells`),
   * so the raster ground is as fine as the vector ground beside it.
   */
  forTileZoom(zoom: number, atLeast = 0): RasterTileGridMesh {
    return this.mesh(Math.max(RasterTileGrid.cells(zoom), atLeast));
  }

  /** The grid of exactly `cells` cells a side (1 to `maximumCells`), whatever the zoom. */
  mesh(cells: number): RasterTileGridMesh {
    const n = Math.min(Math.max(Math.trunc(cells), 1), RasterTileGrid.maximumCells);
    let mesh = this.meshesByCells.get(n);
    if (!mesh) {
      const geometry = RasterTileGrid.geometry(n);
      mesh = {
        vertices: this.upload(`raster grid vertices ${n}`, geometry.vertices, GPUBufferUsage.VERTEX),
        indices: this.upload(`raster grid indices ${n}`, geometry.indices, GPUBufferUsage.INDEX),
        indexCount: geometry.indices.length,
        indexFormat: geometry.indices instanceof Uint16Array ? "uint16" : "uint32",
      };
      this.meshesByCells.set(n, mesh);
    }
    return mesh;
  }

  destroy(): void {
    for (const mesh of this.meshesByCells.values()) {
      mesh.vertices.destroy();
      mesh.indices.destroy();
    }
    this.meshesByCells.clear();
  }

  /** A buffer created mapped and filled in place, its size rounded up to the 4 bytes a mapping needs. */
  private upload(label: string, data: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, usage: number): GPUBuffer {
    const buffer = this.device.createBuffer({ label, size: Math.ceil(data.byteLength / 4) * 4, usage, mappedAtCreation: true });
    new Uint8Array(buffer.getMappedRange(), 0, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buffer.unmap();
    return buffer;
  }
}
