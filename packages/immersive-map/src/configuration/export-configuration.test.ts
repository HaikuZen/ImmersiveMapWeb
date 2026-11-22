// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `ImmersiveMapVideoExportConfigurationTests` and the
// configuration part of `ImmersiveMapStillRecorderTests`.

import { describe, expect, test } from "vitest";
import {
  ImmersiveMapInvalidConfigurationError,
  defaultStillConfiguration,
  defaultVideoExportConfiguration,
  immersiveMapStillConfiguration,
  immersiveMapVideoExportConfiguration,
  resolvedAverageBitRate,
  stillFormat,
  validateStillConfiguration,
  validateVideoExportConfiguration,
  videoExportFormat,
  withVideoExportFormat,
} from "./export-configuration.ts";
import type { ImmersiveMapStillConfiguration, ImmersiveMapVideoExportConfiguration } from "./export-configuration.ts";
import { ImmersiveMapFrameFormat } from "./frame-format.ts";

const video = (patch: Partial<ImmersiveMapVideoExportConfiguration>): ImmersiveMapVideoExportConfiguration => ({
  ...defaultVideoExportConfiguration,
  ...patch,
});

describe("the video export configuration", () => {
  test("the defaults are full HD at 60 frames per second in HEVC", () => {
    const configuration = defaultVideoExportConfiguration;
    expect(configuration.width).toBe(1920);
    expect(configuration.height).toBe(1080);
    expect(configuration.framesPerSecond).toBe(60);
    expect(configuration.codec).toBe("hevc");
    expect(configuration.averageBitRate).toBeNull();
    expect(configuration.tileReadinessTimeout).toBe(10);
    expect(configuration.sceneDate).toBeNull();
    expect(configuration.includesPins).toBe(true);
    expect(configuration.includesAnnotations).toBe(true);
    expect(configuration.annotationScale).toBe(2);
    expect(() => validateVideoExportConfiguration(configuration)).not.toThrow();
  });

  test("an out of range marker scale is rejected", () => {
    expect(() => validateVideoExportConfiguration(video({ annotationScale: 0.4 }))).toThrow();
    expect(() => validateVideoExportConfiguration(video({ annotationScale: 9 }))).toThrow();
  });

  test("odd dimensions are rejected", () => {
    expect(() => validateVideoExportConfiguration(video({ width: 1919 }))).toThrow(ImmersiveMapInvalidConfigurationError);
  });

  test("out of range dimensions are rejected", () => {
    expect(() => validateVideoExportConfiguration(video({ height: 32 }))).toThrow();
    expect(() => validateVideoExportConfiguration(video({ width: 16_384 }))).toThrow();
  });

  test("a frame rate out of range is rejected", () => {
    expect(() => validateVideoExportConfiguration(video({ framesPerSecond: 0 }))).toThrow();
    expect(() => validateVideoExportConfiguration(video({ framesPerSecond: 240 }))).toThrow();
  });

  test("a non-positive bit rate and timeout are rejected", () => {
    expect(() => validateVideoExportConfiguration(video({ averageBitRate: 0 }))).toThrow();
    expect(() => validateVideoExportConfiguration(video({ tileReadinessTimeout: 0 }))).toThrow();
  });

  test("the default bit rate follows the bits per pixel formula", () => {
    const hevc = immersiveMapVideoExportConfiguration({ width: 1920, height: 1080, framesPerSecond: 60, codec: "hevc" });
    expect(resolvedAverageBitRate(hevc)).toBe(Math.trunc(1920 * 1080 * 60 * 0.1));
    const h264 = immersiveMapVideoExportConfiguration({ width: 1920, height: 1080, framesPerSecond: 60, codec: "h264" });
    expect(resolvedAverageBitRate(h264)).toBe(Math.trunc(1920 * 1080 * 60 * 0.2));
    expect(resolvedAverageBitRate({ ...hevc, averageBitRate: 5_000_000 })).toBe(5_000_000);
  });

  test("a format gives the size, an odd side one pixel smaller", () => {
    const reels = immersiveMapVideoExportConfiguration({ format: ImmersiveMapFrameFormat.instagramReels });
    expect([reels.width, reels.height]).toEqual([1080, 1920]);
    const link = immersiveMapVideoExportConfiguration({ format: ImmersiveMapFrameFormat.linkedInLink });
    expect([link.width, link.height]).toEqual([1200, 626]);
    expect(withVideoExportFormat(reels, ImmersiveMapFrameFormat.linkedInLink).height).toBe(626);
    expect(videoExportFormat(reels)).toEqual(ImmersiveMapFrameFormat.instagramReels);
  });
});

describe("the still configuration", () => {
  test("the default configuration validates", () => {
    expect(() => validateStillConfiguration(defaultStillConfiguration)).not.toThrow();
  });

  test("the validation names the field that is out of range", () => {
    const reason = (configuration: ImmersiveMapStillConfiguration): string | null => {
      try {
        validateStillConfiguration(configuration);
        return null;
      } catch (error) {
        return error instanceof ImmersiveMapInvalidConfigurationError ? error.message : null;
      }
    };
    expect(reason(immersiveMapStillConfiguration({ width: 0 }))).toContain("width");
    expect(reason(immersiveMapStillConfiguration({ height: 20_000 }))).toContain("height");
    expect(reason(immersiveMapStillConfiguration({ pixelsPerPoint: 0 }))).toContain("pixelsPerPoint");
    expect(reason(immersiveMapStillConfiguration({ settleTimeout: -1 }))).toContain("settleTimeout");
  });

  /** Odd sizes are allowed, unlike video: there is no encoder demanding even dimensions. */
  test("odd dimensions are allowed", () => {
    expect(() => validateStillConfiguration(immersiveMapStillConfiguration({ width: 375, height: 667 }))).not.toThrow();
  });

  test("a format gives the size as it is", () => {
    const post = immersiveMapStillConfiguration({ format: ImmersiveMapFrameFormat.threadsPost });
    expect(stillFormat(post)).toEqual(ImmersiveMapFrameFormat.threadsPost);
  });
});

describe("the frame formats", () => {
  test("a side below one pixel is one, and the ratio is the width over the height", () => {
    expect(ImmersiveMapFrameFormat.make(0, -4)).toEqual({ pixelWidth: 1, pixelHeight: 1 });
    expect(ImmersiveMapFrameFormat.aspectRatio(ImmersiveMapFrameFormat.threadsPost)).toBeCloseTo(0.8, 6);
    expect(ImmersiveMapFrameFormat.aspectRatio(ImmersiveMapFrameFormat.fullHD)).toBeCloseTo(16 / 9, 6);
    expect(ImmersiveMapFrameFormat.uhd4K).toEqual({ pixelWidth: 3840, pixelHeight: 2160 });
    expect(ImmersiveMapFrameFormat.gitHubSocialPreview).toEqual({ pixelWidth: 1280, pixelHeight: 640 });
  });
});
