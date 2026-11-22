// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

import { deepFreeze, mergeOptions } from "./deep.ts";
import type { Options } from "./deep.ts";

/**
 * The language the map's names are shown in, by its code (`"en"`, `"pl"`,
 * `"pt-BR"`), normalized: trimmed, `_` written `-`, in lower case, and
 * English when empty. The tiles' names are looked up by the code's
 * language part (`pt` of `pt-br`).
 *
 * The built-in font has Latin and Cyrillic letters only: a name in another
 * alphabet (Japanese, Chinese, Arabic, Greek and the rest) cannot be drawn,
 * so the label falls back as `LabelFallbackPolicy` says, to the English
 * name on an international map.
 */
export interface LabelLanguage {
  readonly code: string;
}

function labelLanguage(code: string): LabelLanguage {
  const normalized = code.trim().replaceAll("_", "-").toLowerCase();
  return Object.freeze({ code: normalized.length === 0 ? "en" : normalized });
}

/** The languages, the normalizing factory and the two readings of a code. */
export const LabelLanguage = Object.freeze({
  make: labelLanguage,

  /** The language part of the code (`pt` of `pt-br`), the suffix of the tiles' name fields. */
  nameFieldSuffix(language: LabelLanguage): string {
    const first = language.code.split("-")[0];
    return first === undefined || first.length === 0 ? "en" : first;
  },

  /**
   * The code as a part of a cache namespace: `-`, digits and lower-case
   * Latin letters kept, every other character `_`, so no code can name a
   * path.
   */
  preparedTileCacheNamespaceKey(language: LabelLanguage): string {
    let key = "";
    for (const character of language.code) {
      const scalar = character.codePointAt(0) ?? 0;
      const kept = scalar === 45 || (scalar >= 48 && scalar <= 57) || (scalar >= 97 && scalar <= 122);
      key += kept ? character : "_";
    }
    return key;
  },

  english: labelLanguage("en"),
  russian: labelLanguage("ru"),
  french: labelLanguage("fr"),
  german: labelLanguage("de"),
  spanish: labelLanguage("es"),
  italian: labelLanguage("it"),
  portuguese: labelLanguage("pt"),
  turkish: labelLanguage("tr"),
});

/**
 * What a label shows when the feature has no name in the map's language.
 *
 * - `international`: the English name, then the local name. When the map's
 *   language is written in Latin letters, a local name in Cyrillic, Greek,
 *   Armenian or Georgian is romanized to plain ASCII first, so the map shows
 *   one alphabet ("Georgiyevskiy Lane" for "Георгиевский переулок" on an
 *   English map). A local name in another script is shown as it is. When the
 *   map's language is written in Cyrillic, Greek, Armenian or Georgian, a
 *   local name in that alphabet comes before the English one ("Охотный Ряд",
 *   not "Okhotny Ryad", on a Russian map).
 * - `localFirst`: the local name as the place spells it, then the English
 *   name.
 */
export type LabelFallbackPolicy = "international" | "localFirst";

/** The deepest camera zooms the settlements' names show at. */
export interface SettlementVisibilitySettings {
  readonly capitalMaximumZoom: number;
  readonly cityMaximumZoom: number;
  readonly smallSettlementMaximumZoom: number;
}

export const defaultSettlementVisibilitySettings: SettlementVisibilitySettings = Object.freeze({
  capitalMaximumZoom: 12,
  cityMaximumZoom: 12,
  smallSettlementMaximumZoom: 12,
});

export interface LandmarkSettings {
  /** The camera zoom the landmarks' names show from. 15 by default. */
  readonly minimumZoom: number;
}

export const defaultLandmarkSettings: LandmarkSettings = Object.freeze({ minimumZoom: 15 });

export interface LabelBaseSettings {
  /**
   * Collision grid cell in layout points. In points rather than device
   * pixels so that label density per unit of perceived screen area is the
   * same on every display: in pixels, a 3x phone would pack 2.25 times as
   * many labels into a physically smaller screen. 16 by default.
   */
  readonly gridCellSizePoints: number;
  /** How long a label takes to fade in, in seconds. 0.15 by default. */
  readonly fadeInSeconds: number;
  /** How long a label takes to fade out, in seconds. 0.25 by default. */
  readonly fadeOutSeconds: number;
  /**
   * The least clear space between two point labels, in layout points: a
   * label is kept only where its box, grown by half of this on every side,
   * meets no other. At zero the labels pack edge to edge and a busy street
   * reads as one block of text. 10 by default.
   */
  readonly collisionSpacingPoints: number;
  /**
   * How small a point label gets with distance on a tilted map, as a
   * fraction of its size. A label keeps its size at the point the camera
   * looks at and nearer, and shrinks with its distance beyond it (twice as
   * far, half as big) down to this, so the labels toward the horizon recede
   * with the map instead of lying over it like stickers. The collisions
   * measure the shrunk labels. 1 keeps every label at its size. Read once,
   * when the map is created, like the fades. The debug panel can move it
   * while the map runs. 0.75 by default.
   */
  readonly perspectiveMinimumScale: number;
  /**
   * How near the camera, in metres, the local detail shows: the labels the
   * style marks local (the house numbers, the plaques, the offices), which
   * also keep to the three by three tiles around the one the camera looks
   * at. Measured from the camera to the label's anchor, so on a tilted map
   * the detail at the foot of the frame shows and the detail up the street
   * does not, whatever the zoom. On the flat map. On the globe the tiles
   * alone decide. The debug panel can move it while the map runs. 400 by
   * default.
   */
  readonly localDetailMaximumDistanceMeters: number;
}

export const defaultLabelBaseSettings: LabelBaseSettings = Object.freeze({
  gridCellSizePoints: 16,
  fadeInSeconds: 0.15,
  fadeOutSeconds: 0.25,
  collisionSpacingPoints: 10,
  perspectiveMinimumScale: 0.75,
  localDetailMaximumDistanceMeters: 400,
});

export interface LabelRoadSettings {
  /** Collision grid cell in layout points, as for `LabelBaseSettings`. 16 by default. */
  readonly gridCellSizePoints: number;
  /** The sharpest turn a road name's letters take from one to the next, in radians. A sixth of a half turn by default. */
  readonly maxGlyphTurnRadians: number;
  /**
   * The camera zoom from which the extruded buildings and the scene models
   * paint over the road names behind them, pixel by pixel, like any other
   * thing behind a wall. Each letter stands where it touches its road: a
   * wall behind the road leaves it whole, one in front of it cuts it. The
   * names keep their place in the collisions and their fades. On the flat
   * map only, and the frames that do it keep the world's depth for the
   * label pass, one more full-screen depth texture. `Infinity` never paints
   * over a road name (JSON writes it `null`). Read once, when the map is
   * created, like the fades. 16 by default.
   */
  readonly hidesBehindBuildingsFromZoom: number;
}

export const defaultLabelRoadSettings: LabelRoadSettings = Object.freeze({
  gridCellSizePoints: 16,
  maxGlyphTurnRadians: Math.PI / 6,
  hidesBehindBuildingsFromZoom: 16,
});

export interface LabelSettings {
  /**
   * Whether the map has labels at all: place names, points of interest and
   * road names alike. Off, the parser bakes no text into the prepared tiles
   * (no name resolution, no shaping, no glyph runs on the GPU), and with
   * nothing to place the label layer and the per-frame placement and
   * collision work behind it are skipped. Baked at parse time: toggling
   * re-parses the tiles, like any other label setting. On by default.
   */
  readonly isEnabled: boolean;
  /** English by default. */
  readonly language: LabelLanguage;
  /** International by default. */
  readonly fallbackPolicy: LabelFallbackPolicy;
  readonly settlementVisibility: SettlementVisibilitySettings;
  readonly landmarks: LandmarkSettings;
  readonly base: LabelBaseSettings;
  readonly road: LabelRoadSettings;
}

export const defaultLabelSettings: LabelSettings = deepFreeze({
  isEnabled: true,
  language: LabelLanguage.english,
  fallbackPolicy: "international",
  settlementVisibility: defaultSettlementVisibilitySettings,
  landmarks: defaultLandmarkSettings,
  base: defaultLabelBaseSettings,
  road: defaultLabelRoadSettings,
});

export function labelSettings(options: Options<LabelSettings> = {}): LabelSettings {
  return deepFreeze(mergeOptions(defaultLabelSettings, options));
}
