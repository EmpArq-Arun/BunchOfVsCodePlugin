import * as vscode from 'vscode';
import { WorkspaceScanner } from '../scanner';
import { StateMachine } from '../parser/types';

type TreeItemData =
  | { kind: 'file'; file: string; machines: StateMachine[] }
  | { kind: 'machine'; machine: StateMachine };

export class SidebarProvider implements vscode.TreeDataProvider<TreeItemData> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void | TreeItemData | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly scanner: WorkspaceScanner) {
    scanner.onDidChange(() => this._onDidChangeTreeData.fire());
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeItemData): vscode.TreeItem {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(
        vscode.workspace.asRelativePath(element.file),
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon('file-code');
      item.contextValue = 'file';
      item.description = `${element.machines.length} state machine${element.machines.length === 1 ? '' : 's'}`;
      return item;
    }

    const m = element.machine;
    const item = new vscode.TreeItem(m.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(confidenceIcon(m.confidence));
    item.description = `${m.states.length} states · ${m.transitions.length} transitions · ${m.detectionKind}`;
    item.tooltip = buildTooltip(m);
    item.contextValue = 'stateMachine';
    item.command = {
      command: 'statemachineVisualizer.openVisualization',
      title: 'Open Visualization',
      arguments: [m.id],
    };
    return item;
  }

  getChildren(element?: TreeItemData): TreeItemData[] {
    const all = this.scanner.getAllMachines();
    if (!element) {
      const byFile = new Map<string, StateMachine[]>();
      for (const m of all) {
        const list = byFile.get(m.file) ?? [];
        list.push(m);
        byFile.set(m.file, list);
      }
      if (byFile.size === 0) return [];
      return Array.from(byFile.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([file, machines]) => ({ kind: 'file', file, machines }));
    }
    if (element.kind === 'file') {
      return element.machines.map((machine) => ({ kind: 'machine', machine }));
    }
    return [];
  }
}

function confidenceIcon(confidence: number): string {
  if (confidence >= 0.7) return 'symbol-class';
  if (confidence >= 0.4) return 'symbol-misc';
  return 'question';
}

function buildTooltip(m: StateMachine): string {
  const lines = [
    `${m.name} (enum)`,
    `Detected via: ${m.detectionKind}`,
    `Confidence: ${Math.round(m.confidence * 100)}%`,
    `States: ${m.states.map((s) => s.name).join(', ')}`,
  ];
  if (m.transitions.length === 0) {
    lines.push('No transitions resolved — enum found but dispatch logic was not recognized.');
  }
  return lines.join('\n');
}
