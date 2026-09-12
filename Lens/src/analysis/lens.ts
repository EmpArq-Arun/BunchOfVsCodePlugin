import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AstNode } from '../core/ast.js';
import { detectComplexityConstructs, measureComplexity } from '../core/complexity.js';
import { draftEntry, type Finding } from '../core/constructs.js';
import { analyseLifetimes, detectLifetimeConstructs, type LifetimeModel } from '../core/lifetime.js';
import { generatePrimer, summarise, type LensRun } from '../core/narrative.js';
import { escapeXml } from '../core/render.js';
import { compareSequences, detectSequenceConstructs, staticSequence } from '../core/sequence.js';
import { buildTraceTree, parseUftrace, traceHotspots } from '../core/uftrace.js';
import { loadCachedStructure } from '../structure/cache.js';
import { seedFromFinding } from '../structure/command.js';
import { describeAstFailure, dumpAst } from '../rosetta/runner.js';
import { symbolAt, symbolsFor } from '../symbols.js';
import { htmlShell } from '../webview/shell.js';
import type { Host } from '../commands.js';
import type { StructureModel } from '../core/structure.js';

/**
 * Sequence, lifetime, quality and narrative.
 *
 * All four read the same clang AST the Rosetta lens already parses, so they cost
 * one subprocess between them rather than one each. Complexity in particular is
 * computed here rather than by shelling out to lizard: once the AST is in hand,
 * a second runtime to re-derive branch counts is a dependency with nothing to
 * show for it, and it cannot see the exits C++ generates rather than spells.
 */

function config() {
  return vscode.workspace.getConfiguration('lens');
}

interface Analysed {
  roots: AstNode[];
  mainFile: string;
  decl: string;
  structure?: StructureModel;
}

/** Shared preamble: work out what the cursor is in, dump it, load the hierarchy. */
async function analyse(host: Host): Promise<Analysed | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return undefined;
  }
  const found = symbolAt(await symbolsFor(editor.document, host.timeoutMs()), editor.selection.active);
  const decl = found?.sym.qualifiedName.split('::').pop();
  if (!decl) {
    void vscode.window.showInformationMessage('Lens: put the cursor inside a function first.');
    return undefined;
  }

  const cfg = config();
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
    return undefined;
  }

  const structure = await loadCachedStructure(host.workspaceRoot);
  return { roots: result.roots, mainFile: result.mainFile, decl, structure };
}

/** Virtual methods known from the structure model, as `Type::method`. */
function virtualMethodSet(structure?: StructureModel): Set<string> {
  const out = new Set<string>();
  for (const t of structure?.types ?? []) {
    for (const m of t.methods) {
      if (m.isVirtual) {
        out.add(`${t.qualifiedName}::${m.name}`);
        out.add(`${t.name}::${m.name}`);
      }
    }
  }
  return out;
}

async function loadTrace(host: Host): Promise<{ tree: ReturnType<typeof buildTraceTree>; label: string } | undefined> {
  const configured = config().get<string>('trace.file', '');
  if (!configured) {
    return undefined;
  }
  const abs = path.isAbsolute(configured) ? configured : path.join(host.workspaceRoot, configured);
  try {
    const stream = parseUftrace(await fs.readFile(abs, 'utf8'));
    if (stream.skipped > 0) {
      void vscode.window.showWarningMessage(
        `Lens: ${stream.skipped} trace line${stream.skipped === 1 ? '' : 's'} were not recognised. ` +
          'The expected format is `uftrace replay -f duration,tid` output.',
      );
    }
    return { tree: buildTraceTree(stream), label: path.basename(abs) };
  } catch {
    void vscode.window.showWarningMessage(`Lens: could not read the trace at ${configured}.`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------

export async function showSequence(host: Host): Promise<void> {
  const a = await analyse(host);
  if (!a) {
    return;
  }
  const sequence = staticSequence(a.roots, {
    mainFile: a.mainFile,
    virtualMethods: virtualMethodSet(a.structure),
  });
  const trace = await loadTrace(host);
  const comparison = trace ? compareSequences(sequence, trace.tree) : undefined;
  const findings = detectSequenceConstructs(sequence, comparison);

  const steps = sequence.steps
    .map(
      (s) =>
        `<div class="cand ${s.virtualDispatch ? 'none' : ''}">` +
        `<span class="muted">${s.line}</span> ` +
        (s.guards.length > 0 ? `<span class="muted">${escapeXml(s.guards.join(' > '))} &rsaquo;</span> ` : '') +
        `<code>${escapeXml(s.name)}</code>` +
        (s.virtualDispatch ? ' <span class="muted">— target not fixed here</span>' : '') +
        '</div>',
    )
    .join('');

  const dynamic = trace
    ? `<section><h2>What actually ran <span class="muted">${escapeXml(trace.label)}</span></h2>` +
      traceHotspots(trace.tree)
        .slice(0, 12)
        .map(
          (h) =>
            `<div class="cand"><code>${escapeXml(h.name)}</code> <span class="muted">${h.totalUs.toFixed(
              2,
            )} us over ${h.calls} call${h.calls === 1 ? '' : 's'}</span></div>`,
        )
        .join('') +
      (comparison
        ? `<p class="muted">${Math.round(comparison.coverage * 100)}% of predicted calls were observed.</p>`
        : '') +
      '</section>'
    : '<section><h2>What actually ran</h2><p class="muted">No trace loaded. Set lens.trace.file to the output of ' +
      '<code>uftrace replay -f duration,tid</code> from a host build, or from your own ' +
      '-finstrument-functions decoder on target.</p></section>';

  Panel.show(host, 'lens.sequence', 'Lens — Sequence').render(
    `<h1>${escapeXml(sequence.function)}</h1>
     <p class="muted">${sequence.steps.length} calls in source order</p>
     <div class="split">
       <div class="canvas"><section><h2>What the source says</h2>${steps}</section>${dynamic}</div>
       <div class="findings">${Panel.findingList(findings)}</div>
     </div>`,
    findings,
  );
}

// ---------------------------------------------------------------------------

let lifetimeDecoration: vscode.TextEditorDecorationType | undefined;

export async function showLifetime(host: Host): Promise<void> {
  const a = await analyse(host);
  if (!a) {
    return;
  }
  const model = analyseLifetimes(a.roots, { mainFile: a.mainFile, structure: a.structure });
  const findings = detectLifetimeConstructs(model);
  paintLifetime(model);

  const rows = model.objects
    .map((o) => {
      const life =
        o.destroyedLine === -1
          ? 'until something ends it explicitly'
          : o.destroyedLine === o.constructedLine
            ? 'to the end of this statement'
            : `to line ${o.destroyedLine}`;
      return `<div class="cand ${o.storage === 'dynamic' ? 'none' : 'strong'}">
        <code>${escapeXml(o.name)}</code> <span class="muted">${escapeXml(o.type)} · ${o.storage} · line ${
          o.constructedLine
        } ${life}${o.destructionRank >= 0 ? ` · destroyed #${o.destructionRank + 1}` : ''}</span></div>`;
    })
    .join('');

  Panel.show(host, 'lens.lifetime', 'Lens — Lifetime').render(
    `<h1>${escapeXml(a.decl)}</h1>
     <p class="muted">${model.objects.length} objects across ${model.scopes.length} scopes</p>
     <div class="split">
       <div class="canvas"><section><h2>What is alive, and for how long</h2>${rows}</section></div>
       <div class="findings">${Panel.findingList(findings)}</div>
     </div>`,
    findings,
  );
}

/** Gutter markers spanning each object's life, so scope is visible while reading. */
function paintLifetime(model: LifetimeModel): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  lifetimeDecoration ??= vscode.window.createTextEditorDecorationType({
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('charts.purple'),
    isWholeLine: true,
  });

  const ranges: vscode.Range[] = [];
  for (const o of model.objects) {
    if (o.storage !== 'automatic' || !o.hasDestructor) {
      continue;
    }
    const from = Math.max(0, o.constructedLine - 1);
    const to = Math.min(editor.document.lineCount - 1, Math.max(from, o.destroyedLine - 1));
    ranges.push(new vscode.Range(from, 0, to, 0));
  }
  editor.setDecorations(lifetimeDecoration, ranges);
}

export function clearLifetime(): void {
  if (lifetimeDecoration && vscode.window.activeTextEditor) {
    vscode.window.activeTextEditor.setDecorations(lifetimeDecoration, []);
  }
}

// ---------------------------------------------------------------------------

export async function showComplexity(host: Host): Promise<void> {
  const a = await analyse(host);
  if (!a) {
    return;
  }
  const cfg = config();
  const functions = measureComplexity(a.roots, a.mainFile);
  const findings = detectComplexityConstructs(functions, {
    warn: cfg.get<number>('complexity.warn', 10),
    depth: cfg.get<number>('complexity.depth', 4),
  });

  const rows = functions
    .map(
      (f) =>
        `<div class="cand"><code>${escapeXml(f.name)}</code> <span class="muted">complexity ${f.cyclomatic} ` +
        `(${f.visible} visible${f.hidden > 0 ? ` + ${f.hidden} throw` : ''}) · depth ${f.maxDepth} · line ${
          f.line
        }</span></div>`,
    )
    .join('');

  Panel.show(host, 'lens.complexity', 'Lens — Quality').render(
    `<h1>Complexity</h1>
     <p class="muted">Counted from the AST, so short-circuit operators and explicit throws are included.</p>
     <div class="split"><div class="canvas"><section>${rows}</section></div>
     <div class="findings">${Panel.findingList(findings)}</div></div>`,
    findings,
  );
}

// ---------------------------------------------------------------------------

export async function writePrimer(host: Host, collected: Finding[], runs: LensRun[]): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const moduleName = editor
    ? path.relative(host.workspaceRoot, path.dirname(editor.document.uri.fsPath)).split(path.sep).join('/') || '.'
    : '.';

  const journal = host.journal.entries.filter((e) => e.file.startsWith(moduleName));
  const markdown = generatePrimer({
    module: moduleName,
    findings: collected,
    journal: [...journal],
    runs,
    generatedAt: new Date(),
  });

  const dir = path.join(host.workspaceRoot, '.lens', 'primers');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${moduleName.replace(/[\\/]/g, '-') || 'root'}.md`);
  await fs.writeFile(file, markdown, 'utf8');

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  await vscode.window.showTextDocument(doc, { preview: false });
  void vscode.window.showInformationMessage(`Lens: ${summarise({
    module: moduleName,
    findings: collected,
    journal: [...journal],
    runs,
    generatedAt: new Date(),
  })}`);
}

/**
 * Generate a primer by running every lens that can run against the current
 * module, and recording the ones that cannot. A lens that did not run is stated
 * rather than omitted: "no exceptions here" and "the cost lens never ran" look
 * identical in a document that lists only findings.
 */
export async function generateModulePrimer(host: Host): Promise<void> {
  const a = await analyse(host);
  const runs: LensRun[] = [];
  const collected: Finding[] = [];

  if (!a) {
    runs.push({ lens: 'Rosetta, Sequence, Lifetime, Quality', inputs: [], ran: false, skipped: 'clang could not parse the current file', findingCount: 0 });
  } else {
    const { detectRosetta } = await import('../core/rosetta.js');
    const rosetta = detectRosetta(a.roots, { mainFile: a.mainFile, structure: a.structure });
    const asFindings: Finding[] = rosetta.map((r) => ({
      construct: r.construct,
      severity: r.severity,
      typeId: r.span.file,
      qualifiedName: `${r.span.file}:${r.span.beginLine}`,
      title: r.title,
      emits: r.emits,
      cEquivalent: r.cEquivalent,
      file: r.span.file,
      line: r.span.beginLine,
    }));
    collected.push(...asFindings);
    runs.push({ lens: 'Rosetta', inputs: [a.mainFile], ran: true, findingCount: asFindings.length });

    const lifetime = detectLifetimeConstructs(analyseLifetimes(a.roots, { mainFile: a.mainFile, structure: a.structure }));
    collected.push(...lifetime);
    runs.push({ lens: 'Lifetime', inputs: [a.mainFile], ran: true, findingCount: lifetime.length });

    const complexity = detectComplexityConstructs(measureComplexity(a.roots, a.mainFile));
    collected.push(...complexity);
    runs.push({ lens: 'Quality', inputs: [a.mainFile], ran: true, findingCount: complexity.length });

    if (a.structure) {
      const { detectConstructs } = await import('../core/constructs.js');
      const structure = detectConstructs(a.structure);
      collected.push(...structure);
      runs.push({ lens: 'Structure', inputs: ['.lens/cache/lens_structure.json'], ran: true, findingCount: structure.length });
    } else {
      runs.push({ lens: 'Structure', inputs: [], ran: false, skipped: 'no cached class hierarchy — run the Structure lens once', findingCount: 0 });
    }
  }

  const elf = config().get<string>('cost.elfFile', '');
  runs.push(
    elf
      ? { lens: 'Cost', inputs: [elf], ran: false, skipped: 'run the Cost lens and regenerate to include image figures', findingCount: 0 }
      : { lens: 'Cost', inputs: [], ran: false, skipped: 'no ELF configured at lens.cost.elfFile', findingCount: 0 },
  );
  const trace = config().get<string>('trace.file', '');
  runs.push({
    lens: 'Sequence (dynamic)',
    inputs: trace ? [trace] : [],
    ran: false,
    skipped: trace ? 'traces are compared per function, not per module' : 'no trace configured at lens.trace.file',
    findingCount: 0,
  });

  await writePrimer(host, collected, runs);
}

// ---------------------------------------------------------------------------

/** Small shared panel host, since these four differ only in their body. */
class Panel {
  private static open = new Map<string, Panel>();
  private findings: Finding[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly host: Host,
    id: string,
  ) {
    panel.onDidDispose(() => Panel.open.delete(id));
    panel.webview.onDidReceiveMessage(async (m: { action?: string; index?: number }) => {
      if (m.action === 'seed' && m.index !== undefined) {
        const f = this.findings[m.index];
        if (f) {
          await seedFromFinding(this.host, f, draftEntry(f));
          await this.host.refresh();
        }
      }
    });
  }

  static show(host: Host, id: string, title: string): Panel {
    const existing = Panel.open.get(id);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside, true);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(id, title, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    const created = new Panel(panel, host, id);
    Panel.open.set(id, created);
    return created;
  }

  static findingList(findings: Finding[]): string {
    if (findings.length === 0) {
      return '<section><p class="muted">Nothing here behaves differently from C.</p></section>';
    }
    const items = findings
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
    return `<section><h2>What to look at</h2><ul>${items}</ul></section>`;
  }

  render(body: string, findings: Finding[]): void {
    this.findings = findings;
    this.panel.webview.html = htmlShell(body);
  }
}
