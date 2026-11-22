// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { StarfieldSettings } from "../configuration/scene-settings.ts";
import type { Vec3 } from "../math/vec.ts";

/**
 * The `starfield` folder: the deterministic CPU-side star model, its value
 * types and placement math, independent of tiles and styles, and the
 * pipeline, the shader and the subsystem that draw it. A port of the Swift
 * `StarfieldModel`, with its SplitMix64 stream bit for bit.
 */
export interface Star {
  readonly position: Vec3;
  readonly size: number;
  readonly brightness: number;
  readonly temperature: number;
  readonly twinklePhase: number;
  readonly halo: number;
}

interface LayerProfile {
  readonly sizeLower: number;
  readonly sizeUpper: number;
  readonly brightnessLower: number;
  readonly brightnessUpper: number;
  readonly haloLower: number;
  readonly haloUpper: number;
  readonly clusterProbability: number;
  readonly clusterSpread: number;
  readonly valueBias: number;
}

const MASK64 = (1n << 64n) - 1n;

/** The Swift engine's SplitMix64, on 64-bit BigInts. */
class SplitMix64 {
  constructor(private state: bigint) {}

  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64;
    let value = this.state;
    value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return value ^ (value >> 31n);
  }

  nextFloat(lower = 0, upper = 1): number {
    const unit = Number(this.next() >> 40n) / (1 << 24);
    return Math.fround(lower + (upper - lower) * unit);
  }
}

const defaultSeed = 0x5a17f1e1da7ace01n;

export const StarfieldModel = {
  defaultSeed,

  makeStars(config: StarfieldSettings, seed: bigint = defaultSeed): Star[] {
    if (config.starCount <= 0) return [];
    const starCount = Math.floor(config.starCount);
    const random = new SplitMix64(seed ^ BigInt(starCount));
    const clusterAnchors = makeAnchors(11, random);
    const voidAnchors = makeAnchors(3, random);
    const sizeRange = Math.max(config.sizeMax - config.sizeMin, 0.001);
    const brightnessRange = Math.max(config.brightnessMax - config.brightnessMin, 0.001);

    // Layer sizes are clamped by the remaining budget, so a small starCount
    // never produces more stars than requested.
    const dustCount = Math.min(starCount, Math.max(1, Math.trunc(Math.fround(starCount * 0.68))));
    const midCount = Math.min(starCount - dustCount, Math.max(1, Math.trunc(Math.fround(starCount * 0.25))));
    const accentCount = starCount - dustCount - midCount;

    const layers: { count: number; profile: LayerProfile }[] = [
      {
        count: dustCount,
        profile: { sizeLower: 0, sizeUpper: 0.28, brightnessLower: 0, brightnessUpper: 0.22, haloLower: 0.12, haloUpper: 0.28, clusterProbability: 0.78, clusterSpread: 0.1, valueBias: 1.9 },
      },
      {
        count: midCount,
        profile: { sizeLower: 0.18, sizeUpper: 0.62, brightnessLower: 0.2, brightnessUpper: 0.74, haloLower: 0.22, haloUpper: 0.48, clusterProbability: 0.66, clusterSpread: 0.16, valueBias: 1.35 },
      },
      {
        count: accentCount,
        profile: { sizeLower: 0.56, sizeUpper: 1, brightnessLower: 0.68, brightnessUpper: 1, haloLower: 0.45, haloUpper: 0.95, clusterProbability: 0.48, clusterSpread: 0.24, valueBias: 0.9 },
      },
    ];

    const stars: Star[] = [];
    layers.forEach((layer, layerIndex) => {
      const p = layer.profile;
      for (let i = 0; i < layer.count; i++) {
        const position = makePosition(p, clusterAnchors, voidAnchors, random);
        const size = config.sizeMin + sampleRange(p.sizeLower, p.sizeUpper, p.valueBias, random) * sizeRange;
        const brightness = config.brightnessMin + sampleRange(p.brightnessLower, p.brightnessUpper, Math.max(0.7, p.valueBias - 0.2), random) * brightnessRange;
        const temperature = temperatureSample(layerIndex, random);
        const twinklePhase = random.nextFloat(0, Math.PI * 2);
        const halo = sampleRange(p.haloLower, p.haloUpper, 1.1, random);
        stars.push({ position, size, brightness, temperature, twinklePhase, halo });
      }
    });
    return stars;
  },

  /** The stars as the vertex buffer holds them: per star the position, size, brightness, temperature, twinkle phase and halo, 32 bytes. */
  vertexData(stars: readonly Star[]): Float32Array {
    const data = new Float32Array(stars.length * 8);
    stars.forEach((s, i) => {
      data.set([s.position[0], s.position[1], s.position[2], s.size, s.brightness, s.temperature, s.twinklePhase, s.halo], i * 8);
    });
    return data;
  },
} as const;

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function makeAnchors(count: number, random: SplitMix64): Vec3[] {
  return Array.from({ length: count }, () => uniformSphere(random));
}

function makePosition(profile: LayerProfile, clusterAnchors: readonly Vec3[], voidAnchors: readonly Vec3[], random: SplitMix64): Vec3 {
  for (let attempt = 0; attempt < 8; attempt++) {
    let candidate: Vec3;
    if (random.nextFloat() < profile.clusterProbability) {
      const anchorIndex = Number(random.next() % BigInt(clusterAnchors.length));
      candidate = clusteredDirection(clusterAnchors[anchorIndex]!, profile.clusterSpread, random);
    } else {
      candidate = uniformSphere(random);
    }
    const isInsideVoid = voidAnchors.some((a) => candidate[0] * a[0] + candidate[1] * a[1] + candidate[2] * a[2] > 0.965);
    if (!isInsideVoid || random.nextFloat() > 0.82) return candidate;
  }
  return uniformSphere(random);
}

function clusteredDirection(anchor: Vec3, spread: number, random: SplitMix64): Vec3 {
  const referenceAxis: Vec3 = Math.abs(anchor[1]) < 0.92 ? [0, 1, 0] : [1, 0, 0];
  const tangentA = normalize(cross(anchor, referenceAxis));
  const tangentB = normalize(cross(anchor, tangentA));
  const angle = random.nextFloat(0, Math.PI * 2);
  const radius = spread * Math.pow(random.nextFloat(), 1.75);
  const c = Math.cos(angle) * radius;
  const s = Math.sin(angle) * radius;
  return normalize([anchor[0] + tangentA[0] * c + tangentB[0] * s, anchor[1] + tangentA[1] * c + tangentB[1] * s, anchor[2] + tangentA[2] * c + tangentB[2] * s]);
}

function uniformSphere(random: SplitMix64): Vec3 {
  const u = random.nextFloat();
  const v = random.nextFloat();
  const theta = 2 * Math.PI * u;
  const z = 2 * v - 1;
  const radial = Math.sqrt(Math.max(0, 1 - z * z));
  return [radial * Math.cos(theta), radial * Math.sin(theta), z];
}

function sampleRange(lowerBound: number, upperBound: number, bias: number, random: SplitMix64): number {
  const lower = Math.min(lowerBound, upperBound);
  const upper = Math.max(lowerBound, upperBound);
  return lower + (upper - lower) * Math.pow(random.nextFloat(), bias);
}

function temperatureSample(layerIndex: number, random: SplitMix64): number {
  const roll = random.nextFloat();
  switch (layerIndex) {
    case 0:
      if (roll < 0.12) return random.nextFloat(0, 0.22);
      if (roll < 0.84) return random.nextFloat(0.34, 0.66);
      return random.nextFloat(0.72, 1);
    case 1:
      if (roll < 0.18) return random.nextFloat(0, 0.26);
      if (roll < 0.76) return random.nextFloat(0.3, 0.7);
      return random.nextFloat(0.72, 1);
    default:
      if (roll < 0.22) return random.nextFloat(0, 0.32);
      if (roll < 0.6) return random.nextFloat(0.34, 0.68);
      return random.nextFloat(0.72, 1);
  }
}
