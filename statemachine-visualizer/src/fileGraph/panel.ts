import * as vscode from 'vscode';
import { buildFileInteractionGraph } from './scanner';
import { WorkspaceScanner } from '../scanner';

export class FileGraphPanel {
  private panel: vscode.WebviewPanel | undefined;
  private focusFile: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
    private readonly smScanner: WorkspaceScanner,
  ) {}

  async open(filePath?: string): Promise<void> {
    this.focusFile = filePath;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'statemachineVisualizer.fileGraph', 'C/C++ Dependency Graph',
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')] },
      );
      this.panel.webview.html = this.buildHtml(this.panel.webview);
      this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
      this.panel.onDidDispose(() => { this.panel = undefined; });
      // Do NOT call refresh() here – VS Code silently drops postMessage calls
      // made before the webview script has registered its listener.
      // Instead, the webview sends { type: 'ready' } once loaded, which triggers refresh.
    } else {
      // Panel already exists (retainContextWhenHidden) – script is alive, safe to message
      this.panel.reveal();
      await this.refresh();
      return;
    }
    this.panel.reveal();
  }

  /** Called on file save — partial refresh if panel is open */
  async onFileSaved(uri: vscode.Uri): Promise<void> {
    if (!this.panel) return;
    await this.refresh();
  }

  isOpen(): boolean { return !!this.panel; }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    this.panel.webview.postMessage({ type: 'loading' });
    try {
      const smData = new Map<string, string[]>();
      for (const m of this.smScanner.getAllMachines()) {
        const list = smData.get(m.file) ?? []; list.push(m.name); smData.set(m.file, list);
      }
      const graph = await buildFileInteractionGraph(this.output, smData);
      this.panel.webview.postMessage({ type: 'loadGraph', graph, focusFile: this.focusFile });
    } catch (e: any) {
      this.panel.webview.postMessage({ type: 'error', message: String(e?.message ?? e) });
    }
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg?.type) {
      case 'ready':
        // Webview script is now loaded and listening – safe to send data
        await this.refresh();
        break;
      case 'revealFile': {
        try {
          const doc = await vscode.workspace.openTextDocument(msg.file);
          // Use ViewColumn.Active so it opens in the same column as existing editors
          const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preserveFocus: false });
          const pos = new vscode.Position(Math.max(0, (msg.line ?? 1) - 1), 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        } catch (e) { this.output.appendLine(`[fileGraph] open: ${e}`); }
        break;
      }
      case 'openSM':
        vscode.commands.executeCommand('statemachineVisualizer.openSMForFile', msg.file);
        break;
      case 'refresh':
        await this.refresh();
        break;
    }
  }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'fileGraph.js'));
    const nonce = `${Date.now()}`;
    const csp = [`default-src 'none'`, `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`, `script-src 'nonce-${nonce}'`].join('; ');
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"/>
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;width:100%;overflow:hidden;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-foreground,#ddd);font-family:var(--vscode-font-family,sans-serif);font-size:12px}
#app{display:flex;flex-direction:column;height:100vh;width:100vw}
#toolbar{display:flex;align-items:center;gap:5px;padding:4px 8px;border-bottom:1px solid var(--vscode-panel-border,#333);flex-shrink:0;flex-wrap:wrap;min-height:34px}
#main{display:flex;flex:1 1 0;min-height:0;overflow:hidden;position:relative}
#graph{flex:1 1 0;min-width:0;min-height:0}
#resize-handle{width:5px;flex-shrink:0;cursor:col-resize;background:var(--vscode-panel-border,#2d2d2d)}
#resize-handle:hover,#resize-handle.dragging{background:#4f8cff}
#sidebar{width:220px;flex-shrink:0;display:flex;flex-direction:column;overflow:hidden;border-left:1px solid var(--vscode-panel-border,#333)}
#sidebar.collapsed{width:0!important;border:none}
#loading{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:var(--vscode-editor-background,#1e1e1e);z-index:100;font-size:13px;opacity:.9}
#loading-spinner{width:26px;height:26px;border:3px solid #444;border-top-color:#4f8cff;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
button{background:var(--vscode-button-secondaryBackground,#3a3d41);color:var(--vscode-foreground,#ddd);border:none;padding:3px 8px;border-radius:3px;cursor:pointer;font-size:11px;white-space:nowrap}
button.active{background:var(--vscode-button-background,#0e639c);color:#fff}
button:disabled{opacity:.4;cursor:default}
.tsep{width:1px;height:16px;background:#555;margin:0 2px;flex-shrink:0}
#breadcrumb{font-size:11px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#stats{margin-left:auto;opacity:.5;font-size:10.5px;flex-shrink:0;white-space:nowrap}
#legend-panel{padding:8px;overflow-y:auto;flex:1}
#legend-panel h3{font-size:10px;opacity:.6;margin:6px 0 4px;text-transform:uppercase;letter-spacing:.4px}
.leg-item{display:flex;align-items:center;gap:5px;padding:2px 0;cursor:pointer;user-select:none}
.leg-item input[type=checkbox]{cursor:pointer;accent-color:#4f8cff}
.leg-dot{width:16px;height:3px;border-radius:2px;flex-shrink:0}
.leg-item label{cursor:pointer;font-size:10.5px}
.leg-item.disabled label{opacity:.4;text-decoration:line-through}
#info-panel{border-top:none;padding:8px;font-size:11px;display:none;max-height:280px;overflow-y:auto;flex-shrink:0}
#vresize{height:5px;flex-shrink:0;cursor:row-resize;background:var(--vscode-panel-border,#2d2d2d);display:none}
#vresize:hover,#vresize.dragging{background:#4f8cff}
#info-title{font-weight:bold;font-size:12px;margin-bottom:2px}
#info-path{font-size:9px;opacity:.45;margin-bottom:6px;word-break:break-all}
#info-body{line-height:1.5;opacity:.85}
#info-actions{margin-top:6px;display:flex;gap:5px;flex-wrap:wrap}
#tooltip{position:fixed;pointer-events:none;z-index:999;display:none;background:var(--vscode-editorHoverWidget-background,#252526);border:1px solid var(--vscode-panel-border,#444);border-radius:5px;max-width:360px;font-size:11px;box-shadow:0 4px 12px #0008;min-width:180px}
.tip-header{padding:7px 10px 5px;font-weight:bold;border-bottom:1px solid #3338;font-size:11.5px}
.tip-kind{padding:4px 10px 2px;opacity:.6;font-size:9.5px;text-transform:uppercase;letter-spacing:.5px}
.tip-list{padding:2px 10px 6px;margin:0;list-style:none}
.tip-list li{padding:1px 0;font-family:monospace;font-size:10px;opacity:.9}
.tip-list li::before{content:"\u2022 ";opacity:.45}
</style></head>
<body>
<div id="app">
  <div id="toolbar">
    <button id="btn-back" disabled title="Back to previous view">↩</button>
    <div class="tsep"></div>
    <button class="layout-btn" data-layout="radial" title="Force/Radial">⊙ Radial</button>
    <button class="layout-btn active" data-layout="lr" title="Left→Right">⇆ LR</button>
    <button class="layout-btn" data-layout="tb" title="Top→Bottom">⇅ TB</button>
    <div class="tsep"></div>
    <button id="btn-refresh" title="Re-scan workspace">⟳</button>
    <button id="btn-fit" title="Fit to window">⤢ Fit</button>
    <button id="btn-collapse-all" title="Collapse all">⊟</button>
    <button id="btn-toggle-sidebar" title="Toggle panel">◀ Panel</button>
    <span id="breadcrumb">Workspace</span>
    <span id="stats"></span>
  </div>
  <div id="main">
    <div id="graph"></div>
    <div id="resize-handle"></div>
    <div id="sidebar">
      <div id="legend-panel">
        <h3>Connections</h3>
        <div class="leg-item" data-kind="call"><input type="checkbox" id="lg-call" checked><span class="leg-dot" style="background:#4f8cff"></span><label for="lg-call">Function calls</label></div>
        <div class="leg-item" data-kind="include"><input type="checkbox" id="lg-inc" checked><span class="leg-dot" style="background:#6c7280"></span><label for="lg-inc">#include</label></div>
        <div class="leg-item" data-kind="extern"><input type="checkbox" id="lg-ext" checked><span class="leg-dot" style="background:#ff6b6b"></span><label for="lg-ext">extern var</label></div>
        <div class="leg-item" data-kind="inherit"><input type="checkbox" id="lg-inh" checked><span class="leg-dot" style="background:#a855f7"></span><label for="lg-inh">Inheritance</label></div>
        <div class="leg-item" data-kind="typedef"><input type="checkbox" id="lg-tdf" checked><span class="leg-dot" style="background:none;border-top:2px dashed #f59e0b;width:16px;height:0"></span><label for="lg-tdf">Type usage</label></div>
        <h3>Nodes</h3>
        <div style="font-size:10px;opacity:.65;line-height:1.7">
          📁 Folder — <b>click</b> to expand<br>
          🟦 File — <b>click</b> to expand fns<br>
          ▶ green = exported symbol<br>
          ◀ orange = imported symbol<br>
          ⊡ = state machine file
        </div>
        <h3>Navigate</h3>
        <div style="font-size:10px;opacity:.55;line-height:1.7">
          Click folder → see files<br>
          Click file → see functions<br>
          Click again → collapse<br>
          ↩ → go back<br>
          Hover edge → details popup<br>
          Click edge → open source
        </div>
      </div>
      <div id="vresize"></div>
      <div id="info-panel" style="border-top:1px solid var(--vscode-panel-border,#333)">
        <div id="info-title"></div>
        <div id="info-path"></div>
        <div id="info-body"></div>
        <div id="info-actions"></div>
      </div>
    </div>
  </div>
</div>
<div id="loading"><div id="loading-spinner"></div><span id="loading-text">Scanning…</span></div>
<div id="tooltip"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
  }
}
