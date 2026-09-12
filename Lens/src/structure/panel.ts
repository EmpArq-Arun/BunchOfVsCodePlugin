import * as path from 'node:path';
import * as vscode from 'vscode';
import { detectConstructs, draftEntry, summarise, type Finding } from '../core/constructs.js';
import { escapeXml, renderSvg } from '../core/render.js';
import { contextSubset, filterModel, type StructureModel } from '../core/structure.js';
import type { Journal } from '../core/journal.js';
import { htmlShell } from '../webview/shell.js';

/**
 * Structure lens panel.
 *
 * The diagram is only half of it. The findings list beside it is what turns a
 * picture of the class hierarchy into an explanation of what is unfamiliar about
 * it, and every finding can be turned into a journal entry in one click — which
 * is the auto-seeding path the design asks for, with the user still doing the
 * editing and the keeping.
 */

export interface PanelDeps {
  journal: Journal;
  workspaceRoot: string;
  seed: (finding: Finding, draft: string) => Promise<void>;
}

export class StructurePanel {
  private static current: StructurePanel | undefined;
  private model: StructureModel | undefined;
  private focus: string | undefined;
  private radius = 2;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: PanelDeps,
  ) {
    panel.onDidDispose(() => {
      StructurePanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
  }

  static show(deps: PanelDeps): StructurePanel {
    if (StructurePanel.current) {
      StructurePanel.current.panel.reveal(vscode.ViewColumn.Beside);
      return StructurePanel.current;
    }
    const panel = vscode.window.createWebviewPanel('lens.structure', 'Lens — Structure', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    StructurePanel.current = new StructurePanel(panel, deps);
    return StructurePanel.current;
  }

  setBusy(message: string): void {
    this.panel.webview.html = this.shell(
      `<div class="status"><span class="spinner"></span>${escapeXml(message)}</div>`,
    );
  }

  setUnavailable(reason: string): void {
    this.panel.webview.html = this.shell(
      `<div class="status error"><strong>Structure lens unavailable</strong><p>${escapeXml(reason)}</p>
       <p class="muted">The journal still works without any of this. Structure is an enrichment, not a prerequisite.</p></div>`,
    );
  }

  setModel(model: StructureModel, focusQualifiedName?: string): void {
    this.model = model;
    this.focus = focusQualifiedName;
    this.render();
  }

  private visibleModel(): StructureModel {
    const model = this.model!;
    if (!this.focus) {
      return model;
    }
    const seed = model.types.find((t) => t.qualifiedName === this.focus);
    return seed ? filterModel(model, contextSubset(model, [seed.id], this.radius)) : model;
  }

  private render(): void {
    if (!this.model) {
      return;
    }
    const view = this.visibleModel();
    const findings = detectConstructs(view);
    const summary = summarise(findings);
    const annotated = new Set(this.deps.journal.entries.map((e) => e.symbol));

    const svg = renderSvg(view, { findings, annotated });
    const byType = new Map<string, Finding[]>();
    for (const f of findings) {
      (byType.get(f.qualifiedName) ?? byType.set(f.qualifiedName, []).get(f.qualifiedName)!).push(f);
    }

    const header = [
      `<h1>${escapeXml(view.title || 'Structure')}</h1>`,
      `<p class="muted">${view.types.length} types · ${summary.traps} trap${summary.traps === 1 ? '' : 's'} · `,
      `${summary.neu} unfamiliar · ${summary.familiar} already familiar from C</p>`,
      this.focus
        ? `<p class="muted">Showing ${escapeXml(this.focus)} and everything within ${this.radius} hops. ` +
          `<a href="#" data-action="clear-focus">Show all</a></p>`
        : '',
      view.provenance.missing.length > 0
        ? `<p class="warn">Not shown: ${escapeXml(view.provenance.missing.join('; '))}</p>`
        : '',
    ].join('');

    const cards = [...byType.entries()]
      .sort((a, b) => severityRank(a[1]) - severityRank(b[1]) || a[0].localeCompare(b[0]))
      .map(([qname, list]) => this.card(qname, list))
      .join('');

    this.panel.webview.html = this.shell(
      `${header}<div class="split"><div class="canvas">${svg}</div><div class="findings">${
        cards || '<p class="muted">No constructs detected in this view.</p>'
      }</div></div>`,
    );
  }

  private card(qname: string, list: Finding[]): string {
    const items = list
      .map((f, i) => {
        const payload = escapeXml(JSON.stringify({ qname, index: i }));
        return `<li class="f ${f.severity}">
          <div class="ftitle">${escapeXml(f.title)}</div>
          <div class="femits"><span class="lbl">emits</span> ${escapeXml(f.emits)}</div>
          <div class="fc"><span class="lbl">in C</span> ${escapeXml(f.cEquivalent)}</div>
          <button data-action="seed" data-payload="${payload}">Add to journal</button>
        </li>`;
      })
      .join('');
    const loc = list[0].file ? `<span class="muted">${escapeXml(list[0].file)}:${list[0].line}</span>` : '';
    return `<section><h2><a href="#" data-action="reveal" data-qname="${escapeXml(qname)}">${escapeXml(
      qname,
    )}</a> ${loc}</h2><ul>${items}</ul></section>`;
  }

  private async onMessage(msg: { action?: string; qname?: string; index?: number }): Promise<void> {
    if (!this.model) {
      return;
    }
    if (msg.action === 'clear-focus') {
      this.focus = undefined;
      this.render();
      return;
    }
    if (msg.action === 'focus' && msg.qname) {
      this.focus = msg.qname;
      this.render();
      return;
    }
    if (msg.action === 'reveal' && msg.qname) {
      await this.reveal(msg.qname);
      return;
    }
    if (msg.action === 'seed' && msg.qname !== undefined && msg.index !== undefined) {
      const all = detectConstructs(this.visibleModel()).filter((f) => f.qualifiedName === msg.qname);
      const finding = all[msg.index];
      if (finding) {
        await this.deps.seed(finding, draftEntry(finding));
        this.render();
      }
    }
  }

  private async reveal(qname: string): Promise<void> {
    const t = this.model?.types.find((x) => x.qualifiedName === qname);
    if (!t?.location) {
      void vscode.window.showInformationMessage(`Lens: no source location recorded for ${qname}.`);
      return;
    }
    // clang-uml reports paths relative to the compilation database, which is not
    // always the workspace root, so fall back to a workspace search on miss.
    const direct = vscode.Uri.file(path.join(this.deps.workspaceRoot, t.location.file));
    let uri: vscode.Uri | undefined;
    try {
      await vscode.workspace.fs.stat(direct);
      uri = direct;
    } catch {
      const hits = await vscode.workspace.findFiles(`**/${path.basename(t.location.file)}`, undefined, 2);
      uri = hits[0];
    }
    if (!uri) {
      void vscode.window.showWarningMessage(`Lens: could not locate ${t.location.file} in the workspace.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const pos = new vscode.Position(Math.max(0, t.location.line - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  private shell(body: string): string {
    return htmlShell(body);
  }
}

function severityRank(list: Finding[]): number {
  if (list.some((f) => f.severity === 'trap')) {
    return 0;
  }
  return list.some((f) => f.severity === 'new') ? 1 : 2;
}
