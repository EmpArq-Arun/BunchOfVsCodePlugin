import * as vscode from 'vscode';
import {
  analyzeDocument, FunctionMetric, MetricKey, METRICS, METRIC_KEYS,
  tierOf, TIER_GLYPH, TIER_NAME,
} from './analyzer';
import { HistoryStore } from './history';
import { CosmosPanel, PanelData } from './panel';

const RISK = ['Trivial', 'Simple', 'Modest', 'Notable', 'Heavy', 'Severe', 'Critical', 'Untestable'];

let statusBar: vscode.StatusBarItem;
let diagnostics: vscode.DiagnosticCollection;
let history: HistoryStore;
let extUri: vscode.Uri;

/** Latest analysis per open document. */
const cache = new Map<string, FunctionMetric[]>();

export function activate(context: vscode.ExtensionContext): void {
  extUri = context.extensionUri;
  history = new HistoryStore();

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'complexityCosmos.showPanel';
  context.subscriptions.push(statusBar);

  diagnostics = vscode.languages.createDiagnosticCollection('complexityCosmos');
  context.subscriptions.push(diagnostics);

  context.subscriptions.push(
    vscode.commands.registerCommand('complexityCosmos.showPanel', () => openPanel()),
    vscode.commands.registerCommand('complexityCosmos.snapshot', () => snapshotActive()),
    vscode.commands.registerCommand('complexityCosmos.selectMetric', () => selectMetric()),
    vscode.window.onDidChangeActiveTextEditor((ed) => { if (ed) { void refresh(ed.document, false); } }),
    vscode.window.onDidChangeTextEditorSelection((e) => updateStatusBar(e.textEditor)),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const snap = vscode.workspace.getConfiguration('complexityCosmos').get<boolean>('snapshotOnSave', true);
      void refresh(doc, snap);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => cache.delete(doc.uri.toString())),
  );

  if (vscode.window.activeTextEditor) {
    void refresh(vscode.window.activeTextEditor.document, false);
  }
}

export function deactivate(): void { /* nothing to clean up beyond subscriptions */ }

// ---- config helpers ----

function activeMetric(): MetricKey {
  const m = vscode.workspace.getConfiguration('complexityCosmos').get<string>('metric', 'ccn');
  return (METRIC_KEYS as string[]).includes(m) ? (m as MetricKey) : 'ccn';
}

function thresholds(): Record<MetricKey, number> {
  const obj = vscode.workspace.getConfiguration('complexityCosmos').get<Record<string, number>>('thresholds', {});
  const out = {} as Record<MetricKey, number>;
  for (const m of METRIC_KEYS) { out[m] = obj?.[m] ?? METRICS[m].defaultThreshold; }
  return out;
}

async function setThreshold(metric: MetricKey, value: number): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('complexityCosmos');
  const obj = { ...(cfg.get<Record<string, number>>('thresholds', {})) };
  obj[metric] = value;
  const target = vscode.workspace.workspaceFolders
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await cfg.update('thresholds', obj, target);
}

// ---- core refresh ----

async function refresh(doc: vscode.TextDocument, snapshot: boolean): Promise<void> {
  if (!['c', 'cpp'].includes(doc.languageId)) { return; }
  const functions = await analyzeDocument(doc, extUri);
  cache.set(doc.uri.toString(), functions);

  if (snapshot && functions.length) { await history.record(functions); }

  updateDiagnostics(doc, functions);
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.toString() === doc.uri.toString()) { updateStatusBar(ed); }
  pushPanel();
}

function updateDiagnostics(doc: vscode.TextDocument, functions: FunctionMetric[]): void {
  const metric = activeMetric();
  const thr = thresholds()[metric];
  const items: vscode.Diagnostic[] = [];
  for (const f of functions) {
    const v = f[metric];
    if (v <= thr * 0.75) { continue; }
    const line = Math.max(0, f.start - 1);
    const range = doc.lineAt(Math.min(line, doc.lineCount - 1)).range;
    const tier = tierOf(v, METRICS[metric].bands);
    const sev = v > thr * 2
      ? vscode.DiagnosticSeverity.Error
      : v > thr
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Information;
    const d = new vscode.Diagnostic(
      range,
      `${f.name}: ${METRICS[metric].label} ${v} — ${TIER_NAME[tier]} (${RISK[tier]}), threshold ${thr}`,
      sev,
    );
    d.source = 'Complexity Cosmos';
    items.push(d);
  }
  diagnostics.set(doc.uri, items);
}

function updateStatusBar(editor: vscode.TextEditor | undefined): void {
  if (!editor || !['c', 'cpp'].includes(editor.document.languageId)) {
    statusBar.hide();
    return;
  }
  const functions = cache.get(editor.document.uri.toString());
  if (!functions || !functions.length) { statusBar.hide(); return; }

  const line = editor.selection.active.line + 1; // 1-based to match lizard
  const fn = functions.find((f) => line >= f.start && line <= f.end)
    ?? [...functions].sort((a, b) => b[activeMetric()] - a[activeMetric()])[0];

  const metric = activeMetric();
  const v = fn[metric];
  const thr = thresholds()[metric];
  const tier = tierOf(v, METRICS[metric].bands);

  const series = history.series(fn, metric);
  const delta = series.length > 1 ? series[series.length - 1] - series[0] : 0;
  const arrow = delta > 0.5 ? ' ▲' : delta < -0.5 ? ' ▼' : '';

  statusBar.text = `${TIER_GLYPH[tier]} ${fn.name} · ${METRICS[metric].unit} ${v}${arrow}`;
  statusBar.tooltip = new vscode.MarkdownString(
    `**${fn.name}** — ${TIER_NAME[tier]} (${RISK[tier]})\n\n`
    + `${METRICS[metric].label}: **${v}** (threshold ${thr})\n\n`
    + `CCN ${fn.ccn} · NLOC ${fn.nloc} · ${fn.tokens} tokens · ${fn.params} params\n\n`
    + `_Click to open the cosmos._`,
  );
  statusBar.backgroundColor = v > thr * 2
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : v > thr
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  statusBar.show();
}

// ---- panel ----

function buildPanelData(): PanelData {
  const ed = vscode.window.activeTextEditor;
  const functions = (ed && cache.get(ed.document.uri.toString())) || [];
  const file = ed ? vscode.workspace.asRelativePath(ed.document.uri, false) : '';
  return {
    metric: activeMetric(),
    thresholds: thresholds(),
    file,
    functions: functions.map((f) => ({ ...f, hist: history.histFor(f) })),
  };
}

function pushPanel(): void {
  if (CosmosPanel.current) { CosmosPanel.current.update(buildPanelData()); }
}

function openPanel(): void {
  CosmosPanel.createOrShow(extUri, {
    onReveal: revealFunction,
    onSetMetric: async (m) => {
      await vscode.workspace.getConfiguration('complexityCosmos')
        .update('metric', m, vscode.ConfigurationTarget.Global);
      const ed = vscode.window.activeTextEditor;
      if (ed) { updateDiagnostics(ed.document, cache.get(ed.document.uri.toString()) || []); updateStatusBar(ed); }
      pushPanel();
    },
    onSetThreshold: async (m, value) => {
      await setThreshold(m, value);
      const ed = vscode.window.activeTextEditor;
      if (ed) { updateDiagnostics(ed.document, cache.get(ed.document.uri.toString()) || []); updateStatusBar(ed); }
      pushPanel();
    },
  });
  const ed = vscode.window.activeTextEditor;
  if (ed) { void refresh(ed.document, false); } else { pushPanel(); }
}

async function revealFunction(file: string, start: number): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const uri = file.includes('/') || file.includes('\\')
    ? (folder ? vscode.Uri.joinPath(folder.uri, file) : vscode.Uri.file(file))
    : vscode.Uri.file(file);
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    const line = Math.max(0, start - 1);
    const range = new vscode.Range(line, 0, line, 0);
    editor.selection = new vscode.Selection(range.start, range.start);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  } catch {
    vscode.window.showWarningMessage(`Complexity Cosmos: could not open ${file}.`);
  }
}

// ---- commands ----

async function snapshotActive(): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed) { return; }
  await refresh(ed.document, true);
  vscode.window.showInformationMessage('Complexity Cosmos: snapshot saved to .vscode/complexity-history.json');
}

async function selectMetric(): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    METRIC_KEYS.map((m) => ({ label: METRICS[m].label, description: METRICS[m].unit, key: m })),
    { placeHolder: 'Complexity metric to display' },
  );
  if (!pick) { return; }
  await vscode.workspace.getConfiguration('complexityCosmos')
    .update('metric', pick.key, vscode.ConfigurationTarget.Global);
  const ed = vscode.window.activeTextEditor;
  if (ed) { await refresh(ed.document, false); }
}
