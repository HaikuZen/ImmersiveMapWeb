// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { immersiveMapVideoExportConfiguration } from "../../configuration/export-configuration.ts";
import { mp4CodecOf, videoCodecString, videoEncoderConfig } from "./video-encoder-configuration.ts";

describe("video encoder configuration", () => {
  test("H.264 takes the High profile at the lowest level that holds the frame", () => {
    expect(videoCodecString("h264", 1280, 720, 30)).toBe("avc1.64001f");
    expect(videoCodecString("h264", 1920, 1080, 30)).toBe("avc1.640028");
    expect(videoCodecString("h264", 1920, 1080, 60)).toBe("avc1.64002a");
    expect(videoCodecString("h264", 3840, 2160, 30)).toBe("avc1.640033");
    expect(videoCodecString("h264", 3840, 2160, 60)).toBe("avc1.640034");
    expect(videoCodecString("h264", 8192, 4320, 30)).toBe("avc1.64003c");
  });

  test("HEVC takes the Main profile in the Main tier", () => {
    expect(videoCodecString("hevc", 1920, 1080, 30)).toBe("hvc1.1.6.L120.B0");
    expect(videoCodecString("hevc", 1920, 1080, 60)).toBe("hvc1.1.6.L123.B0");
    expect(videoCodecString("hevc", 3840, 2160, 60)).toBe("hvc1.1.6.L153.B0");
    expect(videoCodecString("hevc", 8192, 4320, 30)).toBe("hvc1.1.6.L180.B0");
  });

  test("AV1 takes the Main profile at 8 bits", () => {
    expect(videoCodecString("av1", 1920, 1080, 30)).toBe("av01.0.08M.08");
    expect(videoCodecString("av1", 1920, 1080, 60)).toBe("av01.0.09M.08");
    expect(videoCodecString("av1", 3840, 2160, 60)).toBe("av01.0.13M.08");
  });

  test("a frame past every level takes the highest", () => {
    expect(videoCodecString("h264", 8192, 8192, 120)).toBe("avc1.64003e");
  });

  test("the encoder runs for quality with the parameter sets out of band", () => {
    const configuration = immersiveMapVideoExportConfiguration({ codec: "h264", framesPerSecond: 30 });
    const config = videoEncoderConfig(configuration);
    expect(config).toMatchObject({ codec: "avc1.640028", width: 1920, height: 1080, framerate: 30, latencyMode: "quality", avc: { format: "avc" } });
    expect(config.bitrate).toBe(Math.trunc(1920 * 1080 * 30 * 0.2));
    expect((videoEncoderConfig(immersiveMapVideoExportConfiguration()) as { hevc?: unknown }).hevc).toEqual({ format: "hevc" });
    expect(mp4CodecOf("h264")).toBe("avc");
    expect(mp4CodecOf("hevc")).toBe("hevc");
    expect(mp4CodecOf("av1")).toBe("av1");
  });
});
