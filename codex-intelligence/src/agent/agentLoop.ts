import * as fs   from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { glob } from 'glob';
import { CodexDB, FunctionEntry, ModuleEntry, FolderEntry, NamedPurpose } from '../db/codexDB';
import { VendorProfile } from '../vendor/vendorProfile';
import { runCtags, runCflow, CtagsSymbol } from '../tools/symbolTools';
import { generateFlow, generateSequence, promptSpecFor, extractDiagram, DiagramFormat } from '../tools/diagramFormat';
import { feedbackContext } from '../tools/userSections';
import { walkFoldersPostOrder, ancestorFolders, FolderNode } from '../tools/folderTree';
import { createLLMClient } from './llmClient';

function stripFences(text: string): string {
  return text.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').trim();
}

function toRelPosix(workspaceRoot: string, absPath: string): string {
  return path.relative(workspaceRoot, absPath).split(path.sep).join('/');
}

interface FunctionAnalysis {
  name: string;
  purpose: string;
  sideEffects: string;
}

interface ModuleSummary {
  purpose: string;
}

interface FolderSummary {
  purpose: string;
}

export class AgentLoop {
  constructor(
    private workspaceRoot: string,
    private db: CodexDB,
    private vendor: VendorProfile
  ) {}

  private format(): DiagramFormat {
    const f = vscode.workspace.getConfiguration('codex').get<string>('diagramFormat', 'plantuml');
    return f === 'mermaid' ? 'mermaid' : 'plantuml';
  }

  // ── Public API ─────────────────────────────────────────────────

  async indexFile(filePath: string): Promise<void> {
    if (this.vendor.isVendorFile(filePath)) { return; }
    const relFile = toRelPosix(this.workspaceRoot, filePath);
    console.log('[Codex Agent] Indexing:', relFile);

    const sourceHash = this.db.hashFile(filePath);
    const symbols    = await runCtags(filePath);
    const functions  = symbols.filter(s => s.kind === 'function');
    if (functions.length === 0) { return; }

    const { dotSource, calls } = await runCflow(
      filePath, this.vendor.getConfig().externLeafPrefixes
    );

    const callersOf = new Map<string, string[]>();
    const calleesOf = new Map<string, string[]>();
    for (const { caller, callee } of calls) {
      if (!calleesOf.has(caller)) { calleesOf.set(caller, []); }
      if (!callersOf.has(callee)) { callersOf.set(callee, []); }
      calleesOf.get(caller)!.push(callee);
      callersOf.get(callee)!.push(caller);
    }

    const stale = functions.filter(fn => this.db.isFunctionStale(fn.name, sourceHash));
    if (stale.length > 0) {
      const source = fs.readFileSync(filePath, 'utf8');
      await this.analyseFunctions(stale, source, filePath, sourceHash, callersOf, calleesOf);
    }

    const base = path.basename(filePath, path.extname(filePath));
    this.db.writeDotGraph(base, dotSource);

    // Flow + sequence: deterministic, mechanical transform of the call
    // graph — no LLM call, cannot hallucinate, instant.
    const fmt = this.format();
    this.db.setDiagramFormat(fmt);
    const externPrefixes = this.vendor.getConfig().externLeafPrefixes;
    this.db.writeDiagram(base, 'flows',     generateFlow(fmt, relFile, functions, calls, externPrefixes));
    this.db.writeDiagram(base, 'sequences', generateSequence(fmt, relFile, functions, calls, externPrefixes));

    // State diagram: genuinely needs LLM judgment (FSM detection from source)
    await this.generateStateDiagram(filePath, functions, calls);

    // Module-level doc (file-level) — cheap LLM call aggregating the
    // function summaries just written above, not raw source.
    if (this.db.isModuleStale(relFile, sourceHash)) {
      await this.writeModuleSummary(relFile, functions, callersOf, calleesOf, sourceHash);
    }

    // Bubble folder-level docs up the ancestor chain — also cheap,
    // aggregates existing module/folder summaries only.
    await this.bubbleUpFolders(filePath);

    // Refresh the agent's own index + the human entry point (R7/R8/R9).
    const idx = this.db.writeIndex();
    this.db.writeArchitectureDoc(idx);
  }

  async rebuildAll(
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const cfg      = vscode.workspace.getConfiguration('codex');
    const maxFiles = cfg.get<number>('maxFilesPerRun', 50);

    const allFiles = await glob('**/*.{c,h}', {
      cwd: this.workspaceRoot, absolute: true,
      ignore: ['**/.codex/**', '**/node_modules/**', '**/.git/**']
    });

    this.db.setDiagramFormat(this.format());
    const userFiles = this.vendor.filterUserFiles(allFiles).slice(0, maxFiles);
    const increment = 100 / Math.max(userFiles.length, 1);

    for (let i = 0; i < userFiles.length; i++) {
      if (token.isCancellationRequested) { break; }
      progress.report({
        message: `${i + 1}/${userFiles.length}: ${path.basename(userFiles[i])}`,
        increment
      });
      await this.indexFile(userFiles[i]);
    }

    // Full bottom-up sweep — covers folders not touched by per-file
    // bubble-up (e.g. a folder containing only subfolders) and ensures
    // every depth is consistent after a fresh rebuild.
    progress.report({ message: 'Generating folder overviews...' });
    await this.generateAllFolderSummaries();

    progress.report({ message: 'Generating system behaviour diagram...' });
    await this.generateBehaviourDiagram();

    progress.report({ message: 'Writing index and architecture overview...' });
    const idx = this.db.writeIndex();
    this.db.writeArchitectureDoc(idx);
  }

  async chat(userMessage: string, currentFile?: string): Promise<string> {
    const client = createLLMClient();

    let contextFns: string[] = currentFile ? this.db.functionsInFile(currentFile) : [];
    const mentioned = this.db.listFunctions().filter(fn =>
      userMessage.toLowerCase().includes(fn.toLowerCase())
    );
    const allFns  = [...new Set([...contextFns, ...mentioned])].slice(0, 30);
    const context = this.db.buildContext(allFns);
    const feedback = allFns
      .map(fn => feedbackContext(fn, this.db.preservedForFunction(fn)))
      .filter(Boolean).join('\n');

    const system =
      `You are an expert embedded C engineer assistant with full knowledge of the user's codebase, ` +
      `provided below as structured summaries from the .codex knowledge base.\n\n` +
      `Rules:\n` +
      `- Reference function names, files, and line numbers from the context\n` +
      `- Match the existing code style\n` +
      `- Flag vendor API calls marked [extern] — do not expand them\n` +
      `- Be concise and actionable\n` +
      `- Where USER CORRECTIONS or USER NOTES appear below, treat them as ground truth\n\n` +
      (feedback ? feedback + '\n' : '') +
      context;

    return client.complete({
      system,
      messages:  [{ role: 'user', content: userMessage }],
      maxTokens: 1500
    });
  }

  async autocomplete(prefix: string, currentFile: string): Promise<string[]> {
    const client  = createLLMClient();
    const fns     = this.db.functionsInFile(currentFile);
    const context = this.db.buildContext(fns.slice(0, 20));

    const prompt =
      `You are an embedded C autocomplete engine. Given the code prefix and .codex context, ` +
      `suggest up to 5 completions. Return ONLY a JSON array of strings.\n\n` +
      `${context}\n\nCode prefix:\n\`\`\`c\n${prefix}\n\`\`\``;

    try {
      const text = await client.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 400 });
      return JSON.parse(stripFences(text)) as string[];
    } catch { return []; }
  }

  // ── Private helpers — functions ─────────────────────────────────

  private async analyseFunctions(
    symbols:    CtagsSymbol[],
    source:     string,
    filePath:   string,
    sourceHash: string,
    callersOf:  Map<string, string[]>,
    calleesOf:  Map<string, string[]>
  ): Promise<void> {
    const client  = createLLMClient();
    const relPath = path.relative(this.workspaceRoot, filePath);

    const bodies = symbols.map(sym => {
      const lines   = source.split('\n');
      const snippet = lines.slice(Math.max(0, sym.line - 1), sym.line + 39).join('\n');
      return `### ${sym.name}\n\`\`\`c\n${snippet}\n\`\`\``;
    }).join('\n\n');

    const prompt =
      `Analyse these C functions from \`${relPath}\`. Return a JSON array where each element has:\n` +
      `- "name": function name\n` +
      `- "purpose": one-sentence description\n` +
      `- "sideEffects": hardware/globals/IO touched, or empty string\n\n` +
      `Return ONLY the JSON array. No prose, no fences.\n\n${bodies}`;

    try {
      const text     = await client.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 1000 });
      const analyses = JSON.parse(stripFences(text)) as FunctionAnalysis[];

      for (const sym of symbols) {
        const a = analyses.find(x => x.name === sym.name) ?? { purpose: '', sideEffects: '' };
        const entry: FunctionEntry = {
          name: sym.name, file: filePath, line: sym.line,
          signature:   sym.signature ?? sym.name,
          purpose:     a.purpose,
          callers:     callersOf.get(sym.name) ?? [],
          callees:     calleesOf.get(sym.name) ?? [],
          sideEffects: a.sideEffects,
          sourceHash
        };
        this.db.writeFunction(entry);
      }
    } catch (err) {
      console.error('[Codex Agent] analyseFunctions error:', err);
    }
  }

  private async generateStateDiagram(
    filePath:  string,
    functions: CtagsSymbol[],
    calls:     Array<{ caller: string; callee: string }>
  ): Promise<void> {
    const client   = createLLMClient();
    const fmt      = this.format();
    const spec     = promptSpecFor(fmt);
    const base     = path.basename(filePath, path.extname(filePath));
    const relPath  = path.relative(this.workspaceRoot, filePath);
    const context  = this.db.buildContext(functions.map(f => f.name));
    const fnNames  = functions.map(f => f.name).join(', ');
    const callList = calls.map(c => `${c.caller} -> ${c.callee}`).join('\n');

    // Feed any user corrections/notes on this file's functions back in as
    // authoritative — this is the R6 loop closing.
    const feedback = functions
      .map(f => feedbackContext(f.name, this.db.preservedForFunction(f.name)))
      .filter(Boolean).join('\n');

    const prompt =
      `Generate a ${spec.name} state diagram for C module \`${relPath}\`.\n\n` +
      (feedback ? `${feedback}\n` : '') +
      `Functions: ${fnNames}\nCalls:\n${callList || '(none)'}\n\n${context}\n\n` +
      `Rules:\n` +
      `- If you find an explicit FSM (switch on a state enum), model it exactly\n` +
      `- Otherwise model the module lifecycle: UNINIT -> IDLE -> RUNNING -> ERROR -> IDLE\n` +
      `- Mark transitions calling vendor APIs with [extern] in the label\n\n` +
      `Example of the required ${spec.name} syntax:\n${spec.stateExample}\n\n` +
      `Return ONLY the diagram, starting with ${spec.openToken} and ending with ${spec.closeToken}. No prose.`;

    try {
      const text = await client.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 1000 });
      this.db.writeDiagram(base, 'states', extractDiagram(text, fmt));
    } catch (err) {
      console.error('[Codex Agent] generateStateDiagram error:', err);
    }
  }

  // ── Private helpers — modules (file-level) ──────────────────────

  private async writeModuleSummary(
    relFile:    string,
    functions:  CtagsSymbol[],
    callersOf:  Map<string, string[]>,
    calleesOf:  Map<string, string[]>,
    sourceHash: string
  ): Promise<void> {
    const client = createLLMClient();
    const externPrefixes = this.vendor.getConfig().externLeafPrefixes;

    // Build from already-computed function summaries — not raw source —
    // keeping this call small regardless of file size.
    const fnSummaries = functions.map(sym => {
      const entry = this.db.readFunction(sym.name);
      const isCalledExternally = (callersOf.get(sym.name) ?? []).some(c => !functions.some(f => f.name === c));
      return {
        name: sym.name,
        purpose: entry?.purpose ?? '',
        calledFromOutsideFile: callersOf.get(sym.name)?.length === 0 || isCalledExternally,
        hasNoCallersAtAll: (callersOf.get(sym.name) ?? []).length === 0
      };
    });

    const allCallees = new Set<string>();
    for (const sym of functions) {
      for (const callee of calleesOf.get(sym.name) ?? []) {
        if (externPrefixes.some(p => callee.startsWith(p))) { allCallees.add(callee); }
      }
    }

    const listing = fnSummaries.map(f =>
      `- ${f.name}: ${f.purpose || '(no summary yet)'}${f.hasNoCallersAtAll ? ' [likely public/entry — no in-file callers]' : ''}`
    ).join('\n');

    const preserved = this.db.preservedForModule(relFile);
    const feedback  = feedbackContext(relFile, preserved);

    const prompt =
      (feedback ? `${feedback}\n` : '') +
      `Write a ONE-PARAGRAPH overview of what the C file \`${relFile}\` achieves as a whole, ` +
      `based on its functions below. Then classify each function as "public" (part of this file's ` +
      `external API — called from elsewhere or has no callers found) or "internal" (only used within this file).\n\n` +
      `Functions:\n${listing}\n\n` +
      `Return ONLY a JSON object: { "purpose": "...", "public": ["fnName", ...], "internal": ["fnName", ...] }. ` +
      `No prose, no fences.`;

    try {
      const text = await client.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 500 });
      const parsed = JSON.parse(stripFences(text)) as { purpose: string; public: string[]; internal: string[] };

      const byName = new Map(fnSummaries.map(f => [f.name, f.purpose]));
      const toNamedList = (names: string[]): NamedPurpose[] =>
        names.map(n => ({ name: n, purpose: byName.get(n) ?? '' }));

      const entry: ModuleEntry = {
        file: relFile,
        sourceHash,
        purpose: parsed.purpose ?? '',
        publicApi: toNamedList(parsed.public ?? []),
        internalApi: toNamedList(parsed.internal ?? []),
        dependencies: [...allCallees],
        functionCount: functions.length
      };
      this.db.writeModule(entry);
    } catch (err) {
      console.error('[Codex Agent] writeModuleSummary error:', err);
    }
  }

  // ── Private helpers — folders (every depth) ─────────────────────

  /** Cheap incremental path: regenerate just the ancestor chain of one
   *  saved file, stopping early if a folder's fingerprint hasn't changed. */
  private async bubbleUpFolders(filePath: string): Promise<void> {
    const chain = ancestorFolders(this.workspaceRoot, filePath);
    for (const relFolder of chain) {
      const changed = await this.regenerateFolderIfStale(relFolder);
      if (!changed) { break; } // fingerprint unchanged -> ancestors above are unaffected
    }
  }

  /** Full bottom-up sweep — used after rebuildAll so every folder at
   *  every depth is covered, including folders only per-file bubble-up
   *  might miss (e.g. a folder containing only subfolders). */
  private async generateAllFolderSummaries(): Promise<void> {
    const cfg = this.vendor.getConfig();
    const nodes: FolderNode[] = walkFoldersPostOrder(this.workspaceRoot, {
      isExcluded: (relPath) => this.vendor.isVendorFile(path.join(this.workspaceRoot, relPath)),
      includeExtensions: cfg.includeExtensions
    });
    for (const node of nodes) {
      await this.regenerateFolderIfStale(node.relPath, node);
    }
  }

  /** Returns true if the folder doc was (re)written, false if it was
   *  already up to date (fingerprint match) and nothing changed. */
  private async regenerateFolderIfStale(relFolder: string, knownNode?: FolderNode): Promise<boolean> {
    const node = knownNode ?? this.describeFolder(relFolder);
    if (!node || (node.files.length === 0 && node.subfolders.length === 0)) { return false; }

    const fileParts = node.files
      .map(relFile => {
        const mod = this.db.readModule(relFile);
        return mod ? { name: path.basename(relFile), hash: mod.sourceHash } : null;
      })
      .filter((p): p is { name: string; hash: string } => !!p);

    const subfolderParts = node.subfolders
      .map(relSub => {
        const folder = this.db.readFolder(relSub);
        return folder ? { name: path.basename(relSub), hash: folder.childrenFingerprint } : null;
      })
      .filter((p): p is { name: string; hash: string } => !!p);

    const fingerprint = this.db.fingerprintOf([...fileParts, ...subfolderParts]);
    if (!this.db.isFolderStale(relFolder, fingerprint)) { return false; }

    const fileSummaries: NamedPurpose[] = node.files.map(relFile => {
      const mod = this.db.readModule(relFile);
      return { name: path.basename(relFile), purpose: mod?.purpose ?? '(not yet indexed)' };
    });
    const subfolderSummaries: NamedPurpose[] = node.subfolders.map(relSub => {
      const folder = this.db.readFolder(relSub);
      return { name: path.basename(relSub), purpose: folder?.purpose ?? '(not yet summarised)' };
    });

    const purpose = await this.synthesiseFolderPurpose(relFolder, fileSummaries, subfolderSummaries);

    const entry: FolderEntry = {
      folder: relFolder,
      purpose,
      files: fileSummaries,
      subfolders: subfolderSummaries,
      childrenFingerprint: fingerprint
    };
    this.db.writeFolder(entry);
    return true;
  }

  private describeFolder(relFolder: string): FolderNode | null {
    const cfg = this.vendor.getConfig();
    const absFolder = relFolder === '' ? this.workspaceRoot : path.join(this.workspaceRoot, relFolder);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(absFolder, { withFileTypes: true }); }
    catch { return null; }

    const files: string[] = [];
    const subfolders: string[] = [];
    for (const entry of entries) {
      if (['.codex', '.git', 'node_modules', '.vscode'].includes(entry.name)) { continue; }
      const relChild = relFolder === '' ? entry.name : `${relFolder}/${entry.name}`;
      const absChild = path.join(this.workspaceRoot, relChild);
      if (entry.isDirectory()) {
        if (!this.vendor.isVendorFile(absChild)) { subfolders.push(relChild); }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (cfg.includeExtensions.includes(ext) && !this.vendor.isVendorFile(absChild)) { files.push(relChild); }
      }
    }
    return { relPath: relFolder, files, subfolders };
  }

  private async synthesiseFolderPurpose(
    relFolder: string,
    files: NamedPurpose[],
    subfolders: NamedPurpose[]
  ): Promise<string> {
    const client = createLLMClient();
    const label  = relFolder === '' ? '(workspace root)' : `${relFolder}/`;

    const listing = [
      ...files.map(f => `- file ${f.name}: ${f.purpose}`),
      ...subfolders.map(s => `- subfolder ${s.name}/: ${s.purpose}`)
    ].join('\n');

    const feedback = feedbackContext(label, this.db.preservedForFolder(relFolder));

    const prompt =
      (feedback ? `${feedback}\n` : '') +
      `Write ONE sentence describing what the folder \`${label}\` achieves as a whole, ` +
      `based on its direct contents below. Be specific about its role in the system, not generic.\n\n` +
      `${listing}\n\nReturn ONLY the sentence. No prose, no fences, no quotes.`;

    try {
      const text = await client.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 150 });
      return text.trim().replace(/^["']|["']$/g, '');
    } catch (err) {
      console.error('[Codex Agent] synthesiseFolderPurpose error:', err);
      return files.length || subfolders.length
        ? `Contains ${files.length} file(s) and ${subfolders.length} subfolder(s).`
        : '';
    }
  }

  // ── Private helpers — whole system ──────────────────────────────

  private async generateBehaviourDiagram(): Promise<void> {
    const client  = createLLMClient();
    const fmt     = this.format();
    const spec    = promptSpecFor(fmt);
    const context = this.db.buildContext(this.db.listFunctions().slice(0, 60));

    const prompt =
      `Generate a ${spec.name} component diagram showing the high-level module structure ` +
      `and data/control flow of the entire system described below.\n\n` +
      `Group functions into logical components. Show data flow arrows. ` +
      `Mark vendor API boundaries as extern.\n\n` +
      `Example of the required ${spec.name} syntax:\n${spec.componentExample}\n\n` +
      `Return ONLY the diagram, starting with ${spec.openToken} and ending with ${spec.closeToken}. No prose.\n\n` +
      context;

    try {
      const text = await client.complete({ messages: [{ role: 'user', content: prompt }], maxTokens: 1500 });
      this.db.writeDiagram('system_behaviour', 'behaviour', extractDiagram(text, fmt));
    } catch (err) {
      console.error('[Codex Agent] generateBehaviourDiagram error:', err);
    }
  }
}
