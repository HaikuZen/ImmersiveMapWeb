// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Simple pictures for pins drawn on the CPU, a port of the Swift
 * `PinImageFactory`: for a pin that needs no picture from the network, a
 * square with a large number on it.
 */
export const PinImageFactory = Object.freeze({
  /** The built-in placeholder's dark grey. */
  defaultBackgroundColor: "rgb(46, 51, 61)",
  defaultTextColor: "rgb(255, 255, 255)",

  /** A square picture `sizePx` a side with `value` in its centre, in bold, as large as fits. */
  number(value: number, sizePx = 256, backgroundColor: string = PinImageFactory.defaultBackgroundColor, textColor: string = PinImageFactory.defaultTextColor): OffscreenCanvas {
    const side = Math.max(1, Math.floor(sizePx));
    const canvas = new OffscreenCanvas(side, side);
    const context = canvas.getContext("2d")!;
    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, side, side);
    const text = String(value);
    // The font size at which the number fits the width and the height.
    const probeSize = 100;
    context.font = `bold ${probeSize}px system-ui, -apple-system, sans-serif`;
    const probe = context.measureText(text);
    const probeHeight = probe.actualBoundingBoxAscent + probe.actualBoundingBoxDescent || probeSize;
    const scale = Math.min((side * 0.78) / Math.max(probe.width, 1), (side * 0.72) / Math.max(probeHeight, 1));
    context.font = `bold ${probeSize * scale}px system-ui, -apple-system, sans-serif`;
    context.fillStyle = textColor;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text, side * 0.5, side * 0.5);
    return canvas;
  },
});
