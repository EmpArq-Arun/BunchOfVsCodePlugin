import * as fs from 'fs';

export interface SimpleCall { caller: string; callee: string; }
export interface CallGraph  { dotSource: string; calls: SimpleCall[]; }

const FN_DEF_RE  = /^[\w\s\*]+?\b(\w+)\s*\(([^;{}]*)\)\s*\{/gm;
const FN_CALL_RE = /\b(\w+)\s*\(/g;
const C_KEYWORDS = new Set([
  'if','else','for','while','do','switch','case','return','sizeof','typeof',
  'alignof','__attribute__','__asm__','asm','volatile','static','inline',
  'extern','const','struct','union','enum','typedef'
]);

/** Core extractor — operates on a source string directly, no fs dependency.
 *  This is what makes it unit-testable without touching disk. */
export function extractCallGraphFromSource(source: string, externLeafPrefixes: string[]): CallGraph {
  const stripped = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const functions = new Map<string, { start: number; end: number }>();

  FN_DEF_RE.lastIndex = 0;
  let defMatch: RegExpExecArray | null;
  while ((defMatch = FN_DEF_RE.exec(stripped)) !== null) {
    const name = defMatch[1];
    let depth = 1, pos = defMatch.index + defMatch[0].length;
    while (pos < stripped.length && depth > 0) {
      if (stripped[pos] === '{') { depth++; } else if (stripped[pos] === '}') { depth--; }
      pos++;
    }
    functions.set(name, { start: defMatch.index + defMatch[0].length - 1, end: pos });
  }

  const calls: SimpleCall[] = [];
  const externLeaves = new Set<string>();
  const allFnNames   = new Set(functions.keys());

  for (const [caller, range] of functions) {
    const body = stripped.slice(range.start, range.end);
    FN_CALL_RE.lastIndex = 0;
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = FN_CALL_RE.exec(body)) !== null) {
      const callee = m[1];
      if (callee === caller || C_KEYWORDS.has(callee) || seen.has(callee)) { continue; }
      seen.add(callee);
      const isExtern = externLeafPrefixes.some(p => callee.startsWith(p));
      if (isExtern) { externLeaves.add(callee); }
      if (allFnNames.has(callee) || isExtern) { calls.push({ caller, callee }); }
    }
  }

  const externNodes = [...externLeaves]
    .map(n => `  "${n}" [shape=box style=dashed color="#888787" label="${n}\\n[extern]"];`)
    .join('\n');
  const edges = calls
    .map(c => `  "${c.caller}" -> "${c.callee}"${externLeaves.has(c.callee) ? ' [style=dashed color="#888787"]' : ''};`)
    .join('\n');

  return {
    calls,
    dotSource: `digraph callgraph {\n  rankdir=TB;\n  node [shape=ellipse fontname="monospace" fontsize=10];\n${externNodes}\n${edges}\n}`
  };
}

/** File-reading wrapper around the pure extractor. */
export function extractCallGraph(filePath: string, externLeafPrefixes: string[]): CallGraph {
  let source: string;
  try { source = fs.readFileSync(filePath, 'utf8'); }
  catch { return { dotSource: 'digraph callgraph {}', calls: [] }; }
  return extractCallGraphFromSource(source, externLeafPrefixes);
}
