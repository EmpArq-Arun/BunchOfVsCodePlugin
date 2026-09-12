import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ParserService } from '../parser/parserService';
import { buildCFG } from '../parser/cfgBuilder';
import { cfgToDot } from '../dot/dotGenerator';
import { renderSvg } from '../export/exportService';
import { hashFunctionText, signatureHash, functionDisplayName } from '../parser/functionHash';

const GITIGNORE_PROMPT_KEY = 'vistacode.gitignorePrompted';
const CACHE_DIR_NAME = '.vistacode';

interface FunctionManifestEntry {
  name: string;
  signatureHash: string;
  contentHash: string;
  lastUpdated: string;
}

interface FileManifest {
  sourceRelativePath: string;
  functions: Record<string, FunctionManifestEntry>; // keyed by "name@signatureHash"
}

export class CacheManager {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly parserService: ParserService
  ) {}

  /** Mirrors <workspace>/<relPath> to <workspace>/.vistacode/cache/<relPath>/ */
  private getMirroredCacheDir(document: vscode.TextDocument): vscode.Uri | undefined {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
      return undefined; // single-file mode, nothing to mirror against
    }
    const relativePath = path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath);
    return vscode.Uri.joinPath(workspaceFolder.uri, CACHE_DIR_NAME, 'cache', relativePath);
  }

  /** Resolves where exports should go: the explicit setting if present, else the mirrored cache folder. */
  resolveExportPath(document: vscode.TextDocument): vscode.Uri | undefined {
    const configured = vscode.workspace.getConfiguration('vistacode').get<string>('exportPath', '');
    if (configured) {
      return vscode.Uri.file(configured);
    }
    return this.getMirroredCacheDir(document);
  }

  private async readManifest(cacheDir: vscode.Uri): Promise<FileManifest | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(cacheDir, 'manifest.json'));
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as FileManifest;
    } catch {
      return null;
    }
  }

  /**
   * Disk cache is written only here, on save — never during live editing (that stays
   * in-memory, see LiveController). Per function: skip the rebuild entirely if its
   * content hash (code + comments) hasn't changed since the last save; otherwise
   * (re)write its .dot/.json/.svg triplet. Functions removed or renamed since the last
   * save get their stale files pruned via the manifest diff.
   */
  async onFileSaved(document: vscode.TextDocument): Promise<void> {
    if (document.languageId !== 'c' && document.languageId !== 'cpp') {
      return;
    }
    const cacheDir = this.getMirroredCacheDir(document);
    if (!cacheDir) {
      return;
    }
    await vscode.workspace.fs.createDirectory(cacheDir);

    const previousManifest = await this.readManifest(cacheDir);
    const functions = await this.parserService.findAllFunctions(document);

    const manifest: FileManifest = {
      sourceRelativePath: vscode.workspace.asRelativePath(document.uri),
      functions: {}
    };
    const keepFiles = new Set<string>(['manifest.json']);

    for (const fn of functions) {
      const name = functionDisplayName(fn.node);
      const sigHash = signatureHash(fn.node);
      const key = `${name}@${sigHash}`;
      const contentHash = hashFunctionText(fn.node);

      manifest.functions[key] = { name, signatureHash: sigHash, contentHash, lastUpdated: new Date().toISOString() };

      const dotFile = `${key}.dot`;
      const jsonFile = `${key}.json`;
      const svgFile = `${key}.svg`;
      keepFiles.add(dotFile);
      keepFiles.add(jsonFile);
      keepFiles.add(svgFile);

      const previousHash = previousManifest?.functions[key]?.contentHash;
      if (previousHash === contentHash) {
        continue; // unchanged since the last save — leave the existing files alone
      }

      const graph = buildCFG(fn.node);
      const dot = cfgToDot(graph);
      const svg = await renderSvg(dot);

      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(cacheDir, dotFile), Buffer.from(dot, 'utf8'));
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(cacheDir, jsonFile),
        Buffer.from(JSON.stringify({ contentHash, nodeCount: graph.nodes.size, edgeCount: graph.edges.length }, null, 2), 'utf8')
      );
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(cacheDir, svgFile), Buffer.from(svg, 'utf8'));
    }

    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(cacheDir, 'manifest.json'),
      Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')
    );

    await this.pruneStale(cacheDir, keepFiles);
  }

  private async pruneStale(cacheDir: vscode.Uri, keepFiles: Set<string>): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(cacheDir);
    } catch {
      return;
    }
    for (const [name, type] of entries) {
      if (type === vscode.FileType.File && !keepFiles.has(name)) {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(cacheDir, name));
      }
    }
  }

  /** One-time prompt (per global install) to keep the cache folder out of git. */
  async maybePromptGitignore(): Promise<void> {
    if (this.context.globalState.get(GITIGNORE_PROMPT_KEY)) {
      return;
    }
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      'Vistacode caches generated flowcharts under .vistacode/. Add it to .gitignore?',
      'Add to .gitignore',
      'Not now'
    );

    if (choice === 'Add to .gitignore') {
      const gitignoreUri = vscode.Uri.joinPath(workspaceFolder.uri, '.gitignore');
      let existing = '';
      try {
        const bytes = await vscode.workspace.fs.readFile(gitignoreUri);
        existing = Buffer.from(bytes).toString('utf8');
      } catch {
        // no .gitignore yet in this workspace — fine, we create one
      }
      if (!existing.includes(CACHE_DIR_NAME)) {
        const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
        const updated = `${existing}${needsLeadingNewline ? '\n' : ''}${CACHE_DIR_NAME}/\n`;
        await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(updated, 'utf8'));
      }
    }

    await this.context.globalState.update(GITIGNORE_PROMPT_KEY, true);
  }
}
