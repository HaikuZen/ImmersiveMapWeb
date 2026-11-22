// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * A size in bytes, written in the unit that reads best:
 *
 * ```ts
 * settings.preparedTileDiskCacheSize(ImmersiveMapByteCount.gigabytes(2));
 * settings.preparedTileDiskCacheSize(ImmersiveMapByteCount.megabytes(512));
 * ```
 *
 * A gigabyte here is 1024 megabytes and a megabyte 1024 kilobytes, as
 * memory and caches are counted. A negative size is zero.
 */
export interface ImmersiveMapByteCount {
  /** The size in bytes. */
  readonly bytes: number;
}

function scaled(count: number, unit: number): ImmersiveMapByteCount {
  const bytes = Math.round(count * unit);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return Object.freeze({ bytes: 0 });
  }
  return Object.freeze({ bytes: Math.min(bytes, Number.MAX_SAFE_INTEGER) });
}

/** The units a byte count is written in, and the order of two counts. */
export const ImmersiveMapByteCount = Object.freeze({
  bytes(count: number): ImmersiveMapByteCount {
    return Object.freeze({ bytes: Math.max(Math.trunc(count), 0) });
  },
  kilobytes(count: number): ImmersiveMapByteCount {
    return scaled(count, 2 ** 10);
  },
  megabytes(count: number): ImmersiveMapByteCount {
    return scaled(count, 2 ** 20);
  },
  gigabytes(count: number): ImmersiveMapByteCount {
    return scaled(count, 2 ** 30);
  },
  /** Negative when `a` is smaller than `b`, zero when they are equal, positive otherwise. */
  compare(a: ImmersiveMapByteCount, b: ImmersiveMapByteCount): number {
    return a.bytes - b.bytes;
  },
});
