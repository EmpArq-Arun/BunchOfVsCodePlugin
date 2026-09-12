import * as vscode from 'vscode';
import * as path from 'node:path';
import { getWebviewContent } from './webview/panel';
import { CacheManager } from './storage/cacheManager';
import { ParserService } from './parser/parserService';
import { LiveController } from './liveUpdate/liveController';
import { writeAnnotationComment } from './rename/renameWriteback';
import { renderSvg, exportDiagram, buildExportTargets } from './export/exportService';
import { registerDebugOverlay } from './debug/debugOverlay';
import type { DisplayMode, LayoutMode } from './dot/dotGenerator';

let currentPanel: vscode.WebviewPanel | undefined;
let pendingPngResolve: ((data: string) => void) | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const parserService = new ParserService(context.extensionPath);
  const cacheManager  = new CacheManager(context, parserService);
  const liveController = new LiveController(parserService, payload => {
    currentPanel?.webview.postMessage({ type: 'render', ...payload });
  });

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(d => void cacheManager.onFileSaved(d)));
  void cacheManager.maybePromptGitignore();

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection(e => {
      if (!currentPanel) return;
      void liveController.onSelectionChanged(e.textEditor.document, e.selections[0].active);
    }),
    vscode.workspace.onDidChangeTextDocument(e => {
      if (!currentPanel) return;
      const ed = vscode.window.activeTextEditor;
      if (ed?.document === e.document) liveController.onDocumentChanged(e.document, ed.selection.active);
    })
  );

  registerDebugOverlay(context, liveController, nodeId => {
    currentPanel?.webview.postMessage({ type: 'highlight', nodeId });
  });

  const showCommand = vscode.commands.registerCommand('vistacode.showFlowchart', () => {
    if (currentPanel) { currentPanel.reveal(vscode.ViewColumn.Beside); return; }

    currentPanel = vscode.window.createWebviewPanel(
      'vistacodeFlowchart', 'Vistacode', vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] }
    );
    currentPanel.webview.html = getWebviewContent(currentPanel.webview, context.extensionUri);

    currentPanel.webview.onDidReceiveMessage(
      async (msg: { type: string; nodeId?: string; currentLabel?: string; row?: number;
                    mode?: DisplayMode; layout?: LayoutMode; data?: string }) => {
        switch (msg.type) {
          case 'ready': {
            const p = liveController.getCurrentPayload();
            if (p) currentPanel?.webview.postMessage({ type: 'render', ...p });
            break;
          }
          case 'changeDisplayMode':
            if (msg.mode) liveController.setDisplayMode(msg.mode);
            break;
          case 'changeLayout':
            if (msg.layout) await liveController.setLayout(msg.layout);
            break;
          case 'renameRequest': {
            if (!msg.nodeId) break;
            const graph = liveController.getCurrentGraph();
            const doc   = liveController.getCurrentDocument();
            if (!graph || !doc) break;
            const node = graph.nodes.get(msg.nodeId);
            if (!node || node.kind === 'entry' || node.kind === 'exit') break;
            const label = await vscode.window.showInputBox({
              prompt: 'Vistacode: label for this node',
              value: msg.currentLabel ?? node.label,
              placeHolder: 'Short description of what this step does'
            });
            if (label?.trim()) await writeAnnotationComment(doc, node.anchorRange, label.trim());
            break;
          }
          case 'navigateToLine': {
            if (typeof msg.row !== 'number') break;
            const doc = liveController.getCurrentDocument(); if (!doc) break;
            const eds = vscode.window.visibleTextEditors.filter(e => e.document === doc);
            const ed  = eds[0] ?? await vscode.window.showTextDocument(doc, vscode.ViewColumn.One, false);
            const pos = new vscode.Position(msg.row, 0);
            ed.selection = new vscode.Selection(pos, pos);
            ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
            break;
          }
          case 'pngData':
            pendingPngResolve?.(msg.data ?? '');
            pendingPngResolve = null;
            break;
        }
      },
      undefined, context.subscriptions
    );
    currentPanel.onDidDispose(() => { currentPanel = undefined; }, null, context.subscriptions);
    const ed = vscode.window.activeTextEditor;
    if (ed) void liveController.onSelectionChanged(ed.document, ed.selection.active);
  });
  context.subscriptions.push(showCommand);

  const exportCommand = vscode.commands.registerCommand('vistacode.exportDiagram', async () => {
    const payload = liveController.getCurrentPayload();
    const doc     = liveController.getCurrentDocument();
    if (!payload || !doc) { void vscode.window.showWarningMessage('Vistacode: open a flowchart first.'); return; }

    const defDir = cacheManager.resolveExportPath(doc);
    let tgtDir   = defDir;
    const choice = await vscode.window.showQuickPick(['Use default location', 'Choose location…'],
      { placeHolder: defDir ? `Default: ${defDir.fsPath}` : 'Choose a location' });
    if (!choice) return;
    if (choice === 'Choose location…' || !defDir) {
      const picked = await vscode.window.showSaveDialog({ saveLabel: 'Export here', defaultUri: defDir });
      if (!picked) return;
      tgtDir = vscode.Uri.file(path.dirname(picked.fsPath));
    }
    if (!tgtDir) return;

    const safeName = payload.functionKey.replace(/@[0-9a-f]+$/, '');
    const targets  = buildExportTargets(tgtDir, safeName);

    // DOT — from live model
    await vscode.workspace.fs.writeFile(targets.dotUri, Buffer.from(payload.dot, 'utf8'));

    // SVG — re-render from dot in extension host (high-quality Graphviz output)
    try {
      const svg = await renderSvg(payload.dot);
      await vscode.workspace.fs.writeFile(targets.svgUri, Buffer.from(svg, 'utf8'));
    } catch { void vscode.window.showWarningMessage('Vistacode: SVG export failed.'); }

    // PNG — request from webview (Cytoscape canvas, preserves user's node arrangement)
    if (currentPanel) {
      try {
        const pngB64 = await new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => { pendingPngResolve = null; reject(new Error('timeout')); }, 8000);
          pendingPngResolve = d => { clearTimeout(t); resolve(d); };
          currentPanel!.webview.postMessage({ type: 'requestPng' });
        });
        if (pngB64) {
          const buf = Buffer.from(pngB64.replace(/^data:image\/png;base64,/, ''), 'base64');
          await vscode.workspace.fs.writeFile(targets.pngUri, buf);
        }
      } catch { void vscode.window.showWarningMessage('Vistacode: PNG export failed (panel may be hidden).'); }
    }

    void vscode.window.showInformationMessage(`Vistacode: exported ${safeName} to ${tgtDir.fsPath}`);
  });
  context.subscriptions.push(exportCommand);
}
export function deactivate(): void {}
