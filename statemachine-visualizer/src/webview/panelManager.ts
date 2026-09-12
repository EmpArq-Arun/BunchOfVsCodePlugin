import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as fs from 'fs';
import { StateMachine } from '../parser/types';

export class PanelManager {
  private panel: vscode.WebviewPanel | undefined;
  private currentMachineId: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {}

  show(machine: StateMachine) {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'statemachineVisualizer.diagram',
        'State Machine: ' + machine.name,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
        this.currentMachineId = undefined;
      });
      this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
      this.panel.webview.html = this.buildHtml(this.panel.webview);
    }

    this.currentMachineId = machine.id;
    this.panel.title = 'State Machine: ' + machine.name;
    this.panel.reveal(vscode.ViewColumn.Beside, true);
    this.postMachine(machine);
  }

  private postMachine(machine: StateMachine) {
    this.panel?.webview.postMessage({ type: 'load', machine });
  }

  private async handleMessage(msg: any) {
    if (msg?.type === 'revealLocation') {
      const { file, line } = msg.location ?? {};
      if (!file) return;
      try {
        const doc = await vscode.workspace.openTextDocument(file);
        const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      } catch (e) {
        this.output.appendLine(`Could not open ${file}: ${e}`);
      }
    }
  }

  isShowing(machineId: string): boolean {
    return !!this.panel && this.currentMachineId === machineId;
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview.css'),
    );
    const nonce = String(Date.now());
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri}">
  <style>
    #toolbar{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--vscode-panel-border,#333);flex-wrap:wrap}
    #backBtn{display:none}
    #title{font-weight:600;font-size:13px}
    #confidence{font-size:10.5px;opacity:.65;margin-left:4px}
    .sm-layout-group{display:flex;gap:3px;border-left:1px solid #555;padding-left:8px;margin-left:auto}
    .sm-layout-btn{background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-foreground,#ddd);border:none;padding:3px 9px;border-radius:3px;cursor:pointer;font-size:11px}
    .sm-layout-btn.active{background:var(--vscode-button-background,#0e639c);color:#fff}
    #graph{width:100%;height:calc(100vh - 110px)}
    #legend{padding:5px 12px;border-top:1px solid var(--vscode-panel-border,#333);font-size:11px}
    .legend-row{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:3px}
    .legend-chip{display:flex;align-items:center;gap:5px}
    .legend-chip i{display:inline-block;width:10px;height:10px;border-radius:2px}
    .legend-note{opacity:.65;font-size:10.5px}
  </style>
  <title>State Machine Diagram</title>
</head>
<body>
  <div id="toolbar">
    <button id="backBtn" disabled></button>
    <span id="title"></span>
    <span id="confidence"></span>
    <div class="sm-layout-group">
      <button class="sm-layout-btn active" data-layout="lr" title="Left-to-right flow">⇆ LR</button>
      <button class="sm-layout-btn"        data-layout="tb" title="Top-to-bottom flow">⇅ TB</button>
    </div>
  </div>
  <div id="graph"></div>
  <div id="legend"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Builds a Graphviz DOT representation of a state machine's state diagram. */
export function machineToDot(m: StateMachine): string {
  const lines: string[] = [];
  lines.push(`digraph "${m.name}" {`);
  lines.push('  rankdir=LR;');
  lines.push('  node [shape=box, style="rounded,filled", fillcolor="#eef2ff", fontname="Helvetica"];');
  for (const s of m.states) {
    const label = s.name.replace(/"/g, '\\"');
    const shape = s.isInitial ? 'shape=box style="rounded,filled,bold"' : '';
    lines.push(`  "${s.name}" [label="${label}" ${shape}];`);
  }
  for (const t of m.transitions) {
    const label = (t.label ?? '').replace(/"/g, '\\"');
    lines.push(`  "${t.from}" -> "${t.to}" [label="${label}"];`);
  }
  lines.push('}');
  return lines.join('\n');
}

export async function exportViaGraphviz(machine: StateMachine, output: vscode.OutputChannel) {
  const config = vscode.workspace.getConfiguration('statemachineVisualizer');
  const dotPath: string = config.get('tools.graphvizPath', '');

  const dot = machineToDot(machine);
  const dir = path.dirname(machine.file);
  const baseName = `${machine.name}.statemachine`;
  const dotFile = path.join(dir, `${baseName}.dot`);
  fs.writeFileSync(dotFile, dot, 'utf8');

  if (!dotPath) {
    const choice = await vscode.window.showInformationMessage(
      `Wrote ${baseName}.dot. Set "statemachineVisualizer.tools.graphvizPath" to your Graphviz 'dot' executable to also render an SVG automatically.`,
      'Open Settings',
    );
    if (choice === 'Open Settings') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'statemachineVisualizer.tools.graphvizPath');
    }
    return;
  }

  const svgFile = path.join(dir, `${baseName}.svg`);
  cp.execFile(dotPath, ['-Tsvg', dotFile, '-o', svgFile], (err) => {
    if (err) {
      output.appendLine(`[graphviz] export failed: ${err.message}`);
      vscode.window.showErrorMessage(`Graphviz export failed: ${err.message}`);
      return;
    }
    vscode.window.showInformationMessage(`Exported ${path.basename(svgFile)}`);
    vscode.commands.executeCommand('vscode.open', vscode.Uri.file(svgFile));
  });
}
