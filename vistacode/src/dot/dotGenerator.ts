import type { ControlFlowGraph, CFGNodeKind, CFGEdgeKind, CFGNode, CFGEdge } from '../parser/cfgTypes';

export type DisplayMode = 'comment' | 'code' | 'both';

const TRUNC: Record<CFGNodeKind,number> = {
  entry:60, exit:20, process:52, decision:42, loop:42, switch:34, label:28, preproc:40
};

// ─── Encoding helpers ────────────────────────────────────────────────────────

/** Escape for regular quoted dot string (single-line values only). */
function esc(s:string): string {
  return s.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,' ');
}

/** Encode for Graphviz HTML-like label content. */
function htmlEnc(s:string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function trunc(text:string, max:number): string {
  const flat=text.replace(/\s+/g,' ').trim();
  return flat.length>max ? flat.slice(0,max-1)+'\u2026' : flat;
}

// ─── Node label builder ───────────────────────────────────────────────────────
/**
 * Returns the dot label= value INCLUDING delimiters:
 *  - Multi-line → HTML label  <line1<BR/>line2>  (no surrounding quotes)
 *  - Single-line → regular   "text"
 *
 * HTML labels are the ONLY reliable way to get multi-line text in Graphviz node boxes.
 * The \n-escape approach was unreliable depending on the rendering path.
 */
function makeLabel(dl:string, kind:CFGNodeKind): string {
  const max = TRUNC[kind] ?? 45;
  const lines = dl.split('\n').filter(l=>l.trim().length>0);

  if (kind === 'entry') {
    // Entry: "FuncName\nEntry" — two lines, bold function name
    const [funcName='', tag='Entry'] = lines;
    return `<<B>${htmlEnc(trunc(funcName,max))}</B><BR/><FONT POINT-SIZE="8">${htmlEnc(tag)}</FONT>>`;
  }

  if (lines.length <= 1) {
    return `"${esc(trunc(dl, max))}"`;
  }

  // Multi-line process / loop node — left-aligned HTML label
  const htmlLines = lines.map(l => htmlEnc(trunc(l, max)));
  return `<${htmlLines.join('<BR ALIGN="LEFT"/>')}<BR ALIGN="LEFT"/>>`;
}

// ─── Visual style mappings ────────────────────────────────────────────────────

function shapeFor(k:CFGNodeKind): string {
  switch(k){case 'entry':case 'exit':return 'oval';case 'decision':case 'switch':return 'diamond';case 'loop':return 'hexagon';case 'label':return 'box';default:return 'box';}
}
function fillFor(k:CFGNodeKind): string {
  switch(k){case 'entry':return '#d4edda';case 'exit':return '#f8d7da';case 'decision':return '#fff3cd';case 'switch':return '#e8d5f5';case 'loop':return '#cce5ff';case 'label':return '#e2e3e5';default:return '#f8f9fa';}
}
function strokeFor(k:CFGNodeKind): string {
  switch(k){case 'entry':return '#28a745';case 'exit':return '#dc3545';case 'decision':return '#856404';case 'switch':return '#6f42c1';case 'loop':return '#004085';case 'label':return '#6c757d';default:return '#495057';}
}
function fontColorFor(k:CFGNodeKind): string {
  switch(k){case 'entry':return '#155724';case 'exit':return '#721c24';case 'decision':return '#533f03';case 'switch':return '#3d1f6a';case 'loop':return '#002752';case 'label':return '#383d41';case 'preproc':return '#784212';default:return '#212529';}
}
function penFor(k:CFGNodeKind): number {
  switch(k){case 'entry':case 'exit':return 2.5;case 'decision':case 'switch':case 'loop':return 2.0;default:return 1.5;}
}
function dimsFor(k:CFGNodeKind): string {
  switch(k){case 'entry':case 'exit':return 'width=1.8,height=0.55';case 'decision':case 'switch':return 'width=2.6,height=1.0';case 'loop':return 'width=2.4,height=0.9';case 'label':return 'width=1.4,height=0.38';case 'preproc':return 'width=2.6,height=1.0';default:return 'width=1.9,height=0.55';}
}
function styleFor(k:CFGNodeKind): string {
  return k==='label' ? 'filled,dashed' : 'filled';
}

// ─── Edge helpers ─────────────────────────────────────────────────────────────

export function edgeColor(k:CFGEdgeKind): string {
  switch(k){case 'true':return '#28a745';case 'false':return '#dc3545';case 'case':return '#0056b3';case 'fallthrough':return '#c06000';case 'break':return '#dc3545';case 'continue':return '#0056b3';case 'goto':return '#6f42c1';case 'loop-back':return '#138496';default:return '#495057';}
}
function edgeStyle(k:CFGEdgeKind): string {
  switch(k){case 'break':case 'continue':return 'dashed';case 'goto':return 'dotted';case 'loop-back':return 'bold';default:return 'solid';}
}

/**
 * Edge label attributes.
 * Yes/No use taillabel (placed near the source decision diamond, consistent distance).
 * labelfontcolor colours taillabel text; fontcolor colours main label text.
 */
function edgeLabelAttrs(edge:CFGEdge): string {
  const fc = edgeColor(edge.kind);
  switch(edge.kind) {
    case 'true':  return `taillabel="Yes" labelfontcolor="${fc}" labeldistance=1.5`;
    case 'false': return `taillabel="No"  labelfontcolor="${fc}" labeldistance=1.5`;
    case 'case':  return edge.label ? `label="${esc(edge.label)}" fontcolor="${fc}"` : '';
    case 'fallthrough': return `label="ft" fontcolor="${fc}"`;
    default: return '';
  }
}

// ─── Metadata exports ─────────────────────────────────────────────────────────

export interface NodeMetadata {
  fullLabel: string;
  annotation: string | null;
  codeLines: string[];
  anchorRow: number;
  kind: CFGNodeKind;
  isISR: boolean;
}
export interface EdgeMetadata { from:string; to:string; kind:CFGEdgeKind; color:string; label?:string; }

export function extractNodeMetadata(g:ControlFlowGraph): Record<string,NodeMetadata> {
  const out:Record<string,NodeMetadata>={};
  for (const [id,n] of g.nodes)
    out[id]={fullLabel:n.label,annotation:n.annotation,codeLines:n.rawLines,
             anchorRow:n.anchorRange.start.row,kind:n.kind,isISR:n.isISR??false};
  return out;
}
export function extractEdgeMetadata(g:ControlFlowGraph): EdgeMetadata[] {
  return g.edges.map(e=>({from:e.from,to:e.to,kind:e.kind,color:edgeColor(e.kind),label:e.label}));
}

// ─── Display-mode label string ─────────────────────────────────────────────────

function displayLabel(node:CFGNode, mode:DisplayMode): string {
  if (node.kind==='entry'||node.kind==='exit') return node.label;
  const codeText = node.rawLines.join('\n');
  switch(mode) {
    case 'code':  return codeText;
    case 'both':  return node.annotation ? `${node.annotation}\n────\n${codeText}` : codeText;
    default:      return node.label;   // 'comment': annotation or heuristic or code
  }
}

// ─── Main dot generator ────────────────────────────────────────────────────────

export function cfgToDot(graph:ControlFlowGraph, mode:DisplayMode='comment'): string {
  const L:string[]=[];
  L.push(`digraph "${esc(graph.functionName)}" {`);
  L.push('  rankdir=TB;');
  L.push('  splines=spline;');
  L.push('  nodesep=0.6;');
  L.push('  ranksep=0.75;');
  L.push('  node [fontname="Consolas,\\"Courier New\\",monospace", fontsize=10, margin="0.18,0.12"];');
  L.push('  edge [fontname="Helvetica,Arial,sans-serif", fontsize=9, arrowsize=1.1];');
  L.push(`  {rank=min; "${graph.entryId}";}`);
  L.push(`  {rank=max; "${graph.exitId}";}`);

  for (const node of graph.nodes.values()) {
    const dl       = displayLabel(node, mode);
    const labelVal = makeLabel(dl, node.kind);
    const tooltip  = esc(dl.replace(/\n/g,' '));
    const dims     = dimsFor(node.kind);
    // Note: label= value already has its delimiters from makeLabel (<...> or "...")
    const attrs = [
      `id="${node.id}"`,
      `label=${labelVal}`,
      `tooltip="${tooltip}"`,
      `shape=${shapeFor(node.kind)}`,
      `style="${styleFor(node.kind)}"`,
      `fillcolor="${fillFor(node.kind)}"`,
      `color="${strokeFor(node.kind)}"`,
      `fontcolor="${fontColorFor(node.kind)}"`,
      `penwidth=${penFor(node.kind)}`,
      dims
    ];
    L.push(`  "${node.id}" [${attrs.join(', ')}];`);
  }

  for (const edge of graph.edges) {
    const lbl  = edgeLabelAttrs(edge);
    const attrs= [`color="${edgeColor(edge.kind)}"`,`style=${edgeStyle(edge.kind)}`,`penwidth=1.4`,
                  ...(lbl ? [lbl] : [])].join(', ');
    L.push(`  "${edge.from}" -> "${edge.to}" [${attrs}];`);
  }

  L.push('}');
  return L.join('\n');
}

export type LayoutMode = 'vertical' | 'horizontal' | 'radial';

/**
 * Adjusts the base TB dot source for the requested layout direction and
 * returns the engine to use for rendering.  Called in the extension host
 * so the webview receives positions rather than having to render itself.
 */
export function prepareDotForLayout(
  baseDot: string,
  layout: LayoutMode
): { dot: string; engine: 'dot' | 'twopi' } {
  if (layout === 'horizontal') {
    return {
      dot: baseDot.replace(/rankdir=\w+;/, 'rankdir=LR;')
                  .replace(/splines=\w+;/, 'splines=spline;'),
      engine: 'dot'
    };
  }
  if (layout === 'radial') {
    const entryMatch = baseDot.match(/\{rank=min;\s*"([^"]+)";\s*\}/);
    const entryId    = entryMatch?.[1] ?? 'n1';
    const bi = baseDot.indexOf('{');
    const dot = bi !== -1
      ? baseDot.slice(0, bi + 1)
        + `\n  root="${entryId}";\n  overlap=false;\n  sep="0.7";\n`
        + baseDot.slice(bi + 1)
      : baseDot;
    return { dot, engine: 'twopi' };
  }
  return { dot: baseDot, engine: 'dot' };
}
