import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { buildReport, detectCostConstructs, type CostReport } from '../core/cost.js';
import { parseElf, ElfParseError } from '../core/elf.js';
import { draftEntry, type Finding } from '../core/constructs.js';
import { escapeXml } from '../core/render.js';
import { htmlShell } from '../webview/shell.js';
import { seedFromFinding } from '../structure/command.js';
import type { Host } from '../commands.js';

/**
 * Cost lens.
 *
 * Turns the linker's output back into statements about the source: this many
 * bytes exist because you wrote `virtual`, this many because exceptions are
 * enabled. The framing throughout is what a feature costs, never whether to keep
 * it — whether exceptions are worth their bytes is a judgement about the product,
 * not something a reading tool gets to make.
 */

function config() {
  return vscode.workspace.getConfiguration('lens');
}

/** Common places a firmware build leaves its image, in the order worth trying. */
async function findElf(root: string, configured: string): Promise<string | undefined> {
  if (configured) {
    const abs = path.isAbsolute(configured) ? configured : path.join(root, configured);
    try {
      await fs.access(abs);
      return abs;
    } catch {
      return undefined;
    }
  }
  const patterns = ['**/*.elf', '**/*.axf', '**/*.out'];
  for (const p of patterns) {
    const hits = await vscode.workspace.findFiles(p, '**/node_modules/**', 4);
    if (hits.length > 0) {
      return hits[0].fsPath;
    }
  }
  return undefined;
}

export async function showCost(host: Host): Promise<void> {
  const cfg = config();
  const file = await findElf(host.workspaceRoot, cfg.get<string>('cost.elfFile', ''));
  if (!file) {
    void vscode.window.showWarningMessage(
      'Lens: no ELF found. Set lens.cost.elfFile to your linked image — the unstripped one, before any strip step.',
    );
    return;
  }

  let report: CostReport;
  try {
    const bytes = new Uint8Array(await fs.readFile(file));
    report = buildReport(parseElf(bytes));
  } catch (err) {
    void vscode.window.showWarningMessage(
      `Lens: could not read ${path.basename(file)} — ${err instanceof ElfParseError ? err.message : String(err)}`,
    );
    return;
  }

  CostPanel.show(host).setReport(path.relative(host.workspaceRoot, file) || file, report);
}

class CostPanel {
  private static instance: CostPanel | undefined;
  private findings: Finding[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly host: Host,
  ) {
    panel.onDidDispose(() => {
      CostPanel.instance = undefined;
    });
    panel.webview.onDidReceiveMessage((m) => void this.onMessage(m));
  }

  static show(host: Host): CostPanel {
    if (CostPanel.instance) {
      CostPanel.instance.panel.reveal(vscode.ViewColumn.Beside, true);
      return CostPanel.instance;
    }
    const panel = vscode.window.createWebviewPanel('lens.cost', 'Lens — Cost', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    CostPanel.instance = new CostPanel(panel, host);
    return CostPanel.instance;
  }

  setReport(label: string, report: CostReport): void {
    this.findings = detectCostConstructs(report);
    const widest = Math.max(1, ...report.groups.map((g) => g.bytes));

    const bars = report.groups
      .map((g) => {
        const width = Math.round((g.bytes / widest) * 100);
        const share = report.total > 0 ? Math.round((g.bytes / report.total) * 100) : 0;
        const top = g.top
          .map((t) => `<div class="cand">${escapeXml(t.name)} <span class="muted">${t.bytes} B · ${t.kind}</span></div>`)
          .join('');
        return `<section>
  <h2>${escapeXml(g.label)} <span class="muted">${g.bytes} bytes · ${share}%${
    g.count > 0 ? ` · ${g.count} symbols` : ''
  }</span></h2>
  <div class="bar"><div class="bar-fill ${g.category}" style="width:${width}%"></div></div>
  <p class="muted">${escapeXml(g.because)}</p>
  ${top}
</section>`;
      })
      .join('');

    const owners = report.perOwner
      .slice(0, 12)
      .map(
        (o) =>
          `<div class="cand"><code>${escapeXml(o.owner)}</code> <span class="muted">${o.bytes} B — ${o.artifacts
            .join(', ')}</span></div>`,
      )
      .join('');

    const items = this.findings
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

    const coverage = Math.round(report.reconciliation.coverage * 100);
    this.panel.webview.html = htmlShell(`
<style>
.bar { height: 9px; background: var(--lens-node); border-radius: 3px; overflow: hidden; margin: 4px 0 6px; }
.bar-fill { height: 100%; background: var(--lens-new); }
.bar-fill.unattributed, .bar-fill.linking { background: var(--lens-muted); }
.bar-fill.exceptions, .bar-fill.rtti, .bar-fill\\.virtual-inheritance { background: var(--lens-trap); }
</style>
<h1>${escapeXml(label)}</h1>
<p class="muted">${report.total} allocated bytes · ${coverage}% accounted for</p>
${
  coverage < 90
    ? `<p class="warn">${report.total - Math.round(report.total * report.reconciliation.coverage)} bytes are not ` +
      'explained by any symbol or known category. Read every figure below as a lower bound. Building with ' +
      '-ffunction-sections -fdata-sections usually closes most of the gap.</p>'
    : ''
}
<div class="split">
  <div class="canvas">${bars}</div>
  <div class="findings">
    <section><h2>What this costs you</h2><ul>${
      items || '<p class="muted">Nothing notable in this image.</p>'
    }</ul></section>
    ${owners ? `<section><h2>Per class</h2>${owners}</section>` : ''}
  </div>
</div>`);
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
