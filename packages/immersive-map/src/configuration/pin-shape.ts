// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** A point of the unit square a pin shape is described in: origin top left, y down. */
export interface PinShapePoint {
  readonly x: number;
  readonly y: number;
}

/** A rectangle of the unit square a pin shape is described in. */
export interface PinShapeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface PinShapePlacement {
  /** The point of the shape that stands on the pin's coordinate. */
  readonly anchor: PinShapePoint;
  /** The rectangle the picture is laid into. */
  readonly pictureArea: PinShapeRect;
}

/**
 * The shape of the frame every pin of a map is drawn in: the outline, the
 * fill under the picture and the cut of the picture itself all follow it.
 * One shape serves all the pins of a map, set with
 * `ImmersiveMapSettings.pinSettings({ shape })`.
 *
 * A shape is described in a unit square whose origin is the top left corner
 * and whose y axis points down, as in CSS and SVG. Besides the built-in ones
 * it can be a picture of the shape (`mask`) or a path (`path`): the engine
 * turns either into a distance field once, when the map is created, so no
 * distance texture has to be prepared by hand.
 *
 * A pin pushed off its place by its neighbours still turns into a circle
 * with a beam, whatever its shape is. The circle is the largest one that
 * fits the shape's picture area.
 *
 * A shape is plain data, as every setting is: a built-in shape is named by
 * its kind, a path is SVG path data and a picture is a URL (a `data:` URL
 * included), so the settings stay structured-cloneable and JSON.
 */
export type PinShape =
  /** The engine's own bubble, from the distance field in its resources. */
  | (PinShapePlacement & { readonly kind: "bubble" })
  /** The parts of the shape, SVG path data in the unit square, filled one over another. */
  | (PinShapePlacement & { readonly kind: "paths"; readonly paths: readonly string[] })
  /** A picture of the shape at a URL: light and opaque where the pin is. */
  | (PinShapePlacement & { readonly kind: "mask"; readonly maskURL: string })
  /** No frame: the picture's own alpha is the shape. */
  | (PinShapePlacement & { readonly kind: "picture" });

/** The height of a built-in shape's tail, as a part of the pin's size. */
const tailHeight = 0.06;
/** Half the width of the tail where it leaves the body. */
const tailHalfWidth = 0.09;
/** How deep the tail's wedge reaches into the body, so that it joins a body with round corners without a gap. */
const tailDepth = 0.1;
/** The height of the built-in bubble's tail, as a part of the pin's size, when the bubble's own resource does not say. */
const bubbleTailHeight = 0.046875;

const unitSquare: PinShapeRect = Object.freeze({ x: 0, y: 0, width: 1, height: 1 });

function clampedPoint(point: PinShapePoint): PinShapePoint {
  return Object.freeze({ x: Math.min(Math.max(point.x, 0), 1), y: Math.min(Math.max(point.y, 0), 1) });
}

/** The rectangle within the unit square, or the whole square where nothing of it is left. */
function areaWithinUnitSquare(area: PinShapeRect): PinShapeRect {
  const x0 = Math.max(area.x, 0);
  const y0 = Math.max(area.y, 0);
  const x1 = Math.min(area.x + area.width, 1);
  const y1 = Math.min(area.y + area.height, 1);
  if (!(x1 > x0) || !(y1 > y0)) {
    return unitSquare;
  }
  return Object.freeze({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
}

/** SVG path data of a rounded rectangle, as Core Graphics' `CGPath(roundedRect:)` draws it. */
function roundedRectanglePath(rect: PinShapeRect, radius: number): string {
  const { x, y, width, height } = rect;
  const r = radius;
  if (r <= 0) {
    return `M${x},${y}H${x + width}V${y + height}H${x}Z`;
  }
  return [
    `M${x + r},${y}`,
    `H${x + width - r}`,
    `A${r},${r} 0 0 1 ${x + width},${y + r}`,
    `V${y + height - r}`,
    `A${r},${r} 0 0 1 ${x + width - r},${y + height}`,
    `H${x + r}`,
    `A${r},${r} 0 0 1 ${x},${y + height - r}`,
    `V${y + r}`,
    `A${r},${r} 0 0 1 ${x + r},${y}`,
    "Z",
  ].join("");
}

/**
 * A rounded rectangle.
 *
 * @param cornerRadius The radius of the corners as a part of the pin's
 *   size, from 0 (a square) to 0.5 (a circle).
 * @param tail Whether the shape has a tail under it. With a tail the tip of
 *   the tail stands on the pin's coordinate, without one the center of the
 *   shape does.
 */
function roundedRectangle(cornerRadius: number, tail = false): PinShape {
  const bodyHeight = tail ? 1 - tailHeight : 1;
  const body: PinShapeRect = Object.freeze({ x: 0, y: 0, width: 1, height: bodyHeight });
  const radius = Math.min(Math.max(cornerRadius, 0), 0.5) * Math.min(body.width, body.height);
  const parts = [roundedRectanglePath(body, radius)];
  if (!tail) {
    return Object.freeze({ kind: "paths", paths: Object.freeze(parts), anchor: Object.freeze({ x: 0.5, y: 0.5 }), pictureArea: body });
  }
  // A wedge from inside the body down to the tip. It is as wide as
  // `tailHalfWidth` where it crosses the body's lower edge.
  const wedgeHalfWidth = (tailHalfWidth * (tailHeight + tailDepth)) / tailHeight;
  const top = bodyHeight - tailDepth;
  parts.push(`M${0.5 - wedgeHalfWidth},${top}L${0.5 + wedgeHalfWidth},${top}L0.5,1Z`);
  return Object.freeze({ kind: "paths", paths: Object.freeze(parts), anchor: Object.freeze({ x: 0.5, y: 1 }), pictureArea: body });
}

/** The pin shapes. */
export const PinShape = Object.freeze({
  /** The engine's own shape: a rounded square with a small tail that points at the pin's place. The default. */
  bubble: Object.freeze({
    kind: "bubble",
    anchor: Object.freeze({ x: 0.5, y: 1 }),
    pictureArea: Object.freeze({ x: 0, y: 0, width: 1, height: 1 - bubbleTailHeight }),
  }) as PinShape,

  /** A circle centered on the pin's place. */
  circle: roundedRectangle(0.5, false),

  roundedRectangle,

  /**
   * A shape of the app's own.
   *
   * @param path A closed path in a unit square as SVG path data, origin in
   *   the top left corner, y down. What lies outside the square is cut off.
   * @param anchor The point of the square that stands on the pin's
   *   coordinate, the bottom center by default. For a shape with a pointer
   *   it is the pointer's tip.
   * @param pictureArea The rectangle of the square the picture is laid
   *   into, the whole square by default (the Swift engine takes the path's
   *   bounding box, which SVG path data does not state). Give it when the
   *   shape has a part the picture should not reach, a pointer for example.
   */
  path(path: string, anchor: PinShapePoint = { x: 0.5, y: 1 }, pictureArea: PinShapeRect = unitSquare): PinShape {
    return Object.freeze({
      kind: "paths",
      paths: Object.freeze([path]),
      anchor: clampedPoint(anchor),
      pictureArea: areaWithinUnitSquare(pictureArea),
    });
  },

  /**
   * A shape taken from a picture of it, a PNG drawn in any editor: the pin
   * is where the picture is light and opaque, and is not where it is black
   * or transparent. The picture is stretched to a square, so draw it square.
   * The map turns it into the frame once, when it is created.
   *
   * @param maskURL The picture of the shape (any URL the page can fetch, a
   *   `data:` URL included). 256 pixels a side are enough.
   * @param anchor The point of the picture that stands on the pin's
   *   coordinate, in a unit square with the origin in the top left corner
   *   and y down. The bottom center by default.
   * @param pictureArea The rectangle of that square the pin's picture is
   *   laid into. The whole square by default. Give it when the shape has a
   *   part the picture should not reach, a pointer for example.
   */
  mask(maskURL: string, anchor: PinShapePoint = { x: 0.5, y: 1 }, pictureArea: PinShapeRect = unitSquare): PinShape {
    return Object.freeze({
      kind: "mask",
      maskURL,
      anchor: clampedPoint(anchor),
      pictureArea: areaWithinUnitSquare(pictureArea),
    });
  },

  /**
   * No frame: the pin is its picture alone, cut by the picture's own alpha,
   * with no outline and no fill.
   *
   * @param anchor The point of the picture that stands on the pin's
   *   coordinate, in a unit square with the origin in the top left corner.
   *   The center by default.
   */
  picture(anchor: PinShapePoint = { x: 0.5, y: 0.5 }): PinShape {
    return Object.freeze({ kind: "picture", anchor: clampedPoint(anchor), pictureArea: unitSquare });
  },

  /** Whether the shape draws no frame, the picture's own alpha its shape. */
  isFrameless(shape: PinShape): boolean {
    return shape.kind === "picture";
  },

  /** Whether the engine bakes the shape's distance field itself. */
  isBaked(shape: PinShape): boolean {
    return shape.kind === "paths" || shape.kind === "mask";
  },
});
