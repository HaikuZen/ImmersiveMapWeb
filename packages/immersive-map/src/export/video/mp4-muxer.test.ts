// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";

import { Mp4Muxer, chunkOffsetBoxKind, durationsToTicks, mp4Timescale, type Mp4VideoChunk, type Mp4VideoTrack } from "./mp4-muxer.ts";

// MARK: Independent box reader

interface ParsedBox {
  readonly type: string;
  /** Offset of the box header in the file. */
  readonly start: number;
  /** Offset of the first payload byte (after size and type). */
  readonly payloadStart: number;
  readonly end: number;
}

// Bytes of a box payload that precede its child boxes, for the boxes the
// tests descend into.
const CHILD_PREFIX: Record<string, number> = {
  moov: 0,
  trak: 0,
  mdia: 0,
  minf: 0,
  stbl: 0,
  dinf: 0,
  stsd: 8,
  avc1: 78,
  av01: 78,
  hvc1: 78,
};

function readBoxes(file: Uint8Array, start: number, end: number): ParsedBox[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const boxes: ParsedBox[] = [];
  let position = start;
  while (position + 8 <= end) {
    let size = view.getUint32(position);
    const type = String.fromCharCode(...file.subarray(position + 4, position + 8));
    let headerSize = 8;
    if (size === 1) {
      size = Number(view.getBigUint64(position + 8));
      headerSize = 16;
    }
    boxes.push({ type, start: position, payloadStart: position + headerSize, end: position + size });
    position += size;
  }
  expect(position).toBe(end);
  return boxes;
}

function children(file: Uint8Array, box: ParsedBox): ParsedBox[] {
  const prefix = CHILD_PREFIX[box.type];
  if (prefix === undefined) {
    throw new Error(`no child layout for ${box.type}`);
  }
  return readBoxes(file, box.payloadStart + prefix, box.end);
}

function child(file: Uint8Array, box: ParsedBox, type: string): ParsedBox {
  const found = children(file, box).find((candidate) => candidate.type === type);
  if (found === undefined) {
    throw new Error(`no ${type} inside ${box.type}`);
  }
  return found;
}

function path(file: Uint8Array, types: readonly string[]): ParsedBox {
  const top = readBoxes(file, 0, file.length).find((box) => box.type === types[0]);
  if (top === undefined) {
    throw new Error(`no top level ${types[0]}`);
  }
  return types.slice(1).reduce((box, type) => child(file, box, type), top);
}

function payload(file: Uint8Array, box: ParsedBox): Uint8Array {
  return file.subarray(box.payloadStart, box.end);
}

function u32List(bytes: Uint8Array, offset: number, count: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, index) => view.getUint32(offset + index * 4));
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function concatenate(parts: readonly BlobPart[]): Uint8Array {
  const arrays = parts.map((part) => {
    if (!(part instanceof Uint8Array)) {
      throw new Error("expected only Uint8Array parts");
    }
    return part;
  });
  const total = arrays.reduce((sum, array) => sum + array.length, 0);
  const file = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    file.set(array, offset);
    offset += array.length;
  }
  return file;
}

// MARK: Fixtures

const avcTrack: Mp4VideoTrack = { codec: "avc", codecString: "avc1.640034", width: 1920, height: 1080, framesPerSecond: 30 };

const avcDescription = new Uint8Array([0x01, 0x64, 0x00, 0x34, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x34, 0x01, 0x00, 0x02, 0x68, 0xee]);

function fakeChunk(timestamp: number, duration: number | null, isKeyFrame: boolean, length: number, fill: number): Mp4VideoChunk {
  return { data: new Uint8Array(length).fill(fill), timestampMicroseconds: timestamp, durationMicroseconds: duration, isKeyFrame };
}

function avcFile(): { file: Uint8Array; chunks: Mp4VideoChunk[] } {
  const muxer = new Mp4Muxer(avcTrack);
  const chunks = [fakeChunk(0, 33_333, true, 120, 0x11), fakeChunk(33_333, 33_334, false, 40, 0x22), fakeChunk(66_667, 33_333, false, 25, 0x33)];
  muxer.addChunk(chunks[0]!, avcDescription);
  muxer.addChunk(chunks[1]!, new Uint8Array([0xde, 0xad]));
  muxer.addChunk(chunks[2]!);
  expect(muxer.sampleCount).toBe(3);
  return { file: concatenate(muxer.finish()), chunks };
}

// MARK: Tests

describe("Mp4Muxer with avc", () => {
  it("writes the ftyp brands and a fast start layout", () => {
    const { file } = avcFile();
    const top = readBoxes(file, 0, file.length).map((box) => box.type);
    expect(top).toEqual(["ftyp", "moov", "mdat"]);
    const ftyp = payload(file, path(file, ["ftyp"]));
    const text = String.fromCharCode(...ftyp.subarray(0, 4), ...ftyp.subarray(8));
    expect(text).toBe("isomisomiso2mp41avc1");
    expect(dataView(ftyp).getUint32(4)).toBe(0x200);
  });

  it("nests the sample entry and copies the avcC description verbatim", () => {
    const { file } = avcFile();
    const avc1 = path(file, ["moov", "trak", "mdia", "minf", "stbl", "stsd", "avc1"]);
    const entry = dataView(payload(file, avc1));
    expect(entry.getUint16(24)).toBe(1920);
    expect(entry.getUint16(26)).toBe(1080);
    expect(entry.getUint16(74)).toBe(0x18);
    expect(entry.getInt16(76)).toBe(-1);
    expect(Array.from(payload(file, child(file, avc1, "avcC")))).toEqual(Array.from(avcDescription));

    const colr = payload(file, child(file, avc1, "colr"));
    expect(String.fromCharCode(...colr.subarray(0, 4))).toBe("nclx");
    expect([dataView(colr).getUint16(4), dataView(colr).getUint16(6), dataView(colr).getUint16(8), colr[10]]).toEqual([1, 1, 1, 0]);
    expect(u32List(payload(file, child(file, avc1, "pasp")), 0, 2)).toEqual([1, 1]);
  });

  it("writes the track size, timescale and duration", () => {
    const { file } = avcFile();
    const tkhd = dataView(payload(file, path(file, ["moov", "trak", "tkhd"])));
    expect(tkhd.getUint32(0) & 0xffffff).toBe(3);
    expect(tkhd.getUint32(76)).toBe(1920 * 65536);
    expect(tkhd.getUint32(80)).toBe(1080 * 65536);

    const mdhd = dataView(payload(file, path(file, ["moov", "trak", "mdia", "mdhd"])));
    expect(mdhd.getUint32(12)).toBe(90_000);
    expect(mdhd.getUint32(16)).toBe(9000);
    expect(mdhd.getUint16(20)).toBe(0x55c4);
  });

  it("writes stts, stsz, stss and stco consistent with the chunk bytes", () => {
    const { file, chunks } = avcFile();
    const stbl = path(file, ["moov", "trak", "mdia", "minf", "stbl"]);

    const stts = payload(file, child(file, stbl, "stts"));
    const runCount = dataView(stts).getUint32(4);
    const runs = u32List(stts, 8, runCount * 2);
    let total = 0;
    let samples = 0;
    for (let index = 0; index < runs.length; index += 2) {
      samples += runs[index]!;
      total += runs[index]! * runs[index + 1]!;
    }
    expect(samples).toBe(3);
    expect(total).toBe(9000);

    const stsz = payload(file, child(file, stbl, "stsz"));
    expect(u32List(stsz, 4, 2)).toEqual([0, 3]);
    expect(u32List(stsz, 12, 3)).toEqual([120, 40, 25]);

    const stss = payload(file, child(file, stbl, "stss"));
    expect(u32List(stss, 4, 2)).toEqual([1, 1]);

    const stco = payload(file, child(file, stbl, "stco"));
    const offsets = u32List(stco, 8, dataView(stco).getUint32(4));
    expect(offsets).toHaveLength(3);
    offsets.forEach((offset, index) => {
      const chunk = chunks[index]!;
      expect(Array.from(file.subarray(offset, offset + chunk.data.length))).toEqual(Array.from(chunk.data));
    });
    const mdat = path(file, ["mdat"]);
    expect(offsets[0]).toBe(mdat.payloadStart);
  });

  it("omits stss when every sample is a key frame", () => {
    const muxer = new Mp4Muxer(avcTrack);
    muxer.addChunk(fakeChunk(1000, null, true, 10, 1), avcDescription);
    muxer.addChunk(fakeChunk(34_333, null, true, 10, 2));
    const file = concatenate(muxer.finish());
    const stbl = path(file, ["moov", "trak", "mdia", "minf", "stbl"]);
    expect(children(file, stbl).map((box) => box.type)).toEqual(["stsd", "stts", "stsc", "stsz", "stco"]);
  });

  it("rejects timestamps that are not strictly increasing", () => {
    const muxer = new Mp4Muxer(avcTrack);
    muxer.addChunk(fakeChunk(0, null, true, 10, 1), avcDescription);
    expect(() => muxer.addChunk(fakeChunk(0, null, false, 10, 2))).toThrow(/strictly increasing/);
  });

  it("throws on finish without an avc description", () => {
    const muxer = new Mp4Muxer(avcTrack);
    muxer.addChunk(fakeChunk(0, null, true, 10, 1));
    expect(() => muxer.finish()).toThrow(/description/);
  });

  it("throws on finish with zero samples or a leading delta frame", () => {
    expect(() => new Mp4Muxer(avcTrack).finish()).toThrow(/zero samples/);
    const muxer = new Mp4Muxer(avcTrack);
    muxer.addChunk(fakeChunk(0, null, false, 10, 1), avcDescription);
    expect(() => muxer.finish()).toThrow(/key frame/);
  });

  it("produces a video/mp4 Blob", () => {
    const muxer = new Mp4Muxer(avcTrack);
    muxer.addChunk(fakeChunk(0, null, true, 10, 1), avcDescription);
    const blob = muxer.finishBlob();
    expect(blob.type).toBe("video/mp4");
  });
});

describe("Mp4Muxer with av1", () => {
  it("extracts the sequence header OBU into av1C", () => {
    const temporalDelimiter = [0x12, 0x00];
    const sequenceHeader = [0x0a, 0x03, 0x00, 0x00, 0x00];
    const frame = [0x32, 0x02, 0xaa, 0xbb];
    const data = new Uint8Array([...temporalDelimiter, ...sequenceHeader, ...frame]);
    const muxer = new Mp4Muxer({ codec: "av1", codecString: "av01.0.08M.08", width: 1280, height: 720, framesPerSecond: 60 });
    muxer.addChunk({ data, timestampMicroseconds: 0, durationMicroseconds: null, isKeyFrame: true });
    const file = concatenate(muxer.finish());

    const ftyp = payload(file, path(file, ["ftyp"]));
    expect(String.fromCharCode(...ftyp.subarray(ftyp.length - 4))).toBe("av01");
    const av01 = path(file, ["moov", "trak", "mdia", "minf", "stbl", "stsd", "av01"]);
    const av1C = payload(file, child(file, av01, "av1C"));
    expect(Array.from(av1C.subarray(0, 4))).toEqual([0x81, 0x08, 0x0c, 0x00]);
    expect(Array.from(av1C.subarray(4))).toEqual(sequenceHeader);
  });
});

describe("mp4 helpers", () => {
  it("selects co64 only above 32-bit offsets", () => {
    expect(chunkOffsetBoxKind(0)).toBe("stco");
    expect(chunkOffsetBoxKind(0xffff_ffff)).toBe("stco");
    expect(chunkOffsetBoxKind(0x1_0000_0000)).toBe("co64");
  });

  it("derives a timescale with integer frame durations", () => {
    expect(mp4Timescale(30)).toBe(90_000);
    expect(mp4Timescale(60)).toBe(90_000);
    expect(mp4Timescale(29.97)).toBe(29_970);
    expect(mp4Timescale(7)).toBe(7000);
  });

  it("keeps the tick sum exact for non-integer microsecond frames", () => {
    const durations = Array.from({ length: 60 }, (_, index) => Math.round(((index + 1) * 1e6) / 60) - Math.round((index * 1e6) / 60));
    const ticks = durationsToTicks(durations, 90_000);
    expect(ticks.every((value) => value === 1500)).toBe(true);
  });
});
