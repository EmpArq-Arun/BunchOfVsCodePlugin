/**
 * Extracts function-alias #define macros from source text.
 *
 * Handles two patterns:
 *   1. Parameterised alias:  #define FOO(x, y)  BAR(x, y)
 *      — Matches when the macro body is a single function call.
 *   2. Simple object-like:   #define FOO         BAR
 *      — Matches when the replacement is a single identifier.
 *
 * Used to resolve calls like `MOT_IF_CommutationTask(mag)` back to the real
 * implementation `COM_CommutationTask(mag)` through an interface-layer macro.
 *
 * Works on the comment-stripped source (`rawCleaned`) so that macros inside
 * block comments don't create spurious aliases.
 */

/** Maps macroName → resolvedName (after following the full chain). */
export type MacroAliasMap = Map<string, string>;

/**
 * Builds a raw (un-chained) alias map from one source file.
 * Call `buildMergedAliasMap` after collecting from all files.
 */
export function extractMacroAliases(rawCleaned: string, relPath = ''): Map<string, string> {
  const aliases = new Map<string, string>();

  // Normalise all line endings (\r\n and bare \r → \n) then join backslash
  // continuation lines so multi-line #defines are a single logical line.
  const src = rawCleaned
    .replace(/\r\n|\r/g, '\n')
    .replace(/\\\n/g, ' ');

  let m: RegExpExecArray | null;

  // Pattern 1: #define MACRO(params) FUNC(
  const FUNC_MACRO_RE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]*\([^)]*\)[ \t]+([A-Za-z_][\w:]*)[ \t]*\(/gm;
  while ((m = FUNC_MACRO_RE.exec(src))) {
    const macro = m[1], real = m[2];
    if (macro !== real) aliases.set(macro, real);
  }

  // Pattern 2: #define MACRO(params) (FUNC(   ← body wrapped in outer parens
  const PAREN_WRAP_RE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]*\([^)]*\)[ \t]+\([ \t]*([A-Za-z_][\w:]*)[ \t]*\(/gm;
  PAREN_WRAP_RE.lastIndex = 0;
  while ((m = PAREN_WRAP_RE.exec(src))) {
    const macro = m[1], real = m[2];
    if (macro !== real && !aliases.has(macro)) aliases.set(macro, real);
  }

  // Pattern 3: #define MACRO(params) do { FUNC(   ← do-while safety wrapper
  const DO_WRAP_RE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]*\([^)]*\)[ \t]+do\s*\{?\s*([A-Za-z_][\w:]*)[ \t]*\(/gm;
  DO_WRAP_RE.lastIndex = 0;
  while ((m = DO_WRAP_RE.exec(src))) {
    const macro = m[1], real = m[2];
    if (macro !== real && !aliases.has(macro)) aliases.set(macro, real);
  }

  // Pattern 4: #define MACRO FUNC   (no-arg alias)
  const SIMPLE_MACRO_RE = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+([A-Za-z_][\w:]*)[ \t]*(?:\/\/[^\n]*)?$/gm;
  SIMPLE_MACRO_RE.lastIndex = 0;
  while ((m = SIMPLE_MACRO_RE.exec(src))) {
    const macro = m[1], real = m[2];
    if (macro !== real && !aliases.has(macro)) aliases.set(macro, real);
  }

  return aliases;
}

/**
 * Merges per-file alias maps and then resolves all chains.
 * `filePaths` is parallel to `perFileMaps` — used only for diagnostic logging.
 */
export function buildMergedAliasMap(
  perFileMaps: Map<string, string>[],
  filePaths: string[] = [],
): MacroAliasMap {
  const raw = new Map<string, string>();
  const sourceFile = new Map<string, string>(); // alias → first-seen file

  for (let i = 0; i < perFileMaps.length; i++) {
    const m = perFileMaps[i];
    const path = filePaths[i] ?? '';
    for (const [k, v] of m) {
      if (!raw.has(k)) {
        raw.set(k, v);
        sourceFile.set(k, path);
      }
    }
  }

  // Resolve chains: FOO→BAR, BAR→BAZ  →  FOO→BAZ, BAR→BAZ
  const resolved = new Map<string, string>();
  for (const key of raw.keys()) {
    resolved.set(key, followChain(key, raw, 8));
  }
  return resolved;
}

function followChain(start: string, raw: Map<string, string>, maxHops: number): string {
  let current = start;
  const seen = new Set<string>([current]);
  for (let i = 0; i < maxHops; i++) {
    const next = raw.get(current);
    if (!next || seen.has(next)) break;
    seen.add(next);
    current = next;
  }
  return current;
}

/**
 * Resolves a single name through the alias map, returning the final target.
 * Returns `name` unchanged when no alias is found.
 */
export function resolveAlias(name: string, aliases: MacroAliasMap): string {
  return aliases.get(name) ?? name;
}
