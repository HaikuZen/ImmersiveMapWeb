// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// A minimal MP4 (ISO/IEC 14496-12 and -15, AV1 ISOBMFF binding) muxer for a
// single video track of WebCodecs `VideoEncoder` output. It writes a "fast
// start" file: ftyp, then moov, then mdat. The chunk bytes are never copied:
// `finish` returns Blob parts that reference them.
//
// Layout choices:
// - One chunk per sample, so stsc holds a single entry and stco (or co64)
//   lists the offset of every sample.
// - No ctts: the muxer assumes presentation order equals decode order (the
//   encoder runs without frame reordering) and rejects timestamps that are
//   not strictly increasing.
// - No edts: the first timestamp is shifted to zero.
// - The movie timescale equals the track timescale.

// MARK: Types

/** The video codec family of the track. */
export type Mp4VideoCodec = "avc" | "hevc" | "av1";

/** Static description of the single video track of the file. */
export interface Mp4VideoTrack {
  readonly codec: Mp4VideoCodec;
  /** The WebCodecs codec string the encoder ran with, e.g. "avc1.640034", "hvc1.1.6.L153.B0", "av01.0.12M.08". */
  readonly codecString: string;
  /** Coded width in pixels. */
  readonly width: number;
  /** Coded height in pixels. */
  readonly height: number;
  /**
   * Frames per second. The track timescale is derived from it, see
   * `mp4Timescale`.
   */
  readonly framesPerSecond: number;
}

/** One encoded chunk as `VideoEncoder`'s output gives it, its bytes copied out of the `EncodedVideoChunk`. */
export interface Mp4VideoChunk {
  readonly data: Uint8Array<ArrayBuffer>;
  readonly timestampMicroseconds: number;
  readonly durationMicroseconds: number | null;
  readonly isKeyFrame: boolean;
}

/** The chunk offset box a sample table needs: 32-bit stco or 64-bit co64. */
export type Mp4ChunkOffsetBoxKind = "stco" | "co64";

const UINT32_MAX = 0xffff_ffff;
const MICROSECONDS_PER_SECOND = 1_000_000;

// MARK: Pure helpers

/**
 * The track timescale for a frame rate. It is 90000 (the customary video
 * clock) when 90000 is an integer multiple of the frame rate, so every frame
 * lasts an integer number of ticks (24, 25, 30, 50, 60, 120 fps and more).
 * Otherwise it is the frame rate times 1000, rounded, which makes a frame
 * exactly 1000 ticks for rates such as 29.97 or 59.94.
 */
export function mp4Timescale(framesPerSecond: number): number {
  if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) {
    throw new Error(`MP4 muxer: framesPerSecond must be a positive finite number, got ${framesPerSecond}.`);
  }
  const ticksPerFrame = 90_000 / framesPerSecond;
  if (Number.isInteger(ticksPerFrame)) {
    return 90_000;
  }
  return Math.max(1, Math.round(framesPerSecond * 1000));
}

/** Whether the chunk offsets fit stco (32 bits) or need co64. */
export function chunkOffsetBoxKind(maxOffset: number): Mp4ChunkOffsetBoxKind {
  return maxOffset > UINT32_MAX ? "co64" : "stco";
}

/** The header fields of an av1C record, as parsed from an `av01.P.LLT.DD` codec string. */
export interface Av1CodecConfiguration {
  readonly seqProfile: number;
  readonly seqLevelIdx0: number;
  readonly seqTier0: number;
  readonly highBitdepth: boolean;
  readonly twelveBit: boolean;
  readonly monochrome: boolean;
  readonly chromaSubsamplingX: number;
  readonly chromaSubsamplingY: number;
  readonly chromaSamplePosition: number;
}

/**
 * Parses an AV1 codec string `av01.P.LLT.DD[.M.CCC.cp.tc.mc.F]`. The optional
 * monochrome flag M and chroma field CCC are honoured when present. Without
 * them the subsampling follows the profile: 4:2:0 for profiles 0 and 2,
 * 4:4:4 for profile 1.
 */
export function parseAv1CodecString(codecString: string): Av1CodecConfiguration {
  const fields = codecString.split(".");
  const match = /^(\d)$/.exec(fields[1] ?? "");
  const levelMatch = /^(\d{2})([MH])$/.exec(fields[2] ?? "");
  const depthMatch = /^(\d{2})$/.exec(fields[3] ?? "");
  if (fields[0] !== "av01" || match === null || levelMatch === null || depthMatch === null) {
    throw new Error(`MP4 muxer: "${codecString}" is not an AV1 codec string of the form av01.P.LLT.DD.`);
  }
  const seqProfile = Number(match[1]);
  const seqLevelIdx0 = Number(levelMatch[1]);
  const seqTier0 = levelMatch[2] === "H" ? 1 : 0;
  const bitDepth = Number(depthMatch[1]);
  if (seqProfile > 2 || seqLevelIdx0 > 31 || (bitDepth !== 8 && bitDepth !== 10 && bitDepth !== 12)) {
    throw new Error(`MP4 muxer: unsupported AV1 profile, level or bit depth in "${codecString}".`);
  }
  const monochrome = fields[4] === "1";
  let chromaSubsamplingX = seqProfile === 1 ? 0 : 1;
  let chromaSubsamplingY = seqProfile === 1 ? 0 : 1;
  let chromaSamplePosition = 0;
  const chroma = fields[5];
  if (chroma !== undefined && /^[01][01][0-3]$/.test(chroma)) {
    chromaSubsamplingX = Number(chroma[0]);
    chromaSubsamplingY = Number(chroma[1]);
    chromaSamplePosition = Number(chroma[2]);
  }
  return {
    seqProfile,
    seqLevelIdx0,
    seqTier0,
    highBitdepth: bitDepth > 8,
    twelveBit: bitDepth === 12,
    monochrome,
    chromaSubsamplingX,
    chromaSubsamplingY,
    chromaSamplePosition,
  };
}

/** The four fixed bytes of an av1C record (marker, version, and the sequence header summary). */
export function av1ConfigurationHeader(configuration: Av1CodecConfiguration): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(4);
  header[0] = 0x81;
  header[1] = ((configuration.seqProfile & 0x07) << 5) | (configuration.seqLevelIdx0 & 0x1f);
  header[2] =
    ((configuration.seqTier0 & 1) << 7) |
    ((configuration.highBitdepth ? 1 : 0) << 6) |
    ((configuration.twelveBit ? 1 : 0) << 5) |
    ((configuration.monochrome ? 1 : 0) << 4) |
    ((configuration.chromaSubsamplingX & 1) << 3) |
    ((configuration.chromaSubsamplingY & 1) << 2) |
    (configuration.chromaSamplePosition & 0x03);
  header[3] = 0;
  return header;
}

/**
 * Finds the first sequence header OBU (obu_type 1) in a low-overhead
 * bitstream temporal unit and returns a copy of the whole OBU, header and
 * size field included. Returns null when there is none. An OBU without
 * obu_has_size_field extends to the end of the data.
 */
export function extractAv1SequenceHeaderObu(data: Uint8Array): Uint8Array<ArrayBuffer> | null {
  let position = 0;
  while (position < data.length) {
    const start = position;
    const header = data[position] ?? 0;
    position += 1;
    const obuType = (header >> 3) & 0x0f;
    const hasExtension = (header & 0x04) !== 0;
    const hasSizeField = (header & 0x02) !== 0;
    if (hasExtension) {
      position += 1;
    }
    let end: number;
    if (hasSizeField) {
      const size = readLeb128(data, position);
      if (size === null) {
        return null;
      }
      position += size.length;
      end = position + size.value;
    } else {
      end = data.length;
    }
    if (end > data.length) {
      return null;
    }
    if (obuType === 1) {
      return data.slice(start, end);
    }
    position = end;
  }
  return null;
}

function readLeb128(data: Uint8Array, offset: number): { value: number; length: number } | null {
  let value = 0;
  for (let index = 0; index < 8; index += 1) {
    const byte = data[offset + index];
    if (byte === undefined) {
      return null;
    }
    value += (byte & 0x7f) * 2 ** (7 * index);
    if ((byte & 0x80) === 0) {
      return { value, length: index + 1 };
    }
  }
  return null;
}

/**
 * Converts per-sample durations in microseconds to track ticks. Each sample
 * end is rounded on the cumulative timeline, so the sum of the tick
 * durations equals the rounded total and no drift accumulates for constant
 * frame rates with non-integer microsecond frame lengths.
 */
export function durationsToTicks(durationsMicroseconds: readonly number[], timescale: number): number[] {
  const ticks: number[] = [];
  let elapsedMicroseconds = 0;
  let previousEndTick = 0;
  for (const duration of durationsMicroseconds) {
    elapsedMicroseconds += duration;
    const endTick = Math.round((elapsedMicroseconds * timescale) / MICROSECONDS_PER_SECOND);
    ticks.push(endTick - previousEndTick);
    previousEndTick = endTick;
  }
  return ticks;
}

function copyBufferSource(source: BufferSource): Uint8Array<ArrayBuffer> {
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
  }
  return new Uint8Array(source).slice();
}

// MARK: Byte writer

// A growable big-endian byte buffer with nested box support: `box` writes a
// size placeholder, runs the body, and patches the size afterwards.
class ByteWriter {
  private bytes = new Uint8Array(1024);
  private view = new DataView(this.bytes.buffer);
  private length = 0;

  private reserve(count: number): void {
    if (this.length + count <= this.bytes.length) {
      return;
    }
    let capacity = this.bytes.length * 2;
    while (capacity < this.length + count) {
      capacity *= 2;
    }
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(value: number): void {
    this.reserve(1);
    this.view.setUint8(this.length, value);
    this.length += 1;
  }

  u16(value: number): void {
    this.reserve(2);
    this.view.setUint16(this.length, value);
    this.length += 2;
  }

  u32(value: number): void {
    this.reserve(4);
    this.view.setUint32(this.length, value);
    this.length += 4;
  }

  u64(value: number): void {
    this.u32(Math.floor(value / 2 ** 32));
    this.u32(value % 2 ** 32);
  }

  zeros(count: number): void {
    this.reserve(count);
    this.bytes.fill(0, this.length, this.length + count);
    this.length += count;
  }

  fourCc(code: string): void {
    for (let index = 0; index < 4; index += 1) {
      this.u8(code.charCodeAt(index));
    }
  }

  raw(data: Uint8Array): void {
    this.reserve(data.length);
    this.bytes.set(data, this.length);
    this.length += data.length;
  }

  box(type: string, body: () => void): void {
    const start = this.length;
    this.u32(0);
    this.fourCc(type);
    body();
    this.view.setUint32(start, this.length - start);
  }

  fullBox(type: string, version: number, flags: number, body: () => void): void {
    this.box(type, () => {
      this.u32(((version & 0xff) << 24) | (flags & 0xff_ffff));
      body();
    });
  }

  finish(): Uint8Array<ArrayBuffer> {
    return this.bytes.slice(0, this.length);
  }
}

// MARK: Box writers

const IDENTITY_MATRIX = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000] as const;

function writeMatrix(writer: ByteWriter): void {
  for (const value of IDENTITY_MATRIX) {
    writer.u32(value);
  }
}

function ftypBox(codec: Mp4VideoCodec): Uint8Array<ArrayBuffer> {
  const writer = new ByteWriter();
  writer.box("ftyp", () => {
    writer.fourCc("isom");
    writer.u32(0x200);
    const brands = ["isom", "iso2", "mp41"];
    if (codec === "avc") {
      brands.push("avc1");
    } else if (codec === "av1") {
      brands.push("av01");
    }
    for (const brand of brands) {
      writer.fourCc(brand);
    }
  });
  return writer.finish();
}

/** Everything the moov box needs, computed once in `finish`. */
interface MovieLayout {
  readonly track: Mp4VideoTrack;
  readonly timescale: number;
  readonly durationTicks: readonly number[];
  readonly totalTicks: number;
  readonly sizes: readonly number[];
  readonly syncSamples: readonly number[] | null;
  readonly configurationBox: { readonly type: string; readonly payload: Uint8Array };
  readonly sampleEntryType: string;
}

function writeMoov(writer: ByteWriter, layout: MovieLayout, offsets: readonly number[], offsetKind: Mp4ChunkOffsetBoxKind): void {
  const durationVersion = layout.totalTicks > UINT32_MAX ? 1 : 0;
  const writeTime = (value: number): void => {
    if (durationVersion === 1) {
      writer.u64(value);
    } else {
      writer.u32(value);
    }
  };
  writer.box("moov", () => {
    writer.fullBox("mvhd", durationVersion, 0, () => {
      writeTime(0);
      writeTime(0);
      writer.u32(layout.timescale);
      writeTime(layout.totalTicks);
      writer.u32(0x0001_0000);
      writer.u16(0x0100);
      writer.zeros(2 + 8);
      writeMatrix(writer);
      writer.zeros(24);
      writer.u32(2);
    });
    writer.box("trak", () => {
      writer.fullBox("tkhd", durationVersion, 3, () => {
        writeTime(0);
        writeTime(0);
        writer.u32(1);
        writer.u32(0);
        writeTime(layout.totalTicks);
        writer.zeros(8);
        writer.u16(0);
        writer.u16(0);
        writer.u16(0);
        writer.u16(0);
        writeMatrix(writer);
        writer.u32(layout.track.width * 0x1_0000);
        writer.u32(layout.track.height * 0x1_0000);
      });
      writer.box("mdia", () => {
        writer.fullBox("mdhd", durationVersion, 0, () => {
          writeTime(0);
          writeTime(0);
          writer.u32(layout.timescale);
          writeTime(layout.totalTicks);
          writer.u16(packLanguage("und"));
          writer.u16(0);
        });
        writer.fullBox("hdlr", 0, 0, () => {
          writer.u32(0);
          writer.fourCc("vide");
          writer.zeros(12);
          for (const character of "VideoHandler") {
            writer.u8(character.charCodeAt(0));
          }
          writer.u8(0);
        });
        writer.box("minf", () => {
          writer.fullBox("vmhd", 0, 1, () => {
            writer.zeros(8);
          });
          writer.box("dinf", () => {
            writer.fullBox("dref", 0, 0, () => {
              writer.u32(1);
              writer.fullBox("url ", 0, 1, () => {});
            });
          });
          writer.box("stbl", () => {
            writeSampleDescription(writer, layout);
            writeTimeToSample(writer, layout.durationTicks);
            if (layout.syncSamples !== null) {
              const syncSamples = layout.syncSamples;
              writer.fullBox("stss", 0, 0, () => {
                writer.u32(syncSamples.length);
                for (const sample of syncSamples) {
                  writer.u32(sample);
                }
              });
            }
            writer.fullBox("stsc", 0, 0, () => {
              writer.u32(1);
              writer.u32(1);
              writer.u32(1);
              writer.u32(1);
            });
            writer.fullBox("stsz", 0, 0, () => {
              writer.u32(0);
              writer.u32(layout.sizes.length);
              for (const size of layout.sizes) {
                writer.u32(size);
              }
            });
            writer.fullBox(offsetKind, 0, 0, () => {
              writer.u32(offsets.length);
              for (const offset of offsets) {
                if (offsetKind === "co64") {
                  writer.u64(offset);
                } else {
                  writer.u32(offset);
                }
              }
            });
          });
        });
      });
    });
  });
}

function packLanguage(code: string): number {
  let packed = 0;
  for (let index = 0; index < 3; index += 1) {
    packed = (packed << 5) | ((code.charCodeAt(index) - 0x60) & 0x1f);
  }
  return packed;
}

function writeSampleDescription(writer: ByteWriter, layout: MovieLayout): void {
  writer.fullBox("stsd", 0, 0, () => {
    writer.u32(1);
    writer.box(layout.sampleEntryType, () => {
      // SampleEntry: reserved, data_reference_index.
      writer.zeros(6);
      writer.u16(1);
      // VisualSampleEntry.
      writer.zeros(2 + 2 + 12);
      writer.u16(layout.track.width);
      writer.u16(layout.track.height);
      writer.u32(0x0048_0000);
      writer.u32(0x0048_0000);
      writer.u32(0);
      writer.u16(1);
      writer.zeros(32);
      writer.u16(0x0018);
      writer.u16(0xffff);
      writer.box(layout.configurationBox.type, () => {
        writer.raw(layout.configurationBox.payload);
      });
      // BT.709 primaries, transfer and matrix, limited range.
      writer.box("colr", () => {
        writer.fourCc("nclx");
        writer.u16(1);
        writer.u16(1);
        writer.u16(1);
        writer.u8(0);
      });
      writer.box("pasp", () => {
        writer.u32(1);
        writer.u32(1);
      });
    });
  });
}

function writeTimeToSample(writer: ByteWriter, durationTicks: readonly number[]): void {
  const runs: { count: number; delta: number }[] = [];
  for (const delta of durationTicks) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.delta === delta) {
      last.count += 1;
    } else {
      runs.push({ count: 1, delta });
    }
  }
  writer.fullBox("stts", 0, 0, () => {
    writer.u32(runs.length);
    for (const run of runs) {
      writer.u32(run.count);
      writer.u32(run.delta);
    }
  });
}

function mdatHeader(payloadSize: number): Uint8Array<ArrayBuffer> {
  const writer = new ByteWriter();
  if (payloadSize + 8 > UINT32_MAX) {
    writer.u32(1);
    writer.fourCc("mdat");
    writer.u64(payloadSize + 16);
  } else {
    writer.u32(payloadSize + 8);
    writer.fourCc("mdat");
  }
  return writer.finish();
}

// MARK: Muxer

/**
 * Collects the encoded chunks of one video track and writes a fast start MP4
 * file. Presentation order must equal decode order (no B-frame reordering):
 * `addChunk` throws when timestamps are not strictly increasing.
 */
export class Mp4Muxer {
  private readonly track: Mp4VideoTrack;
  private readonly timescale: number;
  private readonly chunks: Mp4VideoChunk[] = [];
  private description: Uint8Array<ArrayBuffer> | null = null;

  constructor(track: Mp4VideoTrack) {
    if (!Number.isInteger(track.width) || !Number.isInteger(track.height) || track.width < 1 || track.height < 1 || track.width > 0xffff || track.height > 0xffff) {
      throw new Error(`MP4 muxer: track size ${track.width}x${track.height} must be positive integers up to 65535.`);
    }
    if (track.codec === "av1") {
      parseAv1CodecString(track.codecString);
    }
    this.track = track;
    this.timescale = mp4Timescale(track.framesPerSecond);
  }

  /**
   * Adds one encoded chunk as `VideoEncoder`'s output gives it. The chunk
   * bytes are kept by reference, so the caller must not reuse the buffer.
   * `description` is the `metadata.decoderConfig.description` (avcC record
   * for avc, hvcC record for hevc, usually absent for av1), taken from the
   * first call that carries it.
   */
  addChunk(chunk: Mp4VideoChunk, description?: BufferSource): void {
    if (!Number.isFinite(chunk.timestampMicroseconds)) {
      throw new Error(`MP4 muxer: chunk timestamp ${chunk.timestampMicroseconds} is not finite.`);
    }
    const previous = this.chunks[this.chunks.length - 1];
    if (previous !== undefined && chunk.timestampMicroseconds <= previous.timestampMicroseconds) {
      throw new Error(
        `MP4 muxer: chunk timestamps must be strictly increasing (presentation order must equal decode order), got ${chunk.timestampMicroseconds} after ${previous.timestampMicroseconds}.`,
      );
    }
    if (chunk.durationMicroseconds !== null && !(chunk.durationMicroseconds > 0)) {
      throw new Error(`MP4 muxer: chunk duration ${chunk.durationMicroseconds} must be positive.`);
    }
    if (this.description === null && description !== undefined) {
      this.description = copyBufferSource(description);
    }
    this.chunks.push(chunk);
  }

  /** Number of samples added. */
  get sampleCount(): number {
    return this.chunks.length;
  }

  /**
   * The finished file, moov before mdat ("fast start"), as Blob parts with no
   * copy of the chunk bytes: ftyp, moov, mdat header, then each chunk's bytes.
   */
  finish(): BlobPart[] {
    const chunks = this.chunks;
    const first = chunks[0];
    if (first === undefined) {
      throw new Error("MP4 muxer: finish() called with zero samples.");
    }
    if (!first.isKeyFrame) {
      throw new Error("MP4 muxer: the first sample must be a key frame.");
    }

    const durationTicks = durationsToTicks(this.sampleDurationsMicroseconds(), this.timescale);
    for (const ticks of durationTicks) {
      if (ticks < 1) {
        throw new Error("MP4 muxer: a sample duration rounds to zero ticks of the track timescale.");
      }
    }
    const totalTicks = durationTicks.reduce((sum, ticks) => sum + ticks, 0);
    const sizes = chunks.map((chunk) => chunk.data.length);
    const syncSamples: number[] = [];
    chunks.forEach((chunk, index) => {
      if (chunk.isKeyFrame) {
        syncSamples.push(index + 1);
      }
    });

    const layout: MovieLayout = {
      track: this.track,
      timescale: this.timescale,
      durationTicks,
      totalTicks,
      sizes,
      syncSamples: syncSamples.length === chunks.length ? null : syncSamples,
      configurationBox: this.configurationBox(first),
      sampleEntryType: this.sampleEntryType(),
    };

    const ftyp = ftypBox(this.track.codec);
    const payloadSize = sizes.reduce((sum, size) => sum + size, 0);
    const mdat = mdatHeader(payloadSize);

    // The moov size depends on the offset box kind and the offsets depend on
    // the moov size. A first pass with zero offsets measures moov for stco.
    // co64 only grows moov, so one more pass settles the layout.
    let offsetKind: Mp4ChunkOffsetBoxKind = "stco";
    let moov = this.buildMoov(layout, sizes.map(() => 0), offsetKind);
    let offsets = sampleOffsets(ftyp.length + moov.length + mdat.length, sizes);
    if (chunkOffsetBoxKind(offsets[offsets.length - 1] ?? 0) === "co64") {
      offsetKind = "co64";
      moov = this.buildMoov(layout, sizes.map(() => 0), offsetKind);
      offsets = sampleOffsets(ftyp.length + moov.length + mdat.length, sizes);
    }
    moov = this.buildMoov(layout, offsets, offsetKind);

    const parts: BlobPart[] = [ftyp, moov, mdat];
    for (const chunk of chunks) {
      parts.push(chunk.data);
    }
    return parts;
  }

  /** The finished file as a Blob of type "video/mp4". */
  finishBlob(): Blob {
    return new Blob(this.finish(), { type: "video/mp4" });
  }

  private buildMoov(layout: MovieLayout, offsets: readonly number[], offsetKind: Mp4ChunkOffsetBoxKind): Uint8Array<ArrayBuffer> {
    const writer = new ByteWriter();
    writeMoov(writer, layout, offsets, offsetKind);
    return writer.finish();
  }

  // Durations from the chunks when present, else from the next timestamp,
  // the last one from the frame rate.
  private sampleDurationsMicroseconds(): number[] {
    const chunks = this.chunks;
    return chunks.map((chunk, index) => {
      if (chunk.durationMicroseconds !== null) {
        return chunk.durationMicroseconds;
      }
      const next = chunks[index + 1];
      if (next !== undefined) {
        return next.timestampMicroseconds - chunk.timestampMicroseconds;
      }
      return MICROSECONDS_PER_SECOND / this.track.framesPerSecond;
    });
  }

  private sampleEntryType(): string {
    switch (this.track.codec) {
      case "avc":
        return "avc1";
      case "hevc":
        return "hvc1";
      case "av1":
        return "av01";
    }
  }

  private configurationBox(first: Mp4VideoChunk): { type: string; payload: Uint8Array } {
    const description = this.description;
    switch (this.track.codec) {
      case "avc":
      case "hevc": {
        if (description === null) {
          throw new Error(`MP4 muxer: the ${this.track.codec} track needs a decoder configuration description and none was given.`);
        }
        return { type: this.track.codec === "avc" ? "avcC" : "hvcC", payload: description };
      }
      case "av1": {
        // A description that already is a whole av1C record (marker and
        // version byte 0x81, never a valid OBU header) is used verbatim.
        if (description !== null && description[0] === 0x81) {
          return { type: "av1C", payload: description };
        }
        const configObus = description ?? extractAv1SequenceHeaderObu(first.data);
        if (configObus === null) {
          throw new Error("MP4 muxer: no AV1 sequence header OBU in the first key frame and no description was given.");
        }
        const header = av1ConfigurationHeader(parseAv1CodecString(this.track.codecString));
        const payload = new Uint8Array(header.length + configObus.length);
        payload.set(header, 0);
        payload.set(configObus, header.length);
        return { type: "av1C", payload };
      }
    }
  }
}

function sampleOffsets(dataStart: number, sizes: readonly number[]): number[] {
  const offsets: number[] = [];
  let offset = dataStart;
  for (const size of sizes) {
    offsets.push(offset);
    offset += size;
  }
  return offsets;
}
