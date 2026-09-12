import * as path from 'node:path';
import * as vscode from 'vscode';
import { draftEntry, type Finding } from '../core/constructs.js';
import { detectFlowConstructs, summariseFlow } from '../core/flowfindings.js';
import { FLOW_LEGEND, renderFlowSvg } from '../core/flowrender.js';
import { escapeXml } from '../core/render.js';
import { resolveVirtualCall, type CallGraph } from '../core/flow.js';
import type { StructureModel } from '../core/structure.js';
import { htmlShell } from '../webview/shell.js';
import { seedFromFinding } from '../structure/command.js';
import { loadCachedStructure } from '../structure/cache.js';
import { buildCallGraph } from './provider.js';
import { lastSymbolOutcome } from '../symbols.js';
import type { Host } from '../commands.js';

function config() {
  return vscode.workspace.getConfiguration('lens');
}

class FlowPanel {
  private static current: FlowPanel | undefined;
  private graph: CallGraph | undefined;
  private structure: StructureModel | undefined;
  private findings: Finding[] = [];
  private banner = '';

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly host: Host,
  ) {
    panel.onDidDispose(() => {
      FlowPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
  }

  static show(host: Host): FlowPanel {
    if (FlowPanel.current) {
      FlowPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return FlowPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('lens.flow', 'Lens — Flow', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    FlowPanel.current = new FlowPanel(panel, host);
    return FlowPanel.current;
  }

  setStatus(message: string, error = false): void {
    this.panel.webview.html = htmlShell(
      `<div class="status${error ? ' error' : ''}">${error ? '<strong>Flow lens unavailable</strong>' : ''}<p>${escapeXml(
        message,
      )}</p></div>`,
    );
  }

  setGraph(graph: CallGraph, structure: StructureModel | undefined, banner: string): void {
    this.graph = graph;
    this.structure = structure;
    this.banner = banner;
    this.findings = detectFlowConstructs(graph, { depthWarning: config().get<number>('flow.depthWarning', 8) });
    this.render();
  }

  private render(): void {
    const graph = this.graph!;
    const s = summariseFlow(graph);
    const annotated = new Set(this.host.journal.entries.map((e) => e.symbol));
    const svg = renderFlowSvg(graph, { annotated });

    const legend = FLOW_LEGEND.map((l) => `<span><b>${escapeXml(l.label)}</b> — ${escapeXml(l.meaning)}</span>`).join('');

    const header = [
      `<h1>${escapeXml(graph.root)}</h1>`,
      `<p class="muted">${s.nodes} functions · ${s.certain} certain · ${s.bounded} bounded · ${s.unknown} unknown · `,
      `depth ${s.maxDepth}${s.isrCount > 0 ? ` · ${s.isrCount} interrupt handler${s.isrCount === 1 ? '' : 's'}` : ''}</p>`,
      this.banner ? `<p class="warn">${escapeXml(this.banner)}</p>` : '',
    ].join('');

    const cards = this.findings
      .map((f, i) => {
        const payload = escapeXml(JSON.stringify({ qname: f.qualifiedName, index: i }));
        return `<li class="f ${f.severity}">
          <div class="ftitle">${escapeXml(f.title)}</div>
          <div class="femits"><span class="lbl">emits</span> ${escapeXml(f.emits)}</div>
          <div class="fc"><span class="lbl">in C</span> ${escapeXml(f.cEquivalent)}</div>
          <button data-action="seed" data-payload="${payload}">Add to journal</button>
        </li>`;
      })
      .join('');

    const body = `${header}
<div class="split">
  <div class="canvas">${svg}<div class="legend">${legend}</div></div>
  <div class="findings"><section><h2>What to look at</h2><ul>${
    cards || '<p class="muted">Nothing unusual in this call tree. Every edge resolves exactly.</p>'
  }</ul></section></div>
</div>`;
    this.panel.webview.html = htmlShell(body);
  }

  /** Detail view for one function: who it might dispatch to, and on what evidence. */
  private renderCandidates(qname: string): void {
    if (!this.structure) {
      void vscode.window.showInformationMessage(
        'Lens: run the Structure lens first so virtual calls can be expanded.',
      );
      return;
    }
    const parts = qname.split('::');
    const method = parts.pop()!;
    const staticType = parts.join('::');
    const r = resolveVirtualCall(this.structure, { staticType, methodName: method });

    const rows = r.candidates
      .map(
        (c) =>
          `<div class="cand ${c.evidenceStrength}"><code>${escapeXml(c.qualifiedName)}</code><br>` +
          `<span class="muted">${escapeXml(c.evidence)}</span></div>`,
      )
      .join('');

    this.panel.webview.html = htmlShell(
      `<h1>${escapeXml(qname)}</h1>
       <p class="muted">${escapeXml(r.resolution)} · ${escapeXml(r.certainty)}</p>
       <p>${escapeXml(r.note)}</p>
       ${rows || '<p class="muted">No candidates.</p>'}
       <p><a href="#" data-action="back">Back to the call tree</a></p>`,
    );
  }

  private async onMessage(msg: { action?: string; qname?: string; index?: number }): Promise<void> {
    if (msg.action === 'back') {
      this.render();
      return;
    }
    if (msg.action === 'focus' && msg.qname) {
      this.renderCandidates(msg.qname);
      return;
    }
    if (msg.action === 'reveal' && msg.qname) {
      await this.reveal(msg.qname);
      return;
    }
    if (msg.action === 'seed' && msg.index !== undefined) {
      const f = this.findings[msg.index];
      if (f) {
        await seedFromFinding(this.host, f, draftEntry(f));
        await this.host.refresh();
        this.render();
      }
    }
  }

  private async reveal(qname: string): Promise<void> {
    const n = this.graph?.nodes.get(qname);
    if (!n?.file) {
      void vscode.window.showInformationMessage(`Lens: no source location for ${qname}.`);
      return;
    }
    const uri = vscode.Uri.file(path.join(this.host.workspaceRoot, n.file));
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      const pos = new vscode.Position(Math.max(0, (n.line ?? 1) - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    } catch {
      void vscode.window.showWarningMessage(`Lens: could not open ${n.file}.`);
    }
  }
}

/**
 * Two failures that look identical to a user and have unrelated fixes.
 *
 * `no-symbols` means the language server is not parsing this file at all, which
 * on a header almost always means it was opened as the wrong language or is not
 * reachable from any translation unit in the compilation database. `no-hierarchy`
 * means it parsed fine and simply has no call hierarchy to offer.
 */
function describeBuildFailure(failure: { kind: string; symbol?: string }, doc: vscode.TextDocument): string {
  const isHeader = /\.(h|hpp|hh|hxx|inl)$/i.test(doc.fileName);

  const outcome = lastSymbolOutcome(doc);
  const waited = config().get<number>('symbolProviderTimeoutMs', 15000);

  if (failure.kind === 'no-symbols' && outcome === 'timeout') {
    return (
      `The language server did not answer within ${waited}ms, so Lens does not know whether this file has ` +
      `symbols or not.\n\nThis is normal the first time a large translation unit is opened — clangd parses it ` +
      `and every header it includes before it can answer anything. Wait for indexing to settle and run the lens ` +
      `again, or raise lens.symbolProviderTimeoutMs.`
    );
  }

  if (failure.kind === 'no-symbols' && outcome === 'no-provider') {
    return (
      `No extension answered the request for document symbols in this file over ${waited}ms — not with an empty ` +
      `result, but with none at all, which means no language server has registered for "${doc.languageId}".` +
      `\n\nCheck that clangd or the Microsoft C/C++ extension is installed and enabled, and that IntelliSense is ` +
      `working here — if Ctrl+Shift+O shows no symbols either, the problem is upstream of Lens. Note that the ` +
      `Flow lens specifically needs clangd, because call hierarchy is a clangd feature.`
    );
  }

  if (failure.kind === 'no-symbols') {
    return (
      `The language server answered but reported no symbols in ${doc.fileName.split(/[\\/]/).pop()}, so the ` +
      `cursor position is not the problem.` +
      (isHeader
        ? `\n\nThis is a header opened as "${doc.languageId}". VS Code assigns .h to C by default, and C++ in a ` +
          `file being parsed as C produces no symbols at all. Add to settings.json:\n\n` +
          `    "files.associations": { "*.h": "cpp" }\n\n` +
          `If it is already C++, check that this header is included by some .cpp file listed in your compilation ` +
          `database — clangd infers a header's flags from a translation unit that uses it, and has none to work ` +
          `from otherwise.`
        : `\n\nCheck that this file appears in your compilation database and that IntelliSense is working in it.`)
    );
  }

  return (
    `The language server parsed this file but offered no call hierarchy` +
    (failure.symbol ? ` for ${failure.symbol}` : '') +
    `.\n\nLens already retried at the function's name, so the cursor position is not the problem. Call hierarchy ` +
    `is a clangd feature; the Microsoft C/C++ extension does not implement it. If you are using cpptools, install ` +
    `clangd and disable cpptools' IntelliSense to use the Flow lens.`
  );
}

export async function showFlow(host: Host): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const cfg = config();
  const panel = FlowPanel.show(host);
  panel.setStatus('Asking the language server for the call hierarchy…');

  const structure = await loadCachedStructure(host.workspaceRoot);
  const result = await buildCallGraph(editor.document, editor.selection.active, {
    maxDepth: cfg.get<number>('flow.maxDepth', 6),
    maxNodes: cfg.get<number>('flow.maxNodes', 120),
    isrPatterns: cfg.get<string[]>('flow.isrPatterns', []),
    symbolTimeoutMs: host.timeoutMs(),
    structure,
  });

  if (!('graph' in result)) {
    panel.setStatus(describeBuildFailure(result, editor.document), true);
    return;
  }

  const notes: string[] = [];
  if (result.truncated) {
    notes.push('Traversal stopped early — this is a subset of the call tree, not all of it.');
  }
  if (!structure) {
    notes.push(
      `Virtual calls are not expanded: no structure model cached. Up to ${result.unexpandedVirtuals} member-function ` +
        'leaves may hide dispatch. Run the Structure lens once to enable expansion.',
    );
  }
  panel.setGraph(result.graph, structure, notes.join(' '));
}
