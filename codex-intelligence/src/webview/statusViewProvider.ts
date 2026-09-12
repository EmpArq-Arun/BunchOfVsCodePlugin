import * as vscode from 'vscode';
import { CodexDB } from '../db/codexDB';
import { readLLMConfig } from '../agent/llmClient';

interface StatusMessage { type: string; }

export class StatusViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getDb: () => CodexDB | null
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this.refresh();
    webviewView.webview.onDidReceiveMessage(async (msg: StatusMessage) => {
      if      (msg.type === 'rebuild')      { await vscode.commands.executeCommand('codex.rebuildAll'); }
      else if (msg.type === 'setVendor')    { await vscode.commands.executeCommand('codex.setVendor'); }
      else if (msg.type === 'setProvider')  { await vscode.commands.executeCommand('codex.setProvider'); }
      else if (msg.type === 'openArch')     { await vscode.commands.executeCommand('codex.openArchitecture'); }
      else if (msg.type === 'setFormat')    { await vscode.commands.executeCommand('codex.setDiagramFormat'); }
      else if (msg.type === 'openSettings') { await vscode.commands.executeCommand('workbench.action.openSettings', 'codex'); }
    });
  }

  refresh(): void {
    if (!this.view) { return; }
    let label = 'Unknown', adapter = '';
    try { const c = readLLMConfig(); label = c.label; adapter = c.adapter; } catch { label = 'Not configured'; }
    const db  = this.getDb();
    const cfg = vscode.workspace.getConfiguration('codex');
    const vendor = cfg.get<string>('vendorProfile', 'stm32');
    const fmt    = cfg.get<string>('diagramFormat', 'plantuml');

    if (!db) { this.view.webview.html = this.noWorkspaceHtml(label, adapter); return; }

    try {
      const s = db.getStats();
      this.view.webview.html = this.mainHtml(s, vendor, label, adapter, fmt);
    } catch {
      this.view.webview.html = this.noWorkspaceHtml(label, adapter);
    }
  }

  private css = `
    body{font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-foreground);padding:10px}
    .stat{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--vscode-panel-border)}
    .val{font-weight:bold;max-width:65%;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .adapter{display:inline-block;font-size:10px;padding:1px 6px;border-radius:3px;margin-left:4px;font-weight:500}
    .a-openai{background:#E1F5EE;color:#085041} .a-anthropic{background:#EEEDFE;color:#3C3489} .a-gemini{background:#FAEEDA;color:#633806}
    .warning{color:var(--vscode-editorWarning-foreground);margin-top:8px;font-size:11px}
    .ok{color:var(--vscode-testing-iconPassed);margin-top:8px;font-size:11px}
    .muted{color:var(--vscode-descriptionForeground);margin-top:8px;font-size:11px}
    .btn{margin-top:8px;width:100%;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;border-radius:4px;padding:5px;cursor:pointer;font-size:12px}
    .btn.sec{background:transparent;color:var(--vscode-foreground);border:1px solid var(--vscode-panel-border);margin-top:4px}
    @media(prefers-color-scheme:dark){.a-openai{background:#04342C;color:#9FE1CB}.a-anthropic{background:#26215C;color:#CECBF6}.a-gemini{background:#412402;color:#FAC775}}`;

  private badge(adapter: string): string {
    return adapter ? `<span class="adapter a-${adapter}">${adapter}</span>` : '';
  }

  private noWorkspaceHtml(label: string, adapter: string): string {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${this.css}</style></head><body>
<div class="stat"><span>LLM</span><span class="val" title="${label}">${label}${this.badge(adapter)}</span></div>
<div class="muted">Open a folder to start indexing.</div>
<button class="btn sec" onclick="vscode.postMessage({type:'setProvider'})">Switch LLM provider</button>
<button class="btn sec" onclick="vscode.postMessage({type:'openSettings'})">Settings</button>
<script>const vscode=acquireVsCodeApi();</script></body></html>`;
  }

  private mainHtml(s: import('../db/codexDB').DBStats, vendor: string, label: string, adapter: string, fmt: string): string {
    const staleHtml = s.staleCount > 0
      ? `<div class="warning">&#9888; ${s.staleCount} stale — save files to update</div>`
      : '<div class="ok">&#10003; DB up to date</div>';
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${this.css}</style></head><body>
<div class="stat"><span>Functions indexed</span><span class="val">${s.functionCount}</span></div>
<div class="stat"><span>Modules (file-level)</span><span class="val">${s.moduleCount}</span></div>
<div class="stat"><span>Folders (every depth)</span><span class="val">${s.folderCount}</span></div>
<div class="stat"><span>Diagrams (.puml)</span><span class="val">${s.diagramCount}</span></div>
<div class="stat"><span>Vendor</span><span class="val">${vendor}</span></div>
<div class="stat"><span>Diagram format</span><span class="val">${fmt}</span></div>
<div class="stat"><span>LLM</span><span class="val" title="${label}">${label}${this.badge(adapter)}</span></div>
${staleHtml}
<button class="btn" onclick="vscode.postMessage({type:'openArch'})">Open architecture overview</button>
<button class="btn sec" onclick="vscode.postMessage({type:'rebuild'})">Rebuild all</button>
<button class="btn sec" onclick="vscode.postMessage({type:'setFormat'})">Switch diagram format</button>
<button class="btn sec" onclick="vscode.postMessage({type:'setVendor'})">Switch vendor</button>
<button class="btn sec" onclick="vscode.postMessage({type:'setProvider'})">Switch LLM provider</button>
<button class="btn sec" onclick="vscode.postMessage({type:'openSettings'})">Settings</button>
<script>const vscode=acquireVsCodeApi();</script></body></html>`;
  }
}
