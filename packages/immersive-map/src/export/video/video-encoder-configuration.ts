// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { type ImmersiveMapVideoCodec, type ImmersiveMapVideoExportConfiguration, resolvedAverageBitRate } from "../../configuration/export-configuration.ts";
import type { Mp4VideoCodec } from "./mp4-muxer.ts";

interface Level {
  /** The codec string's level field. */
  readonly code: string;
  /** The most luma samples (or macroblocks for H.264) a frame may hold. */
  readonly maximumFrameSize: number;
  /** The most luma samples (or macroblocks) a second. */
  readonly maximumRate: number;
  /** The longest side the level allows, `Infinity` where it states none. */
  readonly maximumSide: number;
}

/** H.264 levels (ITU-T H.264 Table A-1), in macroblocks of 16 × 16. */
const avcLevels: readonly Level[] = [
  { code: "1f", maximumFrameSize: 3600, maximumRate: 108_000, maximumSide: Infinity },
  { code: "20", maximumFrameSize: 5120, maximumRate: 216_000, maximumSide: Infinity },
  { code: "28", maximumFrameSize: 8192, maximumRate: 245_760, maximumSide: Infinity },
  { code: "2a", maximumFrameSize: 8704, maximumRate: 522_240, maximumSide: Infinity },
  { code: "32", maximumFrameSize: 22_080, maximumRate: 589_824, maximumSide: Infinity },
  { code: "33", maximumFrameSize: 36_864, maximumRate: 983_040, maximumSide: Infinity },
  { code: "34", maximumFrameSize: 36_864, maximumRate: 2_073_600, maximumSide: Infinity },
  { code: "3c", maximumFrameSize: 139_264, maximumRate: 4_177_920, maximumSide: Infinity },
  { code: "3d", maximumFrameSize: 139_264, maximumRate: 8_355_840, maximumSide: Infinity },
  { code: "3e", maximumFrameSize: 139_264, maximumRate: 16_711_680, maximumSide: Infinity },
];

/** HEVC Main tier levels (ITU-T H.265 Table A.8), in luma samples, the side bounded by sqrt(8 × MaxLumaPs). */
const hevcLevels: readonly Level[] = [
  { code: "93", maximumFrameSize: 983_040, maximumRate: 33_177_600, maximumSide: 2804 },
  { code: "120", maximumFrameSize: 2_228_224, maximumRate: 66_846_720, maximumSide: 4222 },
  { code: "123", maximumFrameSize: 2_228_224, maximumRate: 133_693_440, maximumSide: 4222 },
  { code: "150", maximumFrameSize: 8_912_896, maximumRate: 267_386_880, maximumSide: 8444 },
  { code: "153", maximumFrameSize: 8_912_896, maximumRate: 534_773_760, maximumSide: 8444 },
  { code: "156", maximumFrameSize: 8_912_896, maximumRate: 1_069_547_520, maximumSide: 8444 },
  { code: "180", maximumFrameSize: 35_651_584, maximumRate: 1_069_547_520, maximumSide: 16_888 },
  { code: "183", maximumFrameSize: 35_651_584, maximumRate: 2_139_095_040, maximumSide: 16_888 },
  { code: "186", maximumFrameSize: 35_651_584, maximumRate: 4_278_190_080, maximumSide: 16_888 },
];

/** AV1 levels (AV1 specification, annex A.3), in luma samples, with `seq_level_idx` as the code. */
const av1Levels: readonly Level[] = [
  { code: "04", maximumFrameSize: 665_856, maximumRate: 19_975_680, maximumSide: 3072 },
  { code: "05", maximumFrameSize: 1_065_024, maximumRate: 31_950_720, maximumSide: 4096 },
  { code: "08", maximumFrameSize: 2_359_296, maximumRate: 70_778_880, maximumSide: 4096 },
  { code: "09", maximumFrameSize: 2_359_296, maximumRate: 141_557_760, maximumSide: 4096 },
  { code: "12", maximumFrameSize: 8_912_896, maximumRate: 267_386_880, maximumSide: 8192 },
  { code: "13", maximumFrameSize: 8_912_896, maximumRate: 534_773_760, maximumSide: 8192 },
  { code: "14", maximumFrameSize: 8_912_896, maximumRate: 1_069_547_520, maximumSide: 8192 },
  { code: "16", maximumFrameSize: 35_651_584, maximumRate: 1_069_547_520, maximumSide: 16_384 },
  { code: "17", maximumFrameSize: 35_651_584, maximumRate: 2_139_095_040, maximumSide: 16_384 },
  { code: "18", maximumFrameSize: 35_651_584, maximumRate: 4_278_190_080, maximumSide: 16_384 },
];

/** The lowest level that holds the frame size at the rate, the highest one when none does. */
function levelFor(levels: readonly Level[], frameSize: number, rate: number, longestSide: number): Level {
  return levels.find((level) => frameSize <= level.maximumFrameSize && rate <= level.maximumRate && longestSide <= level.maximumSide) ?? levels.at(-1)!;
}

/**
 * The WebCodecs codec string for a codec at a size and a rate: H.264 High
 * profile, HEVC Main profile in the Main tier, AV1 Main profile at 8 bits,
 * each at the lowest level that holds the frame.
 */
export function videoCodecString(codec: ImmersiveMapVideoCodec, width: number, height: number, framesPerSecond: number): string {
  const longestSide = Math.max(width, height);
  switch (codec) {
    case "h264": {
      const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
      return `avc1.6400${levelFor(avcLevels, macroblocks, macroblocks * framesPerSecond, longestSide).code}`;
    }
    case "hevc": {
      const samples = width * height;
      return `hvc1.1.6.L${levelFor(hevcLevels, samples, samples * framesPerSecond, longestSide).code}.B0`;
    }
    case "av1": {
      const samples = width * height;
      return `av01.0.${levelFor(av1Levels, samples, samples * framesPerSecond, longestSide).code}M.08`;
    }
  }
}

/** The muxer's name of a codec. */
export function mp4CodecOf(codec: ImmersiveMapVideoCodec): Mp4VideoCodec {
  return codec === "h264" ? "avc" : codec;
}

/**
 * The encoder's configuration of an export: the codec string, the size, the
 * bit rate and the rate, encoded for quality rather than latency, the
 * parameter sets out of band (in the MP4's sample description) and no frame
 * reordering, which the muxer assumes.
 */
export function videoEncoderConfig(configuration: ImmersiveMapVideoExportConfiguration): VideoEncoderConfig {
  const { codec, width, height, framesPerSecond } = configuration;
  return {
    codec: videoCodecString(codec, width, height, framesPerSecond),
    width,
    height,
    bitrate: resolvedAverageBitRate(configuration),
    framerate: framesPerSecond,
    bitrateMode: "variable",
    latencyMode: "quality",
    hardwareAcceleration: "no-preference",
    ...(codec === "h264" ? { avc: { format: "avc" as const } } : {}),
    ...(codec === "hevc" ? { hevc: { format: "hevc" as const } } : {}),
  };
}
