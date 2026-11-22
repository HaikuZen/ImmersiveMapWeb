// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * Stateless math for Zenly-style pin placement (the Swift
 * `PinCollisionMath`): the smoothing factor, the compression targets, the
 * flower ring and the fallback separation directions for coincident centers.
 *
 * Swift computes in `Float`. The port computes in doubles, here and in the
 * engine's Rust solver (crates/frame-wasm/src/pins.rs), which in Wasm takes
 * its sines, cosines, powers and logarithms from `Math` too, so the
 * TypeScript port of the benchmark and the engine give the same layout bit
 * for bit. The constants are the same.
 *
 * Pin ids are whole numbers up to 2^53 (the Swift `UInt64` within a
 * double's exact range). The 64 bit hash below runs on two 32 bit halves.
 */

/** The offset is considered converged when it is closer to the target than this threshold. */
export const offsetSnapEpsilonPx = 0.5;
/** Scale and morph are considered converged at this proximity to the target. */
export const scaleSnapEpsilon = 0.01;
/** Fraction of the pin size: the anchor sticking radius for overflow grouping. */
export const groupingRadiusScale = 0.35;
/** Sticking radius expansion for already grouped pins (hysteresis). */
export const groupingHysteresisRatio = 1.3;
/** Crossfade duration between pins and a flower, in seconds. */
export const clusterCrossfadeSeconds = 0.25;
/** Cap on the per-frame time step in seconds: guards against jumps after pauses. */
export const maxFrameDeltaSeconds = 0.25;
/** Compression scale below which badges are fully hidden. */
export const badgeFadeStartScale = 0.8;
/** Compression scale at and above which badges are fully visible. */
export const badgeFadeEndScale = 0.95;
/**
 * Fraction of the body radius: the deterministic starting jitter of nodes.
 * It breaks degenerate configurations (collinear anchors would separate
 * strictly along a single line and never fan out).
 */
export const startJitterScale = 0.05;
/** A solved offset below this threshold is treated as zero: it cancels the starting jitter residue on solitary pins. */
export const restSnapRadiusPx = 1.5;
/** High and low 32 bit halves of the salt for the starting jitter direction, 0x517cc1b727220a95. */
export const startJitterSaltHi = 0x517cc1b7;
export const startJitterSaltLo = 0x27220a95;
/** Base scale of a displaced circle: the circle is always noticeably smaller than the pin. */
export const displacedCircleScale = 0.7;
/** Mutual body penetration depth at which the touch counts as full for the static shape check. */
export const staticTouchDepthPx = 8.0;
/** Maximum petals in a flower. Members that do not fit are hidden. */
export const maxFlowerPetals = 7;
/**
 * A flower must be local: the spread of its members' screen anchors must
 * not exceed this multiple of the pin size.
 */
export const flowerCompactnessLimitScale = 2.5;
/** Offset at which a displaced pin starts turning into a circle. */
export const displacedMorphStartPx = 2.0;
/** Offset at which the pin is fully a circle with a beam. */
export const displacedMorphEndPx = 10.0;

const TWO_POW_32 = 4294967296;
const HASH_MODULUS = 6283;
const TWO_POW_32_MOD = TWO_POW_32 % HASH_MODULUS;

export function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Fraction of the path toward the target per frame for exponential
 * smoothing, normalized to the frame duration (fps independent).
 */
export function smoothingFactor(smoothing: number, deltaSeconds: number): number {
  const clamped = clamp(smoothing, 0, 1);
  if (!(deltaSeconds > 0)) return 0;
  return 1 - Math.pow(1 - clamped, deltaSeconds * 60);
}

let hashHi = 0;
let hashLo = 0;

/** FNV-1a over the eight little-endian bytes of a 64 bit value, into hashHi and hashLo. */
function hashValue(hi: number, lo: number): void {
  for (let half = 0; half < 2; half++) {
    let word = half === 0 ? lo : hi;
    for (let byte = 0; byte < 4; byte++) {
      hashLo = (hashLo ^ (word & 0xff)) >>> 0;
      // hash * 0x100000001b3 modulo 2^64: hash * 0x1b3 plus the low half shifted up by 40.
      const low = hashLo * 0x1b3;
      const carry = Math.floor(low / TWO_POW_32);
      hashHi = (hashHi * 0x1b3 + carry + (hashLo << 8)) >>> 0;
      hashLo = low >>> 0;
      word >>>= 8;
    }
  }
}

/**
 * The angle of the deterministic separation direction for two 64 bit keys
 * given as halves, the smaller key first.
 */
export function stableUnitAngleOfHalves(lowerHi: number, lowerLo: number, upperHi: number, upperLo: number): number {
  hashHi = 0xcbf29ce4;
  hashLo = 0x84222325;
  hashValue(lowerHi, lowerLo);
  hashValue(upperHi, upperLo);
  const remainder = ((hashHi % HASH_MODULUS) * TWO_POW_32_MOD + (hashLo % HASH_MODULUS)) % HASH_MODULUS;
  return remainder * 0.001;
}

/** The angle of `stableUnitDirection` for two ids. */
export function stableUnitAngle(idA: number, idB: number): number {
  const lower = Math.min(idA, idB);
  const upper = Math.max(idA, idB);
  return stableUnitAngleOfHalves(Math.floor(lower / TWO_POW_32), lower >>> 0, Math.floor(upper / TWO_POW_32), upper >>> 0);
}

/**
 * Deterministic separation direction for a pair of nodes whose centers
 * coincide and whose collision normal is undefined. Independent of the
 * order of the ids.
 */
export function stableUnitDirection(idA: number, idB: number): readonly [number, number] {
  const angle = stableUnitAngle(idA, idB);
  return [Math.cos(angle), Math.sin(angle)];
}

/** The angle of the starting jitter of a node with this key (the key paired with the salt, which is above every id). */
export function startJitterAngle(key: number): number {
  return stableUnitAngleOfHalves(Math.floor(key / TWO_POW_32), key >>> 0, startJitterSaltHi, startJitterSaltLo);
}

/**
 * Morph based on actual touch: the full pin body at its anchor against
 * the actual (already shrunken) bodies of neighbors. While there is no
 * visible touch, the pin does not react.
 */
export function staticTouchMorph(overlapDepth: number): number {
  return smoothstep(0, staticTouchDepthPx, overlapDepth);
}

/** Shape-based scale upper bound: a pin at full size, a displaced circle no more than `displacedCircleScale`. */
export function scaleCap(morph: number): number {
  return 1 + (displacedCircleScale - 1) * clamp(morph, 0, 1);
}

/**
 * The scale at which a pair of bodies stops intersecting at the given
 * distance. The compression is forced and split evenly between both bodies.
 * When `otherIsRigid` (the neighbor does not shrink: selected, a flower or a
 * dominant), the entire shortfall falls on the current pin.
 */
export function requiredScale(distance: number, bodyRadius: number, otherBodyRadius: number, padding: number, otherIsRigid: boolean): number {
  const available = distance - 2 * padding;
  if (!(bodyRadius > 0)) return 1;
  const scale = otherIsRigid ? (available - otherBodyRadius) / bodyRadius : available / (bodyRadius + otherBodyRadius);
  return clamp(scale, 0, 1);
}

/** Radius of the flower slot ring: adjacent petals touch each other. */
export function flowerRingRadius(petalBodyRadius: number, petalCount: number): number {
  if (petalCount <= 1) return 0;
  return petalBodyRadius / Math.sin(Math.PI / petalCount);
}

/** The angle of a petal on the flower ring: the first petal is at the top. */
export function flowerPetalAngle(index: number, petalCount: number): number {
  return Math.PI / 2 + (2 * Math.PI * index) / petalCount;
}

/** Petal position on the flower ring relative to its center. */
export function flowerPetalOffset(index: number, petalCount: number, ringRadius: number): readonly [number, number] {
  if (petalCount <= 0) return [0, 0];
  const angle = flowerPetalAngle(index, petalCount);
  return [Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius];
}

/**
 * Pin to circle shape morph: a pin keeps the pin shape only while standing
 * exactly on its geo point, any pin displaced by neighbors becomes a circle.
 */
export function displacedMorph(offsetLength: number): number {
  return smoothstep(displacedMorphStartPx, displacedMorphEndPx, offsetLength);
}

/** Badge alpha: as the pin compresses, badges fade out smoothly. */
export function badgeContentAlpha(displayScale: number): number {
  return smoothstep(badgeFadeStartScale, badgeFadeEndScale, displayScale);
}
