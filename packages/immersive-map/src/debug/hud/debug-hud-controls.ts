// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The debug panel's controls as plain DOM: a switch, a slider with its
 * value, a segmented choice, a colour well, a button, a block of text, and
 * the group titles they sit under, the AppKit panel's controls
 * (`DebugOverlayHUDViewMac`) in the browser. Each control is an element and
 * a setter the panel calls with the value the map runs with: a setter never
 * fires the control's change handler, so applying the settings back to the
 * panel does not loop.
 */

import type { Rgb } from "../../configuration/color.ts";

/** The class names of the panel, kept in one place with the panel's stylesheet. */
export const debugHudClass = {
  root: "imm-debug-hud",
  group: "imm-debug-group",
  groupTitle: "imm-debug-group-title",
  row: "imm-debug-row",
  label: "imm-debug-label",
  value: "imm-debug-value",
  text: "imm-debug-text",
  button: "imm-debug-button",
  hint: "imm-debug-hint",
} as const;

/** A control the panel shows and sets back. */
export interface DebugHudControl<Value> {
  readonly element: HTMLElement;
  /** Shows `value` without firing the change handler. */
  set(value: Value): void;
}

function row(labelText: string): { row: HTMLDivElement; label: HTMLSpanElement } {
  const element = document.createElement("div");
  element.className = debugHudClass.row;
  const label = document.createElement("span");
  label.className = debugHudClass.label;
  label.textContent = labelText;
  element.append(label);
  return { row: element, label };
}

/** A group's title over its controls. */
export function debugHudGroup(title: string): { readonly element: HTMLDivElement; readonly body: HTMLDivElement; readonly title: HTMLDivElement } {
  const element = document.createElement("div");
  element.className = debugHudClass.group;
  const heading = document.createElement("div");
  heading.className = debugHudClass.groupTitle;
  heading.textContent = title;
  const body = document.createElement("div");
  element.append(heading, body);
  return { element, body, title: heading };
}

/** A switch with its label. */
export function debugHudSwitch(labelText: string, onChange: (isOn: boolean) => void): DebugHudControl<boolean> {
  const { row: element } = row(labelText);
  const input = document.createElement("input");
  input.type = "checkbox";
  input.addEventListener("change", () => onChange(input.checked));
  element.append(input);
  return {
    element,
    set: (isOn) => {
      input.checked = isOn;
    },
  };
}

/** A slider over `range` with its label and its value's text, which `format` writes. */
export function debugHudSlider(
  labelText: string,
  range: { readonly lowerBound: number; readonly upperBound: number },
  format: (value: number) => string,
  onChange: (value: number) => void,
  step?: number,
): DebugHudControl<number> {
  const { row: element, label } = row(labelText);
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(range.lowerBound);
  input.max = String(range.upperBound);
  input.step = String(step ?? (range.upperBound - range.lowerBound) / 1000);
  const value = document.createElement("span");
  value.className = debugHudClass.value;
  const show = (number: number) => {
    value.textContent = format(number);
  };
  input.addEventListener("input", () => {
    const number = Number(input.value);
    show(number);
    onChange(number);
  });
  label.after(value);
  element.append(input);
  return {
    element,
    set: (number) => {
      input.value = String(number);
      show(number);
    },
  };
}

/** A choice of a few titled values. */
export function debugHudSegments<Value>(labelText: string, options: readonly { readonly title: string; readonly value: Value }[], onChange: (value: Value) => void): DebugHudControl<Value> {
  const { row: element } = row(labelText);
  const select = document.createElement("select");
  options.forEach((option, index) => {
    const item = document.createElement("option");
    item.value = String(index);
    item.textContent = option.title;
    select.append(item);
  });
  select.addEventListener("change", () => {
    const option = options[Number(select.value)];
    if (option !== undefined) onChange(option.value);
  });
  element.append(select);
  return {
    element,
    set: (value) => {
      const index = options.findIndex((option) => Object.is(option.value, value));
      if (index >= 0) select.value = String(index);
    },
  };
}

const hexOf = (component: number) =>
  Math.round(Math.min(Math.max(component, 0), 1) * 255)
    .toString(16)
    .padStart(2, "0");

/** A colour well of an RGB colour in 0 to 1 components. */
export function debugHudColor(labelText: string, onChange: (color: Rgb) => void): DebugHudControl<Rgb> {
  const { row: element } = row(labelText);
  const input = document.createElement("input");
  input.type = "color";
  input.addEventListener("input", () => {
    const hex = input.value;
    onChange([parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255]);
  });
  element.append(input);
  return {
    element,
    set: (color) => {
      input.value = `#${hexOf(color[0])}${hexOf(color[1])}${hexOf(color[2])}`;
    },
  };
}

/** A button. */
export function debugHudButton(title: string, onClick: () => void): { readonly element: HTMLButtonElement; setTitle(title: string): void } {
  const element = document.createElement("button");
  element.type = "button";
  element.className = debugHudClass.button;
  element.textContent = title;
  element.addEventListener("click", onClick);
  return {
    element,
    setTitle: (next) => {
      element.textContent = next;
    },
  };
}

/** A block of monospaced lines. */
export function debugHudText(className: string = debugHudClass.text): DebugHudControl<string> {
  const element = document.createElement("pre");
  element.className = className;
  return {
    element,
    set: (text) => {
      if (element.textContent !== text) element.textContent = text;
    },
  };
}

/** A small grey line under a control. */
export function debugHudHint(text: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = debugHudClass.hint;
  element.textContent = text;
  return element;
}

/** The panel's stylesheet, added once to the document. */
export function installDebugHudStyles(): void {
  if (document.getElementById("imm-debug-hud-styles") !== null) return;
  const style = document.createElement("style");
  style.id = "imm-debug-hud-styles";
  const c = debugHudClass;
  style.textContent = `
.${c.root}{position:absolute;top:0;left:0;bottom:0;width:360px;max-width:100%;display:flex;flex-direction:column;background:rgba(0,0,0,.62);color:#fff;font:12px/1.35 -apple-system,system-ui,sans-serif;z-index:3;pointer-events:auto;box-sizing:border-box}
.${c.root}[hidden],.${c.root} [hidden],.imm-debug-zoom-badge[hidden],.imm-debug-overlay[hidden]{display:none!important}
.${c.root}[data-collapsed="true"]{bottom:auto;width:auto}
.${c.root} .imm-debug-header{display:flex;align-items:center;gap:8px;padding:8px 10px;font-weight:600;font-size:14px}
.${c.root} .imm-debug-header button{margin-left:auto}
.${c.root} .imm-debug-tabs{display:flex;gap:4px;overflow-x:auto;padding:0 10px 8px;flex:none}
.${c.root} .imm-debug-tabs button{flex:none}
.${c.root} .imm-debug-tabs button[aria-selected="true"]{background:rgba(255,255,255,.32)}
.${c.root} .imm-debug-scroll{overflow-y:auto;padding:0 10px 12px;flex:1}
.${c.group}{margin-top:12px}
.${c.groupTitle}{font-weight:600;font-size:12px;color:rgba(255,255,255,.7);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}
.${c.row}{display:flex;align-items:center;gap:8px;min-height:24px}
.${c.row} input[type=range]{flex:1;min-width:90px}
.${c.label}{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.${c.row} input[type=range] + *,.${c.row} .${c.label} + input[type=range]{margin-left:auto}
.${c.value}{font-variant-numeric:tabular-nums;color:rgba(255,255,255,.8);min-width:58px;text-align:right}
.${c.text}{margin:4px 0;font:11px/1.35 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all;color:#fff}
.${c.button}{background:rgba(255,255,255,.16);color:#fff;border:0;border-radius:6px;padding:4px 9px;font:inherit;cursor:pointer}
.${c.button}:hover{background:rgba(255,255,255,.26)}
.${c.hint}{font-size:10px;color:rgba(255,255,255,.55);margin:2px 0 4px}
.imm-debug-curve{display:block;width:100%;height:120px;background:rgba(255,255,255,.06);border-radius:6px;cursor:crosshair;touch-action:none}
.imm-debug-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px;margin-top:6px}
.imm-debug-card{position:relative;height:72px;border-radius:8px;background:rgba(0,0,0,.32);overflow:hidden;padding:7px 12px 0 16px;box-sizing:border-box;font:11px/1.45 ui-monospace,Menlo,monospace}
.imm-debug-card .imm-debug-card-stripe{position:absolute;left:0;top:0;bottom:0;width:4px}
.imm-debug-card .imm-debug-card-title{display:flex;justify-content:space-between;gap:8px;font-size:13px;font-weight:600}
.imm-debug-card .imm-debug-card-detail{color:rgba(255,255,255,.75);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.imm-debug-card .imm-debug-card-track{position:absolute;left:12px;right:12px;bottom:6px;height:3px;border-radius:2px;background:rgba(255,255,255,.35)}
.imm-debug-card .imm-debug-card-progress{height:3px;border-radius:2px}
.imm-debug-zoom-badge{position:absolute;top:12px;right:12px;padding:6px 12px;border-radius:10px;background:rgba(0,0,0,.55);color:#fff;font:600 22px/1.2 ui-monospace,Menlo,monospace;pointer-events:none;z-index:3;text-align:right}
.imm-debug-zoom-badge small{display:block;font-size:12px;font-weight:500;opacity:.75}
.imm-debug-overlay{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2}
.imm-debug-coverage{display:block;width:100%;aspect-ratio:1;background:rgba(255,255,255,.05);border-radius:6px;margin-top:6px}
`;
  document.head.append(style);
}
