// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

// The examples of docs/guide/Attribution.md.

import { ImmersiveMap, ImmersiveMapAttribution, ImmersiveMapSettings } from "@immersive-map/web";

/** The credit of the app's own tiles, in place of "© OpenStreetMap". */
export async function ownCredit(container: HTMLElement): Promise<ImmersiveMap> {
  const map = await ImmersiveMap.create({
    container,
    settings: ImmersiveMapSettings.default
      .tileArchive("https://tiles.mycity.example/city.pmtiles")
      .attributionSettings({
        attributionOverride: ImmersiveMapAttribution.single("© My City", "https://mycity.example/license"),
      }),
  });
  return map;
}

/** Credits of data that is on screen at some zooms only. */
export const zonedCredits: ImmersiveMapAttribution = ImmersiveMapAttribution.make([
  ImmersiveMapAttribution.credit("© My City"),
  ImmersiveMapAttribution.credit("Aerial © Survey Office", { lowerBound: 14, upperBound: 22 }),
]);

/** The badge's look. */
export const badgeLook: ImmersiveMapSettings = ImmersiveMapSettings.default.attributionSettings({
  size: "small",
  position: "bottomLeading",
  margin: 8,
  respectsBottomSafeArea: true,
  textColor: [0, 0, 0, 0.8],
  emphasizesLeadingCredit: true,
  showsEngineCredit: false,
});

/** The badge hidden, the credit shown by the app itself. */
export const creditShownByTheApp: ImmersiveMapSettings = ImmersiveMapSettings.default
  .attributionSettings({ isVisible: false })
  .attributionProvidedExternally();

/** The line the badge shows for a settings value, for an app that draws the credit itself. */
export function creditLine(settings: ImmersiveMapSettings, zoom: number): string {
  return ImmersiveMapAttribution.creditsAtZoom(settings.resolvedAttribution, zoom)
    .map((credit) => credit.text)
    .join(" · ");
}
