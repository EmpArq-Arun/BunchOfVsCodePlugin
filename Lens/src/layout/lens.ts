import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { detectLayoutConstructs, mergeLayout, summariseLayouts, wasteRanking, type MergedLayout } from '../core/layoutmerge.js';
import { LAYOUT_LEGEND, renderLayoutSvg } from '../core/layoutrender.js';
import { observedByName, parsePahole, type PaholeResult } from '../core/pahole.js';
import { parseDwarfDump } from '../core/dwarfdump.js';
import { parseRecordLayouts } from '../core/recordlayout.js';
import { buildRecordLayoutCommand, entryFor, parseCompilationDatabase } from '../core/compdb.js';
import { findDatabaseFile } from '../rosetta/runner.js';
import { escapeXml } from '../core/render.js';
import { draftEntry, type Finding } from '../core/constructs.js';
import { htmlShell } from '../webview/shell.js';
import { seedFromFinding } from '../structure/command.js';
import type { Host } from '../commands.js';

/**
 * Layout lens.
 *
 * clang predicts the layout for the target the build flags describe; pahole
 * observes what the compiler actually emitted into DWARF. clang is primary
 * because pahole cannot read polymorphic classes — see ADR 0006 — and those are
 * exactly the ones whose layout surprises a C engineer.
 *
 * Where both can see a type, disagreement is surfaced as a finding rather than
 * smoothed away: it means the compilation database records different flags from
 * the build that produced the object, which matters more than a tidy diagram.
 */

function config() {
  return vscode.workspace.getConfiguration('lens');
}

function exec(
  binary: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number,
): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: Error; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd, shell: false });
    // Close stdin immediately. The include-path probe compiles from `-`, so a
    // driver left with an open stdin waits for input until the timeout kills it
    // — a hang rather than an error, and invisible to any test that mocks the
    // subprocess. Harmless for every other tool Lens spawns.
    child.stdin?.end();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSeconds * 1000);
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (spawnError) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, spawnError, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/**
 * Ask pahole about a specific set of types.
 *
 * Queried one type at a time rather than dumping everything, because a whole
 * object file yields thousands of records from system headers and the ones that
 * matter are the ones already on screen.
 */
async function observe(binary: string, objectFile: string, names: string[], cwd: string): Promise<string> {
  const chunks: string[] = [];
  for (const name of names.slice(0, 60)) {
    // -F dwarf forces the DWARF backend: a pahole built for kernel work defaults
    // to BTF, which carries no C++ types at all.
    const r = await exec(binary, ['-F', 'dwarf', '-C', name, objectFile], cwd, 20);
    if (r.spawnError) {
      return '';
    }
    chunks.push(r.stdout, r.stderr);
  }
  return chunks.join('\n');
}

/**
 * Pick an observed-layout provider.
 *
 * llvm-dwarfdump is preferred and is what `auto` selects: it runs on Windows,
 * and it reads polymorphic classes, which pahole refuses (ADR 0006) — precisely
 * the types whose layout a C engineer most needs explained. pahole remains
 * selectable for anyone who already has it and prefers its output.
 */
async function observeLayouts(
  cfg: vscode.WorkspaceConfiguration,
  provider: string,
  objectFile: string,
  names: string[],
  cwd: string,
): Promise<PaholeResult> {
  if (provider !== 'pahole') {
    const dwarfdump = cfg.get<string>('dwarfdump.path', 'llvm-dwarfdump');
    const run = await exec(dwarfdump, ['--debug-info', objectFile], cwd, 120);
    if (!run.spawnError && run.stdout.trim().length > 0) {
      return parseDwarfDump(run.stdout);
    }
    if (provider === 'dwarfdump') {
      void vscode.window.showWarningMessage(
        `Lens: could not run "${dwarfdump}". It ships with LLVM — set lens.dwarfdump.path, or switch ` +
          'lens.observedLayout.provider to pahole.',
      );
      return { records: [], notFound: [] };
    }
  }
  const paholePath = cfg.get<string>('pahole.path', 'pahole');
  return parsePahole(await observe(paholePath, objectFile, names, cwd));
}

export async function showLayout(host: Host): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const cfg = config();
  const root = host.workspaceRoot;

  const dbFile = await findDatabaseFile(root, cfg.get<string>('compilationDatabase') || undefined);
  if (!dbFile) {
    void vscode.window.showWarningMessage(
      'Lens: no compilation database found. The Layout lens needs it to analyse for the right target — host ' +
        'defaults would give you the layout of a program that does not exist. If yours is not called ' +
        'compile_commands.json, set lens.compilationDatabase to the file itself.',
    );
    return;
  }

  let entries;
  try {
    entries = parseCompilationDatabase(await fs.readFile(dbFile, 'utf8'));
  } catch (err) {
    void vscode.window.showWarningMessage(`Lens: ${String(err)}`);
    return;
  }
  const entry = entryFor(entries, editor.document.uri.fsPath);
  if (!entry) {
    void vscode.window.showWarningMessage(
      `Lens: ${path.basename(editor.document.uri.fsPath)} is not in the compilation database. Open a source file that is.`,
    );
    return;
  }

  const clang = cfg.get<string>('clang.path', 'clang++');
  // --driver-mode comes from the database entry: clang++ given -std=c11 refuses
  // to run at all, so a C project fails outright without it.
  const command = buildRecordLayoutCommand(entry);

  const run = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'Lens: computing object layouts' },
    () => exec(clang, command.args, command.cwd, cfg.get<number>('clang.timeoutSeconds', 90)),
  );

  if (run.spawnError) {
    void vscode.window.showWarningMessage(
      `Lens: could not run "${clang}". Set lens.clang.path to a clang or clang++ binary.`,
    );
    return;
  }
  if (run.timedOut) {
    void vscode.window.showWarningMessage('Lens: clang timed out. Raise lens.clang.timeoutSeconds.');
    return;
  }

  // clang writes record layouts to stdout and diagnostics to stderr; a non-zero
  // exit with usable output is the normal state for a file mid-edit.
  const predicted = parseRecordLayouts(run.stdout);
  if (predicted.length === 0) {
    void vscode.window.showInformationMessage(
      command.language === 'c'
        ? 'Lens: no struct layouts in this translation unit. It compiled as C, so there is nothing here a C ' +
          'engineer needs translating.'
        : 'Lens: no class or struct layouts in this translation unit.',
    );
    return;
  }

  // Observation is optional enrichment. Its absence costs internal-hole detail
  // and nothing else.
  let observed: PaholeResult = { records: [], notFound: [] };
  const objectFile = cfg.get<string>('pahole.objectFile', '');
  const provider = cfg.get<string>('observedLayout.provider', 'auto');
  if (objectFile && provider !== 'none') {
    const abs = path.isAbsolute(objectFile) ? objectFile : path.join(root, objectFile);
    try {
      await fs.access(abs);
      observed = await observeLayouts(cfg, provider, abs, predicted.map((r) => r.name), root);
    } catch {
      void vscode.window.showWarningMessage(
        `Lens: could not read ${objectFile}. Layouts will be shown as predicted only.`,
      );
    }
  }

  const byName = observedByName(observed);
  const merged = predicted.map((r) => mergeLayout(r, byName.get(r.name)));
  LayoutPanel.show(host).setLayouts(merged, objectFile.length > 0);
}

class LayoutPanel {
  private static instance: LayoutPanel | undefined;
  private findings: Finding[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly host: Host,
  ) {
    panel.onDidDispose(() => {
      LayoutPanel.instance = undefined;
    });
    panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
  }

  static show(host: Host): LayoutPanel {
    if (LayoutPanel.instance) {
      LayoutPanel.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      return LayoutPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel('lens.layout', 'Lens — Layout', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    LayoutPanel.instance = new LayoutPanel(panel, host);
    return LayoutPanel.instance;
  }

  setLayouts(layouts: MergedLayout[], observedAvailable: boolean): void {
    this.findings = detectLayoutConstructs(layouts);
    const s = summariseLayouts(layouts);
    const ranked = wasteRanking(layouts);
    const byType = new Map<string, Finding[]>();
    for (const f of this.findings) {
      (byType.get(f.qualifiedName) ?? byType.set(f.qualifiedName, []).get(f.qualifiedName)!).push(f);
    }

    const legend = LAYOUT_LEGEND.map((l) => `<span><b>${l.cls}</b> — ${escapeXml(l.meaning)}</span>`).join('');

    const cards = layouts
      .map((l) => {
        const findings = byType.get(l.qualifiedName) ?? [];
        const items = findings
          .map((f) => {
            const i = this.findings.indexOf(f);
            const payload = escapeXml(JSON.stringify({ qname: f.qualifiedName, index: i }));
            return `<li class="f ${f.severity}">
              <div class="ftitle">${escapeXml(f.title)}</div>
              <div class="femits"><span class="lbl">emits</span> ${escapeXml(f.emits)}</div>
              <div class="fc"><span class="lbl">in C</span> ${escapeXml(f.cEquivalent)}</div>
              <button data-action="seed" data-payload="${payload}">Add to journal</button>
            </li>`;
          })
          .join('');

        return `<section>
  <h2>${escapeXml(l.qualifiedName)}</h2>
  <p class="muted">sizeof ${l.sizeOf} · align ${l.align} · data ${l.dataSize}${
    l.tailPadding > 0 ? ` · ${l.tailPadding} tail padding` : ''
  }${l.internalPadding !== undefined ? ` · ${l.internalPadding} in holes` : ''}</p>
  ${renderLayoutSvg(l)}
  ${l.observedGap ? `<p class="warn">${escapeXml(l.observedGap)}</p>` : ''}
  <ul>${items}</ul>
</section>`;
      })
      .join('');

    const wasteRows = ranked
      .slice(0, 10)
      .map(
        (l) =>
          `<div class="cand">${escapeXml(l.name)} — ${l.tailPadding + (l.internalPadding ?? 0)} of ${
            l.sizeOf
          } bytes wasted</div>`,
      )
      .join('');

    this.panel.webview.html = htmlShell(`
<h1>Object layouts</h1>
<p class="muted">${s.records} types · ${s.totalSize} bytes total · ${s.wasted} wasted · ${s.polymorphic} carry a vptr</p>
${
  observedAvailable
    ? s.uncomputed > 0
      ? `<p class="warn">${s.uncomputed} type${s.uncomputed === 1 ? '' : 's'} could not be cross-checked against ` +
        'the built object. Offsets and tail padding are still exact; internal holes are not computed.</p>'
      : '<p class="muted">Every type cross-checked against the built object.</p>'
    : '<p class="warn">Predicted layouts only. Set lens.pahole.objectFile to a .o or .elf built with -g to ' +
      'cross-check against what the compiler actually emitted and to compute internal holes. On Windows use ' +
      'llvm-dwarfdump, which is the default provider.</p>'
}
${wasteRows ? `<section><h2>Where the bytes go</h2>${wasteRows}</section>` : ''}
<div class="legend">${legend}</div>
${cards}`);
  }

  private async onMessage(msg: { action?: string; index?: number }): Promise<void> {
    if (msg.action === 'seed' && msg.index !== undefined) {
      const f = this.findings[msg.index];
      if (f) {
        await seedFromFinding(this.host, f, draftEntry(f));
        await this.host.refresh();
      }
    }
  }
}
