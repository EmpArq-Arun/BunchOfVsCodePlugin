import * as vscode from 'vscode';
import * as fs from 'fs';

export type ViewId = 'terminal' | 'response' | 'graph';

const TITLES: Record<ViewId, string> = {
  terminal: 'Serial Terminal',
  response: 'Serial Response',
  graph: 'Serial Plotter'
};

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

/** Creates/reuses one webview panel per view id and routes messages to the hub. */
export class PanelManager {
  private panels = new Map<ViewId, vscode.WebviewPanel>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onMessage: (view: ViewId, message: any) => void,
    private readonly onReveal: (view: ViewId) => void
  ) {}

  isOpen(view: ViewId): boolean {
    return this.panels.has(view);
  }

  show(view: ViewId, column: vscode.ViewColumn = vscode.ViewColumn.Active): vscode.WebviewPanel {
    const existing = this.panels.get(view);
    if (existing) {
      existing.reveal(existing.viewColumn ?? column, true);
      return existing;
    }

    const panel = vscode.window.createWebviewPanel(
      `serialTerminalPlus.${view}`,
      TITLES[view],
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
      }
    );

    panel.webview.html = this.render(panel.webview, view);
    panel.webview.onDidReceiveMessage(
      (message) => {
        if (message?.type === 'ready') {
          this.onReveal(view);
          return;
        }
        this.onMessage(view, message);
      },
      undefined,
      this.context.subscriptions
    );
    panel.onDidDispose(() => this.panels.delete(view), undefined, this.context.subscriptions);

    this.panels.set(view, panel);
    return panel;
  }

  post(view: ViewId, message: unknown): void {
    const panel = this.panels.get(view);
    if (panel) {
      void panel.webview.postMessage(message);
    }
  }

  broadcast(message: unknown): void {
    for (const panel of this.panels.values()) {
      void panel.webview.postMessage(message);
    }
  }

  private render(webview: vscode.Webview, view: ViewId): string {
    const mediaRoot = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const htmlPath = vscode.Uri.joinPath(mediaRoot, `${view}.html`).fsPath;
    const raw = fs.readFileSync(htmlPath, 'utf8');
    const n = nonce();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'common.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, `${view}.js`));
    return raw
      .replace(/{{cspSource}}/g, webview.cspSource)
      .replace(/{{nonce}}/g, n)
      .replace(/{{styleUri}}/g, styleUri.toString())
      .replace(/{{scriptUri}}/g, scriptUri.toString());
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }
}
