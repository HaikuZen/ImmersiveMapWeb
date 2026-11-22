// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The pin collision layout in TypeScript, the loser of B4 (pins), kept for
// bench-pins only: the engine solves in Rust/Wasm (crates/frame-wasm,
// pins.rs) through packages/immersive-map/src/pins/clustering/pin-collision-layout-solver.ts,
// and this port gives the same layout.

/**
 * Zenly-like pin placement (the Swift `PinCollisionLayoutSolver`): pins push
 * each other apart as circles in screen space (Gauss-Seidel with a spring
 * to the anchor). Only a pin standing exactly on its geo point keeps the pin
 * shape, a displaced pin is a shrunken circle with a beam to the geo point.
 * Dense piles are laid out as a flower of petals, and members that do not
 * fit are hidden. Inter-frame state gives smooth, fps independent
 * transitions.
 *
 * The frame's input is copied once into flat arrays in id order, the
 * algorithm runs on indices into them, and the items are made at the end.
 * Sets keyed by id in Swift are flags by input index here, which is the same
 * for unique ids. Computation is in doubles.
 */

import type { ScreenPointOutput } from "../../../../packages/immersive-map/src/geo/geo-screen-projection-math.ts";
import type { PinSettings } from "../../../../packages/immersive-map/src/configuration/pin-settings.ts";
import {
  clusterCrossfadeSeconds,
  displacedMorph,
  flowerCompactnessLimitScale,
  flowerPetalAngle,
  flowerRingRadius,
  groupingHysteresisRatio,
  groupingRadiusScale,
  maxFlowerPetals,
  maxFrameDeltaSeconds,
  offsetSnapEpsilonPx,
  requiredScale,
  restSnapRadiusPx,
  scaleCap,
  scaleSnapEpsilon,
  smoothingFactor,
  smoothstep,
  stableUnitAngle,
  startJitterAngle,
  startJitterScale,
  staticTouchMorph,
} from "../../../../packages/immersive-map/src/pins/clustering/pin-collision-math.ts";
import { PinCollisionLayout, pinCollisionBodyRadius } from "../../../../packages/immersive-map/src/pins/clustering/pin-collision-types.ts";
import type { PinCollisionGeometry, PinCollisionItem, PinFlowerGroup, ProjectedPin } from "../../../../packages/immersive-map/src/pins/clustering/pin-collision-types.ts";
import { PinDisjointSet, PinIndexList, PinPairLists, PinScreenHashGrid } from "./ts-pin-screen-hash-grid.ts";


/** The settings the solver reads. */
export type PinCollisionSettings = Pick<PinSettings, "compressedScale" | "collisionPaddingPx" | "groupingThreshold" | "maxOffsetPx" | "collisionIterations" | "springK" | "smoothing">;

interface PinMotionState {
  offsetX: number;
  offsetY: number;
  scale: number;
  morph: number;
  clusterBlend: number;
  /** -1 for none. */
  lastClusterKey: number;
}

interface ClusterMotionState {
  presence: number;
  memberIDs: number[];
}

interface ClusterSeed {
  readonly stateKey: number;
  /** Member indices into the frame input, ascending (id order). */
  readonly memberIndexes: number[];
  readonly memberIDs: number[];
  readonly boundsMinX: number;
  readonly boundsMinY: number;
  readonly boundsMaxX: number;
  readonly boundsMaxY: number;
  /** The ring position: the anchor centroid, possibly shifted to separate intersecting unmergeable rings. */
  centerX: number;
  centerY: number;
}

/** A crowd: this many candidates in one cell of the join radius are united without pairwise checks. */
const denseGroupingCellPopulation = 16;
/** How many members of a dense cell a neighboring sparse pin is checked against before concluding there is no link. */
const denseGroupingProbeLimit = 64;

const JOIN_EVENT = 0;
const JOIN_OVERFLOW = 1;
const JOIN_BODIES = 2;

/** The length of a vector, as `simd_length`: the square root of the dot product. */
function vectorLength(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

function growF64(array: Float64Array<ArrayBuffer>, size: number): Float64Array<ArrayBuffer> {
  if (array.length >= size) return array;
  let length = Math.max(64, array.length);
  while (length < size) length *= 2;
  return new Float64Array(length);
}

function growI32(array: Int32Array<ArrayBuffer>, size: number): Int32Array<ArrayBuffer> {
  if (array.length >= size) return array;
  let length = Math.max(64, array.length);
  while (length < size) length *= 2;
  return new Int32Array(length);
}

function growU8(array: Uint8Array<ArrayBuffer>, size: number): Uint8Array<ArrayBuffer> {
  if (array.length >= size) return array;
  let length = Math.max(64, array.length);
  while (length < size) length *= 2;
  return new Uint8Array(length);
}

/** Merges two ascending index lists in linear time. */
function mergeSortedIndexes(lhs: readonly number[], rhs: readonly number[]): number[] {
  const result: number[] = [];
  let l = 0;
  let r = 0;
  while (l < lhs.length && r < rhs.length) {
    if (lhs[l]! <= rhs[r]!) result.push(lhs[l++]!);
    else result.push(rhs[r++]!);
  }
  while (l < lhs.length) result.push(lhs[l++]!);
  while (r < rhs.length) result.push(rhs[r++]!);
  return result;
}

function flowerOuterRadius(memberCount: number, petalBodyRadius: number): number {
  return flowerRingRadius(petalBodyRadius, Math.min(memberCount, maxFlowerPetals)) + petalBodyRadius;
}

/** Solver nodes: standalone pins, then the petal slots of the live flowers. */
class SolverNodes {
  count = 0;
  anchorX = new Float64Array(64);
  anchorY = new Float64Array(64);
  positionX = new Float64Array(64);
  positionY = new Float64Array(64);
  radius = new Float64Array(64);
  inverseMass = new Float64Array(64);
  directionKey = new Float64Array(64);
  positions = new Float64Array(128);

  reserve(size: number): void {
    this.anchorX = growF64(this.anchorX, size);
    this.anchorY = growF64(this.anchorY, size);
    this.positionX = growF64(this.positionX, size);
    this.positionY = growF64(this.positionY, size);
    this.radius = growF64(this.radius, size);
    this.inverseMass = growF64(this.inverseMass, size);
    this.directionKey = growF64(this.directionKey, size);
    this.positions = growF64(this.positions, size * 2);
    this.count = 0;
  }

  push(anchorX: number, anchorY: number, positionX: number, positionY: number, radius: number, inverseMass: number, directionKey: number): void {
    const i = this.count++;
    this.anchorX[i] = anchorX;
    this.anchorY[i] = anchorY;
    this.positionX[i] = positionX;
    this.positionY[i] = positionY;
    this.radius[i] = radius;
    this.inverseMass[i] = inverseMass;
    this.directionKey[i] = directionKey;
  }
}

export class PinCollisionLayoutSolver {
  private pinStates = new Map<number, PinMotionState>();
  /** Keyed by the minimum member id: preserves state across membership changes. */
  private clusterStates = new Map<number, ClusterMotionState>();
  /** Ids grouped into flowers last frame, ascending. */
  private previouslyGrouped: number[] = [];
  private lastTime: number | null = null;

  // The frame's input in id order.
  private count = 0;
  private sourceIndex = new Int32Array(64);
  private ids = new Float64Array(64);
  private px = new Float64Array(64);
  private py = new Float64Array(64);
  private wx = new Float64Array(64);
  private wy = new Float64Array(64);
  private alpha = new Float64Array(64);
  private sizeScale = new Float64Array(64);
  private priority = new Float64Array(64);
  private selected = new Uint8Array(64);
  private event = new Uint8Array(64);
  private wasGrouped = new Uint8Array(64);
  private seen = new Uint8Array(64);
  private seedOf = new Int32Array(64);

  // The frame's emitted items, by input index.
  private itemCount = 0;
  private itemIndex = new Int32Array(64);
  private itemX = new Float64Array(64);
  private itemY = new Float64Array(64);
  private itemAlpha = new Float64Array(64);
  private itemScale = new Float64Array(64);
  private itemMorph = new Float64Array(64);
  private itemPetal = new Uint8Array(64);

  // Scratch.
  private readonly grid = new PinScreenHashGrid();
  private readonly disjointSet = new PinDisjointSet();
  private readonly candidates = new PinIndexList();
  private readonly pairLists = new PinPairLists();
  private readonly nodes = new SolverNodes();
  private positions = new Float64Array(128);
  private groupSizes = new Int32Array(64);
  private groupSlots = new Int32Array(64);
  private joinMode = JOIN_EVENT;
  private joinRadius = 0;
  private joinExitRadius = 0;
  private bodyX = new Float64Array(64);
  private bodyY = new Float64Array(64);
  private bodyReach = new Float64Array(64);
  private jitterX = new Float64Array(64);
  private jitterY = new Float64Array(64);

  /** Forgets the inter-frame state, as if the solver were new. */
  reset(): void {
    this.pinStates.clear();
    this.clusterStates.clear();
    this.previouslyGrouped = [];
    this.lastTime = null;
  }

  solve(projectedPins: readonly ProjectedPin[], geometry: PinCollisionGeometry, config: PinCollisionSettings, time: number): PinCollisionLayout {
    try {
      return this.solveFrame(projectedPins, geometry, config, time);
    } finally {
      this.lastTime = time;
    }
  }

  private loadInput(projectedPins: readonly ProjectedPin[]): void {
    const n = projectedPins.length;
    this.count = n;
    this.sourceIndex = growI32(this.sourceIndex, n);
    this.ids = growF64(this.ids, n);
    this.px = growF64(this.px, n);
    this.py = growF64(this.py, n);
    this.wx = growF64(this.wx, n);
    this.wy = growF64(this.wy, n);
    this.alpha = growF64(this.alpha, n);
    this.sizeScale = growF64(this.sizeScale, n);
    this.priority = growF64(this.priority, n);
    this.selected = growU8(this.selected, n);
    this.event = growU8(this.event, n);
    this.wasGrouped = growU8(this.wasGrouped, n);
    this.seen = growU8(this.seen, n);
    this.seedOf = growI32(this.seedOf, n);
    // The input is almost always already ordered by id, sorting is a safety net.
    let sorted = true;
    for (let i = 1; i < n; i++) {
      if (projectedPins[i - 1]!.pin.id >= projectedPins[i]!.pin.id) {
        sorted = false;
        break;
      }
    }
    const order = this.sourceIndex;
    for (let i = 0; i < n; i++) order[i] = i;
    if (!sorted) order.subarray(0, n).sort((a, b) => projectedPins[a]!.pin.id - projectedPins[b]!.pin.id);
    for (let i = 0; i < n; i++) {
      const projected = projectedPins[order[i]!]!;
      const pin = projected.pin;
      this.ids[i] = pin.id;
      this.px[i] = projected.screenPoint.positionX;
      this.py[i] = projected.screenPoint.positionY;
      this.wx[i] = projected.worldX;
      this.wy[i] = projected.worldY;
      this.alpha[i] = projected.screenPoint.visibilityAlpha;
      this.sizeScale[i] = pin.screenSizeScale;
      this.priority[i] = pin.drawPriority;
      this.selected[i] = pin.isSelected ? 1 : 0;
      this.event[i] = pin.clusterPolicy === "event" ? 1 : 0;
      this.seen[i] = 0;
      this.seedOf[i] = -1;
    }
    // Last frame's flower membership as flags, by merging two ascending id lists.
    const previous = this.previouslyGrouped;
    let p = 0;
    for (let i = 0; i < n; i++) {
      const id = this.ids[i]!;
      while (p < previous.length && previous[p]! < id) p++;
      this.wasGrouped[i] = p < previous.length && previous[p] === id ? 1 : 0;
    }
  }

  /** Binary search for a pin's input index by id, -1 when absent. */
  private inputIndex(id: number): number {
    let low = 0;
    let high = this.count - 1;
    const ids = this.ids;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const candidate = ids[middle]!;
      if (candidate === id) return middle;
      if (candidate < id) low = middle + 1;
      else high = middle - 1;
    }
    return -1;
  }

  private solveFrame(projectedPins: readonly ProjectedPin[], geometry: PinCollisionGeometry, config: PinCollisionSettings, time: number): PinCollisionLayout {
    if (projectedPins.length === 0) {
      this.pinStates.clear();
      this.clusterStates.clear();
      this.previouslyGrouped = [];
      return PinCollisionLayout.empty;
    }
    const deltaSeconds = Math.min(Math.max(time - (this.lastTime ?? time), 0), maxFrameDeltaSeconds);
    const smoothingK = smoothingFactor(config.smoothing, deltaSeconds);
    const blendStep = deltaSeconds / Math.max(clusterCrossfadeSeconds, 0.001);
    const pinSizePx = geometry.pinSizePx;
    const compressedScale = Math.min(config.compressedScale, 1);
    const petalBodyRadius = geometry.circleBodyRadiusPx * compressedScale;
    const padding = config.collisionPaddingPx;
    const offsetX = geometry.bodyCenterOffsetX;
    const offsetY = geometry.bodyCenterOffsetY;

    this.loadInput(projectedPins);
    const n = this.count;
    const ids = this.ids;
    const px = this.px;
    const py = this.py;
    const sizeScale = this.sizeScale;
    const selected = this.selected;
    let unsettled = false;

    // A cluster must be local: the limit on the spread of one flower's anchors.
    const compactnessLimit = pinSizePx * flowerCompactnessLimitScale;

    // Grouping: event clusters, then overflow piles with hysteresis.
    const eventSeeds = this.eventClusterSeeds(pinSizePx, padding);
    const excluded = new Uint8Array(n);
    for (const seed of eventSeeds) for (const member of seed.memberIndexes) excluded[member] = 1;
    const overflowSeeds = this.overflowClusterSeeds(excluded, eventSeeds.length > 0, pinSizePx, compactnessLimit, config.groupingThreshold);

    // Flowers and rigid bodies cannot yield to each other, so conflicts between
    // them are resolved by membership.
    let clusterSeeds = this.mergeIntersectingFlowers(eventSeeds.concat(overflowSeeds), petalBodyRadius, compactnessLimit);
    const clustered = new Uint8Array(n);
    for (const seed of clusterSeeds) for (const member of seed.memberIndexes) clustered[member] = 1;
    let standalone: number[] = [];
    for (let i = 0; i < n; i++) if (clustered[i] === 0) standalone.push(i);
    standalone = this.absorbPinsIntoFlowers(clusterSeeds, standalone, geometry, petalBodyRadius, padding);
    clusterSeeds = this.mergeIntersectingFlowers(clusterSeeds, petalBodyRadius, compactnessLimit).sort((a, b) => a.stateKey - b.stateKey);

    // Rings of unmergeable neighbors are separated until they no longer intersect.
    separateFlowerRings(clusterSeeds, petalBodyRadius);

    // Next frame's hysteresis keeps the widened radius for all flower members.
    const seedOf = this.seedOf;
    for (let s = 0; s < clusterSeeds.length; s++) for (const member of clusterSeeds[s]!.memberIndexes) seedOf[member] = s;
    const groupedNow: number[] = [];
    for (let i = 0; i < n; i++) if (seedOf[i]! >= 0) groupedNow.push(ids[i]!);
    this.previouslyGrouped = groupedNow;

    const standaloneCount = standalone.length;

    // Every pile of touching pins has a dominant: it keeps the pin shape and
    // does not move, only the others yield.
    const rigid = this.dominantFlags(standalone, clusterSeeds, geometry, compressedScale, padding);
    for (let s = 0; s < standaloneCount; s++) if (selected[standalone[s]!] === 1) rigid[s] = 1;

    // Pass A with full-size bodies decides who is displaced, an intermediate
    // pass with shapes from A finds the actual neighbors for the static touch
    // check, pass B with radii from the morph targets gives the positions.
    const nodes = this.nodes;
    // The deterministic starting jitter of each standalone pin, the same in every pass.
    const jitterAmplitude = geometry.bodyRadiusPx * startJitterScale;
    this.jitterX = growF64(this.jitterX, standaloneCount);
    this.jitterY = growF64(this.jitterY, standaloneCount);
    for (let s = 0; s < standaloneCount; s++) {
      const angle = startJitterAngle(ids[standalone[s]!]!);
      this.jitterX[s] = Math.cos(angle) * jitterAmplitude;
      this.jitterY[s] = Math.sin(angle) * jitterAmplitude;
    }
    this.makeNodes(standalone, rigid, clusterSeeds, geometry, config, null);
    this.relax(config);
    const fullBodyMorphs = new Float64Array(standaloneCount);
    for (let s = 0; s < standaloneCount; s++) {
      fullBodyMorphs[s] = displacedMorph(vectorLength(nodes.positionX[s]! - nodes.anchorX[s]!, nodes.positionY[s]! - nodes.anchorY[s]!));
    }

    this.makeNodes(standalone, rigid, clusterSeeds, geometry, config, fullBodyMorphs);
    this.relax(config);

    // Physical shape rule: a pin becomes a circle only if its full-size body
    // at the anchor actually touches the neighbors' already shrunken bodies.
    let maxStandaloneSizeScale = 0;
    for (let s = 0; s < standaloneCount; s++) maxStandaloneSizeScale = Math.max(maxStandaloneSizeScale, sizeScale[standalone[s]!]!);
    const morphTargets = new Float64Array(standaloneCount);
    const grid = this.grid;
    const candidates = this.candidates;
    if (standaloneCount > 0) {
      let maxProbeRadius = 1;
      const nodeCount = nodes.count;
      const positions = (this.positions = growF64(this.positions, nodeCount * 2));
      for (let i = 0; i < nodeCount; i++) {
        maxProbeRadius = Math.max(maxProbeRadius, nodes.radius[i]!);
        positions[i * 2] = nodes.positionX[i]!;
        positions[i * 2 + 1] = nodes.positionY[i]!;
      }
      grid.build(positions, nodeCount, geometry.bodyRadiusPx * Math.max(maxStandaloneSizeScale, 1) + maxProbeRadius);
      for (let s = 0; s < standaloneCount; s++) {
        if (!(fullBodyMorphs[s]! > 0)) {
          morphTargets[s] = 0;
          continue;
        }
        const index = standalone[s]!;
        const scale = sizeScale[index]!;
        const centerX = px[index]! + offsetX * scale;
        const centerY = py[index]! + offsetY * scale;
        const fullBodyRadius = geometry.bodyRadiusPx * scale;
        let maxOverlapDepth = 0;
        grid.collectCandidates(centerX, centerY, candidates);
        for (let c = 0; c < candidates.length; c++) {
          const other = candidates.data[c]!;
          if (other === s) continue;
          const otherBodyRadius = nodes.radius[other]! - padding;
          const distance = vectorLength(centerX - nodes.positionX[other]!, centerY - nodes.positionY[other]!);
          maxOverlapDepth = Math.max(maxOverlapDepth, fullBodyRadius + otherBodyRadius - distance);
        }
        morphTargets[s] = Math.min(fullBodyMorphs[s]!, staticTouchMorph(maxOverlapDepth));
      }
    }

    this.makeNodes(standalone, rigid, clusterSeeds, geometry, config, morphTargets);
    this.relax(config);

    // Circle compression is forced and variable, but not below compressedScale.
    const targetScales = new Float64Array(standaloneCount);
    if (standaloneCount > 0) {
      let maxNodeRadius = 1;
      const nodeCount = nodes.count;
      const positions = (this.positions = growF64(this.positions, nodeCount * 2));
      for (let i = 0; i < nodeCount; i++) {
        maxNodeRadius = Math.max(maxNodeRadius, nodes.radius[i]!);
        positions[i * 2] = nodes.positionX[i]!;
        positions[i * 2 + 1] = nodes.positionY[i]!;
      }
      grid.build(positions, nodeCount, Math.max(geometry.bodyRadiusPx * Math.max(maxStandaloneSizeScale, 1), maxNodeRadius) * 2 + 2 * padding);
      for (let s = 0; s < standaloneCount; s++) {
        const index = standalone[s]!;
        const morphTarget = morphTargets[s]!;
        const capScale = scaleCap(morphTarget);
        let scale = capScale;
        if (rigid[s] === 0 && morphTarget > 0) {
          const bodyRadius = pinCollisionBodyRadius(geometry, morphTarget) * sizeScale[index]!;
          let required = 1;
          // The minimum does not depend on the order of the neighbors.
          grid.collectCellNeighbors(s, candidates);
          for (let c = 0; c < candidates.length; c++) {
            const other = candidates.data[c]!;
            if (other === s) continue;
            const distance = vectorLength(nodes.positionX[s]! - nodes.positionX[other]!, nodes.positionY[s]! - nodes.positionY[other]!);
            const otherIsPin = other < standaloneCount;
            const otherBodyRadius = otherIsPin ? pinCollisionBodyRadius(geometry, morphTargets[other]!) * sizeScale[standalone[other]!]! : nodes.radius[other]! - padding;
            const otherIsRigid = otherIsPin ? rigid[other] === 1 : true;
            if (!(distance < bodyRadius + otherBodyRadius + 2 * padding)) continue;
            required = Math.min(required, requiredScale(distance, bodyRadius, otherBodyRadius, padding, otherIsRigid));
          }
          const lowerLimit = Math.min(compressedScale, capScale);
          scale = Math.max(Math.min(required, capScale), lowerLimit);
        } else if (selected[index] === 1) {
          scale = 1;
        }
        targetScales[s] = scale;
      }
    }

    this.beginItems(n);
    const flowerGroups: PinFlowerGroup[] = [];
    const clusterCenters = new Map<number, readonly [number, number]>();
    const seenClusterKeys = new Set<number>();
    const seen = this.seen;
    const wasGrouped = this.wasGrouped;

    // Selected members of each flower, in id order.
    const selectedBySeed: number[][] = clusterSeeds.map(() => []);
    for (let i = 0; i < n; i++) if (selected[i] === 1 && seedOf[i]! >= 0) selectedBySeed[seedOf[i]!]!.push(i);

    // Live flowers: the ring at the pile center, the petal layout.
    for (let seedIndex = 0; seedIndex < clusterSeeds.length; seedIndex++) {
      const seed = clusterSeeds[seedIndex]!;
      seenClusterKeys.add(seed.stateKey);
      let state = this.clusterStates.get(seed.stateKey);
      if (state === undefined) {
        state = { presence: 1, memberIDs: seed.memberIDs };
        this.clusterStates.set(seed.stateKey, state);
      }
      const presence = advanceBlend(state.presence, 1, blendStep);
      state.presence = blendValue;
      state.memberIDs = seed.memberIDs;
      unsettled = unsettled || presence;

      clusterCenters.set(seed.stateKey, [seed.centerX, seed.centerY]);
      const petalCount = Math.min(seed.memberIndexes.length, maxFlowerPetals);
      const ringRadius = flowerRingRadius(petalBodyRadius, petalCount);
      // Selected members are guaranteed among the visible petals and go first,
      // the fill-up takes the lowest ids.
      const visible: number[] = [];
      for (const index of selectedBySeed[seedIndex]!) {
        visible.push(index);
        if (visible.length === petalCount) break;
      }
      if (visible.length < petalCount) {
        for (const index of seed.memberIndexes) {
          if (selected[index] === 1) continue;
          visible.push(index);
          if (visible.length === petalCount) break;
        }
      }
      flowerGroups.push({ memberIDs: seed.memberIDs, visibleMemberIDs: visible.map((index) => ids[index]!), centerX: seed.centerX, centerY: seed.centerY });

      for (let slot = 0; slot < visible.length; slot++) {
        const index = visible[slot]!;
        const angle = flowerPetalAngle(slot, petalCount);
        const slotX = seed.centerX + Math.cos(angle) * ringRadius;
        const slotY = seed.centerY + Math.sin(angle) * ringRadius;
        unsettled = this.emitPetal(index, slotX, slotY, seed.stateKey, wasGrouped[index] === 1, offsetX, offsetY, compressedScale, smoothingK, blendStep) || unsettled;
      }
    }

    // Hidden flower members: only live inter-frame states are advanced, in
    // id order. Petals are skipped as already seen.
    if (this.pinStates.size > 0 && clusterSeeds.length > 0) {
      for (let i = 0; i < n; i++) {
        const seedIndex = seedOf[i]!;
        if (seedIndex < 0 || seen[i] === 1) continue;
        const state = this.pinStates.get(ids[i]!);
        if (state === undefined) continue;
        const seed = clusterSeeds[seedIndex]!;
        unsettled = this.emitHiddenMember(i, state, seed.centerX, seed.centerY, seed.stateKey, compressedScale, smoothingK, blendStep) || unsettled;
      }
    }

    // Dissolved flowers: the center is still needed by members flying out
    // while the presence fades.
    const dissolvedKeyByMember = new Map<number, number>();
    if (this.clusterStates.size > seenClusterKeys.size) {
      const keys = [...this.clusterStates.keys()].sort((a, b) => a - b);
      for (const key of keys) {
        if (seenClusterKeys.has(key)) continue;
        const state = this.clusterStates.get(key)!;
        let sumX = 0;
        let sumY = 0;
        let memberCount = 0;
        for (const memberID of state.memberIDs) {
          const index = this.inputIndex(memberID);
          if (index < 0) continue;
          sumX += px[index]!;
          sumY += py[index]!;
          memberCount++;
        }
        if (memberCount === 0) {
          this.clusterStates.delete(key);
          continue;
        }
        const presence = advanceBlend(state.presence, 0, blendStep);
        state.presence = blendValue;
        if (!(state.presence > 0)) {
          this.clusterStates.delete(key);
          continue;
        }
        unsettled = unsettled || presence;
        clusterCenters.set(key, [sumX / memberCount, sumY / memberCount]);
        for (const memberID of state.memberIDs) if (!dissolvedKeyByMember.has(memberID)) dissolvedKeyByMember.set(memberID, key);
      }
    }

    // Standalone pins: smoothing of offset, scale and morph, fly-out from the flower.
    for (let s = 0; s < standaloneCount; s++) {
      const index = standalone[s]!;
      const id = ids[index]!;
      seen[index] = 1;
      const targetOffsetX = nodes.positionX[s]! - nodes.anchorX[s]!;
      const targetOffsetY = nodes.positionY[s]! - nodes.anchorY[s]!;
      const targetMorph = morphTargets[s]!;
      const targetScale = targetScales[s]!;
      let state = this.pinStates.get(id);
      if (state === undefined) {
        const dissolvedKey = wasGrouped[index] === 1 ? dissolvedKeyByMember.get(id) : undefined;
        // A stationarily hidden member of a dissolved pile reappears by flying out of its center.
        state =
          dissolvedKey !== undefined
            ? { offsetX: targetOffsetX, offsetY: targetOffsetY, scale: targetScale, morph: targetMorph, clusterBlend: 1, lastClusterKey: dissolvedKey }
            : { offsetX: targetOffsetX, offsetY: targetOffsetY, scale: targetScale, morph: targetMorph, clusterBlend: 0, lastClusterKey: -1 };
        this.pinStates.set(id, state);
      }
      const offsetActive = smoothOffsetToward(state, targetOffsetX, targetOffsetY, smoothingK, offsetSnapEpsilonPx);
      const scaleActive = smoothToward(state.scale, targetScale, smoothingK, scaleSnapEpsilon);
      state.scale = smoothValue;
      const morphActive = smoothToward(state.morph, targetMorph, smoothingK, scaleSnapEpsilon);
      state.morph = smoothValue;
      const blendActive = advanceBlend(state.clusterBlend, 0, blendStep);
      state.clusterBlend = blendValue;
      unsettled = unsettled || offsetActive || scaleActive || morphActive || blendActive;

      // Anchor correction: the center of the actual (compressed) body stays at
      // the point solved by pass B for a body of scale scaleCap(morph target).
      const lift = sizeScale[index]! * (scaleCap(morphTargets[s]!) - state.scale);
      let x = px[index]! + state.offsetX + offsetX * lift;
      let y = py[index]! + state.offsetY + offsetY * lift;
      let alphaFactor = 1;
      if (state.clusterBlend > 0) {
        const center = state.lastClusterKey >= 0 ? clusterCenters.get(state.lastClusterKey) : undefined;
        if (center !== undefined) {
          const ease = smoothstep(0, 1, state.clusterBlend);
          x += (center[0] - x) * ease;
          y += (center[1] - y) * ease;
          alphaFactor = 1 - state.clusterBlend;
        } else {
          state.clusterBlend = 0;
        }
      }
      if (state.clusterBlend <= 0) state.lastClusterKey = -1;
      this.emit(index, x, y, this.alpha[index]! * alphaFactor, state.scale, state.morph, false);
    }

    for (const id of this.pinStates.keys()) {
      const index = this.inputIndex(id);
      if (index < 0 || seen[index] === 0) this.pinStates.delete(id);
    }

    // Hard per-frame guarantee: the final pass resolves overlaps of the displayed bodies.
    this.resolveDisplayedOverlaps(geometry, compressedScale);

    return {
      pinItems: this.makeItems(projectedPins),
      flowerGroups,
      hasActiveAnimations: unsettled,
    };
  }

  // MARK: Items

  private beginItems(n: number): void {
    this.itemCount = 0;
    this.itemIndex = growI32(this.itemIndex, n);
    this.itemX = growF64(this.itemX, n);
    this.itemY = growF64(this.itemY, n);
    this.itemAlpha = growF64(this.itemAlpha, n);
    this.itemScale = growF64(this.itemScale, n);
    this.itemMorph = growF64(this.itemMorph, n);
    this.itemPetal = growU8(this.itemPetal, n);
  }

  private emit(index: number, x: number, y: number, alpha: number, scale: number, morph: number, petal: boolean): void {
    const k = this.itemCount++;
    this.itemIndex[k] = index;
    this.itemX[k] = x;
    this.itemY[k] = y;
    this.itemAlpha[k] = alpha;
    this.itemScale[k] = scale;
    this.itemMorph[k] = morph;
    this.itemPetal[k] = petal ? 1 : 0;
  }

  /** The items in draw order, then id order. */
  private makeItems(projectedPins: readonly ProjectedPin[]): PinCollisionItem[] {
    const count = this.itemCount;
    const order = new Int32Array(count);
    for (let k = 0; k < count; k++) order[k] = k;
    const source = this.sourceIndex;
    const itemIndex = this.itemIndex;
    const ids = this.ids;
    const drawOrder = new Float64Array(count);
    for (let k = 0; k < count; k++) drawOrder[k] = projectedPins[source[itemIndex[k]!]!]!.drawOrder;
    order.sort((a, b) => drawOrder[a]! - drawOrder[b]! || ids[itemIndex[a]!]! - ids[itemIndex[b]!]!);
    const items: PinCollisionItem[] = new Array(count);
    for (let r = 0; r < count; r++) {
      const k = order[r]!;
      const projected = projectedPins[source[itemIndex[k]!]!]!;
      const anchor = projected.screenPoint;
      const screenPoint: ScreenPointOutput = { positionX: this.itemX[k]!, positionY: this.itemY[k]!, depth: anchor.depth, visible: anchor.visible, visibilityAlpha: this.itemAlpha[k]! };
      items[r] = {
        pin: projected.pin,
        squashScaleX: projected.squashScaleX,
        squashScaleY: projected.squashScaleY,
        screenPoint,
        anchorScreenPoint: anchor,
        displayScale: this.itemScale[k]!,
        morph: this.itemMorph[k]!,
        isFlowerPetal: this.itemPetal[k] === 1,
        drawOrder: projected.drawOrder,
      };
    }
    return items;
  }

  /**
   * Micro-correction of displayed positions: removes brief overlaps of the
   * actual bodies during animations. Works on top of the smoothed state and
   * does not write into it.
   */
  private resolveDisplayedOverlaps(geometry: PinCollisionGeometry, compressedScale: number): void {
    const count = this.itemCount;
    if (count <= 1) return;
    const itemIndex = this.itemIndex;
    const scale = this.itemScale;
    const morph = this.itemMorph;
    const petal = this.itemPetal;
    const sizeScale = this.sizeScale;
    const selected = this.selected;
    const ids = this.ids;
    const offsetX = geometry.bodyCenterOffsetX;
    const offsetY = geometry.bodyCenterOffsetY;

    const cx = new Float64Array(count);
    const cy = new Float64Array(count);
    const radii = new Float64Array(count);
    const inverseMasses = new Float64Array(count);
    for (let k = 0; k < count; k++) {
      const index = itemIndex[k]!;
      const bodyScale = scale[k]! * sizeScale[index]!;
      cx[k] = this.itemX[k]! + offsetX * bodyScale;
      cy[k] = this.itemY[k]! + offsetY * bodyScale;
      // Fading members of the crossfade fly through the others: a zero radius excludes them.
      const fadingThrough = this.itemAlpha[k]! < this.alpha[index]! * 0.99;
      radii[k] = fadingThrough ? 0 : pinCollisionBodyRadius(geometry, morph[k]!) * bodyScale;
      // Pins (morph 0) and flower petals stay put, only free circles yield.
      inverseMasses[k] = selected[index] === 1 || petal[k] === 1 ? 0 : morph[k]!;
    }

    const solid: number[] = [];
    const fading: number[] = [];
    let maxSolidRadius = 1;
    for (let k = 0; k < count; k++) {
      if (radii[k]! > 0) {
        solid.push(k);
        maxSolidRadius = Math.max(maxSolidRadius, radii[k]!);
      } else {
        fading.push(k);
      }
    }
    const positions = (this.positions = growF64(this.positions, solid.length * 2));
    for (let l = 0; l < solid.length; l++) {
      positions[l * 2] = cx[solid[l]!]!;
      positions[l * 2 + 1] = cy[solid[l]!]!;
    }
    const grid = this.grid.build(positions, solid.length, 2 * maxSolidRadius);
    const candidates = this.candidates;
    const pairs: number[] = [];
    for (const f of fading) {
      grid.collectCandidates(cx[f]!, cy[f]!, candidates);
      for (let c = 0; c < candidates.length; c++) {
        const s = solid[candidates.data[c]!]!;
        const reach = radii[f]! + radii[s]! + maxSolidRadius;
        const dx = cx[f]! - cx[s]!;
        const dy = cy[f]! - cy[s]!;
        if (dx * dx + dy * dy < reach * reach) pairs.push(Math.min(f, s), Math.max(f, s));
      }
    }
    const solidRadii = new Float64Array(solid.length);
    for (let l = 0; l < solid.length; l++) solidRadii[l] = radii[solid[l]!]!;
    const lists = this.pairLists;
    grid.ascendingPairs(positions, solidRadii, maxSolidRadius, lists);
    for (let l = 0; l < solid.length; l++) {
      const k = solid[l]!;
      const end = lists.starts[l + 1]!;
      for (let p = lists.starts[l]!; p < end; p++) pairs.push(k, solid[lists.neighbors[p]!]!);
    }

    const resolvePair = (lhs: number, rhs: number): void => {
      let lhsInverseMass = inverseMasses[lhs]!;
      let rhsInverseMass = inverseMasses[rhs]!;
      const bothPetals = petal[lhs] === 1 && petal[rhs] === 1;
      if (bothPetals) {
        // Petals of different flowers yield to each other, or an overlap in a
        // dense mosaic of rings would freeze.
        lhsInverseMass = selected[itemIndex[lhs]!] === 1 ? 0 : 1;
        rhsInverseMass = selected[itemIndex[rhs]!] === 1 ? 0 : 1;
      }
      const inverseMassSum = lhsInverseMass + rhsInverseMass;
      if (!(inverseMassSum > 0)) return;
      const minDistance = radii[lhs]! + radii[rhs]!;
      const dx = cx[rhs]! - cx[lhs]!;
      const dy = cy[rhs]! - cy[lhs]!;
      const distanceSquared = dx * dx + dy * dy;
      if (!(distanceSquared < minDistance * minDistance)) return;
      const distance = Math.sqrt(distanceSquared);
      const overlap = minDistance - distance;
      // Slots of one ring touch exactly: float noise must not push a flower's own petals apart.
      if (bothPetals && overlap <= 1) return;
      let dirX: number;
      let dirY: number;
      if (distance > 1e-4) {
        dirX = dx / distance;
        dirY = dy / distance;
      } else {
        const angle = stableUnitAngle(ids[itemIndex[lhs]!]!, ids[itemIndex[rhs]!]!);
        dirX = Math.cos(angle);
        dirY = Math.sin(angle);
      }
      const lhsShare = overlap * (lhsInverseMass / inverseMassSum);
      const rhsShare = overlap * (rhsInverseMass / inverseMassSum);
      cx[lhs] = cx[lhs]! - dirX * lhsShare;
      cy[lhs] = cy[lhs]! - dirY * lhsShare;
      cx[rhs] = cx[rhs]! + dirX * rhsShare;
      cy[rhs] = cy[rhs]! + dirY * rhsShare;
    };

    // A dense mosaic of rings converges slowly.
    for (let iteration = 0; iteration < 20; iteration++) {
      for (let p = 0; p < pairs.length; p += 2) resolvePair(pairs[p]!, pairs[p + 1]!);
    }

    // A circle squeezed between bodies immovable to it is compressed further
    // per the actual distances (within the limit), then the positions are re-settled.
    let scaleAdjusted = false;
    for (let p = 0; p < pairs.length; p += 2) {
      const a = pairs[p]!;
      const b = pairs[p + 1]!;
      const residualMinDistance = radii[a]! + radii[b]!;
      const dx = cx[b]! - cx[a]!;
      const dy = cy[b]! - cy[a]!;
      const distanceSquared = dx * dx + dy * dy;
      if (!(residualMinDistance > 0.5) || !(distanceSquared < (residualMinDistance - 0.5) * (residualMinDistance - 0.5))) continue;
      const distance = Math.sqrt(distanceSquared);
      for (let side = 0; side < 2; side++) {
        const candidate = side === 0 ? a : b;
        const other = side === 0 ? b : a;
        const index = itemIndex[candidate]!;
        if (petal[candidate] === 1 || selected[index] === 1 || !(morph[candidate]! > 0.5) || !(radii[candidate]! > 0)) continue;
        const unitBodyRadius = pinCollisionBodyRadius(geometry, morph[candidate]!) * sizeScale[index]!;
        if (!(unitBodyRadius > 0)) continue;
        const required = (distance - radii[other]!) / unitBodyRadius;
        const displayScale = scale[candidate]!;
        const lowerLimit = Math.min(compressedScale, displayScale);
        const newScale = Math.max(Math.min(required, displayScale), lowerLimit);
        if (!(newScale < displayScale - 0.005)) continue;
        scale[candidate] = newScale;
        radii[candidate] = unitBodyRadius * newScale;
        scaleAdjusted = true;
      }
    }
    if (scaleAdjusted) {
      for (let iteration = 0; iteration < 8; iteration++) {
        for (let p = 0; p < pairs.length; p += 2) resolvePair(pairs[p]!, pairs[p + 1]!);
      }
    }

    for (let k = 0; k < count; k++) {
      const bodyScale = scale[k]! * sizeScale[itemIndex[k]!]!;
      const x = cx[k]! - offsetX * bodyScale;
      const y = cy[k]! - offsetY * bodyScale;
      if (!(vectorLength(x - this.itemX[k]!, y - this.itemY[k]!) > 0.01)) continue;
      this.itemX[k] = x;
      this.itemY[k] = y;
    }
  }

  // MARK: Flower petals

  /**
   * A petal is an ordinary pin whose offset target is a slot on the flower
   * ring: the flight into the slot and back uses the same smoothing as the
   * push-apart.
   */
  private emitPetal(index: number, slotX: number, slotY: number, stateKey: number, wasGroupedLastFrame: boolean, offsetX: number, offsetY: number, compressedScale: number, smoothingK: number, blendStep: number): boolean {
    const id = this.ids[index]!;
    this.seen[index] = 1;
    const lift = this.sizeScale[index]! * compressedScale;
    // The target offset puts the petal's body center exactly into the slot.
    const targetX = slotX - this.px[index]! - offsetX * lift;
    const targetY = slotY - this.py[index]! - offsetY * lift;
    let state = this.pinStates.get(id);
    if (state === undefined) {
      // A stationarily hidden member has no state: promotion to a petal fades in.
      state = { offsetX: targetX, offsetY: targetY, scale: compressedScale, morph: 1, clusterBlend: wasGroupedLastFrame ? 1 : 0, lastClusterKey: stateKey };
      this.pinStates.set(id, state);
    }
    state.lastClusterKey = stateKey;
    const offsetActive = smoothOffsetToward(state, targetX, targetY, smoothingK, offsetSnapEpsilonPx);
    const scaleActive = smoothToward(state.scale, compressedScale, smoothingK, scaleSnapEpsilon);
    state.scale = smoothValue;
    const morphActive = smoothToward(state.morph, 1, smoothingK, scaleSnapEpsilon);
    state.morph = smoothValue;
    const blendActive = advanceBlend(state.clusterBlend, 0, blendStep);
    state.clusterBlend = blendValue;
    this.emit(index, this.px[index]! + state.offsetX, this.py[index]! + state.offsetY, this.alpha[index]! * (1 - state.clusterBlend), state.scale, state.morph, true);
    return offsetActive || scaleActive || morphActive || blendActive;
  }

  /** A member that did not fit into the flower: fades out while converging on the flower center. */
  private emitHiddenMember(index: number, state: PinMotionState, centerX: number, centerY: number, stateKey: number, compressedScale: number, smoothingK: number, blendStep: number): boolean {
    this.seen[index] = 1;
    state.lastClusterKey = stateKey;
    const blendActive = advanceBlend(state.clusterBlend, 1, blendStep);
    state.clusterBlend = blendValue;
    const offsetActive = smoothOffsetToward(state, 0, 0, smoothingK, offsetSnapEpsilonPx);
    const scaleActive = smoothToward(state.scale, compressedScale, smoothingK, scaleSnapEpsilon);
    state.scale = smoothValue;
    const morphActive = smoothToward(state.morph, 1, smoothingK, scaleSnapEpsilon);
    state.morph = smoothValue;
    const active = blendActive || offsetActive || scaleActive || morphActive;

    // A fully faded member has settled: the state is reset. A reappearance is
    // told by last frame's group membership.
    if (state.clusterBlend >= 0.999 && !active) {
      this.pinStates.delete(this.ids[index]!);
      return active;
    }
    if (!(state.clusterBlend < 0.999)) return active;
    const ease = smoothstep(0, 1, state.clusterBlend);
    const baseX = this.px[index]! + state.offsetX;
    const baseY = this.py[index]! + state.offsetY;
    this.emit(index, baseX + (centerX - baseX) * ease, baseY + (centerY - baseY) * ease, this.alpha[index]! * (1 - state.clusterBlend), state.scale, state.morph, false);
    return active;
  }

  // MARK: Grouping

  private makeSeed(memberIndexes: number[]): ClusterSeed {
    const px = this.px;
    const py = this.py;
    const memberIDs: number[] = new Array(memberIndexes.length);
    let sumX = 0;
    let sumY = 0;
    const first = memberIndexes[0]!;
    let minX = px[first]!;
    let minY = py[first]!;
    let maxX = minX;
    let maxY = minY;
    for (let k = 0; k < memberIndexes.length; k++) {
      const index = memberIndexes[k]!;
      const x = px[index]!;
      const y = py[index]!;
      memberIDs[k] = this.ids[index]!;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const centroidX = sumX / memberIndexes.length;
    const centroidY = sumY / memberIndexes.length;
    return { stateKey: memberIDs[0]!, memberIndexes, memberIDs, boundsMinX: minX, boundsMinY: minY, boundsMaxX: maxX, boundsMaxY: maxY, centerX: centroidX, centerY: centroidY };
  }

  private eventClusterSeeds(pinSizePx: number, padding: number): ClusterSeed[] {
    const threshold = Math.max(1, pinSizePx + padding * 2);
    const candidates: number[] = [];
    for (let i = 0; i < this.count; i++) if (this.event[i] === 1) candidates.push(i);
    this.joinMode = JOIN_EVENT;
    this.joinRadius = threshold;
    return this.connectedGroups(candidates, this.px, this.py, threshold).map((group) => this.makeSeed(group));
  }

  private overflowClusterSeeds(excluded: Uint8Array, anyExcluded: boolean, pinSizePx: number, compactnessLimit: number, groupingThreshold: number): ClusterSeed[] {
    const enterRadius = pinSizePx * groupingRadiusScale;
    const exitRadius = enterRadius * groupingHysteresisRatio;
    const candidates: number[] = [];
    for (let i = 0; i < this.count; i++) if (!anyExcluded || excluded[i] === 0) candidates.push(i);
    this.joinMode = JOIN_OVERFLOW;
    this.joinRadius = enterRadius;
    this.joinExitRadius = exitRadius;
    const components = this.connectedGroups(candidates, this.px, this.py, exitRadius);
    // Chain percolation: an overgrown component is cut by the world grid into local piles.
    return this.splitSprawlingComponents(components, compactnessLimit, groupingThreshold)
      .filter((group) => group.length > 1 && group.length >= groupingThreshold)
      .map((group) => this.makeSeed(group));
  }

  /**
   * Splits components whose screen anchor spread exceeds the limit by a world
   * grid: cell boundaries are anchored to the world (stable under pan and
   * rotation), the step is a power of two. Cells are keyed relative to the
   * component's lowest cell, which keeps the keys small and exact.
   */
  private splitSprawlingComponents(components: number[][], compactnessLimit: number, groupingThreshold: number): number[][] {
    const px = this.px;
    const py = this.py;
    const wx = this.wx;
    const wy = this.wy;
    const result: number[][] = [];
    for (const component of components) {
      if (component.length <= 1) {
        result.push(component);
        continue;
      }
      const first = component[0]!;
      let minX = px[first]!;
      let minY = py[first]!;
      let maxX = minX;
      let maxY = minY;
      for (let k = 1; k < component.length; k++) {
        const index = component[k]!;
        minX = Math.min(minX, px[index]!);
        minY = Math.min(minY, py[index]!);
        maxX = Math.max(maxX, px[index]!);
        maxY = Math.max(maxY, py[index]!);
      }
      const screenDiagonal = vectorLength(maxX - minX, maxY - minY);
      if (!(screenDiagonal > compactnessLimit)) {
        result.push(component);
        continue;
      }
      let worldMinX = wx[first]!;
      let worldMinY = wy[first]!;
      let worldMaxX = worldMinX;
      let worldMaxY = worldMinY;
      for (let k = 1; k < component.length; k++) {
        const index = component[k]!;
        worldMinX = Math.min(worldMinX, wx[index]!);
        worldMinY = Math.min(worldMinY, wy[index]!);
        worldMaxX = Math.max(worldMaxX, wx[index]!);
        worldMaxY = Math.max(worldMaxY, wy[index]!);
      }
      const worldDiagonal = vectorLength(worldMaxX - worldMinX, worldMaxY - worldMinY);
      if (!(worldDiagonal > 0)) {
        result.push(component);
        continue;
      }
      const pixelsPerWorldUnit = screenDiagonal / worldDiagonal;
      const rawStep = compactnessLimit / pixelsPerWorldUnit;
      const step = Math.pow(2, Number.isFinite(rawStep) ? Math.floor(Math.log2(rawStep)) : 0);
      const baseX = Math.floor(worldMinX / step);
      const baseY = Math.floor(worldMinY / step);
      // Buckets in the order of their first member, which is their smallest.
      const buckets = new Map<number, number[]>();
      for (const index of component) {
        const key = (Math.floor(wx[index]! / step) - baseX) * 2097152 + (Math.floor(wy[index]! / step) - baseY);
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = [];
          buckets.set(key, bucket);
        }
        bucket.push(index);
      }
      let subgroups = [...buckets.values()];

      // Undersized subgroups merge into the nearest full subgroup of the same pile.
      const seedThreshold = Math.max(groupingThreshold, 2);
      const full: { subgroup: number; x: number; y: number }[] = [];
      for (let g = 0; g < subgroups.length; g++) {
        const subgroup = subgroups[g]!;
        if (!(subgroup.length >= seedThreshold)) continue;
        let sumX = 0;
        let sumY = 0;
        for (const index of subgroup) {
          sumX += px[index]!;
          sumY += py[index]!;
        }
        full.push({ subgroup: g, x: sumX / subgroup.length, y: sumY / subgroup.length });
      }
      if (full.length > 0) {
        for (let g = 0; g < subgroups.length; g++) {
          const subgroup = subgroups[g]!;
          if (subgroup.length >= seedThreshold) continue;
          let sumX = 0;
          let sumY = 0;
          for (const index of subgroup) {
            sumX += px[index]!;
            sumY += py[index]!;
          }
          const centroidX = sumX / subgroup.length;
          const centroidY = sumY / subgroup.length;
          let nearest = full[0]!.subgroup;
          let nearestDistance = Number.MAX_VALUE;
          for (const candidate of full) {
            const dx = candidate.x - centroidX;
            const dy = candidate.y - centroidY;
            const distance = dx * dx + dy * dy;
            if (distance < nearestDistance) {
              nearestDistance = distance;
              nearest = candidate.subgroup;
            }
          }
          subgroups[nearest]!.push(...subgroup);
          subgroups[g] = [];
        }
        subgroups = subgroups.filter((subgroup) => subgroup.length > 0);
        for (const subgroup of subgroups) subgroup.sort((a, b) => a - b);
      }
      for (const subgroup of subgroups) result.push(subgroup);
    }
    return result;
  }

  /** Whether two candidates join, by the current join mode. */
  private joinable(lhs: number, rhs: number): boolean {
    switch (this.joinMode) {
      case JOIN_EVENT: {
        const dx = this.px[lhs]! - this.px[rhs]!;
        const dy = this.py[lhs]! - this.py[rhs]!;
        return dx * dx + dy * dy <= this.joinRadius * this.joinRadius;
      }
      case JOIN_OVERFLOW: {
        // The widened (hysteresis) radius holds an already formed group
        // together but does not pull in neighbors passing by.
        const widened = this.wasGrouped[lhs] === 1 && this.wasGrouped[rhs] === 1;
        const radius = widened ? this.joinExitRadius : this.joinRadius;
        const dx = this.px[lhs]! - this.px[rhs]!;
        const dy = this.py[lhs]! - this.py[rhs]!;
        return dx * dx + dy * dy <= radius * radius;
      }
      default: {
        const minDistance = this.bodyReach[lhs]! + this.bodyReach[rhs]!;
        const dx = this.bodyX[lhs]! - this.bodyX[rhs]!;
        const dy = this.bodyY[lhs]! - this.bodyY[rhs]!;
        return dx * dx + dy * dy < minDistance * minDistance;
      }
    }
  }

  /**
   * Connected components by the join predicate via a spatial grid with
   * cellSize the maximum join distance. Dense cells (crowds) are united
   * wholesale without pairwise scanning. Returns the components of two or
   * more members (a single member is never used), in the order of their
   * smallest member, each ascending. `x` and `y` are indexed by candidate.
   */
  private connectedGroups(candidates: readonly number[], x: Float64Array, y: Float64Array, maxJoinDistance: number): number[][] {
    const count = candidates.length;
    if (count <= 1) return [];
    const positions = (this.positions = growF64(this.positions, count * 2));
    for (let k = 0; k < count; k++) {
      positions[k * 2] = x[candidates[k]!]!;
      positions[k * 2 + 1] = y[candidates[k]!]!;
    }
    const grid = this.grid.build(positions, count, maxJoinDistance);
    const set = this.disjointSet;
    set.reset(count);
    const starts = grid.starts;
    const entries = grid.entries;
    const neighborSlots = grid.neighborSlots;
    const cellCount = grid.cellCount;

    // Dense cells are handled at cell level: a crowd is united wholesale, neighboring crowds merge.
    for (let slot = 0; slot < cellCount; slot++) {
      if (starts[slot + 1]! - starts[slot]! < denseGroupingCellPopulation) continue;
      const begin = starts[slot]!;
      const end = starts[slot + 1]!;
      const first = entries[begin]!;
      for (let e = begin + 1; e < end; e++) set.union(first, entries[e]!);
      for (let offset = 0; offset < 9; offset++) {
        const neighbor = neighborSlots[slot * 9 + offset]!;
        if (neighbor <= slot || starts[neighbor + 1]! - starts[neighbor]! < denseGroupingCellPopulation) continue;
        set.union(first, entries[starts[neighbor]!]!);
      }
    }

    // The pointwise pass covers only points of sparse cells. The union order
    // does not change the components, so pairs are joined as they are found.
    const slotForPoint = grid.slotForPoint;
    for (let lhs = 0; lhs < count; lhs++) {
      const own = slotForPoint[lhs]!;
      if (starts[own + 1]! - starts[own]! >= denseGroupingCellPopulation) continue;
      const lhsInput = candidates[lhs]!;
      for (let offset = 0; offset < 9; offset++) {
        const slot = neighborSlots[own * 9 + offset]!;
        if (slot < 0) continue;
        const begin = starts[slot]!;
        const end = starts[slot + 1]!;
        if (end - begin >= denseGroupingCellPopulation) {
          // A sparse pin against a crowd: an exact check over a bounded sample.
          let probesLeft = denseGroupingProbeLimit;
          for (let e = begin; e < end; e++) {
            const rhs = entries[e]!;
            if (this.joinable(lhsInput, candidates[rhs]!)) {
              set.union(lhs, rhs);
              break;
            }
            probesLeft--;
            if (probesLeft <= 0) break;
          }
          continue;
        }
        for (let e = begin; e < end; e++) {
          const rhs = entries[e]!;
          if (rhs > lhs && this.joinable(lhsInput, candidates[rhs]!)) set.union(lhs, rhs);
        }
      }
    }

    // Components without hashing: the root is the minimum index.
    const sizes = (this.groupSizes = growI32(this.groupSizes, count));
    const slots = (this.groupSlots = growI32(this.groupSlots, count));
    sizes.fill(0, 0, count);
    for (let k = 0; k < count; k++) {
      const root = set.find(k);
      slots[k] = root;
      sizes[root]!++;
    }
    const groups: number[][] = [];
    const groupOfRoot = new Int32Array(count).fill(-1);
    for (let k = 0; k < count; k++) {
      const root = slots[k]!;
      if (sizes[root]! < 2) continue;
      let group = groupOfRoot[root]!;
      if (group < 0) {
        group = groups.length;
        groupOfRoot[root] = group;
        groups.push([]);
      }
      groups[group]!.push(candidates[k]!);
    }
    return groups;
  }

  /**
   * Flowers are immovable and cannot yield to each other: piles with
   * intersecting rings merge into one flower, in rounds to a fixed point. A
   * merge whose anchor spread would exceed the compactness limit is forbidden.
   */
  private mergeIntersectingFlowers(seeds: ClusterSeed[], petalBodyRadius: number, compactnessLimit: number): ClusterSeed[] {
    if (seeds.length <= 1) return seeds;
    const limitSquared = compactnessLimit * compactnessLimit;
    let merged = [...seeds].sort((a, b) => a.stateKey - b.stateKey);
    const set = new PinDisjointSet();
    while (merged.length > 1) {
      set.reset(merged.length);
      let didMerge = false;
      for (let l = 0; l < merged.length; l++) {
        const lhs = merged[l]!;
        const lhsRadius = flowerOuterRadius(lhs.memberIDs.length, petalBodyRadius);
        for (let r = l + 1; r < merged.length; r++) {
          const rhs = merged[r]!;
          const minDistance = lhsRadius + flowerOuterRadius(rhs.memberIDs.length, petalBodyRadius);
          const dx = lhs.centerX - rhs.centerX;
          const dy = lhs.centerY - rhs.centerY;
          if (!(dx * dx + dy * dy < minDistance * minDistance)) continue;
          const spanX = Math.max(lhs.boundsMaxX, rhs.boundsMaxX) - Math.min(lhs.boundsMinX, rhs.boundsMinX);
          const spanY = Math.max(lhs.boundsMaxY, rhs.boundsMaxY) - Math.min(lhs.boundsMinY, rhs.boundsMinY);
          if (!(spanX * spanX + spanY * spanY <= limitSquared)) continue;
          set.union(l, r);
          didMerge = true;
        }
      }
      if (!didMerge) break;
      const components = new Map<number, number[]>();
      for (let k = 0; k < merged.length; k++) {
        const root = set.find(k);
        let list = components.get(root);
        if (list === undefined) {
          list = [];
          components.set(root, list);
        }
        list.push(k);
      }
      // Roots are first met at themselves, in ascending order.
      const next: ClusterSeed[] = [];
      for (const indexes of components.values()) {
        if (indexes.length === 1) {
          next.push(merged[indexes[0]!]!);
          continue;
        }
        let members = merged[indexes[0]!]!.memberIndexes;
        for (let k = 1; k < indexes.length; k++) members = mergeSortedIndexes(members, merged[indexes[k]!]!.memberIndexes);
        next.push(this.makeSeed(members));
      }
      merged = next.sort((a, b) => a.stateKey - b.stateKey);
    }
    return merged;
  }

  /**
   * Pin absorption by a flower: a selected pin joins as a petal on body
   * touch, a regular pin is absorbed when its anchor body ends up inside the
   * ring or is wedged between petals of two or more flowers. Returns the
   * standalone indices left.
   */
  private absorbPinsIntoFlowers(seeds: ClusterSeed[], standalone: number[], geometry: PinCollisionGeometry, petalBodyRadius: number, padding: number): number[] {
    if (seeds.length === 0 || standalone.length === 0) return standalone;
    const absorbed = new Set<number>();
    for (const index of standalone) {
      const scale = this.sizeScale[index]!;
      const isSelected = this.selected[index] === 1;
      const centerX = this.px[index]! + geometry.bodyCenterOffsetX * scale;
      const centerY = this.py[index]! + geometry.bodyCenterOffsetY * scale;
      // The smallest possible body: if even it touches petals of two or more
      // flowers, the pin is wedged in a pocket of the mosaic.
      const minimalBodyRadius = petalBodyRadius * scale;
      let touchedSeedCount = 0;
      let nearestTouchedSeed = -1;
      let nearestTouchedDistance = Number.MAX_VALUE;
      for (let s = 0; s < seeds.length; s++) {
        const seed = seeds[s]!;
        const ringRadius = flowerOuterRadius(seed.memberIDs.length, petalBodyRadius) - petalBodyRadius;
        const threshold = isSelected ? ringRadius + petalBodyRadius + geometry.bodyRadiusPx * scale + padding : ringRadius;
        const dx = centerX - seed.centerX;
        const dy = centerY - seed.centerY;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared < threshold * threshold) {
          seeds[s] = this.makeSeed(mergeSortedIndexes(seed.memberIndexes, [index]));
          absorbed.add(index);
          break;
        }
        if (isSelected) continue;
        const petalCount = Math.min(seed.memberIDs.length, maxFlowerPetals);
        const slotRing = flowerRingRadius(petalBodyRadius, petalCount);
        const touchDistance = minimalBodyRadius + petalBodyRadius;
        // A pin farther from the center than the ring plus the touch distance
        // touches no petal: the petals are not looked at (a pixel of margin
        // covers the rounding).
        const reach = slotRing + touchDistance + 1;
        if (distanceSquared >= reach * reach) continue;
        for (let petal = 0; petal < petalCount; petal++) {
          const angle = flowerPetalAngle(petal, petalCount);
          const distance = vectorLength(centerX - (seed.centerX + Math.cos(angle) * slotRing), centerY - (seed.centerY + Math.sin(angle) * slotRing));
          if (distance < touchDistance) {
            touchedSeedCount++;
            if (distance < nearestTouchedDistance) {
              nearestTouchedDistance = distance;
              nearestTouchedSeed = s;
            }
            break;
          }
        }
      }
      if (!absorbed.has(index) && touchedSeedCount >= 2 && nearestTouchedSeed >= 0) {
        const seed = seeds[nearestTouchedSeed]!;
        seeds[nearestTouchedSeed] = this.makeSeed(mergeSortedIndexes(seed.memberIndexes, [index]));
        absorbed.add(index);
      }
    }
    return absorbed.size === 0 ? standalone : standalone.filter((index) => !absorbed.has(index));
  }

  // MARK: Relaxation

  /**
   * Solver nodes: standalone pins and the petal slots of live flowers. A pin
   * node is centered on its body center with the radius of its size, a
   * flower is represented by its actual petals. Relaxation starts from
   * undisplaced positions plus a deterministic jitter, so the target is a
   * pure function of the input. `morphs` null gives full-size pin bodies.
   */
  private makeNodes(standalone: readonly number[], rigid: Uint8Array, seeds: readonly ClusterSeed[], geometry: PinCollisionGeometry, config: PinCollisionSettings, morphs: Float64Array | null): void {
    const compressedScale = Math.min(config.compressedScale, 1);
    const petalBodyRadius = geometry.circleBodyRadiusPx * compressedScale;
    const padding = config.collisionPaddingPx;
    let petals = 0;
    for (const seed of seeds) petals += Math.min(seed.memberIDs.length, maxFlowerPetals);
    const nodes = this.nodes;
    nodes.reserve(standalone.length + petals);
    for (let s = 0; s < standalone.length; s++) {
      const index = standalone[s]!;
      const morph = morphs === null ? 0 : morphs[s]!;
      const shapeScale = morphs === null ? 1 : scaleCap(morph);
      const shapeRadius = morphs === null ? geometry.bodyRadiusPx : pinCollisionBodyRadius(geometry, morph);
      const sizeScale = this.sizeScale[index]!;
      const centerX = this.px[index]! + geometry.bodyCenterOffsetX * (shapeScale * sizeScale);
      const centerY = this.py[index]! + geometry.bodyCenterOffsetY * (shapeScale * sizeScale);
      const radius = shapeRadius * shapeScale * sizeScale + padding;
      nodes.push(centerX, centerY, centerX + this.jitterX[s]!, centerY + this.jitterY[s]!, Math.max(1, radius), rigid[s] === 1 ? 0 : 1, this.ids[index]!);
    }
    // A flower is immovable and represented by its actual petals.
    for (const seed of seeds) {
      const petalCount = Math.min(seed.memberIDs.length, maxFlowerPetals);
      const ringRadius = flowerRingRadius(petalBodyRadius, petalCount);
      for (let petal = 0; petal < petalCount; petal++) {
        const angle = flowerPetalAngle(petal, petalCount);
        const slotX = seed.centerX + Math.cos(angle) * ringRadius;
        const slotY = seed.centerY + Math.sin(angle) * ringRadius;
        nodes.push(slotX, slotY, slotX, slotY, petalBodyRadius + padding, 0, seed.stateKey + petal);
      }
    }
  }

  /**
   * Pile dominants as flags by standalone index: in each connected component
   * of touching full-size bodies, a pair keeps its best-ranked pin
   * (selected, then drawPriority, then lower id) as a pin that does not
   * move. Three or more are all circles. A pin whose anchor body intersects
   * a flower cannot be a dominant.
   */
  private dominantFlags(standalone: readonly number[], seeds: readonly ClusterSeed[], geometry: PinCollisionGeometry, compressedScale: number, padding: number): Uint8Array {
    const count = standalone.length;
    const dominant = new Uint8Array(count);
    if (count === 0) return dominant;
    dominant.fill(1);
    const total = this.count;
    this.bodyX = growF64(this.bodyX, total);
    this.bodyY = growF64(this.bodyY, total);
    this.bodyReach = growF64(this.bodyReach, total);
    let maxBodyReach = 1;
    for (const index of standalone) {
      const scale = this.sizeScale[index]!;
      this.bodyX[index] = this.px[index]! + geometry.bodyCenterOffsetX * scale;
      this.bodyY[index] = this.py[index]! + geometry.bodyCenterOffsetY * scale;
      this.bodyReach[index] = geometry.bodyRadiusPx * scale + padding;
      maxBodyReach = Math.max(maxBodyReach, this.bodyReach[index]!);
    }
    // Groups are found over input indices, then mapped back to standalone positions.
    const standalonePosition = new Int32Array(total);
    for (let s = 0; s < count; s++) standalonePosition[standalone[s]!] = s;
    this.joinMode = JOIN_BODIES;
    const groups = this.connectedGroups(standalone, this.bodyX, this.bodyY, 2 * maxBodyReach);
    for (const group of groups) {
      if (group.length !== 2) {
        // Three or more packed tightly are all shown as circles.
        for (const index of group) dominant[standalonePosition[index]!] = 0;
        continue;
      }
      let ranked = group[0]!;
      for (let k = 1; k < group.length; k++) if (this.ranksBefore(group[k]!, ranked)) ranked = group[k]!;
      for (const index of group) if (index !== ranked) dominant[standalonePosition[index]!] = 0;
    }

    if (seeds.length === 0) return dominant;
    const petalBodyRadius = geometry.circleBodyRadiusPx * compressedScale;
    // Petal slots of all flowers in one grid: proximity to a flower is a point query.
    const slots: number[] = [];
    for (const seed of seeds) {
      const petalCount = Math.min(seed.memberIDs.length, maxFlowerPetals);
      const ringRadius = flowerRingRadius(petalBodyRadius, petalCount);
      for (let petal = 0; petal < petalCount; petal++) {
        const angle = flowerPetalAngle(petal, petalCount);
        slots.push(seed.centerX + Math.cos(angle) * ringRadius, seed.centerY + Math.sin(angle) * ringRadius);
      }
    }
    const grid = this.grid.build(slots, slots.length / 2, maxBodyReach + petalBodyRadius + padding);
    const candidates = this.candidates;
    for (let s = 0; s < count; s++) {
      const index = standalone[s]!;
      if (this.selected[index] === 1) continue;
      const minDistance = this.bodyReach[index]! + petalBodyRadius + padding;
      const x = this.bodyX[index]!;
      const y = this.bodyY[index]!;
      grid.collectCandidates(x, y, candidates);
      for (let c = 0; c < candidates.length; c++) {
        const slot = candidates.data[c]!;
        const dx = x - slots[slot * 2]!;
        const dy = y - slots[slot * 2 + 1]!;
        if (dx * dx + dy * dy < minDistance * minDistance) {
          dominant[s] = 0;
          break;
        }
      }
    }
    return dominant;
  }

  /** Whether input pin `a` outranks `b` for dominance: selected, then higher drawPriority, then lower id. */
  private ranksBefore(a: number, b: number): boolean {
    if (this.selected[a] !== this.selected[b]) return this.selected[a] === 1;
    if (this.priority[a] !== this.priority[b]) return this.priority[a]! > this.priority[b]!;
    return this.ids[a]! < this.ids[b]!;
  }

  /**
   * Positional relaxation: a spring toward the anchor, then pairwise overlap
   * resolution applied immediately (Gauss-Seidel). The displacement limit is
   * applied once to the final target.
   */
  private relax(config: PinCollisionSettings): void {
    const nodes = this.nodes;
    const count = nodes.count;
    const ax = nodes.anchorX;
    const ay = nodes.anchorY;
    const x = nodes.positionX;
    const y = nodes.positionY;
    const radius = nodes.radius;
    const inverseMass = nodes.inverseMass;
    if (count > 1) {
      const springK = Math.min(Math.max(config.springK, 0), 1);
      // Candidate pairs are collected once from the start positions, with a margin.
      let maxRadius = 1;
      const positions = nodes.positions;
      for (let i = 0; i < count; i++) {
        maxRadius = Math.max(maxRadius, radius[i]!);
        positions[i * 2] = x[i]!;
        positions[i * 2 + 1] = y[i]!;
      }
      const grid = this.grid.build(positions, count, 3 * maxRadius);
      // A pair stays a candidate if it can touch after closing in by the maxRadius budget.
      const lists = this.pairLists;
      grid.ascendingPairs(positions, radius, maxRadius, lists);
      const pairStarts = lists.starts;
      const pairNeighbors = lists.neighbors;
      const keys = nodes.directionKey;
      const iterations = Math.max(1, Math.floor(config.collisionIterations));
      for (let iteration = 0; iteration < iterations; iteration++) {
        for (let i = 0; i < count; i++) {
          if (inverseMass[i]! > 0) {
            x[i] = x[i]! + (ax[i]! - x[i]!) * springK;
            y[i] = y[i]! + (ay[i]! - y[i]!) * springK;
          } else {
            x[i] = ax[i]!;
            y[i] = ay[i]!;
          }
        }
        for (let l = 0; l < count; l++) {
          const lhsMass = inverseMass[l]!;
          const lhsRadius = radius[l]!;
          const end = pairStarts[l + 1]!;
          for (let p = pairStarts[l]!; p < end; p++) {
            const r = pairNeighbors[p]!;
            const rhsMass = inverseMass[r]!;
            const inverseMassSum = lhsMass + rhsMass;
            if (!(inverseMassSum > 0)) continue;
            const minDistance = lhsRadius + radius[r]!;
            const dx = x[r]! - x[l]!;
            const dy = y[r]! - y[l]!;
            const distanceSquared = dx * dx + dy * dy;
            if (!(distanceSquared < minDistance * minDistance)) continue;
            const distance = Math.sqrt(distanceSquared);
            let dirX: number;
            let dirY: number;
            if (distance > 1e-4) {
              dirX = dx / distance;
              dirY = dy / distance;
            } else {
              const angle = stableUnitAngle(keys[l]!, keys[r]!);
              dirX = Math.cos(angle);
              dirY = Math.sin(angle);
            }
            const overlap = minDistance - distance;
            const lhsShare = overlap * (lhsMass / inverseMassSum);
            const rhsShare = overlap * (rhsMass / inverseMassSum);
            x[l] = x[l]! - dirX * lhsShare;
            y[l] = y[l]! - dirY * lhsShare;
            x[r] = x[r]! + dirX * rhsShare;
            y[r] = y[r]! + dirY * rhsShare;
          }
        }
      }
    } else {
      for (let i = 0; i < count; i++) {
        x[i] = ax[i]!;
        y[i] = ay[i]!;
      }
    }
    const maxOffset = Math.max(0, config.maxOffsetPx);
    for (let i = 0; i < count; i++) {
      const dx = x[i]! - ax[i]!;
      const dy = y[i]! - ay[i]!;
      const length = vectorLength(dx, dy);
      if (length > maxOffset) {
        const factor = maxOffset / Math.max(length, 1e-6);
        x[i] = ax[i]! + dx * factor;
        y[i] = ay[i]! + dy * factor;
      } else if (length < restSnapRadiusPx) {
        x[i] = ax[i]!;
        y[i] = ay[i]!;
      }
    }
  }
}

/** Rings forbidden to merge by the compactness limit are separated: the smaller flower moves (on a tie, the larger key). */
function separateFlowerRings(seeds: ClusterSeed[], petalBodyRadius: number): void {
  if (seeds.length <= 1) return;
  for (let round = 0; round < 8; round++) {
    let moved = false;
    for (let l = 0; l < seeds.length; l++) {
      const lhs = seeds[l]!;
      const lhsRadius = flowerOuterRadius(lhs.memberIDs.length, petalBodyRadius);
      for (let r = l + 1; r < seeds.length; r++) {
        const rhs = seeds[r]!;
        const minDistance = lhsRadius + flowerOuterRadius(rhs.memberIDs.length, petalBodyRadius);
        const dx = rhs.centerX - lhs.centerX;
        const dy = rhs.centerY - lhs.centerY;
        const distanceSquared = dx * dx + dy * dy;
        if (!(distanceSquared < minDistance * minDistance)) continue;
        const distance = Math.sqrt(distanceSquared);
        let dirX: number;
        let dirY: number;
        if (distance > 1e-4) {
          dirX = dx / distance;
          dirY = dy / distance;
        } else {
          const angle = stableUnitAngle(lhs.stateKey, rhs.stateKey);
          dirX = Math.cos(angle);
          dirY = Math.sin(angle);
        }
        const overlap = minDistance - distance;
        const lhsYields = lhs.memberIDs.length < rhs.memberIDs.length || (lhs.memberIDs.length === rhs.memberIDs.length && lhs.stateKey > rhs.stateKey);
        if (lhsYields) {
          lhs.centerX -= dirX * overlap;
          lhs.centerY -= dirY * overlap;
        } else {
          rhs.centerX += dirX * overlap;
          rhs.centerY += dirY * overlap;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }
}

// MARK: Smoothing

/** The value `smoothToward` and `advanceBlend` moved, read right after the call. */
let smoothValue = 0;
let blendValue = 0;

/** Moves a value toward the target by a fraction of the way, into smoothValue. True while not converged. */
function smoothToward(value: number, target: number, factor: number, epsilon: number): boolean {
  const delta = target - value;
  if (Math.abs(delta) <= epsilon) {
    smoothValue = target;
    return false;
  }
  smoothValue = value + delta * factor;
  return true;
}

function smoothOffsetToward(state: PinMotionState, targetX: number, targetY: number, factor: number, epsilon: number): boolean {
  const dx = targetX - state.offsetX;
  const dy = targetY - state.offsetY;
  if (vectorLength(dx, dy) <= epsilon) {
    state.offsetX = targetX;
    state.offsetY = targetY;
    return false;
  }
  state.offsetX += dx * factor;
  state.offsetY += dy * factor;
  return true;
}

/** Linear crossfade step toward the target, into blendValue. True until it arrives. */
function advanceBlend(value: number, target: number, step: number): boolean {
  const delta = target - value;
  if (Math.abs(delta) <= 0.001) {
    blendValue = target;
    return false;
  }
  blendValue = value + (delta > 0 ? Math.min(step, delta) : Math.max(-step, delta));
  return true;
}
