import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Graphviz } from '@hpcc-js/wasm-graphviz';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

let resvgReady: Promise<void> | null = null;

async function ensureResvg(extensionPath: string): Promise<void> {
  if (!resvgReady) {
    const wasmPath = path.join(extensionPath, 'dist', 'wasm', 'resvg.wasm');
    resvgReady = initWasm(fs.readFileSync(wasmPath));
  }
  await resvgReady;
}

export async function renderSvg(dot: string): Promise<string> {
  const graphviz = await Graphviz.load();
  return graphviz.dot(dot, 'svg');
}

export async function renderPng(svg: string, extensionPath: string): Promise<Uint8Array> {
  await ensureResvg(extensionPath);
  const instance = new Resvg(svg);
  const rendered = instance.render();
  return rendered.asPng();
}

export interface ExportTargets {
  dotUri: vscode.Uri;
  svgUri: vscode.Uri;
  pngUri: vscode.Uri;
}

export function buildExportTargets(dir: vscode.Uri, functionKey: string): ExportTargets {
  const safeName = functionKey.replace(/[\\/:*?"<>|]/g, '_');
  return {
    dotUri: vscode.Uri.joinPath(dir, `${safeName}.dot`),
    svgUri: vscode.Uri.joinPath(dir, `${safeName}.svg`),
    pngUri: vscode.Uri.joinPath(dir, `${safeName}.png`)
  };
}

export async function exportDiagram(extensionPath: string, dot: string, targets: ExportTargets): Promise<void> {
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(targets.dotUri.fsPath)));

  await vscode.workspace.fs.writeFile(targets.dotUri, Buffer.from(dot, 'utf8'));

  const svg = await renderSvg(dot);
  await vscode.workspace.fs.writeFile(targets.svgUri, Buffer.from(svg, 'utf8'));

  try {
    const png = await renderPng(svg, extensionPath);
    await vscode.workspace.fs.writeFile(targets.pngUri, Buffer.from(png));
  } catch (err) {
    // PNG is a nice-to-have on top of the always-available dot/svg — don't fail the whole export over it.
    void vscode.window.showWarningMessage(`Vistacode: SVG and DOT exported, but PNG conversion failed (${String(err)}).`);
  }
}

/** Singleton Graphviz instance (avoids WASM re-init on every render). */
let _gv: import('@hpcc-js/wasm-graphviz').Graphviz | null = null;
async function getGv() {
  if (!_gv) { const { Graphviz } = await import('@hpcc-js/wasm-graphviz'); _gv = await Graphviz.load(); }
  return _gv!;
}

/** Render dot to SVG using the given Graphviz engine (dot or twopi). */
export async function renderSvgWithEngine(dot: string, engine: 'dot' | 'twopi' = 'dot'): Promise<string> {
  const gv = await getGv();
  return engine === 'twopi' ? gv.twopi(dot, 'svg') : gv.dot(dot, 'svg');
}
