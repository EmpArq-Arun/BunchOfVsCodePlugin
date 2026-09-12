import * as vscode from 'vscode';
import * as path from 'path';
import { parseFile, parseFilePair } from './parser/cParser';
import { ScanResult, StateMachine } from './parser/types';

export class WorkspaceScanner {
  private cache = new Map<string, StateMachine[]>(); // key: impl file path (or standalone file)
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private watcher?: vscode.FileSystemWatcher;

  constructor(private readonly output: vscode.OutputChannel) {}

  dispose() { this.watcher?.dispose(); }

  getAllMachines(): StateMachine[] {
    const all: StateMachine[] = [];
    for (const list of this.cache.values()) all.push(...list);
    return all;
  }

  getMachine(id: string): StateMachine | undefined {
    for (const list of this.cache.values()) {
      const found = list.find((m) => m.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /** All machines whose enum OR dispatch logic lives in the given file. */
  getMachinesForFile(filePath: string): StateMachine[] {
    const out: StateMachine[] = [];
    for (const [key, list] of this.cache.entries()) {
      for (const m of list) {
        if (m.file === filePath || key === filePath) { out.push(m); continue; }
        // Also match if any state/transition location points at this file
        if (m.states.some(s => s.location.file === filePath) ||
            m.transitions.some(t => t.location.file === filePath)) out.push(m);
      }
    }
    return out;
  }

  startWatching() {
    const config = vscode.workspace.getConfiguration('statemachineVisualizer');
    const includes: string[] = config.get('scan.include', []);
    const pattern = `{${includes.join(',')}}`;
    this.watcher?.dispose();
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.watcher.onDidChange((uri) => this.scanFile(uri));
    this.watcher.onDidCreate((uri) => this.scanFile(uri));
    this.watcher.onDidDelete((uri) => { this.cache.delete(uri.fsPath); this._onDidChange.fire(); });
  }

  private async readText(uri: vscode.Uri): Promise<string> {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  }

  async scanWorkspace(): Promise<ScanResult> {
    this.cache.clear();
    const config = vscode.workspace.getConfiguration('statemachineVisualizer');
    const includes: string[] = config.get('scan.include', []);
    const excludes: string[] = config.get('scan.exclude', []);
    const excludePattern = `{${excludes.join(',')}}`;

    const errors: { file: string; message: string }[] = [];

    // ── Gather all files first so we can pair headers with implementations ──
    const allUris: vscode.Uri[] = [];
    for (const include of includes) {
      allUris.push(...await vscode.workspace.findFiles(include, excludePattern, 10000));
    }
    const allPaths = allUris.map(u => u.fsPath);
    const pathSet = new Set(allPaths);

    // header → impl
    const pairedHeader = new Map<string, string>();  // impl → header
    const consumedHeaders = new Set<string>();
    for (const p of allPaths) {
      if (!/\.(c|cpp|cc|cxx)$/i.test(p)) continue;
      const base = p.replace(/\.(c|cpp|cc|cxx)$/i, '');
      for (const hext of ['.h', '.hpp', '.hxx']) {
        const h = base + hext;
        if (pathSet.has(h)) { pairedHeader.set(p, h); consumedHeaders.add(h); break; }
      }
    }

    let filesScanned = 0;
    for (const uri of allUris) {
      const p = uri.fsPath;
      try {
        // A header that has a paired impl is parsed as part of that pair, not alone.
        if (consumedHeaders.has(p)) { filesScanned++; continue; }

        const src = await this.readText(uri);
        let machines: StateMachine[];
        const hdr = pairedHeader.get(p);
        if (hdr) {
          // Parse header + impl as one unit so enum-in-.h / switch-in-.c is detected
          const hdrSrc = await this.readText(vscode.Uri.file(hdr));
          machines = parseFilePair(hdr, hdrSrc, p, src);
        } else {
          machines = parseFile(p, src);
        }

        if (machines.length > 0) this.cache.set(p, machines);
        else this.cache.delete(p);
        filesScanned++;
      } catch (e: any) {
        errors.push({ file: p, message: e?.message ?? String(e) });
      }
    }

    this._onDidChange.fire();
    const machines = this.getAllMachines();
    const withEdges = machines.filter(m => m.transitions.length > 0).length;
    this.output.appendLine(
      `[scan] ${filesScanned} files, ${machines.length} state machine(s) (${withEdges} with transitions), ${errors.length} error(s).`,
    );
    return { machines, filesScanned, errors };
  }

  async scanFile(uri: vscode.Uri, fireEvent = true): Promise<void> {
    try {
      const p = uri.fsPath;
      const src = await this.readText(uri);

      // If this is a header with a paired impl, re-scan the impl instead
      if (/\.(h|hpp|hxx)$/i.test(p)) {
        const base = p.replace(/\.(h|hpp|hxx)$/i, '');
        for (const iext of ['.c', '.cpp', '.cc', '.cxx']) {
          const impl = base + iext;
          try {
            const implSrc = await this.readText(vscode.Uri.file(impl));
            const machines = parseFilePair(p, src, impl, implSrc);
            if (machines.length > 0) this.cache.set(impl, machines);
            else this.cache.delete(impl);
            if (fireEvent) this._onDidChange.fire();
            return;
          } catch { /* impl doesn't exist, fall through */ }
        }
      }

      // Impl file: pair with its header if present
      let machines: StateMachine[];
      if (/\.(c|cpp|cc|cxx)$/i.test(p)) {
        const base = p.replace(/\.(c|cpp|cc|cxx)$/i, '');
        let hdrSrc: string | null = null, hdrPath = '';
        for (const hext of ['.h', '.hpp', '.hxx']) {
          try { hdrSrc = await this.readText(vscode.Uri.file(base + hext)); hdrPath = base + hext; break; } catch {}
        }
        machines = hdrSrc !== null ? parseFilePair(hdrPath, hdrSrc, p, src) : parseFile(p, src);
      } else {
        machines = parseFile(p, src);
      }

      if (machines.length > 0) this.cache.set(p, machines);
      else this.cache.delete(p);
    } catch (e) {
      this.output.appendLine(`[scan] failed to read/parse ${uri.fsPath}: ${e}`);
    }
    if (fireEvent) this._onDidChange.fire();
  }
}
