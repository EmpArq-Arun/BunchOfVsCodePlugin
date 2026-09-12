/**
 * Shared webview shell.
 *
 * Every lens renders SVG built in the extension host and styles it through CSS
 * custom properties bound here to VS Code theme variables. Keeping that binding
 * in one place is what lets the renderers stay pure functions that know nothing
 * about themes — and what stops two lenses drifting into using the same colour
 * to mean different things, which in a comprehension tool is a correctness
 * problem rather than a cosmetic one.
 */

const CSS = `
:root {
  --lens-bg: var(--vscode-editor-background);
  --lens-fg: var(--vscode-editor-foreground);
  --lens-muted: var(--vscode-descriptionForeground);
  --lens-node: var(--vscode-editorWidget-background);
  --lens-border: var(--vscode-panel-border);
  --lens-edge: var(--vscode-editorIndentGuide-activeBackground, #888);
  --lens-trap: var(--vscode-editorWarning-foreground);
  --lens-new: var(--vscode-editorInfo-foreground);
  --lens-familiar: var(--vscode-charts-green, #5cb85c);
  --lens-annotated: var(--vscode-charts-purple, #b072d8);
  --lens-unknown: var(--vscode-editorWarning-foreground);
  --lens-highlight: var(--vscode-editor-selectionBackground);
}
body { font-family: var(--vscode-font-family); color: var(--lens-fg); padding: 12px 16px; }
h1 { font-size: 1.15rem; margin: 0 0 4px; }
h2 { font-size: 0.9rem; margin: 0 0 6px; font-weight: 600; }
h2 a, a { color: var(--vscode-textLink-foreground); }
p { margin: 2px 0 10px; }
.muted { color: var(--lens-muted); font-size: 0.85rem; }
.warn { color: var(--lens-trap); font-size: 0.85rem; }
.split { display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap; }
.canvas { flex: 1 1 480px; overflow: auto; }
.findings { flex: 1 1 380px; max-width: 560px; }
section { border-top: 1px solid var(--lens-border); padding: 12px 0; }
ul { list-style: none; margin: 0; padding: 0; }
.f { border-left: 3px solid var(--lens-border); padding: 6px 0 8px 10px; margin-bottom: 10px; font-size: 0.86rem; }
.f.trap { border-left-color: var(--lens-trap); }
.f.new { border-left-color: var(--lens-new); }
.f.familiar { border-left-color: var(--lens-familiar); }
.ftitle { font-weight: 600; margin-bottom: 4px; }
.femits, .fc { margin-bottom: 4px; color: var(--lens-muted); }
.lbl { display: inline-block; min-width: 42px; text-transform: uppercase; font-size: 0.68rem;
       letter-spacing: 0.04em; opacity: 0.7; }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
         border: none; padding: 3px 9px; border-radius: 2px; cursor: pointer; font-size: 0.78rem; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.status { padding: 40px 0; max-width: 620px; }
.status.error strong { color: var(--lens-trap); }
.node { cursor: pointer; }
.node:hover rect { filter: brightness(1.25); }
svg { max-width: 100%; height: auto; }
.legend { display: flex; gap: 18px; flex-wrap: wrap; font-size: 0.78rem; color: var(--lens-muted);
          border-top: 1px solid var(--lens-border); padding-top: 8px; margin-top: 10px; }
.legend b { color: var(--lens-fg); font-weight: 600; }
.cand { font-size: 0.83rem; padding: 4px 0 4px 10px; border-left: 2px solid var(--lens-border); margin-bottom: 6px; }
.cand.strong { border-left-color: var(--lens-familiar); }
.cand.none { border-left-color: var(--lens-unknown); }
.cand code { font-size: 0.83rem; }
`;

/** Client script shared by all panels: clicks and keyboard activation post messages. */
const SCRIPT = `
const vscode = acquireVsCodeApi();
document.addEventListener('click', (e) => {
  const seed = e.target.closest('[data-action="seed"]');
  if (seed) {
    const p = JSON.parse(seed.getAttribute('data-payload'));
    vscode.postMessage({ action: 'seed', qname: p.qname, index: p.index });
    return;
  }
  const el = e.target.closest('[data-action]');
  if (el) {
    e.preventDefault();
    vscode.postMessage({ action: el.getAttribute('data-action'), qname: el.getAttribute('data-qname') });
    return;
  }
  const node = e.target.closest('.node');
  if (node) {
    vscode.postMessage({ action: 'reveal', qname: node.getAttribute('data-qname') });
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const node = e.target.closest && e.target.closest('.node');
  if (node) {
    e.preventDefault();
    vscode.postMessage({ action: 'focus', qname: node.getAttribute('data-qname') });
  }
});
`;

export function htmlShell(body: string): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${CSS}</style></head><body>${body}
<script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
