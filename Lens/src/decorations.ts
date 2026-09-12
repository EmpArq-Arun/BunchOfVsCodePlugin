import * as vscode from 'vscode';
import type { Journal } from './core/journal.js';
import { ENTRY_KINDS, type EntryKind } from './core/model.js';
import { symbolsFor } from './symbols.js';

/**
 * Gutter markers on annotated symbols.
 *
 * Placed on the *selection* range (the name) rather than the full body range,
 * so a 200-line function gets one marker next to its signature instead of a
 * stripe down the whole gutter.
 */

const KIND_COLOUR: Record<EntryKind, string> = {
  wtf: 'editorWarning.foreground',
  quirk: 'editorInfo.foreground',
  idiom: 'charts.purple',
  learned: 'charts.green',
  todo: 'charts.yellow',
};

export class Decorations implements vscode.Disposable {
  private types = new Map<EntryKind, vscode.TextEditorDecorationType>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly journal: Journal,
    mediaRoot: vscode.Uri,
    private readonly enabled: () => boolean,
    private readonly timeoutMs: () => number,
  ) {
    for (const kind of ENTRY_KINDS) {
      this.types.set(
        kind,
        vscode.window.createTextEditorDecorationType({
          gutterIconPath: vscode.Uri.joinPath(mediaRoot, `gutter-${kind}.svg`),
          gutterIconSize: 'contain',
          overviewRulerColor: new vscode.ThemeColor(KIND_COLOUR[kind]),
          overviewRulerLane: vscode.OverviewRulerLane.Right,
        }),
      );
    }
  }

  /** Coalesce bursts of edits and selection changes into one refresh. */
  schedule(editor: vscode.TextEditor | undefined): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.refresh(editor), 200);
  }

  async refresh(editor: vscode.TextEditor | undefined): Promise<void> {
    if (!editor) {
      return;
    }
    const buckets = new Map<EntryKind, vscode.DecorationOptions[]>();
    for (const kind of ENTRY_KINDS) {
      buckets.set(kind, []);
    }

    if (this.enabled()) {
      const anchors = this.journal.anchors();
      if (anchors.size > 0) {
        const symbols = await symbolsFor(editor.document, this.timeoutMs());
        for (const s of symbols) {
          if (!anchors.has(s.anchor)) {
            continue;
          }
          const entries = this.journal.for(s.anchor);
          // A symbol carrying several kinds shows the most urgent one: an
          // unanswered question outranks settled knowledge.
          const kind = ENTRY_KINDS.find((k) => entries.some((e) => e.kind === k));
          if (!kind) {
            continue;
          }
          buckets.get(kind)!.push({
            range: new vscode.Range(s.selection.start, s.selection.start),
            hoverMessage: undefined,
          });
        }
      }
    }

    for (const [kind, type] of this.types) {
      editor.setDecorations(type, buckets.get(kind) ?? []);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    for (const t of this.types.values()) {
      t.dispose();
    }
  }
}
