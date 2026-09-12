import * as vscode from 'vscode';
import { escapeXml } from '../core/render.js';
import { detectRosetta, rosettaByLine, type RosettaFinding } from '../core/rosetta.js';
import { nextRevisit } from '../core/review.js';
import { symbolAnchor } from '../core/anchor.js';
import type { JournalEntry } from '../core/model.js';
import { htmlShell } from '../webview/shell.js';
import { loadCachedStructure } from '../structure/cache.js';
import { symbolAt, symbolsFor } from '../symbols.js';
import { describeAstFailure, dumpAst } from './runner.js';
import type { Host } from '../commands.js';

function config() {
  return vscode.workspace.getConfiguration('lens');
}

/**
 * The Rosetta surface.
 *
 * Inline decorations are the primary read path, not the panel. The whole claim
 * of this lens is that the surprising things in C++ are invisible *at the line*,
 * so the explanation has to appear at the line while you are reading it. The
 * panel is for when you want the three-column comparison side by side.
 */

let decorationType: vscode.TextEditorDecorationType | undefined;
const current = new Map<string, RosettaFinding[]>();

function ensureDecoration(): vscode.TextEditorDecorationType {
  decorationType ??= vscode.window.createTextEditorDecorationType({
    after: {
      margin: '0 0 0 1.5rem',
      color: new vscode.ThemeColor('editorCodeLens.foreground'),
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  return decorationType;
}

function severityMark(f: RosettaFinding): string {
  return f.severity === 'trap' ? '!' : f.severity === 'familiar' ? '=' : '~';
}

function paint(editor: vscode.TextEditor, findings: RosettaFinding[]): void {
  const byLine = rosettaByLine(findings);
  const options: vscode.DecorationOptions[] = [];

  for (const [line, list] of byLine) {
    const index = Math.min(line - 1, editor.document.lineCount - 1);
    if (index < 0) {
      continue;
    }
    const text = editor.document.lineAt(index);
    // Several constructs on one line are summarised rather than stacked; the
    // hover carries the detail, and a wall of end-of-line text is unreadable.
    const label =
      list.length === 1
        ? `${severityMark(list[0])} ${list[0].title}`
        : `${list.map(severityMark).join('')} ${list.length} constructs`;
    options.push({
      range: new vscode.Range(text.range.end, text.range.end),
      renderOptions: { after: { contentText: `  ${label}` } },
    });
  }
  editor.setDecorations(ensureDecoration(), options);
}

export function clearRosetta(editor: vscode.TextEditor | undefined): void {
  current.delete(editor?.document.uri.toString() ?? '');
  if (editor && decorationType) {
    editor.setDecorations(decorationType, []);
  }
}

export class RosettaHover implements vscode.HoverProvider {
  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const list = (current.get(doc.uri.toString()) ?? []).filter((f) => f.span.beginLine === pos.line + 1);
    if (list.length === 0) {
      return undefined;
    }
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    list.forEach((f, i) => {
      if (i > 0) {
        md.appendMarkdown('\n\n---\n\n');
      }
      md.appendMarkdown(
        [
          `**${f.title}**`,
          '',
          `*What the compiler emits:* ${f.emits}`,
          '',
          `*In C you would write:* ${f.cEquivalent}`,
          ...(f.mangled ? ['', `\`${f.mangled}\``] : []),
        ].join('\n'),
      );
    });
    return new vscode.Hover(md);
  }
}

/** Name of the declaration enclosing the cursor — what gets passed to -ast-dump-filter. */
async function declAtCursor(timeoutMs: number): Promise<string | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const found = symbolAt(await symbolsFor(editor.document, timeoutMs), editor.selection.active);
  if (!found) {
    return undefined;
  }
  // The filter matches on the unqualified name, so the last segment is what
  // clang wants — and a broader match simply returns more declarations, which
  // the detector handles.
  return found.sym.qualifiedName.split('::').pop();
}

export async function showRosetta(host: Host): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const cfg = config();
  const decl = await declAtCursor(host.timeoutMs());
  if (!decl) {
    void vscode.window.showInformationMessage(
      'Lens: put the cursor inside a function so Rosetta knows what to analyse.',
    );
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Lens: parsing ${decl}` },
    () =>
      dumpAst({
        clangPath: cfg.get<string>('clang.path', 'clang++'),
        workspaceRoot: host.workspaceRoot,
        databaseDir: cfg.get<string>('compilationDatabase') || undefined,
        sourceFile: editor.document.uri.fsPath,
        declName: decl,
        timeoutSeconds: cfg.get<number>('clang.timeoutSeconds', 90),
      }),
  );

  if (!result.ok) {
    void vscode.window.showWarningMessage(`Lens: ${describeAstFailure(result.failure)}`);
    return;
  }

  const structure = await loadCachedStructure(host.workspaceRoot);
  const findings = detectRosetta(result.roots, { mainFile: result.mainFile, structure });
  current.set(editor.document.uri.toString(), findings);
  paint(editor, findings);

  if (findings.length === 0) {
    void vscode.window.showInformationMessage(
      result.language === 'c'
        ? `Lens: ${decl} compiled as C, so there is nothing here that behaves differently from the C you already ` +
          'read. Rosetta explains C++ constructs; in a C translation unit an empty result is the correct one.'
        : `Lens: nothing in ${decl} behaves differently from the C you already read. That is a real answer, not a failure.`,
    );
    return;
  }
  RosettaPanel.show(host).setFindings(decl, findings, structure !== undefined, editor.document.uri);
}

class RosettaPanel {
  private static instance: RosettaPanel | undefined;
  private findings: RosettaFinding[] = [];
  private source: vscode.Uri | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly host: Host,
  ) {
    panel.onDidDispose(() => {
      RosettaPanel.instance = undefined;
    });
    panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
  }

  static show(host: Host): RosettaPanel {
    if (RosettaPanel.instance) {
      RosettaPanel.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      return RosettaPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel('lens.rosetta', 'Lens — Rosetta', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    RosettaPanel.instance = new RosettaPanel(panel, host);
    return RosettaPanel.instance;
  }

  setFindings(decl: string, findings: RosettaFinding[], hasStructure: boolean, source: vscode.Uri): void {
    this.findings = findings;
    this.source = source;
    const traps = findings.filter((f) => f.severity === 'trap').length;
    const familiar = findings.filter((f) => f.severity === 'familiar').length;

    const rows = findings
      .map((f, i) => {
        const payload = escapeXml(JSON.stringify({ qname: f.construct, index: i }));
        return `<section class="f ${f.severity}">
  <h2><a href="#" data-action="reveal" data-qname="${f.span.beginLine}">line ${f.span.beginLine}</a> — ${escapeXml(
    f.title,
  )}</h2>
  <div class="femits"><span class="lbl">emits</span> ${escapeXml(f.emits)}</div>
  <div class="fc"><span class="lbl">in C</span> ${escapeXml(f.cEquivalent)}</div>
  ${f.mangled ? `<div class="muted"><code>${escapeXml(f.mangled)}</code></div>` : ''}
  <button data-action="seed" data-payload="${payload}">Add to journal</button>
</section>`;
      })
      .join('');

    this.panel.webview.html = htmlShell(`
<h1>${escapeXml(decl)}</h1>
<p class="muted">${findings.length} constructs · ${traps} worth care · ${familiar} already familiar from C</p>
${
  hasStructure
    ? ''
    : '<p class="warn">No structure model cached, so virtual calls are not identified and destructor claims are ' +
      'hedged. Run the Structure lens once to sharpen both.</p>'
}
<div class="findings">${rows}</div>`);
  }

  private async onMessage(msg: { action?: string; qname?: string; index?: number }): Promise<void> {
    if (msg.action === 'reveal' && msg.qname && this.source) {
      const line = Math.max(0, Number.parseInt(msg.qname, 10) - 1);
      const doc = await vscode.workspace.openTextDocument(this.source);
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
      const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      return;
    }
    if (msg.action === 'seed' && msg.index !== undefined) {
      const f = this.findings[msg.index];
      if (f) {
        await seedRosetta(this.host, f);
      }
    }
  }
}

/**
 * Seed a journal entry from a statement-level finding.
 *
 * Anchored to the enclosing file and line via a fingerprint rather than a symbol
 * name, because the thing being noted is a *statement*, and statements have no
 * name to anchor to. That is a weaker anchor and the entry says so.
 */
async function seedRosetta(host: Host, f: RosettaFinding): Promise<void> {
  const body = await vscode.window.showInputBox({
    title: `Lens — ${f.title}`,
    prompt: 'Edit before keeping. Notes you did not read are worse than no notes.',
    value: `${f.title}. `,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length === 0 ? 'A note needs a body.' : undefined),
  });
  if (body === undefined) {
    return;
  }
  const now = new Date();
  const iso = now.toISOString();
  const kind = f.severity === 'trap' ? 'quirk' : 'idiom';
  const label = `${f.span.file}:${f.span.beginLine}`;
  const entry: JournalEntry = {
    anchor: symbolAnchor({ qualifiedName: label, symbolKind: 'Statement' }),
    anchorMode: 'fingerprint',
    kind,
    symbol: label,
    symbolKind: 'Statement',
    file: f.span.file,
    line: f.span.beginLine,
    created: iso,
    updated: iso,
    revisitAt: nextRevisit(kind, 0, now, host.intervals()),
    confidence: 0,
    tags: [f.construct],
    body: `${body.trim()}\n\n**What the compiler emits:** ${f.emits}\n\n**In C you would write:** ${f.cEquivalent}`,
  };
  await host.journal.save(entry);
  await host.refresh();
}
