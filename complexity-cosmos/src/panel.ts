import * as vscode from 'vscode';
import { FunctionMetric, MetricKey } from './analyzer';

export interface PanelData {
  metric: MetricKey;
  thresholds: Record<MetricKey, number>;
  file: string;
  functions: Array<FunctionMetric & { hist: Record<MetricKey, number[]> }>;
}

export interface PanelHandlers {
  onReveal: (file: string, start: number) => void;
  onSetMetric: (metric: MetricKey) => void;
  onSetThreshold: (metric: MetricKey, value: number) => void;
}

export class CosmosPanel {
  public static current: CosmosPanel | undefined;
  private static readonly viewType = 'complexityCosmos.panel';

  private ready = false;
  private pending: PanelData | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly handlers: PanelHandlers,
  ) {
    this.panel.webview.html = this.html(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
  }

  static createOrShow(extensionUri: vscode.Uri, handlers: PanelHandlers): CosmosPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (CosmosPanel.current) {
      CosmosPanel.current.panel.reveal(column);
      return CosmosPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(
      CosmosPanel.viewType,
      'Complexity Cosmos',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    );
    CosmosPanel.current = new CosmosPanel(panel, extensionUri, handlers);
    return CosmosPanel.current;
  }

  update(data: PanelData): void {
    this.pending = data;
    if (this.ready) { this.panel.webview.postMessage({ type: 'data', ...data }); }
  }

  private onMessage(msg: { type: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        if (this.pending) { this.panel.webview.postMessage({ type: 'data', ...this.pending }); }
        break;
      case 'reveal':
        this.handlers.onReveal(String(msg.file), Number(msg.start));
        break;
      case 'setMetric':
        this.handlers.onSetMetric(msg.metric as MetricKey);
        break;
      case 'setThreshold':
        this.handlers.onSetThreshold(msg.metric as MetricKey, Number(msg.value));
        break;
    }
  }

  dispose(): void {
    CosmosPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) { this.disposables.pop()?.dispose(); }
  }

  private html(webview: vscode.Webview): string {
    const nonce = nonceStr();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link href="${styleUri}" rel="stylesheet" />
<title>Complexity Cosmos</title></head>
<body><div class="wrap">
  <header class="top">
    <div class="title">Complexity Cosmos
      <small>Functions in <code id="file">—</code> — gravity scales with complexity</small></div>
    <div class="controls">
      <div class="ctl"><label for="metric">Metric</label><select id="metric"></select></div>
      <div class="ctl"><label for="thr">Flag above</label><input id="thr" type="number" min="1" /></div>
    </div>
  </header>
  <section class="scale" id="scale"></section>
  <div class="list" id="list"></div>
</div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
  }
}

function nonceStr(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) { s += chars.charAt(Math.floor(Math.random() * chars.length)); }
  return s;
}
