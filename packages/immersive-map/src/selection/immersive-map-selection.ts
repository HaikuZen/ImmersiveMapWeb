// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The selection's public values and handle, a port of the Swift
 * `ImmersiveMapSelectionController.swift`: what the map has selected, the
 * events that report a change, and the controller an app attaches to change
 * it from code.
 */

/**
 * The feature a selected object belongs to. An open set of strings: each
 * selectable feature declares its own (`ImmersiveMapSelectionKind.pin`,
 * `ImmersiveMapSelectionKind.layer("zones")`), so a `switch` over a kind
 * needs a `default`.
 */
export type ImmersiveMapSelectionKind = string;

const layerPrefix = "layer:";

/** The kinds the engine's features declare, and the arithmetic of a layer's kind. */
export const ImmersiveMapSelectionKind = Object.freeze({
  /** A pin, named by `ImmersiveMapPin.id`. */
  pin: "pin" as ImmersiveMapSelectionKind,
  /** A scene model, named by its id (the models arrive with stage 7). */
  sceneModel: "sceneModel" as ImmersiveMapSelectionKind,
  /** The layers as a whole: the kind their pick data goes by. */
  layers: "layer" as ImmersiveMapSelectionKind,

  /**
   * A shape of the layer with `id` (`ImmersiveMapLayer.id`), named by the
   * shape's id within the layer's source:
   *
   * ```ts
   * selection.select({ kind: ImmersiveMapSelectionKind.layer("zones"), objectID: 42 });
   * ```
   */
  layer(id: string): ImmersiveMapSelectionKind {
    return layerPrefix + id;
  },

  /** The id of the layer a selection of this kind names a shape of, null for the kind of another feature. */
  layerID(kind: ImmersiveMapSelectionKind): string | null {
    return kind.startsWith(layerPrefix) ? kind.slice(layerPrefix.length) : null;
  },
});

/** An object of the map the app or a tap selected: the feature it belongs to and its id within that feature. */
export interface ImmersiveMapSelection {
  readonly kind: ImmersiveMapSelectionKind;
  /** The object's id within its feature, such as `ImmersiveMapPin.id`. */
  readonly objectID: number;
}

export function selectionsEqual(a: ImmersiveMapSelection | null, b: ImmersiveMapSelection | null): boolean {
  if (a === null || b === null) return a === b;
  return a.kind === b.kind && a.objectID === b.objectID;
}

/** What changed the selection: a tap, the app's code, or the map itself (the selected object went away). */
export type ImmersiveMapSelectionSource = "tap" | "programmatic" | "system";

/** A point of the map's element in CSS pixels, origin top left. */
export interface ImmersiveMapScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface ImmersiveMapSelectionChangeEvent {
  readonly selection: ImmersiveMapSelection;
  readonly source: ImmersiveMapSelectionSource;
  /** Where the tap landed, null for a selection from code. */
  readonly screenPoint: ImmersiveMapScreenPoint | null;
}

export interface ImmersiveMapSelectionClearEvent {
  readonly previousSelection: ImmersiveMapSelection;
  readonly source: ImmersiveMapSelectionSource;
  readonly screenPoint: ImmersiveMapScreenPoint | null;
}

/** A command of the selection controller, as the map's selection handler receives it. */
export type ImmersiveMapSelectionCommand = { readonly kind: "select"; readonly selection: ImmersiveMapSelection } | { readonly kind: "clear" };

/**
 * The command and callback surface for the map's selection. Attach one with
 * `ImmersiveMap.selection = controller`: a tap then selects a pin or a shape
 * of a layer, and a tap on the empty map clears the selection.
 *
 * ```ts
 * const selection = new ImmersiveMapSelectionController();
 * selection.onSelectionChanged = (event) => console.log(event.selection);
 * map.selection = selection;
 * selection.select({ kind: ImmersiveMapSelectionKind.pin, objectID: 1 });
 * ```
 *
 * Everything runs on the main thread.
 */
export class ImmersiveMapSelectionController {
  private selected: ImmersiveMapSelection | null = null;
  private commandHandler: ((command: ImmersiveMapSelectionCommand) => boolean) | null = null;
  /** Owner of the current binding (the selection handler of one map). */
  private handlerOwner: object | null = null;

  onSelectionChanged: ((event: ImmersiveMapSelectionChangeEvent) => void) | null = null;
  onSelectionCleared: ((event: ImmersiveMapSelectionClearEvent) => void) | null = null;
  /** A tap on the map away from everything selectable, in CSS pixels of the map's element. */
  onMapBackgroundTap: ((point: ImmersiveMapScreenPoint) => void) | null = null;

  currentSelection(): ImmersiveMapSelection | null {
    return this.selected;
  }

  /** Selects the object. False when no map is attached or the map holds no such object. */
  select(selection: ImmersiveMapSelection): boolean {
    return this.commandHandler?.({ kind: "select", selection: { kind: selection.kind, objectID: selection.objectID } }) ?? false;
  }

  /** Clears the selection. False when nothing was selected or no map is attached. */
  clearSelection(): boolean {
    return this.commandHandler?.({ kind: "clear" }) ?? false;
  }

  /** @internal The map's selection handler binds itself. */
  attachHandler(owner: object, handler: (command: ImmersiveMapSelectionCommand) => boolean): void {
    this.handlerOwner = owner;
    this.commandHandler = handler;
  }

  /**
   * @internal Detaches strictly by owner: tearing down an old map must not
   * erase the binding a new map installed.
   */
  detachHandler(owner: object): void {
    if (this.handlerOwner !== owner) return;
    this.handlerOwner = null;
    this.commandHandler = null;
    this.selected = null;
  }

  /** @internal */
  updateCurrentSelection(selection: ImmersiveMapSelection | null): void {
    this.selected = selection;
  }

  /** @internal */
  notifySelectionChanged(event: ImmersiveMapSelectionChangeEvent): void {
    this.selected = event.selection;
    this.onSelectionChanged?.(event);
  }

  /** @internal */
  notifySelectionCleared(event: ImmersiveMapSelectionClearEvent): void {
    this.selected = null;
    this.onSelectionCleared?.(event);
  }

  /** @internal */
  notifyMapBackgroundTap(point: ImmersiveMapScreenPoint): void {
    this.onMapBackgroundTap?.(point);
  }
}
