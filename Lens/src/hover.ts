import * as vscode from 'vscode';
import type { Journal } from './core/journal.js';
import { KIND_LABEL, type JournalEntry } from './core/model.js';
import { isDue } from './core/review.js';
import { symbolAt, symbolsFor } from './symbols.js';

/**
 * Hover surface.
 *
 * The point of the journal is that past-you briefs present-you without being
 * asked. That only works if the notes appear in the reading flow rather than in
 * a panel you have to remember to open, so the hover is the primary read path
 * and the tree views are secondary.
 */
export class JournalHover implements vscode.HoverProvider {
  constructor(
    private readonly journal: Journal,
    private readonly timeoutMs: () => number,
  ) {}

  async provideHover(
    doc: vscode.TextDocument,
    pos: vscode.Position,
  ): Promise<vscode.Hover | undefined> {
    if (this.journal.entries.length === 0) {
      return undefined;
    }
    const symbols = await symbolsFor(doc, this.timeoutMs());
    const found = symbolAt(symbols, pos);
    if (!found) {
      return undefined;
    }
    const entries = this.journal.for(found.anchor);
    if (entries.length === 0) {
      return undefined;
    }

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = false;

    entries.forEach((e, i) => {
      if (i > 0) {
        md.appendMarkdown('\n\n---\n\n');
      }
      md.appendMarkdown(this.render(e));
    });

    return new vscode.Hover(md, found.selection);
  }

  private render(e: JournalEntry): string {
    const icon = {
      wtf: '$(question)',
      quirk: '$(alert)',
      idiom: '$(symbol-namespace)',
      learned: '$(lightbulb)',
      todo: '$(checklist)',
    }[e.kind];

    const parts: string[] = [];
    parts.push(`${icon} **${KIND_LABEL[e.kind]}** · noted ${age(e.created)}`);
    if (e.tags.length > 0) {
      parts.push(e.tags.map((t) => `\`${t}\``).join(' '));
    }
    parts.push('', e.body.trim());

    if (isDue(e, new Date())) {
      parts.push('', '_Due for review — does this still surprise you?_');
    }

    const open = vscode.Uri.parse(
      `command:lens.openEntry?${encodeURIComponent(JSON.stringify([e.anchor, e.created]))}`,
    );
    parts.push('', `[Open entry](${open})`);
    return parts.join('\n');
  }
}

function age(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return 'at an unknown time';
  }
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) {
    return 'today';
  }
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 30) {
    return `${days} days ago`;
  }
  const months = Math.floor(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}
