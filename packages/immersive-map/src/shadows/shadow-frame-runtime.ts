// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The frame's shadows, the shadow half of the Swift `RenderFrameEngine`
 * and `RenderPassGraph`: the light's windows are resolved before the
 * subsystems update (`resolveFrame`, `ShadowMapReuseController`), and once
 * the buildings have said what they draw the gate decides whether the frame
 * has shadows at all (`plan`, `ShadowPassGateResolver`). The plan writes the
 * uniform every receiver reads (the disabled one without shadows, whose
 * strength guard skips every lookup), makes the textures, and lists the
 * passes: a caster pass a window whose slice went stale, then the ground's
 * mask. The receivers read the gated state (`frameState`), so the passes and
 * the samplers never disagree within a frame. A pass whose casters alone
 * changed keeps its slice: the casters that arrived or rose are drawn over
 * it, and where casters left, the rectangle they covered is cleared and
 * drawn again (`ShadowCasterPassPlan`, `ShadowCasterRegionResolver`).
 */

import type { GroundReliefShadowSignature } from "../tile/relief/frame/ground-relief-frame.ts";
import type { Mat4 } from "../math/matrix.ts";
import type { ShadowPassPlan } from "../render/frame-engine.ts";
import { writeGroundShadowMaskUniform, GroundShadowMaskUniformLayout } from "./ground-shadow-mask.ts";
import { ShadowCascadeAtlas, type ShadowCascadeSlot } from "./shadow-cascade-atlas.ts";
import { ShadowFrameState } from "./shadow-frame-state.ts";
import type { ShadowFrameInput } from "./shadow-frame-state-resolver.ts";
import { ShadowCasterRegionResolver } from "./shadow-caster-region.ts";
import { ShadowGpuResources } from "./shadow-gpu-resources.ts";
import { standingCeiling } from "../tile/subsystems/standing-frame.ts";
import { type ShadowCasterKeyPlacement, type ShadowCasterPassPlan, ShadowMapReuseController } from "./shadow-map-reuse-controller.ts";
import { ShadowPassGateResolver } from "./shadow-pass-gate.ts";
import { ShadowUniform, ShadowUniformLayout, writeShadowUniform } from "./shadow-uniform.ts";

/** A placement whose buildings cast this frame: its resident tile, where it draws, its quarters and the step of its rise. */
export type ShadowCasterPlacement = ShadowCasterKeyPlacement;

/** What the gate and the reuse read of the casters a frame draws. */
export interface ShadowCasterFrame {
  /** The building placements drawn this frame (`BuildingExtrusionSubsystem.drawnPlacements`). */
  readonly buildingPlacements: readonly ShadowCasterPlacement[];
  /**
   * What else moves the buildings' shadows (`BuildingExtrusionSubsystem.shadowRiseSignature`,
   * their lifts on the relief): a change redraws the map. Each placement's
   * rise travels in its own `riseStep`.
   */
  readonly buildingRiseSignature: number;
  /**
   * The model tiles that cast this frame (`SceneModelFrameState.staticShadowCasters`):
   * they never move, so they join the buildings in the caster set, one key
   * a tile and world copy.
   */
  readonly modelCasters?: readonly ShadowCasterPlacement[] | undefined;
  /** The app's scene models cast this frame: they may move, so the map renders again every frame while one casts. */
  readonly hasMovingModelCasters?: boolean | undefined;
  /** The CPU camera matrix the mask unprojects its pixels by. */
  readonly projectionView: Mat4;
  /** What the mountains cast from this frame (`GroundReliefFrame.shadowSignature`), `undefined` while they cast nothing. */
  readonly terrain?: GroundReliefShadowSignature | undefined;
  readonly drawWidth: number;
  readonly drawHeight: number;
}

const noShadowPasses: ShadowPassPlan = { casterPasses: [], groundShadowMask: undefined };

export class ShadowFrameRuntime {
  readonly resources: ShadowGpuResources;
  private readonly reuse = new ShadowMapReuseController();
  private resolved: ShadowFrameState | undefined;
  /** What the frame's windows were resolved from: the pan, the map size and the relief's heights the caster regions are measured by. */
  private input: ShadowFrameInput | undefined;
  private gated: ShadowFrameState | undefined;
  private readonly uniformStaging = new Float32Array(ShadowUniformLayout.byteLength / 4);
  private readonly maskStaging = new Float32Array(GroundShadowMaskUniformLayout.byteLength / 4);
  /** Which window may put a caster change off this frame: they alternate. */
  private parity = false;
  /** Whether the uniform holds the disabled one already. */
  private holdsDisabled = false;

  constructor(private readonly device: GPUDevice) {
    this.resources = new ShadowGpuResources(device);
    this.writeDisabled();
  }

  /** The frame's windows, before the gate: `undefined` off the flat map, with the shadows off or the sun too low. */
  resolveFrame(input: ShadowFrameInput): void {
    this.input = input;
    this.resolved = this.reuse.resolveFrameState(input);
  }

  /**
   * Makes the textures the frame may draw into before any bind group of the
   * frame is built on them: the plan later finds them made.
   */
  prepareTextures(drawWidth: number, drawHeight: number): void {
    if (!this.resolved) return;
    this.resources.ensureShadowMap(this.resolved.mapResolution);
    this.resources.ensureGroundShadowMask(drawWidth, drawHeight);
  }

  /** The frame's windows before the gate: what the models cull their casters by while they update, `undefined` without shadows. */
  get resolvedFrameState(): ShadowFrameState | undefined {
    return this.resolved;
  }

  /** The frame's shadows past the gate: what the casters draw by, `undefined` on a frame without shadows. */
  get frameState(): ShadowFrameState | undefined {
    return this.gated;
  }

  /** The frame's shadow passes, after the subsystems' update. */
  plan(frame: ShadowCasterFrame): ShadowPassPlan {
    const hasBuildingCasters = frame.buildingPlacements.length > 0;
    const modelCasters = frame.modelCasters ?? [];
    const hasMovingModelCasters = frame.hasMovingModelCasters === true;
    const hasModelCasters = modelCasters.length > 0 || hasMovingModelCasters;
    this.gated = ShadowPassGateResolver.resolve(this.resolved, { hasBuildingCasters, hasModelCasters, hasTerrainCasters: frame.terrain !== undefined });
    const state = this.gated;
    if (!state) {
      this.writeDisabled();
      return noShadowPasses;
    }
    const { queue } = this.device;
    writeShadowUniform(this.uniformStaging, 0, state.shadowUniform);
    queue.writeBuffer(this.resources.shadowUniformBuffer, 0, this.uniformStaging);
    this.holdsDisabled = false;

    const textureIdentity = this.resources.ensureShadowMap(state.mapResolution);
    const casterKeys = ShadowMapReuseController.casterKeys(modelCasters.length === 0 ? frame.buildingPlacements : [...frame.buildingPlacements, ...modelCasters]);
    const casterPasses: { layer: ShadowPassPlan["casterPasses"][number]["layer"]; view: GPUTextureView; keepsDepth: boolean }[] = [];
    const passPlans = new Map<ShadowCascadeSlot, ShadowCasterPassPlan>();
    // A window whose casters alone changed (a tile landing, the rise) may
    // render a frame late, the windows taking turns frame by frame: while
    // the buildings rise, a frame pays for one caster pass, not two.
    this.parity = !this.parity;
    const mayDefer = state.farLightProjectionView === undefined ? undefined : this.parity ? "near" : "far";
    for (const slot of ShadowFrameState.slots(state)) {
      const renders = this.reuse.planShadowRender({
        casterKeys,
        hasModelCasters: hasMovingModelCasters,
        heightScales: [frame.buildingRiseSignature, 0],
        textureIdentity,
        slot,
        terrain: frame.terrain,
        mayDeferCasterChange: slot === mayDefer,
      });
      if (!renders) continue;
      const passPlan = this.withRegion(slot, state, this.reuse.passPlan(slot));
      if (passPlan !== undefined) passPlans.set(slot, passPlan);
      // A pass changing some casters keeps the depth its slice holds, and
      // with removals clears the rectangle they covered first.
      const region = passPlan?.region;
      casterPasses.push({
        layer: ShadowCascadeAtlas.casterLayer(slot),
        view: this.resources.sliceView(slot),
        keepsDepth: passPlan?.added !== undefined,
        ...(region === undefined ? {} : { encodeFirst: (pass: GPURenderPassEncoder) => this.resources.encodeRegionClear(pass, region.scissor) }),
      });
    }
    // The casters read how their passes run from the gated state.
    if (passPlans.size > 0) this.gated = { ...state, casterPasses: passPlans };

    const mask = this.resources.ensureGroundShadowMask(frame.drawWidth, frame.drawHeight);
    if (!writeGroundShadowMaskUniform(this.maskStaging, frame.projectionView, mask.width, mask.height)) return { casterPasses, groundShadowMask: undefined };
    queue.writeBuffer(this.resources.maskUniformBuffer, 0, this.maskStaging);
    return { casterPasses, groundShadowMask: mask.view };
  }

  /**
   * A plan with removals gets the rectangle of the slice its changed casters
   * cover, measured from the tiles' ground (or the lowest terrain) to the
   * highest roof: too large a rectangle makes it a full pass.
   */
  private withRegion(slot: ShadowCascadeSlot, state: ShadowFrameState, plan: ShadowCasterPassPlan | undefined): ShadowCasterPassPlan | undefined {
    const input = this.input;
    if (plan?.added === undefined || plan.removed.length === 0 || input === undefined) return plan;
    const lightProjectionView = ShadowFrameState.lightProjectionView(state, slot);
    const ground = input.groundHeights ?? [0, 0];
    const heights: [number, number] = [Math.min(ground[0], 0), Math.max(ground[1], 0) + standingCeiling(input.renderMapSize)];
    const region =
      lightProjectionView === undefined
        ? undefined
        : ShadowCasterRegionResolver.resolve([...plan.removed, ...plan.added], lightProjectionView, input.flatRenderPan, input.renderMapSize, heights, state.mapResolution);
    if (region === undefined) {
      this.reuse.redrawWhole(slot);
      return this.reuse.passPlan(slot);
    }
    return { ...plan, region };
  }

  /** Forgets the rendered windows: the next frame with shadows draws them again. */
  reset(): void {
    this.reuse.reset();
  }

  destroy(): void {
    this.resources.destroy();
  }

  private writeDisabled(): void {
    if (this.holdsDisabled) return;
    writeShadowUniform(this.uniformStaging, 0, ShadowUniform.disabled);
    this.device.queue.writeBuffer(this.resources.shadowUniformBuffer, 0, this.uniformStaging);
    this.holdsDisabled = true;
  }
}
