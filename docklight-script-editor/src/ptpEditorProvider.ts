import * as vscode from 'vscode';
import {
  parsePtp,
  serializePtp,
  detectEol,
  getSendCommands,
  sendCommandToBlock,
  editableAsciiToHex,
  ParsedPtp,
  Block,
} from './ptpModel';

type PanelState = {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  applyingOwnEdit: boolean;
};

/** Messages sent from the webview to the extension. */
type InboundMessage =
  | { type: 'ready' }
  | { type: 'editSendHex'; blockIndex: number; value: string }
  | { type: 'editSendLabelLine'; blockIndex: number; labelLineIndex: number; value: string }
  | { type: 'editSendTrailingField'; blockIndex: number; fieldIndex: number; value: string }
  | { type: 'applyAsciiEdit'; blockIndex: number; asciiText: string }
  | { type: 'addSend' }
  | { type: 'deleteSend'; blockIndex: number }
  | { type: 'duplicateSend'; blockIndex: number }
  | { type: 'moveSend'; blockIndex: number; direction: 'up' | 'down' }
  | { type: 'renumber' }
  | { type: 'editOtherLine'; blockIndex: number; lineIndex: number; value: string };

export class PtpEditorProvider implements vscode.CustomTextEditorProvider {
  public static currentProvider: PtpEditorProvider | undefined;

  private readonly panels = new Map<string, PanelState>();
  private activeUriKey: string | undefined;

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new PtpEditorProvider(context);
    PtpEditorProvider.currentProvider = provider;
    return vscode.window.registerCustomEditorProvider('docklightScriptEditor.ptp', provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    });
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  public get activeDocumentUri(): vscode.Uri | undefined {
    if (!this.activeUriKey) return undefined;
    return this.panels.get(this.activeUriKey)?.document.uri;
  }

  public addSendCommandToActive(): void {
    if (!this.activeUriKey) return;
    const state = this.panels.get(this.activeUriKey);
    if (state) this.handleAddSend(state);
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const key = document.uri.toString();
    const state: PanelState = { panel: webviewPanel, document, applyingOwnEdit: false };
    this.panels.set(key, state);
    this.activeUriKey = key;

    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    webviewPanel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) this.activeUriKey = key;
    });

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== key) return;
      if (state.applyingOwnEdit) {
        state.applyingOwnEdit = false;
        return;
      }
      this.pushModel(state);
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      this.panels.delete(key);
      if (this.activeUriKey === key) this.activeUriKey = undefined;
    });

    webviewPanel.webview.onDidReceiveMessage((msg: InboundMessage) => this.handleMessage(state, msg));
  }

  // ---------- message handling ----------

  private getSendBlockOrThrow(parsed: ParsedPtp, blockIndex: number): Block | undefined {
    const block = parsed.blocks[blockIndex];
    return block && block.keyword === 'SEND' ? block : undefined;
  }

  private handleMessage(state: PanelState, msg: InboundMessage): void {
    switch (msg.type) {
      case 'ready':
        this.pushModel(state);
        return;

      case 'editSendHex':
        this.mutate(state, (parsed) => {
          const block = this.getSendBlockOrThrow(parsed, msg.blockIndex);
          if (!block) return;
          const cmd = getSendCommands({ blocks: [block], sendBlockIndices: [0] } as ParsedPtp)[0];
          cmd.hex = msg.value;
          parsed.blocks[msg.blockIndex] = sendCommandToBlock(cmd);
        });
        return;

      case 'applyAsciiEdit':
        this.mutate(state, (parsed) => {
          const block = this.getSendBlockOrThrow(parsed, msg.blockIndex);
          if (!block) return;
          const cmd = getSendCommands({ blocks: [block], sendBlockIndices: [0] } as ParsedPtp)[0];
          cmd.hex = editableAsciiToHex(msg.asciiText);
          parsed.blocks[msg.blockIndex] = sendCommandToBlock(cmd);
        });
        return;

      case 'editSendLabelLine':
        this.mutate(state, (parsed) => {
          const block = this.getSendBlockOrThrow(parsed, msg.blockIndex);
          if (!block) return;
          const cmd = getSendCommands({ blocks: [block], sendBlockIndices: [0] } as ParsedPtp)[0];
          while (cmd.labelLines.length <= msg.labelLineIndex) cmd.labelLines.push('');
          cmd.labelLines[msg.labelLineIndex] = msg.value;
          parsed.blocks[msg.blockIndex] = sendCommandToBlock(cmd);
        });
        return;

      case 'editSendTrailingField':
        this.mutate(state, (parsed) => {
          const block = this.getSendBlockOrThrow(parsed, msg.blockIndex);
          if (!block) return;
          const cmd = getSendCommands({ blocks: [block], sendBlockIndices: [0] } as ParsedPtp)[0];
          while (cmd.trailingFields.length <= msg.fieldIndex) cmd.trailingFields.push('');
          cmd.trailingFields[msg.fieldIndex] = msg.value;
          parsed.blocks[msg.blockIndex] = sendCommandToBlock(cmd);
        });
        return;

      case 'addSend':
        this.handleAddSend(state);
        return;

      case 'deleteSend':
        this.mutate(state, (parsed) => {
          parsed.blocks.splice(msg.blockIndex, 1);
        });
        return;

      case 'duplicateSend':
        this.mutate(state, (parsed) => {
          const block = parsed.blocks[msg.blockIndex];
          if (!block) return;
          const copy: Block = { keyword: block.keyword, lines: [...block.lines] };
          parsed.blocks.splice(msg.blockIndex + 1, 0, copy);
        });
        return;

      case 'moveSend':
        this.mutate(state, (parsed) => {
          const from = msg.blockIndex;
          const to = msg.direction === 'up' ? from - 1 : from + 1;
          if (to < 0 || to >= parsed.blocks.length) return;
          const [block] = parsed.blocks.splice(from, 1);
          parsed.blocks.splice(to, 0, block);
        });
        return;

      case 'renumber':
        this.mutate(state, (parsed) => {
          let n = 0;
          for (const b of parsed.blocks) {
            if (b.keyword === 'SEND' && b.lines.length > 0) {
              b.lines[0] = String(n);
              n++;
            }
          }
        });
        return;

      case 'editOtherLine':
        this.mutate(state, (parsed) => {
          const block = parsed.blocks[msg.blockIndex];
          if (!block) return;
          block.lines[msg.lineIndex] = msg.value;
        });
        return;
    }
  }

  private handleAddSend(state: PanelState): void {
    this.mutate(state, (parsed) => {
      const newBlock: Block = { keyword: 'SEND', lines: ['0', '', ''] };
      const lastSendIdx = parsed.sendBlockIndices.length
        ? parsed.sendBlockIndices[parsed.sendBlockIndices.length - 1]
        : parsed.blocks.length - 1;
      parsed.blocks.splice(lastSendIdx + 1, 0, newBlock);
    });
  }

  /** Parse current doc, run a mutation, renumber SEND indices, write back, and push fresh state to webview. */
  private mutate(state: PanelState, fn: (parsed: ParsedPtp) => void): void {
    const parsed = parsePtp(state.document.getText());
    fn(parsed);
    parsed.sendBlockIndices = parsed.blocks
      .map((b, idx) => (b.keyword === 'SEND' ? idx : -1))
      .filter((idx) => idx !== -1);
    let n = 0;
    for (const idx of parsed.sendBlockIndices) {
      if (parsed.blocks[idx].lines.length > 0) {
        parsed.blocks[idx].lines[0] = String(n);
      }
      n++;
    }
    this.writeAndRefresh(state, parsed);
  }

  private async writeAndRefresh(state: PanelState, parsed: ParsedPtp): Promise<void> {
    const eol = detectEol(state.document.getText());
    const newText = serializePtp(parsed, eol);
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(0, 0, state.document.lineCount, 0);
    edit.replace(state.document.uri, fullRange, newText);
    state.applyingOwnEdit = true;
    await vscode.workspace.applyEdit(edit);
    this.pushModel(state);
  }

  private pushModel(state: PanelState): void {
    const parsed = parsePtp(state.document.getText());
    const sendCommands = getSendCommands(parsed);
    const otherBlocks = parsed.blocks
      .map((b, idx) => ({ block: b, idx }))
      .filter(({ block }) => block.keyword !== 'SEND')
      .map(({ block, idx }) => ({ blockIndex: idx, keyword: block.keyword, lines: block.lines }));

    state.panel.webview.postMessage({
      type: 'init',
      sendCommands,
      otherBlocks,
    });
  }

  // ---------- webview html ----------

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'style.css')
    );
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Docklight Script Editor</title>
</head>
<body>
  <div id="app">
    <div id="toolbar">
      <button id="addSendBtn" title="Add a new Send command">+ Send Command</button>
      <button id="renumberBtn" title="Renumber all Send command indices sequentially">Renumber</button>
      <input id="filterInput" type="text" placeholder="Filter commands…" />
    </div>
    <details id="otherBlocksPanel">
      <summary>Project settings (VERSION / COMMSETTINGS / COMMDISPLAY / COMMCHANNELS / other blocks)</summary>
      <div id="otherBlocksBody"></div>
    </details>
    <table id="sendTable">
      <thead>
        <tr>
          <th class="col-index">#</th>
          <th class="col-label">Name / label</th>
          <th class="col-ascii">Command (ASCII)</th>
          <th class="col-trailing" title="Meaning not confirmed from Docklight docs — shown generically">Other fields</th>
          <th class="col-actions"></th>
        </tr>
      </thead>
      <tbody id="sendTableBody"></tbody>
    </table>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
