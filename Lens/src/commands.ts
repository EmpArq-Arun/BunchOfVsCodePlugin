import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Journal } from './core/journal.js';
import { entryFilename } from './core/frontmatter.js';
import {
  ENTRY_KINDS,
  KIND_BLURB,
  KIND_LABEL,
  type EntryKind,
  type JournalEntry,
} from './core/model.js';
import {
  dueEntries,
  markUnclear,
  markUnderstood,
  nextRevisit,
  rampUpStatus,
  resolveQuestion,
} from './core/review.js';
import { resolveTarget, symbolsFor } from './symbols.js';

export interface Host {
  journal: Journal;
  workspaceRoot: string;
  intervals(): number[];
  timeoutMs(): number;
  /** Reload from disk and repaint every surface. */
  refresh(): Promise<void>;
}

function relative(host: Host, uri: vscode.Uri): string {
  return path.relative(host.workspaceRoot, uri.fsPath).split(path.sep).join('/');
}

/** Entries are identified across the command boundary by anchor + creation time. */
function find(host: Host, anchor: string, created: string): JournalEntry | undefined {
  return host.journal.for(anchor).find((e) => e.created === created);
}

async function pickKind(): Promise<EntryKind | undefined> {
  // `kind` is a reserved field on QuickPickItem, so the entry kind travels as
  // `value` to avoid colliding with VS Code's separator mechanism.
  const picked = await vscode.window.showQuickPick(
    ENTRY_KINDS.map((k) => ({ label: KIND_LABEL[k], description: KIND_BLURB[k], value: k })),
    { title: 'Lens — what kind of note is this?', matchOnDescription: true },
  );
  return picked?.value;
}

export async function annotate(host: Host, forcedKind?: EntryKind): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }

  const kind = forcedKind ?? (await pickKind());
  if (!kind) {
    return;
  }

  const rel = relative(host, editor.document.uri);
  const target = await resolveTarget(
    editor.document,
    editor.selection.active,
    rel,
    host.timeoutMs(),
  );

  const body = await vscode.window.showInputBox({
    title: `Lens — ${KIND_LABEL[kind]} on ${target.label}`,
    prompt:
      kind === 'wtf'
        ? "Describe what you don't understand. Vague is fine — the point is to record the confusion, not resolve it."
        : 'Write the note in your own words.',
    placeHolder: kind === 'wtf' ? 'Why does this go through a vtable at all?' : '',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'A note needs a body.' : undefined),
  });
  if (body === undefined) {
    return;
  }

  const tagsRaw = await vscode.window.showInputBox({
    title: 'Lens — tags (optional)',
    prompt: 'Comma-separated. Useful later for grouping by construct, e.g. virtual, template, raii.',
    ignoreFocusOut: true,
  });
  if (tagsRaw === undefined) {
    return;
  }

  const now = new Date();
  const iso = now.toISOString();
  const entry: JournalEntry = {
    anchor: target.anchor,
    anchorMode: target.mode,
    kind,
    symbol: target.sym.qualifiedName,
    symbolKind: target.sym.symbolKind,
    detail: target.sym.detail,
    file: rel,
    line: target.line,
    created: iso,
    updated: iso,
    revisitAt: nextRevisit(kind, 0, now, host.intervals()),
    confidence: 0,
    tags: tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0),
    body: body.trim(),
  };

  await host.journal.save(entry);
  await host.refresh();

  const note =
    target.mode === 'fingerprint'
      ? 'Anchored to surrounding text — the language server could not name this position, so the note will detach if these lines change.'
      : `Anchored to \`${target.sym.qualifiedName}\`.`;
  void vscode.window.showInformationMessage(`Lens: ${KIND_LABEL[kind].toLowerCase()} recorded. ${note}`);
}

export async function showAnnotations(host: Host): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const rel = relative(host, editor.document.uri);
  const target = await resolveTarget(editor.document, editor.selection.active, rel, host.timeoutMs());
  const entries = host.journal.for(target.anchor);

  if (entries.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      `Lens: nothing recorded for ${target.label}.`,
      'Add a note',
    );
    if (choice) {
      await annotate(host);
    }
    return;
  }
  await pickAndOpen(host, entries);
}

async function pickAndOpen(host: Host, entries: JournalEntry[]): Promise<void> {
  if (entries.length === 1) {
    await openEntry(host, entries[0].anchor, entries[0].created);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    entries.map((e) => ({
      label: `${KIND_LABEL[e.kind]} — ${e.symbol}`,
      detail: e.body.split('\n')[0],
      entry: e,
    })),
    { title: 'Lens — entries on this symbol' },
  );
  if (picked) {
    await openEntry(host, picked.entry.anchor, picked.entry.created);
  }
}

export async function openEntry(host: Host, anchor: string, created: string): Promise<void> {
  const entry = find(host, anchor, created);
  if (!entry?.path) {
    void vscode.window.showWarningMessage('Lens: that entry is no longer on disk.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(entry.path));
  await vscode.window.showTextDocument(doc, { preview: false });
}

/**
 * Navigate to the symbol an entry is anchored to.
 *
 * The stored line is only a hint. The current location is recovered by asking
 * the language server for symbols and matching on anchor, which is what makes
 * notes survive the code moving underneath them. When the anchor no longer
 * resolves the entry is reported as orphaned rather than silently dropping the
 * user at a stale line.
 */
export async function revealAnchor(host: Host, anchor: string, created: string): Promise<void> {
  const entry = find(host, anchor, created);
  if (!entry) {
    return;
  }
  if (!entry.file) {
    await openEntry(host, anchor, created);
    return;
  }

  const uri = vscode.Uri.file(path.join(host.workspaceRoot, entry.file));
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    void vscode.window.showWarningMessage(
      `Lens: ${entry.file} is gone. The note is still in the journal.`,
    );
    await openEntry(host, anchor, created);
    return;
  }

  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  let line = entry.line - 1;
  let stale = false;

  if (entry.anchorMode === 'symbol') {
    const symbols = await symbolsFor(doc, host.timeoutMs());
    const match = symbols.find((s) => s.anchor === anchor);
    if (match) {
      line = match.selection.start.line;
      if (line !== entry.line - 1) {
        entry.line = line + 1;
        await host.journal.save(entry);
      }
    } else if (symbols.length > 0) {
      stale = true;
    }
  }

  const pos = new vscode.Position(Math.min(Math.max(line, 0), doc.lineCount - 1), 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);

  if (stale) {
    void vscode.window.showWarningMessage(
      `Lens: \`${entry.symbol}\` no longer exists in ${entry.file} — it may have been renamed. Showing the last known position.`,
    );
  }
}

/**
 * Review session.
 *
 * One question per entry, no scoring. "Still unclear" resets the schedule rather
 * than punishing anything; an entry that keeps coming back is information about
 * where your model of the codebase is thin, not a failure.
 */
export async function review(host: Host): Promise<void> {
  const due = dueEntries([...host.journal.entries], new Date());
  if (due.length === 0) {
    void vscode.window.showInformationMessage('Lens: nothing due for review.');
    return;
  }

  for (let i = 0; i < due.length; i++) {
    const e = due[i];
    const answer = await vscode.window.showQuickPick(
      [
        { label: '$(check) Clear now', value: 'understood' as const },
        { label: '$(question) Still unclear', value: 'unclear' as const },
        { label: '$(go-to-file) Open the code', value: 'open' as const },
        { label: '$(x) Stop reviewing', value: 'stop' as const },
      ],
      {
        title: `Lens review ${i + 1}/${due.length} — ${e.symbol}`,
        placeHolder: e.body.split('\n')[0],
        ignoreFocusOut: true,
      },
    );

    if (!answer || answer.value === 'stop') {
      break;
    }
    if (answer.value === 'open') {
      await revealAnchor(host, e.anchor, e.created);
      break;
    }

    const now = new Date();
    const updated =
      answer.value === 'understood'
        ? markUnderstood(e, now, host.intervals())
        : markUnclear(e, now, host.intervals());
    updated.path = e.path;
    await host.journal.save(updated);
  }

  await host.refresh();
}

export async function resolveEntry(host: Host, anchor: string, created: string): Promise<void> {
  const entry = find(host, anchor, created);
  if (!entry) {
    return;
  }
  const resolution = await vscode.window.showInputBox({
    title: `Lens — what did you work out about ${entry.symbol}?`,
    prompt: 'This gets appended to the note and the entry becomes recorded knowledge.',
    ignoreFocusOut: true,
  });
  if (resolution === undefined) {
    return;
  }

  const previousPath = entry.path;
  const updated = resolveQuestion(entry, resolution, new Date(), host.intervals());
  await host.journal.saveRenaming(updated, previousPath);
  await host.refresh();
  void vscode.window.showInformationMessage(`Lens: ${entry.symbol} moved to Learned.`);
}

export async function deleteEntry(host: Host, anchor: string, created: string): Promise<void> {
  const entry = find(host, anchor, created);
  if (!entry) {
    return;
  }
  const confirm = await vscode.window.showWarningMessage(
    `Delete the note on ${entry.symbol}?`,
    { modal: true, detail: entry.body.split('\n')[0] },
    'Delete',
  );
  if (confirm !== 'Delete') {
    return;
  }
  await host.journal.remove(entry);
  await host.refresh();
}

export async function exportJournal(host: Host): Promise<void> {
  const name = path.basename(host.workspaceRoot);
  const content = host.journal.export(`${name} — Lens Journal`);
  const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: false });
}

export async function status(host: Host): Promise<void> {
  const s = rampUpStatus([...host.journal.entries], new Date());
  const lines = [
    `${s.total} entries across ${s.modulesTouched} modules.`,
    `${s.openQuestions} open questions · ${s.byKind.learned} learned · ${s.retired} retired.`,
    s.dueNow > 0 ? `${s.dueNow} due for review.` : 'Nothing due for review.',
  ];
  if (s.oldestOpenQuestionDays !== null && s.oldestOpenQuestionDays > 30) {
    lines.push(`Oldest open question is ${s.oldestOpenQuestionDays} days old.`);
  }

  const choice = await vscode.window.showInformationMessage(
    lines.join(' '),
    ...(s.dueNow > 0 ? ['Review now'] : []),
  );
  if (choice === 'Review now') {
    await review(host);
  }
}

export { entryFilename };
