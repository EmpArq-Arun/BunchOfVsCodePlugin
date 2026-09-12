import * as vscode from 'vscode';
import type { Journal } from './core/journal.js';
import { ENTRY_KINDS, KIND_LABEL, type EntryKind, type JournalEntry } from './core/model.js';
import { dueEntries } from './core/review.js';

type Node = GroupNode | EntryNode;

interface GroupNode {
  type: 'group';
  label: string;
  children: JournalEntry[];
}

interface EntryNode {
  type: 'entry';
  entry: JournalEntry;
}

const KIND_ICON: Record<EntryKind, string> = {
  wtf: 'question',
  quirk: 'alert',
  idiom: 'symbol-namespace',
  learned: 'lightbulb',
  todo: 'checklist',
};

abstract class BaseProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(protected readonly journal: Journal) {}

  refresh(): void {
    this.emitter.fire();
  }

  abstract getChildren(node?: Node): Node[];

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.type === 'group') {
      const item = new vscode.TreeItem(
        `${node.label}  (${node.children.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = 'lens.group';
      return item;
    }

    const e = node.entry;
    const item = new vscode.TreeItem(e.symbol, vscode.TreeItemCollapsibleState.None);
    item.description = firstLine(e.body);
    item.tooltip = new vscode.MarkdownString(
      [`**${KIND_LABEL[e.kind]}** · \`${e.symbolKind}\``, '', e.body.trim(), '', `_${e.file}:${e.line}_`].join('\n'),
    );
    item.iconPath = new vscode.ThemeIcon(KIND_ICON[e.kind]);
    item.contextValue = `lens.entry.${e.kind}`;
    item.command = {
      command: 'lens.revealAnchor',
      title: 'Go to Annotated Symbol',
      arguments: [e.anchor, e.created],
    };
    return item;
  }

  protected groupBy(entries: JournalEntry[], keyOf: (e: JournalEntry) => string): Node[] {
    const map = new Map<string, JournalEntry[]>();
    for (const e of entries) {
      const key = keyOf(e);
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(e);
      } else {
        map.set(key, [e]);
      }
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, children]) => ({ type: 'group', label, children }) as GroupNode);
  }

  protected expand(node: Node | undefined, roots: () => Node[]): Node[] {
    if (!node) {
      return roots();
    }
    if (node.type === 'group') {
      return node.children.map((entry) => ({ type: 'entry', entry }) as EntryNode);
    }
    return [];
  }
}

/**
 * Open questions, grouped by directory.
 *
 * This list is the ramp-up plan. It is expected to grow fast in week one and
 * shrink steadily afterwards, and watching it shrink matters more for morale
 * than it sounds.
 */
export class OpenQuestionsProvider extends BaseProvider {
  getChildren(node?: Node): Node[] {
    return this.expand(node, () =>
      this.groupBy(this.journal.ofKind('wtf'), (e) => dirOf(e.file)),
    );
  }
}

export class ReviewQueueProvider extends BaseProvider {
  getChildren(node?: Node): Node[] {
    return this.expand(node, () =>
      dueEntries([...this.journal.entries], new Date()).map(
        (entry) => ({ type: 'entry', entry }) as EntryNode,
      ),
    );
  }
}

export class JournalProvider extends BaseProvider {
  getChildren(node?: Node): Node[] {
    return this.expand(node, () => {
      const groups: Node[] = [];
      for (const kind of ENTRY_KINDS) {
        const children = this.journal.ofKind(kind);
        if (children.length > 0) {
          groups.push({ type: 'group', label: KIND_LABEL[kind], children });
        }
      }
      return groups;
    });
  }
}

function dirOf(file: string): string {
  const i = file.lastIndexOf('/');
  return i === -1 ? '.' : file.slice(0, i);
}

function firstLine(body: string): string {
  const line = body.trim().split('\n')[0] ?? '';
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}
