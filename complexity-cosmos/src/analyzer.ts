import * as vscode from 'vscode';
import { spawn } from 'child_process';

export type MetricKey = 'ccn' | 'nloc' | 'tokens' | 'params' | 'length';

export interface FunctionMetric {
  file: string;
  name: string;
  longName: string;
  ccn: number;
  nloc: number;
  tokens: number;
  params: number;
  length: number;
  start: number;
  end: number;
}

export interface MetricMeta {
  label: string;
  unit: string;
  defaultThreshold: number;
  /** 7 ascending edges -> 8 tiers (0 asteroid … 7 black hole). */
  bands: number[];
}

export const METRICS: Record<MetricKey, MetricMeta> = {
  ccn:    { label: 'Cyclomatic',   unit: 'CCN',   defaultThreshold: 10,  bands: [3, 5, 7, 11, 16, 24, 40] },
  nloc:   { label: 'Lines (NLOC)', unit: 'NLOC',  defaultThreshold: 60,  bands: [8, 18, 30, 50, 80, 120, 180] },
  tokens: { label: 'Tokens',       unit: 'TOK',   defaultThreshold: 400, bands: [60, 120, 220, 360, 560, 820, 1100] },
  params: { label: 'Parameters',   unit: 'PARAM', defaultThreshold: 5,   bands: [1, 2, 3, 4, 5, 6, 7] },
  length: { label: 'Span (lines)', unit: 'LINES', defaultThreshold: 80,  bands: [10, 20, 35, 55, 85, 130, 200] },
};

export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

/** Celestial tier 0..7 for a value against a metric's bands. */
export function tierOf(value: number, bands: number[]): number {
  let t = 0;
  for (const b of bands) {
    if (value > b) { t++; } else { break; }
  }
  return t;
}

export const TIER_GLYPH = ['🪨', '🌑', '🪐', '🟠', '⭐', '🔴', '✦', '🕳️'];
export const TIER_NAME = ['Asteroid', 'Moon', 'Planet', 'Gas giant', 'Star', 'Red giant', 'Neutron star', 'Black hole'];

let warnedNoLizard = false;

/** Run the python/lizard backend over the given files. Always resolves (never throws). */
export function analyzeFiles(files: string[], extensionUri: vscode.Uri): Promise<FunctionMetric[]> {
  if (files.length === 0) { return Promise.resolve([]); }
  const cfg = vscode.workspace.getConfiguration('complexityCosmos');
  const py = cfg.get<string>('pythonPath', 'python');
  const script = vscode.Uri.joinPath(extensionUri, 'python', 'analyze.py').fsPath;

  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(py, [script, ...files]);
    } catch {
      resolve([]);
      return;
    }
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { err += d.toString(); });
    proc.on('error', () => {
      vscode.window.showWarningMessage(
        `Complexity Cosmos: could not run "${py}". Set "complexityCosmos.pythonPath" in settings.`,
      );
      resolve([]);
    });
    proc.on('close', () => {
      if (err.includes('lizard-not-installed')) {
        if (!warnedNoLizard) {
          warnedNoLizard = true;
          vscode.window
            .showWarningMessage('Complexity Cosmos needs the "lizard" package.', 'Install command')
            .then((pick) => {
              if (pick) {
                vscode.env.clipboard.writeText(`${py} -m pip install lizard`);
                vscode.window.showInformationMessage('Copied: pip install lizard');
              }
            });
        }
        resolve([]);
        return;
      }
      try {
        resolve(JSON.parse(out || '[]') as FunctionMetric[]);
      } catch {
        resolve([]);
      }
    });
  });
}

/** Convenience: analyze a single open document (writes through its on-disk path). */
export async function analyzeDocument(doc: vscode.TextDocument, extensionUri: vscode.Uri): Promise<FunctionMetric[]> {
  if (!['c', 'cpp'].includes(doc.languageId)) { return []; }
  if (doc.isUntitled) { return []; }
  return analyzeFiles([doc.uri.fsPath], extensionUri);
}
