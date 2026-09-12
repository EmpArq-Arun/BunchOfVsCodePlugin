import * as path from 'path';
import * as vscode from 'vscode';
import { stripCommentsAndLiterals, lineAt, findMatchingBrace, findMatchingParen } from '../parser/textUtils';
import {
  ComponentPort, CrossRef, CrossRefKind, FileDetail, FileEdge,
  FileNode, FolderNode, SerializedGraph, SymbolDef, SymbolKind,
} from './types';

const CKW = new Set(['if','else','for','while','do','switch','case','default','return',
  'sizeof','typedef','struct','union','enum','class','public','private','protected',
  'new','delete','throw','catch','try','namespace','using','template','static_cast',
  'dynamic_cast','reinterpret_cast','const_cast','defined','goto','break','continue',
  'static','const','volatile','inline','extern','virtual','override','explicit',
  'friend','operator','void','int','char','short','long','float','double','bool',
  'unsigned','signed','auto','register','typename','this','nullptr','true','false',
  'NULL','assert','printf','fprintf','sprintf','malloc','free','memcpy','memset','strlen']);

interface FileData {
  file: string; source: string; stripped: string;
  defs: SymbolDef[];
  localIncludes: Array<{ header: string; line: number }>;
}

// ── Public entry ────────────────────────────────────────────────────────────
export async function buildFileInteractionGraph(
  output: vscode.OutputChannel,
  smData: Map<string, string[]> = new Map(),
): Promise<SerializedGraph> {
  const cfg   = vscode.workspace.getConfiguration('statemachineVisualizer');
  const incs: string[] = cfg.get('scan.include', []);
  const excs: string[] = cfg.get('scan.exclude', []);
  const excPat = `{${excs.join(',')}}`;
  const uris: vscode.Uri[] = [];
  for (const inc of incs) uris.push(...await vscode.workspace.findFiles(inc, excPat, 10000));

  output.appendLine(`[fileGraph] scanning ${uris.length} files…`);
  const fdMap = new Map<string, FileData>();
  for (const uri of uris) {
    try {
      const src    = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
      const strip  = stripCommentsAndLiterals(src);
      fdMap.set(uri.fsPath, { file: uri.fsPath, source: src, stripped: strip,
        defs: extractDefs(uri.fsPath, src, strip), localIncludes: extractIncludes(src) });
    } catch (e) { output.appendLine(`[fileGraph] skip ${uri.fsPath}: ${e}`); }
  }

  // Global symbol table
  const globalDefs = new Map<string, SymbolDef[]>();
  for (const fd of fdMap.values())
    for (const d of fd.defs) { if (!globalDefs.has(d.name)) globalDefs.set(d.name, []); globalDefs.get(d.name)!.push(d); }

  // Basename → file list (for header resolution)
  const bnMap = new Map<string, string[]>();
  for (const f of fdMap.keys()) {
    const bn = path.basename(f).toLowerCase();
    if (!bnMap.has(bn)) bnMap.set(bn, []);
    bnMap.get(bn)!.push(f);
  }

  // All cross-file refs
  const allRefs: CrossRef[] = [];
  for (const fd of fdMap.values())
    allRefs.push(...extractCrossRefs(fd, fdMap, globalDefs, bnMap));

  output.appendLine(`[fileGraph] ${allRefs.length} cross-file refs`);
  return buildGraph(fdMap, allRefs, smData);
}

// ── Pass 1: per-file extraction ──────────────────────────────────────────────
function extractDefs(file: string, source: string, stripped: string): SymbolDef[] {
  const defs: SymbolDef[] = [];
  const fnRe = /(^|[};])\s*((?:(?:static|inline|virtual|explicit|extern)\s+)*)([A-Za-z_][\w:<>,\s*&]*?[\s*&])([A-Za-z_~]\w*(?:::[A-Za-z_~]\w*)?)\s*\(([^;{}]*)\)\s*(?:const\s*)?(?:override\s*)?\{/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(stripped))) {
    const q = m[2] ?? ''; const name = m[4];
    if (!name || CKW.has(name) || /\bstatic\b/.test(q) || /\bextern\b/.test(q)) continue;
    const short = name.split('::').pop()!;
    if (CKW.has(short)) continue;
    defs.push({ name: short, file, line: lineAt(source, m.index), kind: 'function' });
    if (name !== short) defs.push({ name, file, line: lineAt(source, m.index), kind: 'function' });
  }
  const clsRe = /\b(?:class|struct)\s+([A-Za-z_]\w*)\s*(?:final\s*)?(?::[^{]*)?\{/g;
  while ((m = clsRe.exec(stripped))) { if (m[1]) defs.push({ name: m[1], file, line: lineAt(source, m.index), kind: 'class' }); }
  const enumRe = /\benum\b(?:\s+class)?\s+([A-Za-z_]\w*)\s*(?::[^{]*)?\{/g;
  while ((m = enumRe.exec(stripped))) { if (m[1]) defs.push({ name: m[1], file, line: lineAt(source, m.index), kind: 'typedef' }); }
  const tdRe = /\btypedef\b[^;]+\b([A-Za-z_]\w*)\s*;/g;
  while ((m = tdRe.exec(stripped))) { if (m[1] && !CKW.has(m[1]) && m[1].length >= 3) defs.push({ name: m[1], file, line: lineAt(source, m.index), kind: 'typedef' }); }
  return defs;
}

function braceDepth(text: string, idx: number): number {
  let d = 0; for (let i = 0; i < idx; i++) { if (text[i]==='{') d++; else if (text[i]==='}') d--; } return Math.max(0,d);
}

function extractIncludes(src: string): Array<{ header: string; line: number }> {
  const r: Array<{ header: string; line: number }> = [];
  const re = /^\s*#include\s*"([^"]+)"/gm; let m: RegExpExecArray | null;
  while ((m = re.exec(src))) r.push({ header: m[1], line: lineAt(src, m.index) });
  return r;
}

// ── Pass 3: cross-file refs ──────────────────────────────────────────────────
function extractCrossRefs(
  fd: FileData, allFiles: Map<string, FileData>,
  globalDefs: Map<string, SymbolDef[]>, bnMap: Map<string, string[]>,
): CrossRef[] {
  const refs: CrossRef[] = [];
  const localNames = new Set<string>([...fd.defs.map(d=>d.name), ...fd.defs.map(d=>d.name.split('::').pop()!)]);
  const isHeader = /\.(h|hpp|hxx)$/i.test(fd.file);
  const pairedImpl = isHeader
    ? ['.c','.cpp','.cc','.cxx'].map(ext => fd.file.replace(/\.(h|hpp|hxx)$/i, ext))
    : [];

  // 1. Includes
  for (const inc of fd.localIncludes) {
    for (const toFile of resolveHeader(inc.header, fd.file, bnMap)) {
      if (toFile !== fd.file)
        refs.push({ fromFile: fd.file, toFile, kind: 'include', symbol: inc.header, detail: `#include "${inc.header}"`, fromLine: inc.line });
    }
  }

  // 2. Function calls
  const callRe = /\b([A-Za-z_]\w*)\s*\(/g; const seenC = new Set<string>(); let m: RegExpExecArray | null;
  while ((m = callRe.exec(fd.stripped))) {
    const name = m[1];
    if (CKW.has(name) || localNames.has(name) || seenC.has(name) || name.length < 2 || /^[A-Z_]{2,}$/.test(name)) continue;
    seenC.add(name);
    for (const def of (globalDefs.get(name) ?? [])) {
      if (def.file === fd.file || def.kind !== 'function') continue;
      if (isHeader && pairedImpl.includes(def.file)) continue;
      refs.push({ fromFile: fd.file, toFile: def.file, kind: 'call', symbol: name, detail: `${name}()`, fromLine: lineAt(fd.source, m.index) });
    }
  }

  // 3. Extern variables — capture type for detail
  const extRe = /\bextern\b\s+(?!"C")((?:const\s+)?[A-Za-z_][\w\s*<>]*?)\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*;/g;
  while ((m = extRe.exec(fd.stripped))) {
    const varType = m[1]?.trim(); const varName = m[2];
    if (!varName || CKW.has(varName)) continue;
    for (const def of (globalDefs.get(varName) ?? [])) {
      if (def.file === fd.file || def.kind !== 'variable') continue;
      refs.push({ fromFile: fd.file, toFile: def.file, kind: 'extern', symbol: varName, detail: `extern ${varType} ${varName}`, fromLine: lineAt(fd.source, m.index) });
    }
  }

  // 4. Inheritance
  const inhRe = /\bclass\s+([A-Za-z_]\w*)\s*(?:final\s*)?:\s*((?:(?:public|private|protected)\s+[A-Za-z_:]\w*(?:\s*,\s*(?:public|private|protected)\s+[A-Za-z_:]\w*)*)+)/g;
  while ((m = inhRe.exec(fd.stripped))) {
    const derived = m[1];
    for (const base of m[2].split(',').map(b=>b.replace(/\b(public|private|protected)\b/g,'').replace(/::/g,'').trim())) {
      if (!base) continue;
      for (const def of (globalDefs.get(base) ?? [])) {
        if (def.file === fd.file) continue;
        refs.push({ fromFile: fd.file, toFile: def.file, kind: 'inherit', symbol: base, detail: `class ${derived} : ${base}`, fromLine: lineAt(fd.source, m.index) });
      }
    }
  }

  // 5. Type usage
  const typeRe = /\b([A-Za-z_]\w*)\s*(?:\*\s*)?(?:[A-Za-z_]\w*\s*)?[,;(){]/g;
  const seenT = new Set<string>();
  while ((m = typeRe.exec(fd.stripped))) {
    const name = m[1];
    if (CKW.has(name) || localNames.has(name) || seenT.has(name) || name.length < 3 || /^[A-Z_]{2,}$/.test(name)) continue;
    seenT.add(name);
    for (const def of (globalDefs.get(name) ?? [])) {
      if (def.file === fd.file || def.kind === 'function') continue;
      refs.push({ fromFile: fd.file, toFile: def.file, kind: 'typedef', symbol: name, detail: `${name} (${def.kind})`, fromLine: lineAt(fd.source, m.index) });
    }
  }

  return refs;
}

function resolveHeader(header: string, fromFile: string, bnMap: Map<string, string[]>): string[] {
  const fromDir = path.dirname(fromFile);
  const bn = path.basename(header).toLowerCase();
  const candidates = bnMap.get(bn) ?? [];
  const norm = header.replace(/\\/g, '/');
  const exact = candidates.filter(c => c.replace(/\\/g, '/').endsWith(norm));
  return exact.length ? exact : candidates;
}

// ── Graph assembly ────────────────────────────────────────────────────────────
/** Detect header/source pairs: returns Map<headerPath, implPath>
 *  Strategy: exact basename match first (motor.h → motor.c),
 *  then prefix match (motor.h → motor_driver.c) as fallback. */
function buildFilePairs(allFiles: string[]): Map<string, string> {
  const h2i = new Map<string, string>(); // header → impl
  const implFiles = allFiles.filter(f => /\.(c|cpp|cc|cxx)$/i.test(f));
  const headerFiles = allFiles.filter(f => /\.(h|hpp|hxx)$/i.test(f));

  for (const h of headerFiles) {
    const base = h.replace(/\.(h|hpp|hxx)$/i, '');
    const hName = path.basename(base).toLowerCase();

    // 1. Exact match: motor.h → motor.c
    for (const iext of ['.c', '.cpp', '.cc', '.cxx']) {
      const exact = base + iext;
      if (implFiles.includes(exact)) { h2i.set(h, exact); break; }
    }
    if (h2i.has(h)) continue;

    // 2. Prefix match: motor.h → motor_driver.c (impl name starts with header base name)
    const prefix = hName + '_';
    const prefixMatch = implFiles.find(f => {
      const fBase = path.basename(f, path.extname(f)).toLowerCase();
      return fBase.startsWith(prefix) && path.dirname(f) === path.dirname(h);
    });
    if (prefixMatch) { h2i.set(h, prefixMatch); continue; }

    // 3. Suffix match: motor_api.h → motor.c (header is a sub-header of a module)
    const hDir = path.dirname(h);
    const suffixMatch = implFiles.find(f => {
      const fBase = path.basename(f, path.extname(f)).toLowerCase();
      return hName.startsWith(fBase + '_') && path.dirname(f) === hDir;
    });
    if (suffixMatch && ![...h2i.values()].includes(suffixMatch)) { h2i.set(h, suffixMatch); }
  }
  return h2i;
}

function buildGraph(fdMap: Map<string, FileData>, allRefs: CrossRef[], smData: Map<string, string[]>): SerializedGraph {
  const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

  // ── Detect header/source pairs ────────────────────────────────────────────
  const allFilePaths = [...fdMap.keys()];
  const h2i = buildFilePairs(allFilePaths);        // header → impl
  const i2h = new Map<string, string>();           // impl → header
  for (const [h, i] of h2i.entries()) i2h.set(i, h);

  // Re-map all refs: refs from/to a header are attributed to its impl file
  const remapFile = (f: string) => h2i.get(f) ?? f;
  const remappedRefs = allRefs
    .map(r => ({ ...r, fromFile: remapFile(r.fromFile), toFile: remapFile(r.toFile) }))
    .filter(r => r.fromFile !== r.toFile);  // remove now-internal pair refs

  // ── Folder groups ─────────────────────────────────────────────────────────
  const folderFiles = new Map<string, { absPath: string; files: string[] }>();
  for (const file of fdMap.keys()) {
    if (h2i.has(file)) continue; // skip header files that have a paired impl
    const dir = path.dirname(file);
    const relDir = (dir.startsWith(wsRoot) ? dir.slice(wsRoot.length).replace(/^[/\\]+/, '') : path.basename(dir)) || '(root)';
    if (!folderFiles.has(relDir)) folderFiles.set(relDir, { absPath: dir, files: [] });
    folderFiles.get(relDir)!.files.push(file);
  }

  const fileFolderMap = new Map<string, string>();
  const folders: FolderNode[] = [];
  for (const [id, { absPath, files }] of folderFiles.entries()) {
    for (const f of files) fileFolderMap.set(f, id);
    folders.push({ id, label: path.basename(absPath) || id, path: absPath, fileCount: files.length, crossFolderEdges: 0 });
  }
  folders.sort((a, b) => a.label.localeCompare(b.label));

  // ── Degree per impl file (using remapped refs) ────────────────────────────
  const degMap = new Map<string, Set<string>>();
  for (const r of remappedRefs) {
    if (!degMap.has(r.fromFile)) degMap.set(r.fromFile, new Set());
    if (!degMap.has(r.toFile))   degMap.set(r.toFile,   new Set());
    degMap.get(r.fromFile)!.add(r.toFile);
    degMap.get(r.toFile)!.add(r.fromFile);
  }

  // ── File nodes (impl files only; paired headers are merged in) ────────────
  const files: FileNode[] = [];
  for (const file of fdMap.keys()) {
    if (h2i.has(file)) continue;  // skip headers with a paired impl
    const pairedHdr = i2h.get(file);
    const names = [
      ...(smData.get(file) ?? []),
      ...(pairedHdr ? (smData.get(pairedHdr) ?? []) : []),
    ];
    // Use just the base name when paired (e.g. "motor" instead of "motor.c")
    const displayLabel = pairedHdr ? path.basename(file, path.extname(file)) : undefined;
    files.push({
      id: file, label: path.basename(file), file,
      folderId: fileFolderMap.get(file) ?? '(root)',
      ext: path.extname(file).toLowerCase(),
      degree: degMap.get(file)?.size ?? 0,
      hasSM: names.length > 0, smNames: [...new Set(names)],
      pairedFile: pairedHdr,
      displayLabel,
    });
  }
  files.sort((a,b)=>a.label.localeCompare(b.label));

  // ── Per-kind edges (using remapped refs) ──────────────────────────────────
  const edgeMap = new Map<string, { symbols: string[]; details: string[]; count: number }>();
  for (const r of remappedRefs) {
    const key = `${r.fromFile}|||${r.toFile}|||${r.kind}`;
    if (!edgeMap.has(key)) edgeMap.set(key, { symbols: [], details: [], count: 0 });
    const e = edgeMap.get(key)!;
    if (!e.symbols.includes(r.symbol)) { e.symbols.push(r.symbol); if (r.detail) e.details.push(r.detail); }
    e.count++;
  }
  const edges: FileEdge[] = [];
  for (const [key, data] of edgeMap.entries()) {
    const [from, to, kind] = key.split('|||') as [string, string, CrossRefKind];
    edges.push({ from, to, kind, ...data });
  }

  for (const e of edges) {
    const ff = fileFolderMap.get(e.from); const tf = fileFolderMap.get(e.to);
    if (ff && tf && ff !== tf) { const fn = folders.find(f=>f.id===ff); if (fn) fn.crossFolderEdges++; }
  }

  // ── Details (build for impl files, merge in header refs via remapped list) ─
  const details: Record<string, FileDetail> = {};
  for (const fd of fdMap.values()) {
    if (h2i.has(fd.file)) continue; // skip headers
    details[fd.file] = buildFileDetail(fd, remappedRefs);
  }
  return { folders, files, edges, details };
}

function buildFileDetail(fd: FileData, allRefs: CrossRef[]): FileDetail {
  const compMap = new Map<string, ComponentPort>();
  const getComp = (name: string, kind: SymbolKind, dir: 'export'|'import'): ComponentPort => {
    const key = `${dir}::${name}`;
    if (!compMap.has(key)) {
      const cp: ComponentPort = { name, kind, direction: dir, connections: [] };
      compMap.set(key, cp);
    }
    return compMap.get(key)!;
  };
  for (const r of allRefs) {
    if (r.toFile === fd.file) {
      const cp = getComp(r.symbol, r.kind==='inherit'?'class':r.kind==='extern'?'variable':'function', 'export');
      // Populate defLine from the file's own symbol definitions
      if (!cp.defLine) {
        const def = fd.defs.find(d => d.name === r.symbol || d.name.split('::').pop() === r.symbol);
        if (def) cp.defLine = def.line;
      }
      if (!cp.connections.some(c=>c.file===r.fromFile&&c.mechanism===r.kind))
        cp.connections.push({ file:r.fromFile, mechanism:r.kind, line:r.fromLine, detail:r.detail });
    }
    if (r.fromFile === fd.file && r.kind !== 'include') {
      const cp = getComp(r.symbol, r.kind==='inherit'?'class':r.kind==='extern'?'variable':'function', 'import');
      if (!cp.connections.some(c=>c.file===r.toFile&&c.mechanism===r.kind))
        cp.connections.push({ file:r.toFile, mechanism:r.kind, line:r.fromLine, detail:r.detail });
    }
  }
  const includes   = allRefs.filter(r=>r.fromFile===fd.file&&r.kind==='include').map(r=>r.toFile).filter((v,i,a)=>a.indexOf(v)===i);
  const includedBy = allRefs.filter(r=>r.toFile===fd.file&&r.kind==='include').map(r=>r.fromFile).filter((v,i,a)=>a.indexOf(v)===i);
  return { file:fd.file, label:path.basename(fd.file), components:[...compMap.values()], includes, includedBy };
}
