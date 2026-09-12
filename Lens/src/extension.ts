import * as path from 'node:path';
import * as vscode from 'vscode';
import * as cmd from './commands.js';
import { Journal } from './core/journal.js';
import { DEFAULT_INTERVALS } from './core/review.js';
import { Decorations } from './decorations.js';
import { JournalHover } from './hover.js';
import { JournalProvider, OpenQuestionsProvider, ReviewQueueProvider } from './tree.js';
import { invalidate, invalidateAll } from './symbols.js';
import { showStructure } from './structure/command.js';
import { selectDevice } from './structure/device.js';
import { setExtraCompileFlags } from './core/compdb.js';
import { showFlow } from './flow/command.js';
import { showRosetta, clearRosetta, RosettaHover } from './rosetta/lens.js';
import { showLayout } from './layout/lens.js';
import { showCost } from './cost/lens.js';
import { showSequence, showLifetime, showComplexity, generateModulePrimer, clearLifetime } from './analysis/lens.js';

function config() {
  return vscode.workspace.getConfiguration('lens');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return;
  }
  const root = folder.uri.fsPath;

  const journalDir = path.join(root, config().get<string>('journalPath', '.lens/journal'));
  const journal = new Journal(journalDir);
  await journal.load();
  reportProblems(journal);

  const openQuestions = new OpenQuestionsProvider(journal);
  const reviewQueue = new ReviewQueueProvider(journal);
  const journalView = new JournalProvider(journal);

  const decorations = new Decorations(
    journal,
    vscode.Uri.joinPath(context.extensionUri, 'media'),
    () => config().get<boolean>('showGutterIcons', true),
    () => config().get<number>('symbolProviderTimeoutMs', 4000),
  );

  const host: cmd.Host = {
    journal,
    workspaceRoot: root,
    intervals: () => config().get<number[]>('reviewIntervals', DEFAULT_INTERVALS),
    timeoutMs: () => config().get<number>('symbolProviderTimeoutMs', 4000),
    refresh: async () => {
      await journal.load();
      reportProblems(journal);
      openQuestions.refresh();
      reviewQueue.refresh();
      journalView.refresh();
      await decorations.refresh(vscode.window.activeTextEditor);
      await updateBadge();
    },
  };

  const questionsView = vscode.window.createTreeView('lens.openQuestions', {
    treeDataProvider: openQuestions,
    showCollapseAll: true,
  });

  async function updateBadge(): Promise<void> {
    const open = journal.ofKind('wtf').length;
    questionsView.badge =
      open > 0 ? { value: open, tooltip: `${open} open question${open === 1 ? '' : 's'}` } : undefined;
  }

  // Saved compile flags apply to every command Lens builds, from activation.
  setExtraCompileFlags(config().get<string[]>('extraCompileFlags', []));

  const languages = config().get<string[]>('languages', ['c', 'cpp']);
  const selector: vscode.DocumentSelector = languages.map((language) => ({ language, scheme: 'file' }));

  context.subscriptions.push(
    questionsView,
    vscode.window.registerTreeDataProvider('lens.reviewQueue', reviewQueue),
    vscode.window.registerTreeDataProvider('lens.journal', journalView),
    vscode.languages.registerHoverProvider(selector, new JournalHover(journal, host.timeoutMs)),
    vscode.languages.registerHoverProvider(selector, new RosettaHover()),
    decorations,

    vscode.commands.registerCommand('lens.annotate', () => cmd.annotate(host)),
    vscode.commands.registerCommand('lens.annotateWtf', () => cmd.annotate(host, 'wtf')),
    vscode.commands.registerCommand('lens.showAnnotations', () => cmd.showAnnotations(host)),
    vscode.commands.registerCommand('lens.openEntry', (a: string, c: string) =>
      cmd.openEntry(host, a, c),
    ),
    vscode.commands.registerCommand('lens.revealAnchor', (a: string, c: string) =>
      cmd.revealAnchor(host, a, c),
    ),
    vscode.commands.registerCommand('lens.review', () => cmd.review(host)),
    vscode.commands.registerCommand('lens.resolveEntry', (node: unknown) =>
      withEntry(node, (a, c) => cmd.resolveEntry(host, a, c)),
    ),
    vscode.commands.registerCommand('lens.deleteEntry', (node: unknown) =>
      withEntry(node, (a, c) => cmd.deleteEntry(host, a, c)),
    ),
    vscode.commands.registerCommand('lens.export', () => cmd.exportJournal(host)),
    vscode.commands.registerCommand('lens.status', () => cmd.status(host)),
    vscode.commands.registerCommand('lens.reload', () => host.refresh()),
    vscode.commands.registerCommand('lens.structure', () => showStructure(host, context)),
    vscode.commands.registerCommand('lens.selectDevice', () => selectDevice()),
    vscode.commands.registerCommand('lens.flow', () => showFlow(host)),
    vscode.commands.registerCommand('lens.rosetta', () => showRosetta(host)),
    vscode.commands.registerCommand('lens.layout', () => showLayout(host)),
    vscode.commands.registerCommand('lens.cost', () => showCost(host)),
    vscode.commands.registerCommand('lens.sequence', () => showSequence(host)),
    vscode.commands.registerCommand('lens.lifetime', () => showLifetime(host)),
    vscode.commands.registerCommand('lens.complexity', () => showComplexity(host)),
    vscode.commands.registerCommand('lens.primer', () => generateModulePrimer(host)),
    vscode.commands.registerCommand('lens.rosettaClear', () => clearRosetta(vscode.window.activeTextEditor)),

    vscode.window.onDidChangeActiveTextEditor((e) => decorations.schedule(e)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // A document edit invalidates its cached symbol ranges, but not the
      // anchors themselves — that is the point of anchoring by name.
      invalidate(e.document.uri);
      if (e.contentChanges.length > 0 && e.document === vscode.window.activeTextEditor?.document) {
        clearRosetta(vscode.window.activeTextEditor);
        clearLifetime();
      }
      if (e.document === vscode.window.activeTextEditor?.document) {
        decorations.schedule(vscode.window.activeTextEditor);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('lens')) {
        setExtraCompileFlags(config().get<string[]>('extraCompileFlags', []));
        invalidateAll();
        void host.refresh();
      }
    }),
  );

  // The journal folder is committed, so it changes under us on branch switches
  // and merges. Watch it rather than assuming this editor is the only writer.
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, `${config().get<string>('journalPath', '.lens/journal')}/*.md`),
  );
  const onJournalChange = () => void host.refresh();
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate(onJournalChange),
    watcher.onDidChange(onJournalChange),
    watcher.onDidDelete(onJournalChange),
  );

  await updateBadge();
  await decorations.refresh(vscode.window.activeTextEditor);
}

function withEntry(node: unknown, fn: (anchor: string, created: string) => Promise<void>): Promise<void> {
  const entry = (node as { entry?: { anchor: string; created: string } } | undefined)?.entry;
  if (!entry) {
    return Promise.resolve();
  }
  return fn(entry.anchor, entry.created);
}

function reportProblems(journal: Journal): void {
  if (journal.loadProblems.length > 0) {
    void vscode.window.showWarningMessage(
      `Lens: ${journal.loadProblems.length} journal entr${
        journal.loadProblems.length === 1 ? 'y' : 'ies'
      } could not be read. ${journal.loadProblems[0]}`,
    );
  }
}

export function deactivate(): void {
  invalidateAll();
}
