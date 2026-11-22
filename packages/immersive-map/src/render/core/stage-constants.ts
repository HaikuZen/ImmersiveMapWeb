// Copyright (c) 2025-2026 Artem Bobkin.
// SPDX-License-Identifier: MIT

/**
 * The override constants a pipeline stage may be given: only those its
 * entry point uses. WebGPU lets a stage be handed values for every override
 * of its module, and Chrome and Safari on the Mac take them, but Safari on
 * iOS (26.5) fails to build the stage's Metal library ("Vertex library
 * failed creation", "Fragment library could not be created") when one of
 * them is an override the entry point never reaches. A pipeline whose two
 * stages share one table of constants hits it whenever an override steers
 * one stage only.
 *
 * Use is read from the WGSL text: the entry point's body, every function it
 * calls, and the initializers of the overrides and private variables it
 * names, followed to their end. A name counts as used wherever it appears,
 * so the reading errs toward keeping a constant: a kept constant that the
 * stage does not use is what fails on iOS, but a dropped one that it does
 * use would draw with the default silently, and the WGSL modules here name
 * an override only where they read it.
 */
export class StageOverrides {
  private static readonly cache = new Map<string, StageOverrides>();
  private readonly reached = new Map<string, ReadonlySet<string>>();

  private constructor(
    /** Each function's body, by name. */
    private readonly functions: ReadonlyMap<string, string>,
    /** Each override's initializer (empty without one), by name. */
    private readonly overrides: ReadonlyMap<string, string>,
    /** Each module-scope `var` or `const` initializer, by name. */
    private readonly globals: ReadonlyMap<string, string>,
  ) {}

  /** The reading of a module's source, made once per source. */
  static of(source: string): StageOverrides {
    let found = StageOverrides.cache.get(source);
    if (!found) {
      found = StageOverrides.read(source);
      StageOverrides.cache.set(source, found);
    }
    return found;
  }

  /** The overrides the entry point uses. */
  used(entryPoint: string): ReadonlySet<string> {
    let found = this.reached.get(entryPoint);
    if (found) return found;
    const body = this.functions.get(entryPoint);
    if (body === undefined) throw new Error(`The shader has no entry point ${entryPoint}`);
    const used = new Set<string>();
    const seen = new Set<string>([entryPoint]);
    const pending = [body];
    while (pending.length > 0) {
      for (const name of identifiers(pending.pop()!)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const override = this.overrides.get(name);
        if (override !== undefined) {
          used.add(name);
          pending.push(override);
        }
        const text = this.functions.get(name) ?? this.globals.get(name);
        if (text !== undefined) pending.push(text);
      }
    }
    found = used;
    this.reached.set(entryPoint, found);
    return found;
  }

  /** The constants of `constants` the entry point uses, or `undefined` when none is left. */
  constants(entryPoint: string, constants: Readonly<Record<string, number>>): Record<string, number> | undefined {
    const used = this.used(entryPoint);
    const kept = Object.entries(constants).filter(([name]) => used.has(name));
    return kept.length === 0 ? undefined : Object.fromEntries(kept);
  }

  private static read(source: string): StageOverrides {
    const text = stripComments(source);
    const functions = new Map<string, string>();
    const overrides = new Map<string, string>();
    const globals = new Map<string, string>();
    let depth = 0;
    let index = 0;
    const declaration = /\b(fn|override|var|const)\b(?:\s*<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_]*)/y;
    while (index < text.length) {
      const char = text[index]!;
      if (char === "{") depth++;
      else if (char === "}") depth--;
      else if (depth === 0) {
        declaration.lastIndex = index;
        const match = declaration.exec(text);
        if (match && (index === 0 || !/[A-Za-z0-9_]/.test(text[index - 1]!))) {
          const [whole, kind, name] = match as unknown as [string, string, string];
          const after = index + whole.length;
          if (kind === "fn") {
            const open = text.indexOf("{", after);
            const close = matchingBrace(text, open);
            // The parameters' and the return's types name no override, the body is what runs.
            functions.set(name, text.slice(open + 1, close));
            index = close + 1;
            continue;
          }
          const end = text.indexOf(";", after);
          const initializer = /=(.*)$/s.exec(text.slice(after, end))?.[1] ?? "";
          (kind === "override" ? overrides : globals).set(name, initializer);
          index = end + 1;
          continue;
        }
      }
      index++;
    }
    return new StageOverrides(functions, overrides, globals);
  }
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, "");
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "{") depth++;
    else if (text[index] === "}" && --depth === 0) return index;
  }
  throw new Error("The shader has an unclosed brace");
}

function identifiers(text: string): IterableIterator<string> {
  return (function* () {
    for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) yield match[0];
  })();
}

/**
 * A stage's entry point with the constants it uses, for spreading into a
 * `GPUVertexState`, `GPUFragmentState` or `GPUProgrammableStage`:
 * `{ module, ...stageEntry(code, "tileVertex", constants), buffers }`.
 */
export function stageEntry(source: string, entryPoint: string, constants: Readonly<Record<string, number>>): { entryPoint: string; constants?: Record<string, number> } {
  const kept = StageOverrides.of(source).constants(entryPoint, constants);
  return kept === undefined ? { entryPoint } : { entryPoint, constants: kept };
}
