import * as vscode from 'vscode';

function getNonce(): string {
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let t=''; for(let i=0;i<32;i++) t+=chars[Math.floor(Math.random()*chars.length)]; return t;
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri,'dist','webview','main.js'));
  const n = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Vistacode</title>
  <style>
    *,*::before,*::after{box-sizing:border-box}
    html,body{margin:0;padding:0;height:100%;overflow:hidden}
    body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);display:flex;flex-direction:column}

    /* Toolbar */
    #toolbar{flex-shrink:0;padding:4px 10px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;border-bottom:1px solid var(--vscode-panel-border,#444);font-size:11px;background:var(--vscode-editorGroupHeader-tabsBackground,inherit);user-select:none}
    #toolbar strong{font-size:12px;font-weight:700}
    .tb-sep{width:1px;height:16px;background:var(--vscode-panel-border,#555);flex-shrink:0}
    #function-name{opacity:.8;font-style:italic;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .btn-group{display:flex;gap:2px}
    .tb-btn{background:var(--vscode-button-secondaryBackground,#3c3c3c);color:var(--vscode-button-secondaryForeground,#ccc);border:1px solid var(--vscode-contrastBorder,transparent);border-radius:3px;padding:2px 7px;cursor:pointer;font-size:11px;font-family:inherit;line-height:1.5;white-space:nowrap}
    .tb-btn:hover{background:var(--vscode-button-secondaryHoverBackground,#505050)}
    .tb-btn.active{background:var(--vscode-button-background,#0e639c);color:var(--vscode-button-foreground,#fff);border-color:transparent}
    #zoom-label{min-width:38px;text-align:center;font-size:11px;opacity:.85}
    .tb-spacer{flex:1}

    /* Cytoscape container */
    #diagram{flex:1;position:relative;overflow:hidden}
    #cy{width:100%;height:100%}

    /* Cursor styles */
    #cy{cursor:grab}
    #cy.grabbing{cursor:grabbing}

    /* Ctrl+hover visual cue */
    .vc-ctrl-hint::after{
      content:'✎ rename';position:absolute;background:var(--vscode-editorWidget-background,#252526);
      color:var(--vscode-foreground);padding:2px 6px;border-radius:3px;font-size:10px;
      pointer-events:none;z-index:100;white-space:nowrap
    }

    /* Legend */
    #legend{position:absolute;bottom:12px;right:12px;z-index:10;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-panel-border,#444);border-radius:6px;padding:8px 12px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.3);min-width:170px;pointer-events:all}
    #legend summary{cursor:pointer;font-weight:700;font-size:13px}
    #legend details[open] summary{margin-bottom:6px}
    .legend-row{display:flex;align-items:center;gap:7px;margin:4px 0;cursor:pointer;border-radius:3px;padding:2px 4px;transition:background .1s}
    .legend-row:hover{background:var(--vscode-list-hoverBackground,rgba(255,255,255,.08))}
    .legend-row.active-filter{background:var(--vscode-list-activeSelectionBackground,#094771)}
    .leg-line{display:inline-block;width:28px;height:2px;flex-shrink:0}
    .leg-line.dashed{background:repeating-linear-gradient(90deg,currentColor 0 4px,transparent 4px 7px)}
    .leg-line.dotted{background:repeating-linear-gradient(90deg,currentColor 0 2px,transparent 2px 5px)}
    .leg-line.bold{height:3px}
    .leg-swatch{display:inline-block;width:13px;height:13px;border-radius:2px;flex-shrink:0;border:1px solid #0004}
    #legend hr{margin:6px 0;border:none;border-top:1px solid var(--vscode-panel-border,#555)}
    .leg-clear{font-size:10px;opacity:.6;cursor:pointer;margin-top:4px;text-align:right}
    .leg-clear:hover{opacity:1}

    /* Tooltip */
    #vc-tooltip{position:fixed;display:none;max-width:400px;padding:6px 10px;border-radius:4px;font-size:11px;
      font-family:'Consolas','Courier New',monospace;line-height:1.6;box-shadow:0 3px 10px rgba(0,0,0,.4);
      z-index:9999;pointer-events:none;white-space:pre-wrap;word-break:break-word}
  </style>
</head>
<body>
  <div id="toolbar">
    <strong>Vistacode</strong>
    <div class="tb-sep"></div>
    <span id="function-name">no function selected</span>
    <div class="tb-spacer"></div>

    <!-- Display mode -->
    <div class="btn-group" id="display-group">
      <button class="tb-btn active" data-display="comment" title="Show annotation comment (or code if none)">Comment</button>
      <button class="tb-btn" data-display="code"    title="Always show raw source code">Code</button>
      <button class="tb-btn" data-display="both"    title="Show annotation + code">Both</button>
    </div>
    <div class="tb-sep"></div>

    <!-- Layout direction -->
    <div class="btn-group" id="layout-group">
      <button class="tb-btn active" data-layout="vertical"   title="Top → Bottom">↕ TB</button>
      <button class="tb-btn"        data-layout="horizontal" title="Left → Right">↔ LR</button>
      <button class="tb-btn"        data-layout="radial"     title="Radial (twopi)">⊙ Radial</button>
    </div>
    <button class="tb-btn" id="btn-reset" title="Reset to Graphviz auto-layout (discards manual positions)">↺ Reset</button>
    <div class="tb-sep"></div>

    <!-- Zoom -->
    <div class="btn-group">
      <button class="tb-btn" id="btn-zoom-out" title="Zoom out">−</button>
      <span id="zoom-label">100%</span>
      <button class="tb-btn" id="btn-zoom-in"  title="Zoom in">+</button>
    </div>
    <button class="tb-btn" id="btn-fit" title="Fit diagram to window">⌖ Fit</button>
  </div>

  <div id="diagram">
    <div id="cy"></div>

    <div id="legend">
      <details open>
        <summary>Legend <span style="font-weight:400;font-size:11px;opacity:.6">(click to filter)</span></summary>
        <div class="legend-row" data-edge-kind="flow"><div class="leg-line" style="background:#495057"></div>Flow</div>
        <div class="legend-row" data-edge-kind="true"><div class="leg-line" style="background:#28a745"></div>True / Yes</div>
        <div class="legend-row" data-edge-kind="false"><div class="leg-line" style="background:#dc3545"></div>False / No</div>
        <div class="legend-row" data-edge-kind="case"><div class="leg-line" style="background:#0056b3"></div>Case</div>
        <div class="legend-row" data-edge-kind="fallthrough"><div class="leg-line dashed" style="color:#c06000"></div>Fallthrough</div>
        <div class="legend-row" data-edge-kind="break"><div class="leg-line dashed" style="color:#dc3545"></div>Break exit</div>
        <div class="legend-row" data-edge-kind="continue"><div class="leg-line dashed" style="color:#0056b3"></div>Continue</div>
        <div class="legend-row" data-edge-kind="goto"><div class="leg-line dotted" style="color:#6f42c1"></div>Goto</div>
        <div class="legend-row" data-edge-kind="loop-back"><div class="leg-line bold" style="background:#138496"></div>Loop back</div>
        <hr/>
        <div class="legend-row" data-node-kind="entry"><div class="leg-swatch" style="background:#d4edda"></div>Entry</div>
        <div class="legend-row" data-node-kind="exit"><div class="leg-swatch" style="background:#f8d7da"></div>Exit</div>
        <div class="legend-row" data-node-kind="decision"><div class="leg-swatch" style="background:#fff3cd"></div>Decision (if)</div>
        <div class="legend-row" data-node-kind="switch"><div class="leg-swatch" style="background:#e8d5f5"></div>Switch</div>
        <div class="legend-row" data-node-kind="loop"><div class="leg-swatch" style="background:#cce5ff"></div>Loop</div>
        <div class="legend-row" data-node-kind="process"><div class="leg-swatch" style="background:#f8f9fa;border:1px solid #ccc"></div>Process</div>
        <div class="legend-row" data-node-kind="label"><div class="leg-swatch" style="background:#e2e3e5;border-style:dashed"></div>Label</div>
        <div class="leg-clear" id="legend-clear" style="display:none">✕ Clear filter</div>
      </details>
    </div>
  </div>

  <div id="vc-tooltip"></div>
  <script nonce="${n}" src="${scriptUri}"></script>
</body>
</html>`;
}
