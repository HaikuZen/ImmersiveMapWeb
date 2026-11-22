// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import type { Rgba } from "../configuration/color.ts";
import type { GeoCoordinate } from "../geo/geo-coordinate.ts";
import { type ImmersiveMapPin, type PinImage, PinImageSource, pinCountBadge } from "./immersive-map-pin.ts";
import { PinImageLoader } from "./pin-image-loader.ts";

/** What the renderer takes of the controller after a change: every pin on the map, and the ids that left it or got a new picture. */
export interface PinsSnapshot {
  readonly pins: readonly ImmersiveMapPin[];
  readonly removedIds: readonly number[];
  readonly imageUpdateIds: readonly number[];
  readonly version: number;
}

/** A group of merged pins: the members leave the map and one merged pin stands for them. */
interface MergedPinGroup {
  memberIDs: number[];
  /** The merged pin's look (selection, outline); its coordinate and picture come from the members. */
  template: ImmersiveMapPin;
  /** Seconds between two pictures of the cycle, 0 for none. */
  imageCycleInterval: number;
  imageCycleIndex: number;
}

/** Loads the picture at a URL. */
export type PinImageLoaderFunction = (url: string) => Promise<PinImage>;

/**
 * The app's pins, a port of the Swift `ImmersiveMapPinsController`: keep
 * one, attach it to a map (`ImmersiveMapOptions.pins`, or the map's own
 * `ImmersiveMap.pins`), and change the pins through it. It collects the
 * changes into snapshots the renderer takes once a frame.
 *
 * ```ts
 * map.pins.set([ImmersiveMapPin.remote(1, 55.75, 37.62, photoURL)]);
 * map.pins.move(1, { latitude: 55.76, longitude: 37.6 });
 * map.pins.merge([1, 2, 3], 100);
 * ```
 *
 * Everything runs on the main thread, so the Swift controller's lock has no
 * counterpart here.
 */
export class ImmersiveMapPinsController {
  private readonly pinsById = new Map<number, ImmersiveMapPin>();
  private readonly mergedGroupsById = new Map<number, MergedPinGroup>();
  private readonly imageCycleTimersById = new Map<number, ReturnType<typeof setInterval>>();
  private readonly removedIds = new Set<number>();
  private readonly imageUpdateIds = new Set<number>();
  private readonly loadingRemoteImageURLsById = new Map<number, string>();
  private version = 0;
  private hasChanges = false;
  private changeHandler: (() => void) | null = null;
  private changeHandlerOwner: object | null = null;

  /** `imageLoader` loads a remote picture, a fetch and a decode by default. */
  constructor(private readonly imageLoader: PinImageLoaderFunction = (url) => PinImageLoader.load(url)) {}

  add(pins: ImmersiveMapPin | readonly ImmersiveMapPin[]): void {
    this.upsert(Array.isArray(pins) ? pins : [pins as ImmersiveMapPin]);
  }

  /** Replaces every pin of the map. Every merged group is dissolved. */
  set(pins: readonly ImmersiveMapPin[]): void {
    this.dissolveAllMergedGroups();
    this.pinsById.clear();
    for (const pin of pins) this.pinsById.set(pin.id, pin);
    this.removedIds.clear();
    this.imageUpdateIds.clear();
    for (const id of this.pinsById.keys()) this.imageUpdateIds.add(id);
    const requests = this.remoteImageLoadRequests(pins);
    this.markChanged();
    this.scheduleRemoteImageLoads(requests);
    this.notifyChanged();
  }

  /** Puts each pin in the place of the one with its id, or adds it. A pin whose id is a merged pin's is ignored. */
  upsert(pins: readonly ImmersiveMapPin[]): void {
    for (const pin of pins) {
      if (this.mergedGroupsById.has(pin.id)) {
        console.warn(`ImmersiveMap: pin id ${pin.id} collides with a merged pin id and is ignored.`);
        continue;
      }
      this.pinsById.set(pin.id, pin);
      this.removedIds.delete(pin.id);
      this.imageUpdateIds.add(pin.id);
    }
    const requests = this.remoteImageLoadRequests(pins);
    this.markChanged();
    this.scheduleRemoteImageLoads(requests);
    this.notifyChanged();
  }

  /**
   * Merges existing pins into one merged pin `mergedID`: the members leave
   * the map, and one pin stands for them at their averaged coordinate (a
   * member's `move` moves the average), with a counter of the members and a
   * picture that cycles through the members' every `imageCycleInterval`
   * seconds (0 for none).
   *
   * The members stay in the controller: they can be moved and updated, and
   * `unmerge` returns them to the map. Merging again with the same
   * `mergedID` replaces the group's members. `mergedID` must not be a
   * regular pin's id. A pin already in another group is left out.
   */
  merge(ids: readonly number[], mergedID: number, imageCycleInterval = 3): void {
    if (this.pinsById.has(mergedID)) throw new RangeError(`ImmersiveMap: mergedID ${mergedID} collides with an existing pin id.`);
    const inOtherGroups = new Set<number>();
    for (const [groupID, group] of this.mergedGroupsById) {
      if (groupID !== mergedID) for (const id of group.memberIDs) inOtherGroups.add(id);
    }
    const memberIDs: number[] = [];
    for (const id of ids) {
      if (this.pinsById.has(id) && !inOtherGroups.has(id) && !memberIDs.includes(id)) memberIDs.push(id);
    }
    const first = memberIDs.length > 0 ? this.pinsById.get(memberIDs[0]!) : undefined;
    if (first === undefined) return;
    const template: ImmersiveMapPin = this.mergedGroupsById.get(mergedID)?.template ?? {
      id: mergedID,
      coordinate: first.coordinate,
      imageSource: first.image === null ? first.imageSource : PinImageSource.image(first.image),
      image: first.image,
      countBadge: null,
      borderColor: first.borderColor,
      screenSizeScale: first.screenSizeScale,
      isSelected: false,
      drawPriority: first.drawPriority,
      clusterPolicy: "none",
    };
    this.mergedGroupsById.set(mergedID, { memberIDs, template, imageCycleInterval, imageCycleIndex: 0 });
    // The members leave the map as pins of their own.
    for (const id of memberIDs) this.removedIds.add(id);
    this.removedIds.delete(mergedID);
    this.imageUpdateIds.add(mergedID);
    this.rescheduleImageCycleTimer(mergedID);
    this.markChanged();
    this.notifyChanged();
  }

  /** Dissolves a merged pin: the members come back to the map at their coordinates. */
  unmerge(mergedID: number): void {
    const group = this.mergedGroupsById.get(mergedID);
    if (group === undefined) return;
    this.mergedGroupsById.delete(mergedID);
    this.cancelImageCycleTimer(mergedID);
    this.removedIds.add(mergedID);
    for (const id of group.memberIDs) if (this.pinsById.has(id)) this.imageUpdateIds.add(id);
    this.markChanged();
    this.notifyChanged();
  }

  /** The members of a merged pin in the order of its picture cycle, null when there is no such group. */
  mergedMemberIDs(mergedID: number): readonly number[] | null {
    const group = this.mergedGroupsById.get(mergedID);
    return group === undefined ? null : [...group.memberIDs];
  }

  /** Moves a pin. The map animates it from where it is shown to the new place. */
  move(id: number, coordinate: GeoCoordinate): void {
    const pin = this.pinsById.get(id);
    if (pin === undefined) return;
    this.pinsById.set(id, { ...pin, coordinate: { latitude: coordinate.latitude, longitude: coordinate.longitude } });
    this.markChanged();
    this.notifyChanged();
  }

  /** The pin with `id` as the map shows it (a merged one included), null when there is none. */
  pin(id: number): ImmersiveMapPin | null {
    if (this.mergedGroupsById.has(id)) return this.makeMergedPin(id);
    return this.pinsById.get(id) ?? null;
  }

  /**
   * Changes a pin's picture, outline color or selection. The values left out
   * stay. For a merged pin the picture is ignored: the cycle of its members'
   * owns it.
   */
  update(id: number, values: { readonly image?: PinImage; readonly borderColor?: Rgba; readonly isSelected?: boolean }): void {
    const group = this.mergedGroupsById.get(id);
    if (group !== undefined) {
      group.template = {
        ...group.template,
        ...(values.borderColor !== undefined ? { borderColor: values.borderColor } : {}),
        ...(values.isSelected !== undefined ? { isSelected: values.isSelected } : {}),
      };
      this.markChanged();
      this.notifyChanged();
      return;
    }
    const pin = this.pinsById.get(id);
    if (pin === undefined) return;
    let next: ImmersiveMapPin = pin;
    if (values.image !== undefined) {
      next = { ...next, image: values.image, imageSource: PinImageSource.image(values.image) };
      this.imageUpdateIds.add(id);
      this.loadingRemoteImageURLsById.delete(id);
    }
    if (values.borderColor !== undefined) next = { ...next, borderColor: values.borderColor };
    if (values.isSelected !== undefined) next = { ...next, isSelected: values.isSelected };
    this.pinsById.set(id, next);
    this.markChanged();
    this.notifyChanged();
  }

  /**
   * Removes pins. A merged pin's id removes the group with its members, and
   * a member's id takes it out of its group (a group left empty is
   * dissolved).
   */
  remove(ids: number | readonly number[]): void {
    for (const id of typeof ids === "number" ? [ids] : ids) {
      const group = this.mergedGroupsById.get(id);
      if (group !== undefined) {
        this.mergedGroupsById.delete(id);
        this.cancelImageCycleTimer(id);
        for (const memberID of group.memberIDs) this.forget(memberID);
      }
      this.forget(id);
      this.removeMemberFromGroups(id);
    }
    this.markChanged();
    this.notifyChanged();
  }

  clear(): void {
    for (const id of this.pinsById.keys()) this.removedIds.add(id);
    for (const id of this.mergedGroupsById.keys()) this.removedIds.add(id);
    this.dissolveAllMergedGroups();
    this.pinsById.clear();
    this.imageUpdateIds.clear();
    this.loadingRemoteImageURLsById.clear();
    this.markChanged();
    this.notifyChanged();
  }

  /** @internal The changes since the last snapshot, null when there are none. */
  consumeSnapshot(): PinsSnapshot | null {
    if (!this.hasChanges) return null;
    this.hasChanges = false;
    const snapshot: PinsSnapshot = { pins: this.visiblePins(), removedIds: [...this.removedIds], imageUpdateIds: [...this.imageUpdateIds], version: this.version };
    this.removedIds.clear();
    this.imageUpdateIds.clear();
    return snapshot;
  }

  /** @internal One step of a merged pin's picture cycle (the group's timer). */
  advanceMergedImageCycle(mergedID: number): void {
    const group = this.mergedGroupsById.get(mergedID);
    if (group === undefined || group.memberIDs.length <= 1) return;
    group.imageCycleIndex += 1;
    this.imageUpdateIds.add(mergedID);
    this.markChanged();
    this.notifyChanged();
  }

  /** @internal The map attaching the controller: one map at a time. */
  setChangeHandler(handler: (() => void) | null, owner: object): void {
    this.changeHandler = handler;
    this.changeHandlerOwner = owner;
  }

  /** @internal Clears the handler only if `owner` still owns it: a map torn down must not detach a newer one. */
  clearChangeHandler(owner: object): void {
    if (this.changeHandlerOwner !== owner) return;
    this.changeHandler = null;
    this.changeHandlerOwner = null;
  }

  /** @internal Every pin goes into the next snapshot (a newly attached map). */
  markSnapshotDirty(): void {
    for (const id of this.pinsById.keys()) this.imageUpdateIds.add(id);
    this.markChanged();
  }

  /**
   * @internal A copy for an offline export: the current pins and groups with
   * a full snapshot pending, no change handler and no picture cycle, so the
   * export is deterministic and the live map's snapshots stay its own.
   */
  makeDetachedCopyForExport(): ImmersiveMapPinsController {
    const copy = new ImmersiveMapPinsController(this.imageLoader);
    for (const [id, pin] of this.pinsById) copy.pinsById.set(id, pin);
    for (const [id, group] of this.mergedGroupsById) copy.mergedGroupsById.set(id, { ...group, memberIDs: [...group.memberIDs] });
    copy.version = this.version;
    for (const id of this.pinsById.keys()) copy.imageUpdateIds.add(id);
    for (const id of this.mergedGroupsById.keys()) copy.imageUpdateIds.add(id);
    copy.hasChanges = true;
    return copy;
  }

  /** Stops the picture cycles' timers. A controller no map uses any more can be dropped without it. */
  dispose(): void {
    for (const id of [...this.imageCycleTimersById.keys()]) this.cancelImageCycleTimer(id);
  }

  /**
   * The average of coordinates over unit vectors on the sphere: right near
   * the antimeridian and the poles, where a mean of the degrees is not.
   */
  static averageCoordinate(coordinates: readonly GeoCoordinate[]): GeoCoordinate {
    if (coordinates.length <= 1) return coordinates[0] ?? { latitude: 0, longitude: 0 };
    let x = 0;
    let y = 0;
    let z = 0;
    for (const coordinate of coordinates) {
      const latitude = (coordinate.latitude * Math.PI) / 180;
      const longitude = (coordinate.longitude * Math.PI) / 180;
      const cosLatitude = Math.cos(latitude);
      x += cosLatitude * Math.cos(longitude);
      y += cosLatitude * Math.sin(longitude);
      z += Math.sin(latitude);
    }
    const length = Math.hypot(x, y, z);
    if (!(length > Number.MIN_VALUE)) return coordinates[0]!;
    x /= length;
    y /= length;
    z /= length;
    return { latitude: (Math.atan2(z, Math.sqrt(x * x + y * y)) * 180) / Math.PI, longitude: (Math.atan2(y, x) * 180) / Math.PI };
  }

  private forget(id: number): void {
    this.pinsById.delete(id);
    this.removedIds.add(id);
    this.imageUpdateIds.delete(id);
    this.loadingRemoteImageURLsById.delete(id);
  }

  private removeMemberFromGroups(memberID: number): void {
    for (const [mergedID, group] of [...this.mergedGroupsById]) {
      if (!group.memberIDs.includes(memberID)) continue;
      group.memberIDs = group.memberIDs.filter((id) => id !== memberID);
      if (group.memberIDs.length === 0) {
        this.mergedGroupsById.delete(mergedID);
        this.cancelImageCycleTimer(mergedID);
        this.removedIds.add(mergedID);
      } else {
        this.rescheduleImageCycleTimer(mergedID);
      }
    }
  }

  private dissolveAllMergedGroups(): void {
    for (const id of this.mergedGroupsById.keys()) this.cancelImageCycleTimer(id);
    this.mergedGroupsById.clear();
  }

  /** The pins on the map: the regular ones but the groups' members, then the merged ones. */
  private visiblePins(): ImmersiveMapPin[] {
    const members = new Set<number>();
    for (const group of this.mergedGroupsById.values()) for (const id of group.memberIDs) members.add(id);
    const pins: ImmersiveMapPin[] = [];
    for (const pin of this.pinsById.values()) if (!members.has(pin.id)) pins.push(pin);
    for (const mergedID of this.mergedGroupsById.keys()) {
      const merged = this.makeMergedPin(mergedID);
      if (merged !== null) pins.push(merged);
    }
    return pins;
  }

  /** A group's merged pin: the members' averaged coordinate, the picture of the cycle's step and a counter, the look of the template. */
  private makeMergedPin(mergedID: number): ImmersiveMapPin | null {
    const group = this.mergedGroupsById.get(mergedID);
    if (group === undefined) return null;
    const members: ImmersiveMapPin[] = [];
    for (const id of group.memberIDs) {
      const member = this.pinsById.get(id);
      if (member !== undefined) members.push(member);
    }
    if (members.length === 0) return null;
    const cycleMember = members[group.imageCycleIndex % members.length]!;
    return {
      ...group.template,
      coordinate: ImmersiveMapPinsController.averageCoordinate(members.map((member) => member.coordinate)),
      image: cycleMember.image,
      imageSource: cycleMember.image === null ? cycleMember.imageSource : PinImageSource.image(cycleMember.image),
      countBadge: pinCountBadge(members.length),
    };
  }

  private rescheduleImageCycleTimer(mergedID: number): void {
    this.cancelImageCycleTimer(mergedID);
    const group = this.mergedGroupsById.get(mergedID);
    if (group === undefined || !(group.imageCycleInterval > 0) || group.memberIDs.length <= 1) return;
    this.imageCycleTimersById.set(
      mergedID,
      setInterval(() => this.advanceMergedImageCycle(mergedID), group.imageCycleInterval * 1000),
    );
  }

  private cancelImageCycleTimer(mergedID: number): void {
    const timer = this.imageCycleTimersById.get(mergedID);
    if (timer === undefined) return;
    clearInterval(timer);
    this.imageCycleTimersById.delete(mergedID);
  }

  private markChanged(): void {
    this.version += 1;
    this.hasChanges = true;
  }

  private remoteImageLoadRequests(pins: readonly ImmersiveMapPin[]): { id: number; url: string }[] {
    const requests: { id: number; url: string }[] = [];
    for (const pin of pins) {
      const url = PinImageSource.remoteURL(pin.imageSource);
      if (url === null) {
        this.loadingRemoteImageURLsById.delete(pin.id);
        continue;
      }
      if (this.loadingRemoteImageURLsById.get(pin.id) === url) continue;
      this.loadingRemoteImageURLsById.set(pin.id, url);
      requests.push({ id: pin.id, url });
    }
    return requests;
  }

  private scheduleRemoteImageLoads(requests: readonly { id: number; url: string }[]): void {
    for (const request of requests) {
      this.imageLoader(request.url).then(
        (image) => this.applyRemoteImage(image, request.id, request.url),
        () => this.finishRemoteImageLoad(request.id, request.url),
      );
    }
  }

  private applyRemoteImage(image: PinImage, pinID: number, url: string): void {
    const pin = this.pinsById.get(pinID);
    let changed = false;
    if (pin !== undefined && PinImageSource.remoteURL(pin.imageSource) === url) {
      this.pinsById.set(pinID, { ...pin, image });
      this.imageUpdateIds.add(pinID);
      this.markChanged();
      changed = true;
    }
    this.finishRemoteImageLoad(pinID, url);
    if (changed) this.notifyChanged();
  }

  private finishRemoteImageLoad(pinID: number, url: string): void {
    if (this.loadingRemoteImageURLsById.get(pinID) === url) this.loadingRemoteImageURLsById.delete(pinID);
  }

  private notifyChanged(): void {
    this.changeHandler?.();
  }
}
