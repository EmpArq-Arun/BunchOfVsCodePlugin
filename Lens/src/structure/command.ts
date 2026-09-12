import * as path from 'node:path';
import * as vscode from 'vscode';
import { describeFailure, generateStructure } from '../clanguml/runner.js';
import { findDatabaseFile } from '../rosetta/runner.js';
import type { Finding } from '../core/constructs.js';
import { nextRevisit } from '../core/review.js';
import { symbolAnchor } from '../core/anchor.js';
import type { JournalEntry } from '../core/model.js';
import { StructurePanel } from './panel.js';
import { rememberStructure } from './cache.js';
import { diagnoseDeviceSelection, selectDevice } from './device.js';
import type { Host } from '../commands.js';
import { symbolsFor, symbolAt } from '../symbols.js';

function config() {
  return vscode.workspace.getConfiguration('lens');
}

/**
 * Choose the diagram scope.
 *
 * Whole-codebase class diagrams are unreadable and slow, so the default scope is
 * the directory of the active file. That matches how a newcomer actually reads —
 * one module at a time — and keeps clang-uml runs to seconds.
 */
async function chooseScope(
  root: string,
): Promise<{ scopeDir: string; recursive: boolean; title: string } | undefined> {
  const active = vscode.window.activeTextEditor?.document.uri;
  const options: { label: string; description?: string; scopeDir: string; recursive: boolean; title: string }[] = [];

  if (active) {
    const dir = path.dirname(active.fsPath);
    const rel = path.relative(root, dir).split(path.sep).join('/') || '.';
    options.push({
      label: `$(folder) ${rel}`,
      description: 'this folder',
      scopeDir: rel,
      recursive: false,
      title: rel,
    });
    const parentRel = path.relative(root, path.dirname(dir)).split(path.sep).join('/') || '.';
    if (parentRel !== rel) {
      options.push({
        label: `$(folder-opened) ${parentRel}`,
        description: 'this folder and below',
        scopeDir: parentRel,
        recursive: true,
        title: `${parentRel} (recursive)`,
      });
    }
  }
  options.push({
    label: '$(root-folder) Whole workspace',
    description: 'slow on a large codebase',
    scopeDir: '',
    recursive: true,
    title: path.basename(root),
  });

  const picked = await vscode.window.showQuickPick(options, { title: 'Lens — scope of the structure diagram' });
  return picked ? { scopeDir: picked.scopeDir, recursive: picked.recursive, title: picked.title } : undefined;
}

/** Qualified name of the class enclosing the cursor, if any. */
async function classAtCursor(timeoutMs: number): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const symbols = await symbolsFor(editor.document, timeoutMs);
  const here = symbolAt(symbols, editor.selection.active);
  if (!here) {
    return undefined;
  }
  if (here.sym.symbolKind === 'Class' || here.sym.symbolKind === 'Struct' || here.sym.symbolKind === 'Interface') {
    return here.sym.qualifiedName;
  }
  // A method's enclosing class is its qualified name minus the last segment.
  const parts = here.sym.qualifiedName.split('::');
  return parts.length > 1 ? parts.slice(0, -1).join('::') : undefined;
}

export async function showStructure(host: Host, context: vscode.ExtensionContext): Promise<void> {
  const scope = await chooseScope(host.workspaceRoot);
  if (!scope) {
    return;
  }
  const focus = await classAtCursor(host.timeoutMs());

  const panel = StructurePanel.show({
    journal: host.journal,
    workspaceRoot: host.workspaceRoot,
    seed: (finding, draft) => seedFromFinding(host, finding, draft),
  });
  panel.setBusy(`Running clang-uml over ${scope.title}…`);

  const cfg = config();
  const databaseFile = await findDatabaseFile(host.workspaceRoot, cfg.get<string>('compilationDatabase') || undefined);
  const result = await generateStructure({
    workspaceRoot: host.workspaceRoot,
    binary: cfg.get<string>('clangUml.path', 'clang-uml'),
    ...(databaseFile ? { databaseFile } : {}),
    scopeDir: scope.scopeDir,
    recursive: scope.recursive,
    namespaces: cfg.get<string[]>('structure.namespaces', []),
    excludeNamespaces: cfg.get<string[]>('structure.excludeNamespaces', []),
    title: scope.title,
    cacheDir: path.join(host.workspaceRoot, '.lens', 'cache'),
    timeoutSeconds: cfg.get<number>('clangUml.timeoutSeconds', 180),
    gitWorkaround: cfg.get<boolean>('clangUml.gitWorkaround', true),
    clangPath: cfg.get<string>('clang.path', 'clang++'),
    extraFlags: cfg.get<string[]>('extraCompileFlags', []),
  });

  void context;

  if (!result.ok) {
    const stderr = result.failure.kind === 'failed' ? result.failure.stderr : '';
    const device = await diagnoseDeviceSelection(stderr);
    if (device) {
      panel.setUnavailable(device);
      const choice = await vscode.window.showWarningMessage(
        'Lens: the compilation database is missing the target device macro.',
        'Select device',
      );
      if (choice === 'Select device' && (await selectDevice())) {
        await showStructure(host, context);
      }
      return;
    }
    panel.setUnavailable(describeFailure(result.failure));
    return;
  }
  if (result.model.types.length === 0) {
    panel.setUnavailable(
      `clang-uml found no classes in ${scope.title}. If this folder is plain C, that is the expected answer — ` +
        'there is nothing here a C engineer needs translating.',
    );
    return;
  }
  rememberStructure(result.model);
  panel.setModel(result.model, focus);
}

/**
 * Turn a finding into a draft journal entry.
 *
 * Seeded entries are `quirk` for traps and `idiom` for everything else, and the
 * user edits before it is kept. An auto-generated note the user never read is
 * worse than no note: the journal's value is that past-you actually thought
 * about this.
 */
export async function seedFromFinding(host: Host, finding: Finding, draft: string): Promise<void> {
  const kind = finding.severity === 'trap' ? 'quirk' : 'idiom';
  const body = await vscode.window.showInputBox({
    title: `Lens — ${finding.qualifiedName}`,
    prompt: 'Edit before keeping. Notes you did not read are worse than no notes.',
    value: `${finding.title}. `,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'A note needs a body.' : undefined),
  });
  if (body === undefined) {
    return;
  }

  const now = new Date();
  const iso = now.toISOString();
  const anchor = symbolAnchor({ qualifiedName: finding.qualifiedName, symbolKind: 'Class' });
  const entry: JournalEntry = {
    anchor,
    anchorMode: 'symbol',
    kind,
    symbol: finding.qualifiedName,
    symbolKind: 'Class',
    file: finding.file ?? '',
    line: finding.line ?? 1,
    created: iso,
    updated: iso,
    revisitAt: nextRevisit(kind, 0, now, host.intervals()),
    confidence: 0,
    tags: [finding.construct],
    body: `${body.trim()}\n\n${draft.split('\n').slice(2).join('\n')}`,
  };

  await host.journal.save(entry);
  await host.refresh();
}
