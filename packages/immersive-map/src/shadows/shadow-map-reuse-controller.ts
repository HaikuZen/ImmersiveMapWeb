// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { GroundReliefShadowSignature } from "../tile/relief/frame/ground-relief-frame.ts";
import { type ShadowCascadeSlot, shadowCascadeSlots } from "./shadow-cascade-atlas.ts";
import type { ShadowFrameState } from "./shadow-frame-state.ts";
import { type ShadowAnchoredFit, type ShadowFitInputs, type ShadowFrameInput, ShadowFrameStateResolver } from "./shadow-frame-state-resolver.ts";

/**
 * A disc of the ground, in flat world xy, inside which no receiver reads the
 * far window: the casters whose whole shadow falls in it are left out of the
 * far window's pass (`ShadowMapReuseController.farCasterHoleShare`).
 */
export interface ShadowCasterHole {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/**
 * How one window's caster pass runs this frame. With `added` the pass keeps
 * the slice as it was rendered and changes only what the casters changed:
 * `added` names the casters that arrived or grew taller since, `removed`
 * the ones that left (or stand lower). Without removals the added casters
 * are drawn over the kept depth. With removals the part of the slice the
 * changed casters cover is cleared and drawn again (`region`, made by
 * `ShadowFrameRuntime`). `added` undefined clears the slice and draws every
 * caster. `hole` is the disc whose casters the pass leaves out, in this
 * frame's flat world xy, `undefined` for none.
 */
export interface ShadowCasterPassPlan {
  readonly added: ReadonlySet<string> | undefined;
  readonly removed: readonly string[];
  readonly hole: ShadowCasterHole | undefined;
  readonly region?: ShadowCasterRegion | undefined;
}

/**
 * The part of a slice a pass with removals draws again: the scissor
 * rectangle in texels (x, y, width, height), cleared first, and the light
 * camera cropped to it, which the casters outside it are culled by.
 */
export interface ShadowCasterRegion {
  readonly scissor: readonly [number, number, number, number];
  readonly cullingProjectionView: Float64Array;
}

/** What a caster's key says of where it stands (`ShadowMapReuseController.casterPlace`). */
export interface ShadowCasterPlace {
  readonly tile: { readonly x: number; readonly y: number; readonly z: number };
  readonly worldWrap: number;
}

/**
 * Keeps the rendered shadow map alive across frames, a port of the Swift
 * `ShadowMapReuseController`. The sun is static and the buildings do not
 * move, so a rendered window only goes stale when the camera leaves its
 * fitted window, the light or the resolution changes, the set of tiles with
 * buildings changes, the buildings rise, the texture is recreated, or moving
 * models cast. Otherwise the receivers keep sampling the map rendered some
 * frames ago, through matrices re-materialized for the current pan, and the
 * caster pass does not run.
 *
 * Each window is fitted and recorded on its own: the near window follows
 * the camera closely and refits often, the far one is wide and seldom does,
 * and a refit of the near window does not redraw the far one.
 *
 * A fit is computed with an inflated receiver footprint (`radiusMargin`),
 * so the camera can travel and turn inside the rendered window before a
 * refit, and the fitted centre snaps to whole texels in pan-anchored space,
 * so a refit moves the window by whole texels.
 *
 * A change of the casters alone does not clear the slice. Casters that
 * only arrived or rose a step are drawn over the kept depth, which is then
 * exactly the map of all of them, since a taller building holds the shorter
 * one and the depth keeps the nearest occluder. Casters that left clear
 * the part of the slice they covered, which is drawn again
 * (`ShadowCasterPassPlan`). Not in Swift, which draws the whole map again
 * (docs/STATUS.md, stage 4).
 *
 * The far window leaves out the casters whose whole shadow falls where the
 * receivers read the near window alone (`farCasterHoleShare`), and goes
 * stale when the camera's near disc no longer holds that hole.
 *
 * A window also goes stale when the terrain under it changes: a terrain
 * tile arriving or welded, the rise, the datum the ground is drawn from
 * (`GroundReliefShadowSignature`). The static model casters (the model
 * tiles) are keys of the caster set like the buildings' placements, and a
 * building tile with buildings left out for the models casts under a key of
 * its own (its working index buffer), so both join the set's changes. The
 * Swift window keeps them as fields of their own (`staticModelCasters`,
 * `hiddenBuildings`) and draws the whole map again on any change.
 */
export class ShadowMapReuseController {
  /**
   * Footprint inflation of the fit, about the camera: about 10% of travel
   * before the window needs a refit, for up to 10% coarser texels than a
   * frame-exact fit.
   */
  static readonly radiusMargin = 1.1;

  /**
   * The far window's caster hole as a share of the radius where the
   * receivers start reading the far window (the near window's fade start,
   * shadow.wgsl `shadowCascadeBlend`), less the longest shadow a caster of
   * `maxCasterHeightMeters` throws. The rest of the radius is the slack the
   * camera spends before the far window renders again: about half a zoom
   * level in, or 30% of the radius of travel.
   */
  static readonly farCasterHoleShare = 0.7;

  private readonly fits = new Map<ShadowCascadeSlot, ShadowAnchoredFit>();
  private readonly fitGenerations = new Map<ShadowCascadeSlot, number>();
  private readonly rendered = new Map<ShadowCascadeSlot, RenderedWindow>();
  /** How each window's pass runs this frame, for the windows planned to render. */
  private readonly passPlans = new Map<ShadowCascadeSlot, ShadowCasterPassPlan>();
  /** The frame's inputs, from `resolveFrameState`: the far window's hole is measured on them. */
  private inputs: ShadowFitInputs | undefined;

  /** The windows whose caster-only render the last frame put off: they render on this one. */
  private readonly casterRenderDeferred = new Set<ShadowCascadeSlot>();
  /** Whether the last frame put the far window's refit off (it refits on this one whatever the near one does). */
  private farDeferred = false;
  /** The size of the flat world the kept fits are measured in. */
  private renderMapSize: number | undefined;

  /**
   * The frame's shadow state: every window's cached fit re-materialized
   * under the current pan when it still covers the frame, a fresh margined
   * fit otherwise.
   */
  resolveFrameState(input: ShadowFrameInput): ShadowFrameState | undefined {
    const R = ShadowFrameStateResolver;
    // The flat world is measured in units that double at every whole zoom
    // (`renderMapSize`), and a fit is kept in those units: across the step
    // no kept fit means anything, so both windows are fitted afresh on that
    // frame and neither is put off. A far window drawn for one more frame by
    // a fit in the old units would cull and sample by a window half or twice
    // its size somewhere else, and the shadows would blink.
    if (this.renderMapSize !== input.renderMapSize) {
      this.renderMapSize = input.renderMapSize;
      this.fits.clear();
      this.farDeferred = false;
      this.casterRenderDeferred.clear();
    }
    const inputs = R.resolveInputs(input);
    this.inputs = inputs;
    if (inputs === undefined) return undefined;
    let nearRefitted = false;
    let farDeferred = false;
    for (const slot of shadowCascadeSlots) {
      // A window the frame has not got keeps no fit: when it is back it is
      // fitted afresh and its pass runs.
      if ((slot === "near" ? inputs.near : inputs.far) === undefined) {
        this.fits.delete(slot);
        continue;
      }
      const cached = this.fits.get(slot);
      if (cached !== undefined && R.fitCovers(cached, inputs, slot, ShadowMapReuseController.radiusMargin)) continue;
      // Both windows stale on one frame (a turning camera spends both
      // slacks at once): the near one refits now and the far one on the next
      // frame, drawn meanwhile by the fit its slice was rendered for, so a
      // frame never pays for two caster passes over the same casters. The far
      // window lies past the near one's fade, where a frame of a slightly
      // short window does not show. Never twice running. Not in Swift
      // (docs/STATUS.md, stage 4).
      if (slot === "far" && nearRefitted && cached !== undefined && !this.farDeferred) {
        farDeferred = true;
        continue;
      }
      const fresh = R.resolveAnchoredFit(inputs, slot, ShadowMapReuseController.radiusMargin);
      if (fresh === undefined) {
        this.fits.delete(slot);
        if (slot === "near") return undefined;
        continue;
      }
      this.fits.set(slot, fresh);
      this.fitGenerations.set(slot, (this.fitGenerations.get(slot) ?? 0) + 1);
      if (slot === "near") nearRefitted = true;
    }
    this.farDeferred = farDeferred;
    return R.materialize(this.fits, inputs);
  }

  /**
   * The single render-or-reuse decision for one window, made once a frame
   * at pass planning. True when the window's caster pass must run this
   * frame, and the render is then recorded so the next frames can reuse it.
   * `heightScales` are the rise signatures of the buildings and of the
   * models, and `textureIdentity` names the shadow map's texture, a new number
   * for a recreated (blank) one.
   */
  planShadowRender(window: {
    readonly casterKeys: ReadonlySet<string>;
    readonly hasModelCasters: boolean;
    readonly heightScales: readonly [number, number];
    readonly textureIdentity: number;
    readonly slot: ShadowCascadeSlot;
    /** What the mountains cast from (`GroundReliefFrame.shadowSignature`), `undefined` while they cast nothing. */
    readonly terrain?: GroundReliefShadowSignature | undefined;
    /**
     * Put a render whose only cause is the casters off to the next frame:
     * the window's fit and texture are those its slice was rendered with,
     * so the slice stays right for every caster it already holds. Never
     * twice running for a window (not in Swift, docs/STATUS.md, stage 4).
     */
    readonly mayDeferCasterChange?: boolean;
  }): boolean {
    this.passPlans.delete(window.slot);
    const previous = this.rendered.get(window.slot);
    const next: RenderedWindow = {
      fitGeneration: this.fitGenerations.get(window.slot) ?? 0,
      textureIdentity: window.textureIdentity,
      casterKeys: new Set(window.casterKeys),
      heightScales: [window.heightScales[0], window.heightScales[1]],
      terrain: window.terrain,
      hole: window.slot === "far" ? this.farCasterHole() : undefined,
    };
    // A far slice drawn without the casters of a hole the receivers now
    // read the far window over is stale, whatever else stayed.
    const holeBroken = previous?.hole !== undefined && !this.holeServes(previous.hole);
    // Moving models re-render every frame. Otherwise any difference from
    // the rendered window does: a fresh fit, a recreated texture, the rise,
    // and any change of the caster set, an arrival (not in the map) as a
    // departure (its shadows may lie on ground whose buildings are gone).
    const needsRender = window.hasModelCasters || previous === undefined || holeBroken || !sameWindow(previous, next);
    if (!needsRender) {
      this.casterRenderDeferred.delete(window.slot);
      return false;
    }
    const onlyCasters = !window.hasModelCasters && !holeBroken && previous !== undefined && previous.fitGeneration === next.fitGeneration && previous.textureIdentity === next.textureIdentity;
    if (window.mayDeferCasterChange === true && onlyCasters && !this.casterRenderDeferred.has(window.slot)) {
      this.casterRenderDeferred.add(window.slot);
      return false;
    }
    this.casterRenderDeferred.delete(window.slot);
    // A change of the casters alone is drawn into the kept slice, by the
    // hole it was drawn with.
    const change = onlyCasters && previous !== undefined ? casterChange(previous, next) : undefined;
    const rendered = change === undefined ? next : { ...next, hole: previous!.hole };
    this.rendered.set(window.slot, rendered);
    this.passPlans.set(window.slot, { added: change?.added, removed: change?.removed ?? [], hole: this.holeInFrame(rendered.hole) });
    return true;
  }

  /**
   * A pass with removals whose changed part could not be drawn alone (it
   * covers too much of the slice) clears the slice and draws everything:
   * the plan becomes a full one, by the hole the slice was drawn with.
   */
  redrawWhole(slot: ShadowCascadeSlot): void {
    const plan = this.passPlans.get(slot);
    if (plan !== undefined) this.passPlans.set(slot, { added: undefined, removed: [], hole: plan.hole });
  }

  /** How a window's pass runs this frame: `undefined` unless `planShadowRender` planned it to render. */
  passPlan(slot: ShadowCascadeSlot): ShadowCasterPassPlan | undefined {
    return this.passPlans.get(slot);
  }

  /**
   * The far window's caster hole for this frame, in pan-anchored world xy
   * (the record outlives the pan): a disc about the camera's ground point,
   * `farCasterHoleShare` of the near window's fade start less the longest
   * shadow a caster throws. `undefined` without a far window or when
   * nothing is left of the disc.
   */
  private farCasterHole(): ShadowCasterHole | undefined {
    const inputs = this.inputs;
    if (inputs?.far === undefined) return undefined;
    const light = inputs.lightDirection;
    const longestShadow = (inputs.far.spec.maxCasterHeight * Math.hypot(light[0], light[1])) / light[2];
    const radius = ShadowFrameStateResolver.fadeDistances(inputs.near.spec.radius).start * ShadowMapReuseController.farCasterHoleShare - longestShadow;
    if (!(radius > 0) || !Number.isFinite(radius)) return undefined;
    return { x: inputs.cameraEye[0] - inputs.panShift[0], y: inputs.cameraEye[1] - inputs.panShift[1], radius };
  }

  /** Whether the receivers of this frame read the near window alone over the whole of a pan-anchored hole. */
  private holeServes(hole: ShadowCasterHole): boolean {
    const inputs = this.inputs;
    if (inputs === undefined) return false;
    const nearOnly = ShadowFrameStateResolver.fadeDistances(inputs.near.spec.radius).start;
    const distance = Math.hypot(inputs.cameraEye[0] - inputs.panShift[0] - hole.x, inputs.cameraEye[1] - inputs.panShift[1] - hole.y);
    return distance + hole.radius <= nearOnly;
  }

  /** A pan-anchored hole in this frame's flat world xy. */
  private holeInFrame(hole: ShadowCasterHole | undefined): ShadowCasterHole | undefined {
    const inputs = this.inputs;
    if (hole === undefined || inputs === undefined) return undefined;
    return { x: hole.x + inputs.panShift[0], y: hole.y + inputs.panShift[1], radius: hole.radius };
  }

  /** Forgets every fit and every rendered window. */
  reset(): void {
    this.fits.clear();
    this.fitGenerations.clear();
    this.rendered.clear();
    this.passPlans.clear();
    this.farDeferred = false;
    this.casterRenderDeferred.clear();
    this.renderMapSize = undefined;
  }

  /**
   * Every building caster the frame rasterizes: the placements it draws
   * buildings for. A caster is its resident tile object (a re-parse of the
   * same coordinates is a new object, and so a new caster), the slot it
   * draws in, the world copy, the quarters it casts from and its rise step
   * (`casterKey`).
   */
  static casterKeys(placements: readonly ShadowCasterKeyPlacement[]): Set<string> {
    const keys = new Set<string>();
    for (const p of placements) keys.add(ShadowMapReuseController.casterKey(p));
    return keys;
  }

  /**
   * One caster's key: its resident tile object, the slot it draws in, the
   * world copy, the quarters it casts from, and the step of its rise it
   * casts at (`riseStep`, 1 for a building at full height). A caster rising
   * a step is the same caster grown (`addedCasters`).
   */
  static casterKey(placement: ShadowCasterKeyPlacement): string {
    const t = placement.placeIn.tile;
    return `${objectIdentity(placement.resident)}|${t.z}/${t.x}/${t.y}|${placement.placeIn.worldWrap}|${placement.quarters}|${placement.riseStep ?? 1}`;
  }

  /** Where the caster of a key stands: its slot and world copy. */
  static casterPlace(key: string): ShadowCasterPlace {
    const [, tile, wrap] = key.split("|");
    const [z, x, y] = tile!.split("/").map(Number);
    return { tile: { x: x!, y: y!, z: z! }, worldWrap: Number(wrap) };
  }
}

/** What a caster's key is made of (`ShadowMapReuseController.casterKey`). */
export interface ShadowCasterKeyPlacement {
  readonly resident: object;
  readonly placeIn: { readonly tile: { readonly x: number; readonly y: number; readonly z: number }; readonly worldWrap: number };
  readonly quarters: number;
  /** The step of its rise the caster casts at, 1 (the default) at full height. */
  readonly riseStep?: number;
}

/**
 * How the casters changed since a window's slice was drawn: the casters
 * that arrived or rose a step (`added`), and the ones that left or stand
 * lower (`removed`). A caster a step higher is the same key up to the step
 * and only adds. `undefined` when more than the casters changed (the
 * lifts' heights, the terrain), which clears the slice.
 */
function casterChange(previous: RenderedWindow, next: RenderedWindow): { added: ReadonlySet<string>; removed: readonly string[] } | undefined {
  if (previous.heightScales[0] !== next.heightScales[0] || previous.heightScales[1] !== next.heightScales[1]) return undefined;
  if (!sameTerrain(previous.terrain, next.terrain)) return undefined;
  const added = new Set<string>();
  for (const key of next.casterKeys) if (!previous.casterKeys.has(key)) added.add(key);
  const grown = new Map<string, number>();
  for (const key of added) {
    const cut = key.lastIndexOf("|");
    grown.set(key.slice(0, cut), Number(key.slice(cut + 1)));
  }
  const removed: string[] = [];
  for (const key of previous.casterKeys) {
    if (next.casterKeys.has(key)) continue;
    const cut = key.lastIndexOf("|");
    const step = grown.get(key.slice(0, cut));
    if (step === undefined || !(step > Number(key.slice(cut + 1)))) removed.push(key);
  }
  return { added, removed };
}

interface RenderedWindow {
  readonly fitGeneration: number;
  readonly textureIdentity: number;
  readonly casterKeys: ReadonlySet<string>;
  readonly heightScales: readonly [number, number];
  readonly terrain: GroundReliefShadowSignature | undefined;
  /** The far window's caster hole the slice was drawn without, pan-anchored. */
  readonly hole: ShadowCasterHole | undefined;
}

/** Whether a window would draw the same slice: the hole moves with the camera every frame and is checked on its own (`holeServes`). */
function sameWindow(a: RenderedWindow, b: RenderedWindow): boolean {
  if (a.fitGeneration !== b.fitGeneration || a.textureIdentity !== b.textureIdentity) return false;
  if (a.heightScales[0] !== b.heightScales[0] || a.heightScales[1] !== b.heightScales[1]) return false;
  if (!sameTerrain(a.terrain, b.terrain)) return false;
  if (a.casterKeys.size !== b.casterKeys.size) return false;
  for (const key of a.casterKeys) if (!b.casterKeys.has(key)) return false;
  return true;
}

function sameTerrain(ta: GroundReliefShadowSignature | undefined, tb: GroundReliefShadowSignature | undefined): boolean {
  if (ta === undefined || tb === undefined) return ta === tb;
  return ta.version === tb.version && ta.strength === tb.strength && ta.worldUnitsPerMetre === tb.worldUnitsPerMetre && ta.datumMetres === tb.datumMetres;
}

/** A stable number per object, the Swift `ObjectIdentifier`. */
const identities = new WeakMap<object, number>();
let nextIdentity = 1;

function objectIdentity(object: object): number {
  let id = identities.get(object);
  if (id === undefined) {
    id = nextIdentity++;
    identities.set(object, id);
  }
  return id;
}
