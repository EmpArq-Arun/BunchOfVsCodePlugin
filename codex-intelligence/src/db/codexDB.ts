import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DiagramFormat, fileExtensionFor } from '../tools/diagramFormat';
import {
  PreservedContent, extractPreserved, renderUserBlock,
  applyCorrection, isCorrected, stripMarker
} from '../tools/userSections';
import {
  CodexIndex, IndexedFunction, IndexedModule, IndexedFolder,
  buildIndex, renderArchitectureMd
} from '../tools/codexIndex';

export type DiagramType = 'flows' | 'states' | 'sequences' | 'behaviour';
export { PreservedContent } from '../tools/userSections';

export interface FunctionEntry {
  name: string; file: string; line: number; signature: string;
  purpose: string; callers: string[]; callees: string[];
  sideEffects: string; sourceHash: string;
}

export interface NamedPurpose { name: string; purpose: string; }

export interface ModuleEntry {
  file: string;             // relative path, e.g. Core/Src/uart_driver.c
  sourceHash: string;
  purpose: string;
  publicApi: NamedPurpose[];
  internalApi: NamedPurpose[];
  dependencies: string[];   // distinct extern/vendor callees referenced anywhere in this file
  functionCount: number;
}

export interface FolderEntry {
  folder: string;           // relative path, '' = workspace root
  purpose: string;
  files: NamedPurpose[];
  subfolders: NamedPurpose[];
  childrenFingerprint: string;
}

export interface DBStats {
  functionCount: number; moduleCount: number; folderCount: number;
  diagramCount: number; lastUpdated: string; staleCount: number;
}

export class CodexDB {
  readonly codexDir: string;
  private diagramFormat: DiagramFormat;

  constructor(private workspaceRoot: string, diagramFormat: DiagramFormat = 'plantuml') {
    this.codexDir = path.join(workspaceRoot, '.codex');
    this.diagramFormat = diagramFormat;
  }

  setDiagramFormat(f: DiagramFormat): void { this.diagramFormat = f; }
  getDiagramFormat(): DiagramFormat { return this.diagramFormat; }
  diagramExt(): string { return fileExtensionFor(this.diagramFormat); }

  async init(): Promise<void> {
    for (const d of ['functions','flows','states','sequences','behaviour','callgraph','tree']) {
      fs.mkdirSync(path.join(this.codexDir, d), { recursive: true });
    }
    const vp = path.join(this.codexDir, 'vendor.json');
    if (!fs.existsSync(vp)) {
      fs.writeFileSync(vp, JSON.stringify({ _note: 'Override vendor profile fields here.' }, null, 2));
    }
  }

  // ── Functions (flat, by symbol name) ──────────────────────────────

  functionPath(name: string): string { return path.join(this.codexDir, 'functions', `${name}.md`); }

  readFunction(name: string): FunctionEntry | null {
    const p = this.functionPath(name);
    if (!fs.existsSync(p)) { return null; }
    try { return this.parseFunctionMd(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }

  /** Reads any user edits (protected block + [corrected] fields) from the
   *  existing file so writeFunction() can preserve them (R6). */
  preservedForFunction(name: string): PreservedContent {
    const p = this.functionPath(name);
    return extractPreserved(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  }

  writeFunction(e: FunctionEntry): void {
    const preserved = this.preservedForFunction(e.name);
    fs.writeFileSync(this.functionPath(e.name), this.renderFunctionMd(e, preserved), 'utf8');
  }

  listFunctions(): string[] {
    const dir = path.join(this.codexDir, 'functions');
    if (!fs.existsSync(dir)) { return []; }
    return fs.readdirSync(dir).filter((f: string) => f.endsWith('.md')).map((f: string) => f.replace('.md',''));
  }

  isFunctionStale(name: string, currentHash: string): boolean {
    const e = this.readFunction(name);
    return !e || e.sourceHash !== currentHash;
  }

  functionsInFile(sourceFile: string): string[] {
    return this.listFunctions().filter(fn => this.readFunction(fn)?.file === sourceFile);
  }

  // ── Modules (mirrored path, one per source file) ──────────────────
  // .codex/tree/Core/Src/uart_driver.c.md

  modulePath(relFile: string): string {
    return path.join(this.codexDir, 'tree', `${relFile}.md`);
  }

  readModule(relFile: string): ModuleEntry | null {
    const p = this.modulePath(relFile);
    if (!fs.existsSync(p)) { return null; }
    try { return this.parseModuleMd(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }

  preservedForModule(relFile: string): PreservedContent {
    const p = this.modulePath(relFile);
    return extractPreserved(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  }

  writeModule(e: ModuleEntry): void {
    const p = this.modulePath(e.file);
    const preserved = this.preservedForModule(e.file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, this.renderModuleMd(e, preserved), 'utf8');
  }

  isModuleStale(relFile: string, currentHash: string): boolean {
    const e = this.readModule(relFile);
    return !e || e.sourceHash !== currentHash;
  }

  // ── Folders (mirrored path, _folder.md per directory, every depth) ─
  // .codex/tree/Core/Src/_folder.md ; root -> .codex/tree/_folder.md

  folderPath(relFolder: string): string {
    return relFolder === ''
      ? path.join(this.codexDir, 'tree', '_folder.md')
      : path.join(this.codexDir, 'tree', relFolder, '_folder.md');
  }

  readFolder(relFolder: string): FolderEntry | null {
    const p = this.folderPath(relFolder);
    if (!fs.existsSync(p)) { return null; }
    try { return this.parseFolderMd(fs.readFileSync(p, 'utf8')); } catch { return null; }
  }

  preservedForFolder(relFolder: string): PreservedContent {
    const p = this.folderPath(relFolder);
    return extractPreserved(fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
  }

  writeFolder(e: FolderEntry): void {
    const p = this.folderPath(e.folder);
    const preserved = this.preservedForFolder(e.folder);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, this.renderFolderMd(e, preserved), 'utf8');
  }

  /** Merkle-style staleness: a folder is stale if its computed children
   *  fingerprint (hash of child source-hashes / child fingerprints)
   *  differs from what's stored — so a change anywhere in a subtree
   *  bubbles up without re-summarising untouched siblings. */
  isFolderStale(relFolder: string, currentFingerprint: string): boolean {
    const e = this.readFolder(relFolder);
    return !e || e.childrenFingerprint !== currentFingerprint;
  }

  /** Deterministic fingerprint from a list of (name, hash) pairs —
   *  used for both module source hashes and nested folder fingerprints. */
  fingerprintOf(parts: Array<{ name: string; hash: string }>): string {
    const sorted = [...parts].sort((a, b) => a.name.localeCompare(b.name));
    const joined = sorted.map(p => `${p.name}:${p.hash}`).join('|');
    return crypto.createHash('sha256').update(joined).digest('hex').slice(0, 16);
  }

  // ── Diagrams ────────────────────────────────────────────────────

  diagramPathFor(sourceFile: string, type: DiagramType): string | null {
    const base = path.basename(sourceFile, path.extname(sourceFile));
    // Prefer the active format, but fall back to the other so switching
    // formats doesn't break "show diagram" before a rebuild happens.
    for (const ext of [this.diagramExt(), '.puml', '.mmd']) {
      const p = path.join(this.codexDir, type, `${base}${ext}`);
      if (fs.existsSync(p)) { return p; }
    }
    return null;
  }

  writeDiagram(base: string, type: DiagramType, content: string): void {
    fs.writeFileSync(path.join(this.codexDir, type, `${base}${this.diagramExt()}`), content, 'utf8');
  }

  writeDotGraph(base: string, content: string): void {
    fs.writeFileSync(path.join(this.codexDir, 'callgraph', `${base}.dot`), content, 'utf8');
  }

  // ── Context builder (function-level, used by chat/autocomplete) ───

  buildContext(functionNames: string[]): string {
    const parts = ['# .codex knowledge base\n'];
    for (const fn of functionNames) {
      const e = this.readFunction(fn);
      if (!e) { continue; }
      parts.push(`## ${e.name}`);
      parts.push(`**File:** \`${e.file}\` line ${e.line}`);
      parts.push(`**Signature:** \`${e.signature}\``);
      parts.push(`**Purpose:** ${e.purpose}`);
      if (e.callers.length) { parts.push(`**Called by:** ${e.callers.join(', ')}`); }
      if (e.callees.length) { parts.push(`**Calls:** ${e.callees.join(', ')}`); }
      if (e.sideEffects)    { parts.push(`**Side effects:** ${e.sideEffects}`); }
      parts.push('');
    }
    return parts.join('\n');
  }

  // ── Stats ───────────────────────────────────────────────────────

  getStats(): DBStats {
    const count = (d: string) => fs.existsSync(d) ? fs.readdirSync(d).length : 0;
    const fnCount   = count(path.join(this.codexDir,'functions'));
    const diagCount = count(path.join(this.codexDir,'flows'))
                    + count(path.join(this.codexDir,'states'))
                    + count(path.join(this.codexDir,'sequences'));
    const stale = this.listFunctions().filter(fn => {
      const e = this.readFunction(fn);
      return !e || !fs.existsSync(e.file) || e.sourceHash !== this.hashFile(e.file);
    }).length;

    let moduleCount = 0, folderCount = 0;
    const treeDir = path.join(this.codexDir, 'tree');
    if (fs.existsSync(treeDir)) {
      const walk = (d: string) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) { walk(p); }
          else if (entry.name === '_folder.md') { folderCount++; }
          else if (entry.name.endsWith('.md')) { moduleCount++; }
        }
      };
      walk(treeDir);
    }

    return {
      functionCount: fnCount, moduleCount, folderCount,
      diagramCount: diagCount, lastUpdated: new Date().toISOString(), staleCount: stale
    };
  }


  // ── Machine-readable index (R7/R8) + human entry point (R9) ────────

  listModules(): string[] {
    const treeDir = path.join(this.codexDir, 'tree');
    if (!fs.existsSync(treeDir)) { return []; }
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (entry.name.endsWith('.md') && entry.name !== '_folder.md') {
          const relFile = (rel ? `${rel}/` : '') + entry.name.replace(/\.md$/, '');
          out.push(relFile);
        }
      }
    };
    walk(treeDir, '');
    return out;
  }

  listFolders(): string[] {
    const treeDir = path.join(this.codexDir, 'tree');
    if (!fs.existsSync(treeDir)) { return []; }
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      if (fs.existsSync(path.join(dir, '_folder.md'))) { out.push(rel); }
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
        }
      }
    };
    walk(treeDir, '');
    return out;
  }

  /** Rebuilds .codex/index.json — the agent's own optimised lookup file.
   *  One read replaces walking hundreds of markdown files (R7/R8). */
  writeIndex(): CodexIndex {
    const functions: IndexedFunction[] = [];
    const externSet = new Set<string>();

    for (const name of this.listFunctions()) {
      const e = this.readFunction(name);
      if (!e) { continue; }
      const preserved = this.preservedForFunction(name);
      functions.push({
        n: e.name, f: e.file, l: e.line,
        p: stripMarker(e.purpose),
        cr: e.callers, ce: e.callees,
        x: isCorrected('Purpose', preserved) || !!preserved.userNotes
      });
    }

    const modules: IndexedModule[] = [];
    for (const relFile of this.listModules()) {
      const m = this.readModule(relFile);
      if (!m) { continue; }
      const preserved = this.preservedForModule(relFile);
      for (const d of m.dependencies) { externSet.add(d); }
      modules.push({
        f: m.file, p: stripMarker(m.purpose),
        pub: m.publicApi.map(a => a.name),
        dep: m.dependencies,
        x: isCorrected('Purpose', preserved) || !!preserved.userNotes
      });
    }

    const folders: IndexedFolder[] = [];
    for (const relFolder of this.listFolders()) {
      const f = this.readFolder(relFolder);
      if (!f) { continue; }
      const preserved = this.preservedForFolder(relFolder);
      folders.push({
        d: f.folder, p: stripMarker(f.purpose),
        files: f.files.map(x => x.name),
        subs: f.subfolders.map(x => x.name),
        x: isCorrected('Overview', preserved) || !!preserved.userNotes
      });
    }

    const index = buildIndex({
      diagramFormat: this.diagramFormat,
      functions, modules, folders,
      externs: [...externSet]
    });

    fs.writeFileSync(
      path.join(this.codexDir, 'index.json'),
      JSON.stringify(index, null, 2),
      'utf8'
    );
    return index;
  }

  readIndex(): CodexIndex | null {
    const p = path.join(this.codexDir, 'index.json');
    if (!fs.existsSync(p)) { return null; }
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) as CodexIndex; }
    catch { return null; }
  }

  /** Writes .codex/ARCHITECTURE.md — the human reading entry point (R9). */
  writeArchitectureDoc(index?: CodexIndex): void {
    const idx = index ?? this.readIndex() ?? this.writeIndex();
    fs.writeFileSync(
      path.join(this.codexDir, 'ARCHITECTURE.md'),
      renderArchitectureMd(idx, this.diagramExt()),
      'utf8'
    );
  }

  hashFile(filePath: string): string {
    try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0,16); }
    catch { return ''; }
  }

  // ── Markdown serialisation — functions ─────────────────────────────

  private renderFunctionMd(e: FunctionEntry, preserved: PreservedContent): string {
    const purpose     = applyCorrection('Purpose', e.purpose, preserved);
    const sideEffects = applyCorrection('Side effects', e.sideEffects || '_none_', preserved);
    return `---
name: ${e.name}
file: ${e.file}
line: ${e.line}
sourceHash: ${e.sourceHash}
updated: ${new Date().toISOString()}
---

# ${e.name}

**Signature:** \`${e.signature}\`

**Purpose:** ${purpose}

**File:** \`${e.file}\` — line ${e.line}

## Callers
${e.callers.length ? e.callers.map(c=>`- \`${c}\``).join('\n') : '_none_'}

## Callees
${e.callees.length ? e.callees.map(c=>`- \`${c}\``).join('\n') : '_none_'}

## Side effects
${sideEffects}

## Notes
${renderUserBlock(preserved.userNotes)}
`;
  }

  private parseFunctionMd(raw: string): FunctionEntry {
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    const get = (k: string) => fm?.[1].match(new RegExp(`^${k}: (.+)$`,'m'))?.[1] ?? '';
    const parseList = (block: string) => block.split('\n').map((l:string)=>l.replace(/^-\s*`?|`?$/g,'').trim()).filter(Boolean);
    return {
      name:        get('name'),
      file:        get('file'),
      line:        parseInt(get('line'),10)||0,
      sourceHash:  get('sourceHash'),
      signature:   raw.match(/\*\*Signature:\*\* `([^`]+)`/)?.[1] ?? '',
      purpose:     raw.match(/\*\*Purpose:\*\* (.+)/)?.[1] ?? '',
      callers:     parseList(raw.match(/## Callers\n([\s\S]*?)(?=\n##|$)/)?.[1]??''),
      callees:     parseList(raw.match(/## Callees\n([\s\S]*?)(?=\n##|$)/)?.[1]??''),
      sideEffects: (raw.match(/## Side effects\n([\s\S]*?)(?=\n##|$)/)?.[1]?.trim()??'').replace('_none_','')
    };
  }

  // ── Markdown serialisation — modules (file-level) ──────────────────

  private renderNamedList(items: NamedPurpose[]): string {
    return items.length
      ? items.map(i => `- \`${i.name}\` — ${i.purpose}`).join('\n')
      : '_none_';
  }

  private parseNamedList(block: string): NamedPurpose[] {
    return block.split('\n')
      .map(l => l.match(/^-\s*`([^`]+)`\s*—\s*(.*)$/))
      .filter((m): m is RegExpMatchArray => !!m)
      .map(m => ({ name: m[1], purpose: m[2].trim() }));
  }

  private renderModuleMd(e: ModuleEntry, preserved: PreservedContent): string {
    return `---
file: ${e.file}
sourceHash: ${e.sourceHash}
functionCount: ${e.functionCount}
updated: ${new Date().toISOString()}
---

# ${e.file}

**Purpose:** ${applyCorrection('Purpose', e.purpose, preserved)}

## Public API
${this.renderNamedList(e.publicApi)}

## Internal
${this.renderNamedList(e.internalApi)}

## Dependencies
${e.dependencies.length ? e.dependencies.map(d => `- \`${d}\``).join('\n') : '_none_'}

## Notes
${renderUserBlock(preserved.userNotes)}
`;
  }

  private parseModuleMd(raw: string): ModuleEntry {
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    const get = (k: string) => fm?.[1].match(new RegExp(`^${k}: (.+)$`,'m'))?.[1] ?? '';
    const depsBlock = raw.match(/## Dependencies\n([\s\S]*?)(?=\n##|$)/)?.[1] ?? '';
    return {
      file:          get('file'),
      sourceHash:    get('sourceHash'),
      functionCount: parseInt(get('functionCount'), 10) || 0,
      purpose:       raw.match(/\*\*Purpose:\*\* (.+)/)?.[1] ?? '',
      publicApi:     this.parseNamedList(raw.match(/## Public API\n([\s\S]*?)(?=\n##|$)/)?.[1] ?? ''),
      internalApi:   this.parseNamedList(raw.match(/## Internal\n([\s\S]*?)(?=\n##|$)/)?.[1] ?? ''),
      dependencies:  depsBlock.split('\n').map(l => l.replace(/^-\s*`?|`?$/g,'').trim()).filter(Boolean).filter(d => d !== '_none_')
    };
  }

  // ── Markdown serialisation — folders (every depth) ──────────────────

  private renderFolderMd(e: FolderEntry, preserved: PreservedContent): string {
    const title = e.folder === '' ? '(workspace root)' : `${e.folder}/`;
    return `---
folder: ${e.folder}
fileCount: ${e.files.length}
subfolderCount: ${e.subfolders.length}
childrenFingerprint: ${e.childrenFingerprint}
updated: ${new Date().toISOString()}
---

# ${title}

**Overview:** ${applyCorrection('Overview', e.purpose, preserved)}

## Files
${this.renderNamedList(e.files)}

## Subfolders
${this.renderNamedList(e.subfolders)}

## Notes
${renderUserBlock(preserved.userNotes)}
`;
  }

  private parseFolderMd(raw: string): FolderEntry {
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    const get = (k: string) => fm?.[1].match(new RegExp(`^${k}: (.*)$`,'m'))?.[1] ?? '';
    return {
      folder:              get('folder'),
      childrenFingerprint: get('childrenFingerprint'),
      purpose:             raw.match(/\*\*Overview:\*\* (.+)/)?.[1] ?? '',
      files:               this.parseNamedList(raw.match(/## Files\n([\s\S]*?)(?=\n##|$)/)?.[1] ?? ''),
      subfolders:          this.parseNamedList(raw.match(/## Subfolders\n([\s\S]*?)(?=\n##|$)/)?.[1] ?? '')
    };
  }
}
