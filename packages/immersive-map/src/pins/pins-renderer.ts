// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The pins of a frame, a port of the Swift `PinsRenderer`: the controller's
 * snapshot into the presentation (moves animate, selected pins breathe),
 * the projection onto the screen, the fades at the globe's horizon, the
 * collision layout (pins push each other apart, piles become flowers), the
 * atlas cells of the pictures, and the per-pin records the overlay draws:
 * the beams first, then the pins, then the counters of merged pins.
 */

import type { CameraUniform } from "../camera/camera-uniform.ts";
import { defaultLabelBaseSettings } from "../configuration/label-settings.ts";
import type { PinSettings } from "../configuration/pin-settings.ts";
import type { Mat4 } from "../math/matrix.ts";
import type { ResolvedPresentationState } from "../presentation/resolved-presentation-state.ts";
import { badgeContentAlpha, displacedMorphStartPx } from "./clustering/pin-collision-math.ts";
import { PinCollisionLayoutSolver } from "./clustering/pin-collision-layout-solver.ts";
import { type PinCollisionGeometry, PinCollisionLayout } from "./clustering/pin-collision-types.ts";
import { PIN_FRAME_UNIFORM_BYTES, PinFrameUniformLayout, PinRecordLayout, type PinsGpu, pinShapeBubbleTailHeight, type PinShapeResource, writePinFrameConstants } from "./drawers/pins-gpu.ts";
import type { ImmersiveMapPin } from "./immersive-map-pin.ts";
import type { ImmersiveMapPinsController, PinsSnapshot } from "./immersive-map-pins-controller.ts";
import { PinCountBadgeStyle, PinStyle, pinShapeMetrics } from "./pin-types.ts";
import { PinPresentationStateStore } from "./presentation/pin-presentation-state-store.ts";
import { PinVisibilityFadeStateStore } from "./presentation/pin-visibility-fade-state-store.ts";
import { PinSelectionProjector, PinSelectionSnapshot } from "./selection/pin-selection-projector.ts";
import { PinCountBadgeAtlas, PinTextureAtlas } from "./textures/pin-texture-atlas.ts";

const selectedFlag = 1;

/** The draws of a frame's pins, in order: the pins, then the counters when one shows. */
export type PinDrawPass = "pinBody" | "countBadge";

export function pinDrawPassSequence(hasVisibleCountBadges: boolean): PinDrawPass[] {
  return hasVisibleCountBadges ? ["pinBody", "countBadge"] : ["pinBody"];
}

/** A value made on first use (the Swift `LazyPinRenderResource`): a map that never draws a pin makes none of its atlases. */
export class LazyPinRenderResource<Value> {
  private factory: (() => Value) | null;
  private stored: { value: Value } | null = null;

  constructor(factory: () => Value) {
    this.factory = factory;
  }

  get isInitialized(): boolean {
    return this.stored !== null;
  }

  get existingValue(): Value | undefined {
    return this.stored?.value;
  }

  get value(): Value {
    if (this.stored !== null) return this.stored.value;
    const factory = this.factory;
    if (factory === null) throw new Error("ImmersiveMap: a lazy pin render resource has no factory.");
    const value = factory();
    this.stored = { value };
    this.factory = null;
    return value;
  }
}

export class PinsRenderer {
  /** The per-frame limit of pictures drawn into the atlas: the rest follow in the next frames, so a batch of new pictures never stalls one. */
  static readonly atlasUploadsPerFrameLimit = 24;

  readonly pinStyle: PinStyle;
  readonly countBadgeStyle: PinCountBadgeStyle;
  readonly collisionGeometry: PinCollisionGeometry;
  private readonly beamStyle: { readonly pinCenterOffsetPx: readonly [number, number]; readonly pinBodyHalfMinPx: number };
  private readonly selectionProjector = new PinSelectionProjector();
  private readonly collisionLayoutSolver = new PinCollisionLayoutSolver();
  private readonly visibilityFadeStateStore = new PinVisibilityFadeStateStore();
  private readonly presentationStateStore = new PinPresentationStateStore();
  readonly pinAtlas: LazyPinRenderResource<PinTextureAtlas>;
  readonly countBadgeAtlas: LazyPinRenderResource<PinCountBadgeAtlas>;
  private readonly uniform = new Float32Array(PIN_FRAME_UNIFORM_BYTES / 4);
  private readonly uniformU32 = new Uint32Array(this.uniform.buffer);
  private records = new Float32Array(64 * PinRecordLayout.words);
  private recordsU32 = new Uint32Array(this.records.buffer);
  private pinCount = 0;
  private hasVisibleCountBadges = false;
  private hasVisibleBeams = false;
  private hasAppliedPins = false;
  private frameCounter = 0;
  private hasPendingAtlasUploads = false;
  private animating = false;
  private snapshot = PinSelectionSnapshot.empty;
  private readonly fadeInSeconds = defaultLabelBaseSettings.fadeInSeconds;
  private readonly fadeOutSeconds = defaultLabelBaseSettings.fadeOutSeconds;

  constructor(
    private readonly config: PinSettings,
    private readonly gpu: PinsGpu,
    shapeResource: PinShapeResource,
  ) {
    const pinSizePx = Math.fround(config.size * config.sizeScale);
    const reading = gpu.shapeReading;
    this.pinStyle = new PinStyle({
      sizePx: pinSizePx,
      outlineWidthPx: config.borderWidthPx,
      contentInset: config.contentInset,
      fillColor: config.fillColor,
      metrics: pinShapeMetrics(config.shape, pinShapeBubbleTailHeight(shapeResource) ?? undefined),
      distanceRangeTexels: reading.distanceRangeTexels,
      distanceInAlpha: reading.distanceInAlpha,
    });
    this.countBadgeStyle = new PinCountBadgeStyle(pinSizePx, this.pinStyle);
    this.beamStyle = { pinCenterOffsetPx: this.pinStyle.bodyCenterOffsetPx, pinBodyHalfMinPx: this.pinStyle.circleRadiusPx };
    const [bodyCenterOffsetX, bodyCenterOffsetY] = this.pinStyle.bodyCenterOffsetPx;
    this.collisionGeometry = { pinSizePx, bodyRadiusPx: this.pinStyle.bodyRadiusPx, circleBodyRadiusPx: this.pinStyle.circleRadiusPx, bodyCenterOffsetX, bodyCenterOffsetY };
    this.pinAtlas = new LazyPinRenderResource(() => {
      gpu.ensureAtlas(config.atlasSizePx, config.atlasPagesMax);
      gpu.ensureShapeField();
      return new PinTextureAtlas(config.atlasSizePx, config.size, config.atlasPagesMax, (image, slot, cellSize) => gpu.uploadPicture(isPlaceholderKey(image) ? null : image, slot, cellSize));
    });
    this.countBadgeAtlas = new LazyPinRenderResource(() => {
      const atlas = new PinCountBadgeAtlas(Math.max(1, Math.round(this.countBadgeStyle.sizePx[0])), (text, x, y, cellSize) => gpu.uploadBadge(text, x, y, cellSize));
      gpu.ensureBadgeAtlas(atlas.width, atlas.height);
      return atlas;
    });
    writePinFrameConstants(this.uniform, this.uniformU32, this.pinStyle.gpu, { ...this.beamStyle, color: config.beamColor }, this.countBadgeStyle);
  }

  get hasRenderablePins(): boolean {
    return this.pinCount > 0;
  }

  /** Whether a pin moves, breathes, fades or waits for its picture: the frames keep coming. */
  get hasActiveAnimations(): boolean {
    return this.animating;
  }

  /** What the last frame drew, for a tap. */
  get selectionSnapshot(): PinSelectionSnapshot {
    return this.snapshot;
  }

  /** Takes the controller's changes (none when it has none). A map without a controller lets its pins go. */
  update(controller: ImmersiveMapPinsController | null, time: number): void {
    const snapshot = controller?.consumeSnapshot() ?? null;
    if (snapshot !== null) this.apply(snapshot, time);
    if (controller === null) this.clear(time);
    this.animating = this.presentationStateStore.hasActiveAnimations || this.visibilityFadeStateStore.hasActiveAnimations;
  }

  private apply(snapshot: PinsSnapshot, time: number): void {
    // The pictures go into the atlas by visibility (`rebuildFrameRecords`):
    // the atlas is keyed by picture and takes its own least used cells.
    this.presentationStateStore.apply(snapshot, time);
    this.hasAppliedPins = snapshot.pins.length > 0;
  }

  private clear(time: number): void {
    if (!this.hasAppliedPins) return;
    this.apply({ pins: [], removedIds: [], imageUpdateIds: [], version: 0 }, time);
  }

  /** The frame's layout and records, uploaded. */
  compute(drawWidth: number, drawHeight: number, cameraUniform: CameraUniform, presentation: ResolvedPresentationState, screenMatrix: Mat4, time: number): void {
    const presented = this.presentationStateStore.presentedEntries(time);
    // The cull margin: the farthest a pin is pushed plus twice its size (the body, the flower's ring, the beam to its place).
    const cullMarginPx = this.config.maxOffsetPx + this.collisionGeometry.pinSizePx * 2;
    const projected = this.selectionProjector.project(presented, drawWidth, drawHeight, cameraUniform, presentation, cullMarginPx);
    const fades = this.visibilityFadeStateStore.resolve(projected, time, this.fadeInSeconds, this.fadeOutSeconds);
    const layout = this.config.spreadsApart ? this.collisionLayoutSolver.solve(fades.projectedPins, this.collisionGeometry, this.config, time) : PinCollisionLayout.anchored(fades.projectedPins);
    this.rebuildFrameRecords(layout);
    this.animating = this.presentationStateStore.hasActiveAnimations || fades.hasActiveAnimations || layout.hasActiveAnimations || this.hasPendingAtlasUploads;
    this.snapshot = this.selectionProjector.makeSnapshot(layout.pinItems, drawWidth, drawHeight, this.pinStyle);
    const matrix = this.uniform;
    for (let index = 0; index < 16; index++) matrix[PinFrameUniformLayout.screenMatrix + index] = screenMatrix[index]!;
    this.gpu.writeFrame(this.uniform, this.records, this.pinCount);
  }

  private rebuildFrameRecords(layout: PinCollisionLayout): void {
    this.hasVisibleCountBadges = false;
    this.hasVisibleBeams = false;
    this.hasPendingAtlasUploads = false;
    // An empty scene makes no atlas.
    if (layout.pinItems.length === 0) {
      this.pinCount = 0;
      return;
    }
    this.frameCounter += 1;
    const atlas = this.pinAtlas.value;
    atlas.beginFrame(this.frameCounter);
    let uploadBudget = PinsRenderer.atlasUploadsPerFrameLimit;
    this.ensureRecordCapacity(layout.pinItems.length);
    const f32 = this.records;
    const u32 = this.recordsU32;
    const l = PinRecordLayout;
    let count = 0;
    for (const item of layout.pinItems) {
      const pin = item.pin;
      // A pin's picture: its own key, or the built-in placeholder's.
      const picture = pin.image;
      let slot = atlas.slot(pictureKey(picture));
      if (slot === null) {
        if (uploadBudget > 0) {
          // A refusal means this frame's pictures fill the atlas: more frames would not help.
          slot = atlas.uploadImage(pictureKey(picture));
          if (slot !== null) uploadBudget -= 1;
        } else {
          // The budget ran out: the pin follows in the next frames.
          this.hasPendingAtlasUploads = true;
        }
      }
      if (slot === null) continue;
      const base = count * l.words;
      f32.fill(0, base, base + l.words);
      const point = item.screenPoint;
      f32[base + l.position] = point.positionX;
      f32[base + l.position + 1] = point.positionY;
      f32[base + l.visibilityAlpha] = point.visibilityAlpha;
      u32[base + l.visible] = point.visible;
      f32.set(slot.uvRect, base + l.uvRect);
      f32.set(pin.borderColor ?? this.config.borderColor, base + l.borderColor);
      const displayScale = item.displayScale;
      f32[base + l.squashScale] = item.squashScaleX * pin.screenSizeScale * displayScale;
      f32[base + l.squashScale + 1] = item.squashScaleY * pin.screenSizeScale * displayScale;
      u32[base + l.atlasIndex] = slot.pageIndex;
      u32[base + l.flags] = pin.isSelected ? selectedFlag : 0;
      f32[base + l.morph] = item.morph;
      // Only a pin standing on its place has a counter: on a pushed circle it fades out with the morph.
      const contentAlpha = badgeContentAlpha(displayScale) * (1 - item.morph);
      f32[base + l.screenSizeScale] = pin.screenSizeScale;
      const badgeSlot = contentAlpha > 0 && pin.countBadge !== null ? this.countBadgeAtlas.value.slot(pin.countBadge) : null;
      if (badgeSlot !== null) {
        f32.set(badgeSlot, base + l.badgeUvRect);
        u32[base + l.badgeFlags] = 1;
        f32[base + l.badgeContentAlpha] = contentAlpha;
        this.hasVisibleCountBadges = true;
      }
      // The cone runs from the true place to the pushed circle, and fades with the pin.
      const anchor = item.anchorScreenPoint;
      f32[base + l.beamAnchor] = anchor.positionX;
      f32[base + l.beamAnchor + 1] = anchor.positionY;
      u32[base + l.beamAnchorVisible] = anchor.visible;
      f32[base + l.beamAnchorAlpha] = point.visibilityAlpha;
      const dx = point.positionX - anchor.positionX;
      const dy = point.positionY - anchor.positionY;
      f32[base + l.beamOffset] = dx;
      f32[base + l.beamOffset + 1] = dy;
      f32[base + l.beamScale] = displayScale * pin.screenSizeScale;
      this.hasVisibleBeams = this.hasVisibleBeams || Math.hypot(dx, dy) > displacedMorphStartPx;
      count += 1;
    }
    this.pinCount = count;
  }

  private ensureRecordCapacity(count: number): void {
    if (this.records.length >= count * PinRecordLayout.words) return;
    let capacity = this.records.length / PinRecordLayout.words;
    while (capacity < count) capacity *= 2;
    this.records = new Float32Array(capacity * PinRecordLayout.words);
    this.recordsU32 = new Uint32Array(this.records.buffer);
  }

  /** The frame's draws, in the overlay pass: the beams under the pins, the counters over them. */
  encode(pass: GPURenderPassEncoder): void {
    if (this.pinCount === 0) return;
    const gpu = this.gpu;
    pass.setBindGroup(0, gpu.bindGroup());
    if (this.hasVisibleBeams) {
      pass.setPipeline(gpu.beamPipeline);
      pass.draw(6, this.pinCount);
    }
    for (const drawPass of pinDrawPassSequence(this.hasVisibleCountBadges)) {
      pass.setPipeline(drawPass === "pinBody" ? gpu.bodyPipeline : gpu.badgePipeline);
      pass.draw(6, this.pinCount);
    }
  }
}

const placeholderKey: object = Object.freeze({ placeholder: true });

/**
 * The atlas key of a picture: the picture itself, one key for every pin
 * on the built-in placeholder. The upload resolves the placeholder key to
 * the placeholder's picture.
 */
function pictureKey(image: ImmersiveMapPin["image"]): NonNullable<ImmersiveMapPin["image"]> {
  return (image ?? placeholderKey) as NonNullable<ImmersiveMapPin["image"]>;
}

/** Whether an atlas key is the placeholder's. */
export function isPlaceholderKey(key: unknown): boolean {
  return key === placeholderKey;
}
