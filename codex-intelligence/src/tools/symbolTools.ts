import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { extractCallGraph } from './callGraphFallback';

const execFileAsync = promisify(execFile);

export interface CtagsSymbol {
  name: string; path: string; pattern: string; kind: string;
  line: number; scope?: string; signature?: string;
}
export interface CallGraph {
  dotSource: string;
  calls: Array<{ caller: string; callee: string }>;
}

export async function runCtags(filePath: string): Promise<CtagsSymbol[]> {
  const bin = vscode.workspace.getConfiguration('codex').get<string>('ctagsPath', 'ctags');
  try {
    const { stdout } = await execFileAsync(bin, ['--output-format=json','--fields=+lnS','--kinds-C=+p','-f','-', filePath]);
    const symbols: CtagsSymbol[] = [];
    for (const line of stdout.split('\n')) {
      if (!line.trim() || line.startsWith('!_')) { continue; }
      try {
        const t = JSON.parse(line) as Record<string, unknown>;
        symbols.push({
          name: String(t['name']??''), path: String(t['path']??filePath),
          pattern: String(t['pattern']??''), kind: String(t['kind']??''),
          line: Number(t['line']??0),
          scope:     t['scope']     !== undefined ? String(t['scope'])     : undefined,
          signature: t['signature'] !== undefined ? String(t['signature']) : undefined
        });
      } catch { /* skip malformed */ }
    }
    return symbols;
  } catch {
    return extractSymbolsFallback(filePath);
  }
}

function extractSymbolsFallback(filePath: string): CtagsSymbol[] {
  try {
    const source   = fs.readFileSync(filePath, 'utf8');
    const stripped = source.replace(/\/\/[^\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
    const FN_RE    = /^[\w\s\*]+?\b(\w+)\s*\(([^;{]*)\)\s*\{/gm;
    const symbols: CtagsSymbol[] = [];
    let m: RegExpExecArray | null;
    while ((m = FN_RE.exec(stripped)) !== null) {
      const before = stripped.slice(0, m.index);
      symbols.push({
        name: m[1], path: filePath, pattern: m[0], kind: 'function',
        line: before.split('\n').length,
        signature: `${m[1]}(${m[2].trim()})`
      });
    }
    return symbols;
  } catch { return []; }
}

export async function runCflow(filePath: string, externLeafPrefixes: string[]): Promise<CallGraph> {
  if (process.platform === 'win32') {
    return extractCallGraph(filePath, externLeafPrefixes);
  }
  const bin = vscode.workspace.getConfiguration('codex').get<string>('cflowPath', 'cflow');
  try {
    const { stdout } = await execFileAsync(bin, ['--format=posix','--omit-arguments', filePath]);
    const calls: Array<{ caller: string; callee: string }> = [];
    const externLeaves = new Set<string>();
    let currentCaller = '';
    for (const line of stdout.split('\n')) {
      const depth = (line.match(/^\s*/)?.[0].length ?? 0) / 4;
      const m = line.trim().match(/^(\w+)\s*\(/);
      if (!m) { continue; }
      const fnName = m[1];
      if (depth === 0) { currentCaller = fnName; }
      else if (currentCaller) {
        if (externLeafPrefixes.some(p => fnName.startsWith(p))) { externLeaves.add(fnName); }
        calls.push({ caller: currentCaller, callee: fnName });
      }
    }
    const externNodes = [...externLeaves].map(n=>`  "${n}" [shape=box style=dashed color="#888787" label="${n}\\n[extern]"];`).join('\n');
    const edges = calls.map(c=>`  "${c.caller}" -> "${c.callee}"${externLeaves.has(c.callee)?' [style=dashed color="#888787"]':''};`).join('\n');
    return { calls, dotSource: `digraph callgraph {\n  rankdir=TB;\n  node [shape=ellipse fontname="monospace" fontsize=10];\n${externNodes}\n${edges}\n}` };
  } catch {
    return extractCallGraph(filePath, externLeafPrefixes);
  }
}
