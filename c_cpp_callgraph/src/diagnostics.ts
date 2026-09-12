import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | undefined;
let _statusBar: vscode.StatusBarItem | undefined;

export function initDiagnostics(context: vscode.ExtensionContext) {
  _channel = vscode.window.createOutputChannel('C/C++ Call Graph');
  _statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  _statusBar.command = 'callgraph.showDiagnostics';
  _statusBar.tooltip = 'C/C++ Call Graph — click for diagnostics';
  setStatusBarMode('heuristic');
  _statusBar.show();
  context.subscriptions.push(_channel, _statusBar);
}

export function setStatusBarMode(mode: 'heuristic' | 'verifying' | 'verified' | 'error') {
  if (!_statusBar) return;
  switch (mode) {
    case 'heuristic':
      _statusBar.text = '$(type-hierarchy) CallGraph: heuristic';
      _statusBar.color = undefined;
      break;
    case 'verifying':
      _statusBar.text = '$(sync~spin) CallGraph: clang running…';
      _statusBar.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      break;
    case 'verified':
      _statusBar.text = '$(check) CallGraph: clang-verified';
      _statusBar.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
      break;
    case 'error':
      _statusBar.text = '$(warning) CallGraph: clang failed';
      _statusBar.color = new vscode.ThemeColor('statusBarItem.errorForeground');
      break;
  }
}

function ts(): string {
  return new Date().toISOString().slice(11, 23); // HH:mm:ss.mmm
}

export function logInfo(msg: string) {
  _channel?.appendLine(`[${ts()}] ℹ  ${msg}`);
}

export function logOk(msg: string) {
  _channel?.appendLine(`[${ts()}] ✓  ${msg}`);
}

export function logWarn(msg: string) {
  _channel?.appendLine(`[${ts()}] ⚠  ${msg}`);
}

export function logError(msg: string) {
  _channel?.appendLine(`[${ts()}] ✗  ${msg}`);
}

export function logSection(title: string) {
  _channel?.appendLine('');
  _channel?.appendLine(`── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

export function show() {
  _channel?.show(true);
}

export function dispose() {
  _channel?.dispose();
  _statusBar?.dispose();
  _channel = undefined;
  _statusBar = undefined;
}
