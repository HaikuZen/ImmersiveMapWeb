// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { PinShape } from "../../configuration/pin-shape.ts";

/**
 * Turns a pin shape into the distance field the pin shader cuts its frame
 * from, a port of the Swift `PinShapeDistanceField`: for every texel, how
 * far it is from the shape's edge, negative inside. Baked on the CPU once
 * per map, so a map's author gives a path or a mask and never a prepared
 * texture.
 *
 * The field is kept as `r16float` (WebGPU has no filterable 16-bit unorm
 * format without an optional feature): the encoded values lie in 0...1,
 * where a half float still resolves a sixteenth of a texel at the edge.
 */
export const PinShapeDistanceField = Object.freeze({
  /** The side of the baked texture, in texels. */
  textureSize: 256,
  /** The shape is filled at this many samples per texel side before the distances are taken. */
  supersampling: 2,
  /** The part of the texture left empty on every side of the shape, so the soft edge of a shape that touches its square is not cut. */
  margin: 0.02,
  /** The distance, in texels, the texture's values span to each side of the edge. */
  distanceRangeTexels: 128,

  /** The side of the grid the shape is filled on. */
  get fineSide(): number {
    return PinShapeDistanceField.textureSize * PinShapeDistanceField.supersampling;
  },

  /**
   * Whether each sample of a `side` by `side` grid lies inside the shape
   * that the SVG path data in a unit square (y down) fill one over another.
   * Row 0 is the top of the square.
   */
  coverageOfPaths(paths: readonly string[], side: number): Uint8Array {
    const canvas = new OffscreenCanvas(side, side);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const margin = PinShapeDistanceField.margin;
    context.setTransform(side * (1 - 2 * margin), 0, 0, side * (1 - 2 * margin), side * margin, side * margin);
    context.beginPath();
    context.rect(0, 0, 1, 1);
    context.clip();
    context.fillStyle = "#fff";
    for (const path of paths) context.fill(new Path2D(path));
    return insideOfPixels(context.getImageData(0, 0, side, side).data, "alpha");
  },

  /** Whether each sample lies inside the shape a mask pictures: where it is light and opaque. Row 0 is the top. */
  coverageOfMask(mask: CanvasImageSource, side: number): Uint8Array {
    const canvas = new OffscreenCanvas(side, side);
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    // Over black, a transparent part of the mask and a black one read the same.
    context.fillStyle = "#000";
    context.fillRect(0, 0, side, side);
    context.imageSmoothingQuality = "high";
    const inset = PinShapeDistanceField.margin * side;
    context.drawImage(mask, inset, inset, side - 2 * inset, side - 2 * inset);
    return insideOfPixels(context.getImageData(0, 0, side, side).data, "luminance");
  },

  /** The signed distance of every sample to the shape's edge, in samples, negative inside. `inside` holds 1 inside. */
  signedDistances(inside: Uint8Array, side: number): Float32Array {
    const outside = new Uint8Array(inside.length);
    for (let index = 0; index < inside.length; index++) outside[index] = inside[index] === 0 ? 1 : 0;
    const toInside = squaredDistances(inside, side);
    const toOutside = squaredDistances(outside, side);
    const distances = new Float32Array(side * side);
    for (let index = 0; index < distances.length; index++) {
      // The edge runs between two samples, half a sample from each.
      distances[index] = inside[index] !== 0 ? -(Math.sqrt(toOutside[index]!) - 0.5) : Math.sqrt(toInside[index]!) - 0.5;
    }
    return distances;
  },

  /** The field as the texture stores it: `textureSize` squared values, 0.5 on the edge, larger inside. `inside` is the fine grid. */
  encodedField(inside: Uint8Array): Float32Array {
    const { textureSize, supersampling } = PinShapeDistanceField;
    const fineSide = textureSize * supersampling;
    const fine = PinShapeDistanceField.signedDistances(inside, fineSide);
    const encoded = new Float32Array(textureSize * textureSize);
    const samplesPerTexel = supersampling * supersampling;
    for (let y = 0; y < textureSize; y++) {
      for (let x = 0; x < textureSize; x++) {
        let sum = 0;
        for (let dy = 0; dy < supersampling; dy++) {
          for (let dx = 0; dx < supersampling; dx++) sum += fine[(y * supersampling + dy) * fineSide + x * supersampling + dx]!;
        }
        encoded[y * textureSize + x] = PinShapeDistanceField.encode(sum / samplesPerTexel / supersampling);
      }
    }
    return encoded;
  },

  /** A distance in texels as the texture stores it, 0.5 on the edge, clamped to 0...1. */
  encode(distanceTexels: number): number {
    const unit = 0.5 - distanceTexels / (2 * PinShapeDistanceField.distanceRangeTexels);
    return Math.min(Math.max(unit, 0), 1);
  },

  /**
   * The field's texels for a shape, `side` a side, ready to upload: a
   * baked shape's 256 squared, one texel for a shape without a frame (the
   * shader's slot needs a texture), null for the built-in bubble, whose
   * field ships with the package. A mask is the decoded picture.
   */
  bake(shape: PinShape, mask: CanvasImageSource | null): { readonly side: number; readonly values: Float32Array } | null {
    const { fineSide, textureSize } = PinShapeDistanceField;
    switch (shape.kind) {
      case "bubble":
        return null;
      case "paths":
        return { side: textureSize, values: PinShapeDistanceField.encodedField(PinShapeDistanceField.coverageOfPaths(shape.paths, fineSide)) };
      case "mask":
        if (mask === null) return null;
        return { side: textureSize, values: PinShapeDistanceField.encodedField(PinShapeDistanceField.coverageOfMask(mask, fineSide)) };
      case "picture":
        return { side: 1, values: Float32Array.of(PinShapeDistanceField.encode(-PinShapeDistanceField.distanceRangeTexels)) };
    }
  },
});

/** Inside where a pixel's alpha (a filled path) or its luminance over black (a mask) reaches half. */
function insideOfPixels(pixels: Uint8ClampedArray, channel: "alpha" | "luminance"): Uint8Array {
  const inside = new Uint8Array(pixels.length / 4);
  for (let index = 0; index < inside.length; index++) {
    const value = channel === "alpha" ? pixels[index * 4 + 3]! : 0.299 * pixels[index * 4]! + 0.587 * pixels[index * 4 + 1]! + 0.114 * pixels[index * 4 + 2]!;
    inside[index] = value >= 128 ? 1 : 0;
  }
  return inside;
}

const far = 1.0e12;

/**
 * For every sample, the squared distance to the nearest sample that is set:
 * the exact Euclidean transform, one pass along the rows and one along the
 * columns (Felzenszwalb and Huttenlocher).
 */
function squaredDistances(isSet: Uint8Array, side: number): Float32Array {
  const grid = new Float32Array(side * side);
  for (let index = 0; index < grid.length; index++) grid[index] = isSet[index] !== 0 ? 0 : far;
  const line = new Float32Array(side);
  const result = new Float32Array(side);
  const parabolas = new Int32Array(side);
  const bounds = new Float32Array(side + 1);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) line[x] = grid[y * side + x]!;
    transformLine(line, result, parabolas, bounds);
    for (let x = 0; x < side; x++) grid[y * side + x] = result[x]!;
  }
  for (let x = 0; x < side; x++) {
    for (let y = 0; y < side; y++) line[y] = grid[y * side + x]!;
    transformLine(line, result, parabolas, bounds);
    for (let y = 0; y < side; y++) grid[y * side + x] = result[y]!;
  }
  return grid;
}

/** The lower envelope of the parabolas that stand on a line's samples. */
function transformLine(line: Float32Array, result: Float32Array, parabolas: Int32Array, bounds: Float32Array): void {
  const count = line.length;
  let last = 0;
  parabolas[0] = 0;
  bounds[0] = -Number.MAX_VALUE;
  bounds[1] = Number.MAX_VALUE;
  for (let sample = 1; sample < count; sample++) {
    let crossing: number;
    for (;;) {
      const other = parabolas[last]!;
      crossing = (line[sample]! + sample * sample - (line[other]! + other * other)) / (2 * (sample - other));
      if (crossing <= bounds[last]! && last > 0) last -= 1;
      else break;
    }
    last += 1;
    parabolas[last] = sample;
    bounds[last] = crossing;
    bounds[last + 1] = Number.MAX_VALUE;
  }
  let current = 0;
  for (let sample = 0; sample < count; sample++) {
    while (bounds[current + 1]! < sample) current += 1;
    const offset = sample - parabolas[current]!;
    result[sample] = offset * offset + line[parabolas[current]!]!;
  }
}
