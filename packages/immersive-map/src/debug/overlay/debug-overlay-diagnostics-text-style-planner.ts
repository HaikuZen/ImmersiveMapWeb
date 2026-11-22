// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/** How a run of the diagnostics text is set: a section title, a key, or a value to warn about. */
export type DebugOverlayDiagnosticsTextStyle = { readonly kind: "section"; readonly title: string } | { readonly kind: "key" } | { readonly kind: "warningValue" };

/** A styled run, its range in UTF-16 code units of the whole text (the Swift `NSRange`). */
export interface DebugOverlayDiagnosticsTextStyleRun {
  readonly location: number;
  readonly length: number;
  readonly style: DebugOverlayDiagnosticsTextStyle;
}

const keyExpression = /(^| )([A-Za-z][A-Za-z0-9]*:)/g;

/**
 * The styling of the diagnostics text (the Swift
 * `DebugOverlayDiagnosticsTextStylePlanner`): the `[Title]` lines as
 * sections, every `key:` as a key, and the Skip section's body, other than
 * `none`, as a warning.
 */
export const DebugOverlayDiagnosticsTextStylePlanner = {
  makeRuns(text: string): DebugOverlayDiagnosticsTextStyleRun[] {
    const runs: DebugOverlayDiagnosticsTextStyleRun[] = [];
    let activeSection: string | undefined;
    let location = 0;
    for (const line of text.split("\n")) {
      const lineLocation = location;
      location += line.length + 1;
      if (line.length === 0) {
        activeSection = undefined;
        continue;
      }
      const section = sectionTitle(line);
      if (section !== undefined) {
        activeSection = section;
        runs.push({ location: lineLocation, length: line.length, style: { kind: "section", title: section } });
        continue;
      }
      if (activeSection === "Skip" && line !== "none") {
        runs.push({ location: lineLocation, length: line.length, style: { kind: "warningValue" } });
      }
      for (const match of line.matchAll(keyExpression)) {
        const key = match[2]!;
        runs.push({ location: lineLocation + match.index + match[1]!.length, length: key.length, style: { kind: "key" } });
      }
    }
    return runs;
  },
} as const;

function sectionTitle(line: string): string | undefined {
  if (!line.startsWith("[") || !line.endsWith("]") || line.length <= 2) return undefined;
  return line.slice(1, -1);
}
