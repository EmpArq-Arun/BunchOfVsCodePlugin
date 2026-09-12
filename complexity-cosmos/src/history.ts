import * as vscode from 'vscode';
import { FunctionMetric, MetricKey, METRIC_KEYS } from './analyzer';

interface Snapshot {
  t: number;
  ccn: number; nloc: number; tokens: number; params: number; length: number;
}
interface HistoryFile {
  version: number;
  functions: Record<string, Snapshot[]>;
}

const FILE_VERSION = 1;

/** Stable key for a function across edits: workspace-relative path + signature. */
function keyFor(f: FunctionMetric): string {
  const rel = vscode.workspace.asRelativePath(f.file, false);
  return `${rel}::${f.longName || f.name}`;
}

export class HistoryStore {
  private cache: HistoryFile | null = null;

  private uri(): vscode.Uri | null {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) { return null; }
    return vscode.Uri.joinPath(folder.uri, '.vscode', 'complexity-history.json');
  }

  private async load(): Promise<HistoryFile> {
    if (this.cache) { return this.cache; }
    const uri = this.uri();
    if (uri) {
      try {
        const buf = await vscode.workspace.fs.readFile(uri);
        const parsed = JSON.parse(Buffer.from(buf).toString('utf8')) as HistoryFile;
        if (parsed && parsed.functions) { this.cache = parsed; return parsed; }
      } catch { /* missing or invalid -> start fresh */ }
    }
    this.cache = { version: FILE_VERSION, functions: {} };
    return this.cache;
  }

  private async save(data: HistoryFile): Promise<void> {
    const uri = this.uri();
    if (!uri) { return; }
    const dir = vscode.Uri.joinPath(uri, '..');
    try { await vscode.workspace.fs.createDirectory(dir); } catch { /* exists */ }
    const body = Buffer.from(JSON.stringify(data, null, 2), 'utf8');
    await vscode.workspace.fs.writeFile(uri, body);
  }

  /** Append a timestamped snapshot for each function and trim to the configured limit. */
  async record(functions: FunctionMetric[]): Promise<void> {
    if (functions.length === 0) { return; }
    const limit = vscode.workspace.getConfiguration('complexityCosmos').get<number>('historyLimit', 50);
    const data = await this.load();
    const t = Date.now();
    for (const f of functions) {
      const k = keyFor(f);
      const arr = data.functions[k] ?? (data.functions[k] = []);
      arr.push({ t, ccn: f.ccn, nloc: f.nloc, tokens: f.tokens, params: f.params, length: f.length });
      if (arr.length > limit) { arr.splice(0, arr.length - limit); }
    }
    await this.save(data);
  }

  /** Numeric series for one function + metric, oldest -> newest. */
  series(f: FunctionMetric, metric: MetricKey): number[] {
    if (!this.cache) { return [f[metric]]; }
    const arr = this.cache.functions[keyFor(f)];
    if (!arr || arr.length === 0) { return [f[metric]]; }
    return arr.map((s) => s[metric]);
  }

  /** Per-metric series bundle for the webview payload. */
  histFor(f: FunctionMetric): Record<MetricKey, number[]> {
    const out = {} as Record<MetricKey, number[]>;
    for (const m of METRIC_KEYS) { out[m] = this.series(f, m); }
    return out;
  }
}
