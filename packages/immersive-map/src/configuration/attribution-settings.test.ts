// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// Ported from `AttributionSettingsTests`.

import { describe, expect, test } from "vitest";
import { ImmersiveMapAttribution } from "./attribution.ts";
import { attributionSettings } from "./attribution-settings.ts";
import { ImmersiveMapSettings } from "./immersive-map-settings.ts";
import { planSettingsApplication } from "./settings-application-planner.ts";
import { ImmersiveMapTerrainSource } from "./terrain-source.ts";
import { ImmersiveMapTilesService } from "./tiles-service.ts";

const settings = ImmersiveMapSettings.default;
const texts = (attribution: ImmersiveMapAttribution, zoom: number | null) =>
  ImmersiveMapAttribution.creditsAtZoom(attribution, zoom).map((credit) => credit.text);

describe("the attribution", () => {
  /** The badge names the data, the overview adds its own credit after it, and the engine's own opens the line. */
  test("the default credits the engine first and OpenStreetMap next", () => {
    const attribution = settings.resolvedAttribution;
    expect(attribution.credits[0]).toEqual(ImmersiveMapAttribution.engineCredit);
    expect(attribution.credits[0]?.zoomRange).toBeNull();
    expect(attribution.credits[1]?.text).toBe("© OpenStreetMap");
    expect(attribution.credits[1]?.zoomRange).toBeNull();
    expect(attribution.linkURL).toBe("https://www.openstreetmap.org/copyright");
    expect(ImmersiveMapTilesService.attribution.credits.length).toBe(1);

    const plain = settings.attributionSettings({ showsEngineCredit: false }).resolvedAttribution;
    expect(plain.credits.some((credit) => credit.text.includes("ImmersiveMap"))).toBe(false);
    expect(plain.credits[0]?.text).toBe("© OpenStreetMap");
  });

  /** The biomes of the overview are credited at the camera zooms they are drawn at, and not past them. */
  test("the overview is credited at the zooms it is drawn at", () => {
    const attribution = settings.resolvedAttribution;
    expect(attribution.credits.length).toBe(3);
    const overview = attribution.credits[2];
    expect(overview?.text).toBe("Biomes © RESOLVE, CC BY 4.0");
    expect(overview?.zoomRange).toEqual({ lowerBound: 0, upperBound: 8 });
    expect(ImmersiveMapAttribution.creditsAtZoom(attribution, 0).length).toBe(3);
    expect(ImmersiveMapAttribution.creditsAtZoom(attribution, 7.9).length).toBe(3);
    expect(texts(attribution, 8)).toEqual(["Powered by ImmersiveMap", "© OpenStreetMap"]);
    expect(texts(attribution, 9.9)).toEqual(["Powered by ImmersiveMap", "© OpenStreetMap"]);
    expect(ImmersiveMapAttribution.creditsAtZoom(attribution, null).length).toBe(3);
  });

  test("the overview credit follows its setting", () => {
    const raised = settings.overviewTiles({ creditMaximumZoom: 10 }).resolvedAttribution;
    expect(raised.credits[2]?.zoomRange).toEqual({ lowerBound: 0, upperBound: 10 });
    expect(texts(raised, 9).some((text) => text.startsWith("Biomes"))).toBe(true);
    const off = settings.overviewTiles({ isEnabled: false }).resolvedAttribution;
    expect(off.credits.map((credit) => credit.text)).toEqual(["Powered by ImmersiveMap", "© OpenStreetMap"]);
  });

  /** Mapterhorn's terrain asks for a credit, shown at the camera zooms the relief stands out of the plane at. */
  test("the terrain is credited at the zooms the relief rises at", () => {
    const attribution = settings.groundRelief({ isEnabled: true }).resolvedAttribution;
    const terrain = attribution.credits[3];
    expect(terrain?.text).toBe("© Mapterhorn");
    expect(terrain?.zoomRange).toEqual({ lowerBound: 10, upperBound: 13.7 });
    expect(texts(attribution, 9.9)).toEqual(["Powered by ImmersiveMap", "© OpenStreetMap"]);
    expect(texts(attribution, 12.2)).toEqual(["Powered by ImmersiveMap", "© OpenStreetMap", "© Mapterhorn"]);
    expect(texts(attribution, 13.7)).toEqual(["Powered by ImmersiveMap", "© OpenStreetMap"]);
  });

  test("the terrain credit follows the relief", () => {
    const reliefOn = settings.groundRelief({ isEnabled: true });
    const mapterhorn = (value: ImmersiveMapSettings) => value.resolvedAttribution.credits.find((credit) => credit.text === "© Mapterhorn");
    expect(mapterhorn(reliefOn.groundRelief({ appearZoom: 8, collapseZoom: 15 }))?.zoomRange).toEqual({ lowerBound: 8, upperBound: 15 });
    expect(mapterhorn(reliefOn.groundRelief({ isEnabled: false }))).toBeUndefined();
    expect(mapterhorn(reliefOn.groundRelief({ appearZoom: 14, collapseZoom: 14 }))).toBeUndefined();
    const elsewhere = reliefOn.terrain(ImmersiveMapTerrainSource.make({ tileURLTemplate: "https://example.com/terrain/{z}/{x}/{y}.png" }));
    expect(mapterhorn(elsewhere)).toBeUndefined();
    const credited = reliefOn.terrain(
      ImmersiveMapTerrainSource.make({ tileURLTemplate: "https://example.com/terrain/{z}/{x}/{y}.png", credit: "© Example Terrain" }),
    );
    expect(credited.resolvedAttribution.credits.at(-1)).toEqual(
      ImmersiveMapAttribution.credit("© Example Terrain", {
        lowerBound: reliefOn.tiles.groundRelief.appearZoom,
        upperBound: reliefOn.tiles.groundRelief.collapseZoom,
      }),
    );
  });

  /** An app pointing the map at its own data owns the credit of that data: the override leads the line. */
  test("the application's override leads the line and the overview follows", () => {
    const override = ImmersiveMapAttribution.make(
      [ImmersiveMapAttribution.credit("Custom source"), ImmersiveMapAttribution.credit("© Custom data")],
      "https://example.com/licence",
    );
    const value = settings.groundRelief({ isEnabled: true }).attributionSettings(attributionSettings({ attributionOverride: override }));
    const resolved = value.resolvedAttribution;
    expect(resolved.linkURL).toBe(override.linkURL);
    expect(resolved.credits.map((credit) => credit.text)).toEqual([
      "Powered by ImmersiveMap",
      "Custom source",
      "© Custom data",
      "Biomes © RESOLVE, CC BY 4.0",
      "© Mapterhorn",
    ]);
    const withoutOverview = value.overviewTiles({ isEnabled: false }).resolvedAttribution;
    expect(withoutOverview.credits.map((credit) => credit.text)).toEqual([
      "Powered by ImmersiveMap",
      "Custom source",
      "© Custom data",
      "© Mapterhorn",
    ]);
  });

  /** An explicit empty override empties the badge: the app took the whole credit over, the overview's with it. */
  test("an empty override resolves to empty", () => {
    const value = settings.attributionSettings(attributionSettings({ attributionOverride: ImmersiveMapAttribution.none }));
    expect(ImmersiveMapAttribution.isEmpty(value.resolvedAttribution)).toBe(true);
    expect(value.resolvedAttribution.credits.length).toBe(0);
  });

  /** A credit with no words is no credit, and a credit's zoom range is a half-open range of camera zoom. */
  test("the credits at a zoom drop the empty and the out of range", () => {
    const attribution = ImmersiveMapAttribution.make([
      ImmersiveMapAttribution.credit("Always"),
      ImmersiveMapAttribution.credit(""),
      ImmersiveMapAttribution.credit("Low", { lowerBound: 0, upperBound: 5 }),
      ImmersiveMapAttribution.credit("High", { lowerBound: 5, upperBound: 20 }),
    ]);
    expect(ImmersiveMapAttribution.isEmpty(ImmersiveMapAttribution.make([ImmersiveMapAttribution.credit(""), ImmersiveMapAttribution.credit("")]))).toBe(true);
    expect(ImmersiveMapAttribution.isEmpty(attribution)).toBe(false);
    expect(texts(attribution, 4.99)).toEqual(["Always", "Low"]);
    expect(texts(attribution, 5)).toEqual(["Always", "High"]);
    expect(texts(attribution, 20)).toEqual(["Always"]);
    expect(texts(attribution, null)).toEqual(["Always", "Low", "High"]);
  });

  test("an override change marks the attribution for a live apply", () => {
    const next = settings.attributionSettings(attributionSettings({ attributionOverride: ImmersiveMapAttribution.single("© Example Data") }));
    expect(planSettingsApplication(settings, next).changedDomains.has("attribution")).toBe(true);
  });

  /** The overview credit's zoom is badge text: applied in place, no re-parse. */
  test("an overview credit zoom change is a live apply alone", () => {
    const plan = planSettingsApplication(settings, settings.overviewTiles({ creditMaximumZoom: 9 }));
    expect(plan.changedDomains).toEqual(new Set(["attribution"]));
    expect(plan.actions).toEqual(new Set(["liveApply"]));
  });

  test("a size and position change is a live apply alone", () => {
    const plan = planSettingsApplication(settings, settings.attributionSettings({ size: "large", position: "topLeading" }));
    expect(plan.changedDomains.has("attribution")).toBe(true);
    expect(plan.actions).toEqual(new Set(["liveApply"]));
  });

  test("the partial builder leaves the omitted fields unchanged", () => {
    const override = ImmersiveMapAttribution.single("Custom");
    const base = settings.attributionSettings(attributionSettings({ isVisible: false, textColor: [1, 0, 0, 1], attributionOverride: override }));
    const updated = base.attributionSettings({ size: "small" });
    expect(updated.attribution.size).toBe("small");
    expect(updated.attribution.isVisible).toBe(false);
    expect(updated.attribution.textColor).toEqual([1, 0, 0, 1]);
    expect(updated.attribution.attributionOverride).toEqual(override);
    expect(updated.attribution.emphasizesLeadingCredit).toBe(false);
    expect(updated.attributionSettings({ emphasizesLeadingCredit: true }).attribution.emphasizesLeadingCredit).toBe(true);
    expect(updated.attributionSettings({ emphasizesLeadingCredit: true }).attribution.size).toBe("small");
  });

  test("attribution provided externally sets only the flag", () => {
    const value = settings.attributionProvidedExternally();
    expect(value.attribution.isProvidedExternally).toBe(true);
    expect(value.attribution.size).toBe(settings.attribution.size);
    expect(value.attribution.isVisible).toBe(true);
  });
});
