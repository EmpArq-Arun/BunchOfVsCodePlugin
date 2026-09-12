import * as vscode from 'vscode';
import { WorkspaceIndex } from './parser/workspaceIndex';
import { buildCallGraph } from './parser/heuristicGraphBuilder';
import { toDot, toMermaid } from './export/graphExport';
import { renderSvgWithGraphviz } from './export/graphvizRunner';
import { resolveSemanticConfig } from './semantic/resolveConfig';
import { enrichCallGraph } from './semantic/semanticEnrichment';
import * as diag from './diagnostics';
import {
  CallGraphData,
  ClassGraphData,
  CallEdge,
  FunctionNode,
  SourceLocation,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
} from './types';

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

function edgeKey(e: CallEdge): string {
  return `${e.callerId}|${e.calleeId}|${e.callSite.line}|${e.callSite.column}`;
}

export class CallGraphPanel {
  private static current: CallGraphPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly accumulatedNodes: Record<string, FunctionNode> = {};
  private readonly accumulatedEdges = new Map<string, CallEdge>();
  private readonly accumulatedDepths: Record<string, number> = {};
  private currentComputedDepth = 0;
  private currentTruncated = false;
  private rootId: string | undefined;
  private rootFunctionName: string | undefined;  // for re-homing after file save
  private rootFunctionFile: string | undefined;
  private mode: 'callgraph' | 'classDiagram' = 'callgraph';
  private lastDiagramType: 'uml' | 'hierarchy' | 'usage' = 'uml';

  /** Called by the file watcher (debounced) — re-scans and re-renders the active panel if one is open. */
  static async refreshCurrent(index: WorkspaceIndex): Promise<void> {
    const panel = CallGraphPanel.current;
    if (!panel) return;

    if (panel.mode === 'classDiagram') {
      await panel.loadClassUml(index, panel.lastDiagramType ?? 'uml', undefined);
      return;
    }

    if (!panel.rootFunctionName || !panel.rootFunctionFile) return;
    await index.ensureFresh();

    // Re-locate the root function by name in the same file (its offset may have
    // shifted due to edits, but its name in its file should be stable).
    const fn = index.getAllFunctions().find(
      (f) => f.name === panel.rootFunctionName && f.location.file === panel.rootFunctionFile,
    );
    if (!fn) return; // function deleted/renamed — don't crash, let the user re-trigger manually

    panel.resetAccumulation();
    await panel.loadGraph(index, fn.id);
  }

  static async createOrShow(context: vscode.ExtensionContext, index: WorkspaceIndex, rootId: string) {
    if (CallGraphPanel.current) {
      CallGraphPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      CallGraphPanel.current.mode = 'callgraph';
      CallGraphPanel.current.resetAccumulation();
      await CallGraphPanel.current.loadGraph(index, rootId);
      return;
    }
    const instance = new CallGraphPanel(context, index);
    await instance.loadGraph(index, rootId);
  }

  static async createOrShowClassDiagram(
    context: vscode.ExtensionContext,
    index: WorkspaceIndex,
    diagramType: 'uml' | 'hierarchy' | 'usage' = 'uml',
    rootClassId?: string,
  ) {
    if (CallGraphPanel.current) {
      CallGraphPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      CallGraphPanel.current.mode = 'classDiagram';
      await CallGraphPanel.current.loadClassUml(index, diagramType, rootClassId);
      return;
    }
    const instance = new CallGraphPanel(context, index);
    instance.mode = 'classDiagram';
    await instance.loadClassUml(index, diagramType, rootClassId);
  }

  private constructor(private readonly context: vscode.ExtensionContext, private readonly index: WorkspaceIndex) {
    this.panel = vscode.window.createWebviewPanel(
      'callgraph',
      'C/C++ Call Graph',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    );

    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => {
      CallGraphPanel.current = undefined;
    });
    this.panel.webview.onDidReceiveMessage((msg: WebviewToExtensionMessage) => this.handleMessage(msg));

    CallGraphPanel.current = this;
  }

  private sendUiConfig() {
    const cfg = vscode.workspace.getConfiguration('callgraph');
    this.post({
      type: 'uiConfig',
      popup: {
        fontSize: cfg.get<number>('popup.fontSize', 12),
        width:    cfg.get<number>('popup.width',    440),
        height:   cfg.get<number>('popup.height',   280),
      },
    });
  }

  private resetAccumulation() {
    for (const k of Object.keys(this.accumulatedNodes)) delete this.accumulatedNodes[k];
    for (const k of Object.keys(this.accumulatedDepths)) delete this.accumulatedDepths[k];
    this.accumulatedEdges.clear();
    this.currentComputedDepth = 0;
    this.currentTruncated = false;
    this.rootId = undefined;
    this.rootFunctionName = undefined;
    this.rootFunctionFile = undefined;
  }

  private getHtml(): string {
    const webview = this.panel.webview;
    const mediaUri = (...segs: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', ...segs));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<link rel="stylesheet" href="${mediaUri('webview.css')}" />
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${mediaUri('vendor', 'cytoscape.min.js')}"></script>
<script nonce="${nonce}" src="${mediaUri('vendor', 'dagre.min.js')}"></script>
<script nonce="${nonce}" src="${mediaUri('vendor', 'cytoscape-dagre.min.js')}"></script>
<script nonce="${nonce}" src="${mediaUri('webview.js')}"></script>
</body>
</html>`;
  }

  private mergeIntoAccumulated(data: CallGraphData, depthOffset = 0) {
    Object.assign(this.accumulatedNodes, data.nodes);
    for (const e of data.edges) {
      this.accumulatedEdges.set(edgeKey(e), e);
    }
    for (const [id, d] of Object.entries(data.nodeDepths)) {
      const offsetDepth = d + depthOffset;
      if (this.accumulatedDepths[id] === undefined || offsetDepth < this.accumulatedDepths[id]) {
        this.accumulatedDepths[id] = offsetDepth;
      }
    }
    this.currentComputedDepth = Math.max(this.currentComputedDepth, data.computedDepth + depthOffset);
    this.currentTruncated = this.currentTruncated || data.truncated;
  }

  private async loadGraph(index: WorkspaceIndex, rootId: string, depth = 20, depthOffset = 0) {
    await index.ensureFresh();
    if (!this.rootId) {
      // first call — anchor to this function name+file for auto-refresh after saves
      this.rootId = rootId;
      const fn = index.getFunction(rootId);
      if (fn) {
        this.rootFunctionName = fn.name;
        this.rootFunctionFile = fn.location.file;
      }
    }
    const cfg = vscode.workspace.getConfiguration('callgraph');
    const maxNodes = cfg.get<number>('maxVisibleNodes', 500);
    try {
      let data = buildCallGraph(index, rootId, Math.min(depth, 20), maxNodes);

      const semanticCfg = resolveSemanticConfig();
      if (semanticCfg) {
        this.post({ type: 'enrichmentStatus', status: 'checking' });
        diag.setStatusBarMode('verifying');
        try {
          data = await enrichCallGraph(data, index, semanticCfg);
          diag.setStatusBarMode('verified');
        } catch (enrichErr: any) {
          diag.logError(`Enrichment failed: ${enrichErr?.message ?? enrichErr}`);
          diag.setStatusBarMode('error');
        }
        this.post({ type: 'enrichmentStatus', status: 'idle' });
      } else {
        diag.setStatusBarMode('heuristic');
      }

      this.mergeIntoAccumulated(data, depthOffset);
      this.postGraph();
    } catch (err: any) {
      this.post({ type: 'error', message: err?.message ?? String(err) });
    }
  }

  private async loadClassUml(index: WorkspaceIndex, diagramType: 'uml' | 'hierarchy' | 'usage', rootClassId?: string) {
    this.lastDiagramType = diagramType;
    await index.ensureFresh();
    const data = index.buildClassGraph(diagramType, rootClassId);

    // Optional ctags enrichment for usage diagram
    const cfg = vscode.workspace.getConfiguration('callgraph');
    const ctagsPath = cfg.get<string>('ctagsPath', '').trim();
    if (ctagsPath && diagramType === 'usage') {
      const folders = vscode.workspace.workspaceFolders;
      if (folders) {
        try {
          const { runCtags, buildTypeUsageMap } = await import('./semantic/ctagsIndex');
          const entries = await runCtags(ctagsPath, folders[0].uri.fsPath);
          const usageMap = buildTypeUsageMap(entries);
          // Inject usage edges: class A is used by file F → if F contains functions, show A→B edges
          for (const [className, files] of usageMap) {
            const callerClass = [...Object.values(data.classes)].find(c => c.name === className);
            if (!callerClass) continue;
            for (const filePath of files) {
              const usersInFile = [...Object.values(data.classes)].filter(c => c.location.file === filePath && c.id !== callerClass.id);
              for (const userCls of usersInFile) {
                const edgeId = `${userCls.id}→${callerClass.id}:usage`;
                if (!data.edges.find(e => e.fromId === userCls.id && e.toId === callerClass.id)) {
                  data.edges.push({ fromId: userCls.id, toId: callerClass.id, kind: 'dependency', access: 'public' });
                }
              }
            }
          }
        } catch { /* ctags optional */ }
      }
    }

    this.post({ type: 'classUml', data });
  }

  private postGraph() {
    if (!this.rootId) return;
    const cfg = vscode.workspace.getConfiguration('callgraph');
    const data: CallGraphData = {
      rootId: this.rootId,
      nodes: this.accumulatedNodes,
      edges: [...this.accumulatedEdges.values()],
      nodeDepths: { ...this.accumulatedDepths },
      mode: 'heuristic',
      computedDepth: this.currentComputedDepth,
      truncated: this.currentTruncated,
      defaultDepth: cfg.get<number>('defaultDepth', 5),
    };
    this.post({ type: 'graph', data });
  }

  private post(msg: ExtensionToWebviewMessage) {
    this.panel.webview.postMessage(msg);
  }

  private async handleMessage(msg: WebviewToExtensionMessage) {
    switch (msg.type) {
      case 'ready':
        this.sendUiConfig();
        if (this.mode === 'classDiagram') await this.loadClassUml(this.index, this.lastDiagramType);
        else this.postGraph();
        return;

      case 'expandNode': {
        const offset = this.accumulatedDepths[msg.nodeId] ?? 0;
        await this.loadGraph(this.index, msg.nodeId, msg.depth, offset);
        return;
      }

      case 'requestDepth':
        if (this.rootId) {
          const cfg = vscode.workspace.getConfiguration('callgraph');
          const maxNodes = (cfg.get<number>('maxVisibleNodes', 500)) * 2; // widen the cap on an explicit deeper request
          try {
            const data = buildCallGraph(this.index, this.rootId, Math.min(msg.depth, 20), maxNodes);
            this.mergeIntoAccumulated(data);
            this.postGraph();
          } catch (err: any) {
            this.post({ type: 'error', message: err?.message ?? String(err) });
          }
        }
        return;

      case 'requestSource':
        await this.sendSource(msg.nodeId);
        return;

      case 'openLocation':
        await this.openLocation(msg.location);
        return;

      case 'exportGraph':
        await this.exportGraph(msg.format);
        return;
    }
  }

  private async sendSource(nodeId: string) {
    const fn = this.index.getFunction(nodeId);
    if (!fn) return;
    try {
      const uri = this.resolveUri(fn.location.file);
      const doc = await vscode.workspace.openTextDocument(uri);

      // Use the parsed body range when available (includes closing brace),
      // otherwise fall back to up to 60 lines from the definition start.
      const range = this.index.getFunctionRange(nodeId);
      const bodyEnd = range
        ? Math.min(doc.lineCount - 1, range.endLine)          // 1-based, inclusive
        : Math.min(doc.lineCount - 1, fn.location.line + 59); // 1-based

      // Walk back from the function definition line to collect preceding
      // doc comments (/** ... */ or // lines).  Stop at a blank line or
      // non-comment, non-blank line.
      let commentStart = fn.location.line - 1; // convert to 0-based
      for (let i = commentStart - 1; i >= Math.max(0, commentStart - 12); i--) {
        const t = doc.lineAt(i).text.trim();
        if (t === '') break;
        if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.endsWith('*/')) {
          commentStart = i;
        } else break;
      }

      // Extract exactly the comment + function span.
      const startLine0 = commentStart;       // 0-based inclusive
      const endLine0   = bodyEnd - 1;         // convert from 1-based to 0-based
      const text = doc.getText(
        new vscode.Range(startLine0, 0, endLine0, doc.lineAt(endLine0).text.length),
      );
      this.post({ type: 'sourceSnippet', nodeId, source: text, startLine: startLine0 + 1 }); // 1-based
    } catch {
      this.post({ type: 'error', message: `Could not load source for ${fn.name}` });
    }
  }

  private async openLocation(loc: SourceLocation) {
    try {
      const uri = this.resolveUri(loc.file);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      const pos = new vscode.Position(Math.max(0, loc.line - 1), Math.max(0, loc.column - 1));
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch {
      vscode.window.showErrorMessage('Could not open that source location.');
    }
  }

  private resolveUri(relPath: string): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) throw new Error('No workspace folder open');
    return vscode.Uri.joinPath(folders[0].uri, relPath);
  }

  private async exportGraph(format: 'svg' | 'dot' | 'mermaid') {
    if (!this.rootId) return;
    const cfg2 = vscode.workspace.getConfiguration('callgraph');
    const data: CallGraphData = {
      rootId: this.rootId,
      nodes: this.accumulatedNodes,
      edges: [...this.accumulatedEdges.values()],
      nodeDepths: { ...this.accumulatedDepths },
      mode: 'heuristic',
      computedDepth: this.currentComputedDepth,
      truncated: this.currentTruncated,
      defaultDepth: cfg2.get<number>('defaultDepth', 5),
    };

    try {
      if (format === 'mermaid') {
        const doc = await vscode.workspace.openTextDocument({ content: toMermaid(data), language: 'markdown' });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        return;
      }

      const dotText = toDot(data);

      if (format === 'dot') {
        const doc = await vscode.workspace.openTextDocument({ content: dotText, language: 'plaintext' });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        return;
      }

      // svg
      const cfg = vscode.workspace.getConfiguration('callgraph');
      const dotPath = cfg.get<string>('graphvizDotPath', '');
      if (!dotPath) {
        vscode.window.showWarningMessage(
          'SVG export needs callgraph.graphvizDotPath set to a Graphviz "dot" binary. Exporting as DOT text instead.',
        );
        const doc = await vscode.workspace.openTextDocument({ content: dotText, language: 'plaintext' });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        return;
      }
      const svg = await renderSvgWithGraphviz(dotPath, dotText);
      const doc = await vscode.workspace.openTextDocument({ content: svg, language: 'xml' });
      await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    } catch (err: any) {
      vscode.window.showErrorMessage(`Export failed: ${err?.message ?? err}`);
    }
  }
}
