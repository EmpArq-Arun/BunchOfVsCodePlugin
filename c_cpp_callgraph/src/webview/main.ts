/// <reference lib="dom" />
import {
  CallGraphData, ClassHierarchyData, ClassGraphData,
  ExtensionToWebviewMessage, WebviewToExtensionMessage,
  FunctionNode, SourceLocation,
} from '../types';

declare const cytoscape: any;
declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToExtensionMessage): void;
  getState(): any; setState(s: any): void;
};

const vscode = acquireVsCodeApi();
function send(msg: WebviewToExtensionMessage) { vscode.postMessage(msg); }

// ── Persisted UI state ───────────────────────────────────────────────────

// All filter IDs; default = all enabled.
const ALL_FILTERS = ['direct','pointer','virtual','confirmed','contradicted','unchecked','inactive','lambda'] as const;
type FilterId = typeof ALL_FILTERS[number];

interface UiState {
  theme: 'dark' | 'light';
  depth: number;
  layout: 'dagre-lr' | 'dagre-tb' | 'dagre-bt' | 'breadthfirst' | 'cose' | 'circle' | 'radial';
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  depthSeeded: boolean;
  filters: FilterId[];
  filtersCollapsed: boolean;
  clustered: boolean;
  pathMode: boolean;  // show only root→selected path
}
const saved: Partial<UiState> = vscode.getState() ?? {};
let theme:             'dark' | 'light'       = saved.theme             ?? 'dark';
let currentLayout:     UiState['layout']      = saved.layout            ?? 'dagre-lr';
let currentDepth:      number                  = saved.depth             ?? 0;
let sidebarWidth:      number                  = saved.sidebarWidth      ?? 280;
let sidebarCollapsed:  boolean                 = saved.sidebarCollapsed   ?? false;
let depthSeeded:       boolean                 = saved.depthSeeded        ?? false;
let filtersCollapsed:  boolean                 = saved.filtersCollapsed   ?? false;
let clustered:         boolean                 = saved.clustered          ?? false;
let classNsFilters:    Set<string>             = new Set();   // populated when class diagram loads
let classFileFilters:  Set<string>             = new Set();   // empty = show all files
let pathMode:          boolean                 = saved.pathMode           ?? false;
let activeFilters: Set<FilterId> = new Set(saved.filters ?? [...ALL_FILTERS]);

function saveState() {
  vscode.setState({ theme, layout: currentLayout, depth: currentDepth,
    sidebarWidth, sidebarCollapsed, depthSeeded,
    filters: [...activeFilters], filtersCollapsed, clustered, pathMode });
}

// ── Runtime graph state ──────────────────────────────────────────────────
let fullGraph:         CallGraphData | null = null;
let classHierarchy:    ClassHierarchyData | null = null;
let classUmlData:      ClassGraphData | null = null;
let uiMode:            'callgraph' | 'classDiagram' = 'callgraph';
let selectedNodeId:    string | null = null;
let callSiteCycle:     SourceLocation[] = [];   // callers of the selected node
let callSiteIndex:     number = -1;              // which caller is active
let cy:                any = null;
let depthFetchTimer:   number | undefined;
let popupNodeId:       string | null = null;     // node whose source is in the popup
let popupPinned:       boolean = false;
let popupHovered:      boolean = false;
let popupDragOffX:     number = 0;
let popupDragOffY:     number = 0;

// ── DOM scaffold ─────────────────────────────────────────────────────────
document.getElementById('app')!.innerHTML = `
<div class="toolbar">
  <span class="mode-badge" id="modeBadge">heuristic mode</span>
  <span class="enrich-status" id="enrichStatus" hidden>verifying with clang…</span>
  <div class="depth-control" id="depthControl">
    <label for="depthSlider">Depth <span id="depthValue">–</span>/20</label>
    <input type="range" id="depthSlider" min="1" max="20" value="5"/>
  </div>
  <div class="layout-control">
    <label for="layoutSel">Layout</label>
    <select id="layoutSel">
      <option value="dagre-lr"     ${currentLayout==='dagre-lr'?'selected':''}>→ Horizontal</option>
      <option value="dagre-tb"     ${currentLayout==='dagre-tb'?'selected':''}>↓ Vertical</option>
      <option value="dagre-bt"     ${currentLayout==='dagre-bt'?'selected':''}>↑ Hierarchy</option>
      <option value="breadthfirst" ${currentLayout==='breadthfirst'?'selected':''}>⊥ Tree</option>
      <option value="cose"         ${currentLayout==='cose'?'selected':''}>⬡ Force</option>
      <option value="circle"       ${currentLayout==='circle'?'selected':''}>○ Circle</option>
      <option value="radial"       ${currentLayout==='radial'?'selected':''}>⬤ Radial</option>
    </select>
  </div>
  <span class="node-count" id="nodeCount"></span>
  <div class="spacer"></div>
  <button class="toolbar-btn ${clustered?'active':''}" id="clusterToggle" title="Group functions by class / file (reduces visual complexity)">⬡ Group</button>
  <button class="toolbar-btn ${pathMode?'active':''}" id="pathToggle" title="Show only the path from root to selected node">⤴ Path</button>
  <button class="toolbar-btn" id="sidebarToggle" title="Toggle sidebar">☰</button>
  <button class="toolbar-btn" id="themeToggle" title="Toggle theme">${theme==='dark'?'☀️':'🌙'}</button>
  <div class="export-controls">
    <button id="exportDot">DOT</button>
    <button id="exportMermaid">Mermaid</button>
    <button id="exportSvg">SVG</button>
  </div>
</div>
<div class="banner" id="banner" hidden></div>
<div class="legend" id="legend">
  <span><i class="swatch swatch-confirmed"></i>clang-confirmed</span>
  <span><i class="swatch swatch-unconfirmed"></i>heuristic, clang disagrees</span>
  <span><i class="swatch swatch-unverified"></i>unchecked</span>
  <span><i class="swatch swatch-pointer"></i>fn pointer</span>
  <span><i class="swatch swatch-virtual"></i>virtual candidate</span>
  <span style="margin-left:10px;font-size:10px;color:var(--text-muted)">Ctrl+hover node = source preview · click edge = go to call site</span>
  <span class="spacer"></span>
  <button class="filter-bar-toggle" id="filterBarToggle" title="Toggle edge/node filters">⚙ Filters</button>
</div>
<div class="filter-bar" id="filterBar" ${filtersCollapsed ? 'hidden' : ''}>
  <span class="filter-group-label">Edges:</span>
  <button class="filter-btn" data-filter="direct"       title="Direct function calls">Direct</button>
  <button class="filter-btn" data-filter="pointer"      title="Calls via function pointer / callback / dispatch table">Fn Pointer</button>
  <button class="filter-btn" data-filter="virtual"      title="Virtual dispatch candidates">Virtual</button>
  <span class="filter-sep"></span>
  <span class="filter-group-label">Confidence:</span>
  <button class="filter-btn" data-filter="confirmed"    title="Edges confirmed by clang">✓ Confirmed</button>
  <button class="filter-btn" data-filter="unchecked"    title="Heuristic edges not yet checked by clang">~ Unchecked</button>
  <button class="filter-btn" data-filter="contradicted" title="Heuristic edges contradicted by clang — real false positives">✗ Disputed</button>
  <span class="filter-sep"></span>
  <span class="filter-group-label">Nodes:</span>
  <button class="filter-btn" data-filter="inactive"     title="Nodes inside inactive #ifdef / #if 0 blocks">Inactive</button>
  <button class="filter-btn" data-filter="lambda"       title="Lambda / anonymous function nodes">Lambdas</button>
  <span class="filter-sep"></span>
  <button class="filter-action-btn" id="filterAllOn"  >All on</button>
  <button class="filter-action-btn" id="filterAllOff" >All off</button>
  <span class="filter-count" id="filterCount"></span>
</div>
<div class="main" id="mainArea">
  <div id="cy"></div>
  <div class="resize-handle" id="resizeHandle"></div>
  <div class="sidebar" id="sidebar" style="width:${sidebarCollapsed?0:sidebarWidth}px">
    <div class="sidebar-inner" id="sidebarInner">
      <div class="empty-msg">Click a node to inspect it.</div>
    </div>
  </div>
</div>
<!-- floating source popup -->
<div class="source-popup hidden" id="sourcePopup">
  <div class="popup-header" id="popupHeader">
    <span class="popup-title" id="popupTitle">Source</span>
    <span class="popup-hint" id="popupHint">Ctrl+click to pin</span>
    <button class="popup-pin" id="popupPin" title="Pin">📌</button>
    <button class="popup-close" id="popupClose">✕</button>
  </div>
  <div class="popup-body" id="popupBody">
    <div class="source-inner" id="popupSourceInner"></div>
  </div>
</div>
`;

// element refs
const modeBadge     = document.getElementById('modeBadge')!;
const filterBar     = document.getElementById('filterBar')!;
const filterCount   = document.getElementById('filterCount')!;
const clusterToggleBtn = document.getElementById('clusterToggle') as HTMLButtonElement;
const pathToggleBtn    = document.getElementById('pathToggle') as HTMLButtonElement;

// Multi-edge click cycling (deduplicated edges may represent N call sites)
let selectedEdgePairKey: string | null = null;
let selectedEdgeSiteIdx: number = 0;
let selectedEdgeCallSites: Array<{ file: string; line: number; col: number }> = [];

// Cluster colour palette — assigned in encounter order, stable within a session
const CLUSTER_PALETTE = [
  '#2f6fed','#e05b2b','#2da44e','#8250df','#d14d4d',
  '#0ea5a0','#c08000','#1a7f37','#6640c9','#b06020',
];
const clusterColorMap = new Map<string, string>();
let clusterColorIdx = 0;
function getClusterColor(key: string): string {
  if (!clusterColorMap.has(key)) {
    clusterColorMap.set(key, CLUSTER_PALETTE[clusterColorIdx % CLUSTER_PALETTE.length]);
    clusterColorIdx++;
  }
  return clusterColorMap.get(key)!;
}
const enrichStatusEl= document.getElementById('enrichStatus')!;
const depthControl  = document.getElementById('depthControl')!;
const depthSlider   = document.getElementById('depthSlider') as HTMLInputElement;
const depthValueEl  = document.getElementById('depthValue')!;
const layoutSel     = document.getElementById('layoutSel') as HTMLSelectElement;
const nodeCountEl   = document.getElementById('nodeCount')!;
const bannerEl      = document.getElementById('banner')!;
const legendEl      = document.getElementById('legend')!;
const sidebar       = document.getElementById('sidebar')!;
const sidebarInner  = document.getElementById('sidebarInner')!;
const resizeHandle  = document.getElementById('resizeHandle')!;
const sourcePopup   = document.getElementById('sourcePopup')!;
const popupTitle    = document.getElementById('popupTitle')!;
const popupHint     = document.getElementById('popupHint')!;
const popupPin      = document.getElementById('popupPin')!;
const popupClose    = document.getElementById('popupClose')!;
const popupBody     = document.getElementById('popupBody')!;
const popupSrcInner = document.getElementById('popupSourceInner')!;
const popupHeader   = document.getElementById('popupHeader')!;

// apply initial theme
applyTheme(theme);
if (sidebarCollapsed) sidebar.classList.add('collapsed');

// ── Cytoscape ────────────────────────────────────────────────────────────
function buildCyStyle() {
  const v = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  return [
    { selector:'node', style:{ label:'data(label)', 'background-color':v('--cy-node-bg'), color:v('--cy-node-text'), 'font-size':11, 'text-valign':'center','text-halign':'center', shape:'round-rectangle', width:'label', height:'label', padding:'8px', 'border-width':1, 'border-color':v('--cy-node-border') } },
    { selector:'node[isRoot]', style:{ 'background-color':v('--cy-node-root-bg'), color:v('--cy-node-root-text'), 'border-color':v('--cy-node-root-bord'), 'border-width':2 } },
    { selector:'node[inactive]', style:{ 'border-style':'dashed','border-color':v('--cy-node-inact-bord'),'background-color':v('--cy-node-inact-bg'),color:v('--cy-node-inact-text') } },
    { selector:'node.selected', style:{ 'border-color':v('--cy-sel-bord'),'border-width':3 } },
    { selector:'node[virtualConfirmed]', style:{ 'border-color':v('--cy-virt-bord'),'border-width':2 } },
    { selector:'node[isIsr]', style:{ 'border-color':'#ff6b35','border-width':3,'border-style':'dashed' } },
    { selector:'node.classNode', style:{ shape:'round-rectangle','background-color':v('--cy-node-cls-bg'),'border-color':v('--cy-node-cls-bord'),'text-wrap':'wrap','text-max-width':160,'font-family':'monospace','font-size':10, color:v('--cy-node-text') } },
    { selector:'node.clusterNode', style:{ shape:'round-rectangle', 'font-size':13,'font-weight':'bold','text-wrap':'wrap','text-max-width':200,'text-valign':'center','text-halign':'center', padding:'18px', width:'label', height:'label' } },
    { selector:'node.umlClassNode', style:{
        shape:'round-rectangle',
        'background-color':v('--cy-node-bg'),
        color:v('--cy-node-text'),
        'font-family':'ui-monospace,"SF Mono",Consolas,monospace',
        'font-size':11,
        'text-wrap':'wrap',
        'text-max-width':220,
        'text-valign':'center',
        'text-halign':'center',      // center the label BLOCK on the node (not text-align)
        'text-justification':'left', // left-align lines WITHIN the label block
        padding:'12px',
        width:'label',
        height:'label',
        'border-width':1.5,
        'border-color':v('--cy-node-border'),
      },
    },
    { selector:'node.umlRoot', style:{
        'border-color':v('--cy-node-root-bord'),
        'border-width':3,
        'background-color':v('--cy-node-root-bg'),
        color:v('--cy-node-root-text'),
      },
    },
    { selector:'edge', style:{ width:1.5,'line-color':v('--cy-edge'),'target-arrow-color':v('--cy-edge'),'target-arrow-shape':'triangle','curve-style':'bezier','font-size':9, color:v('--cy-edge'), opacity:0.6 } },
    { selector:'edge[confirmed="true"]',  style:{ opacity:1,'line-color':v('--cy-edge-ok'),'target-arrow-color':v('--cy-edge-ok') } },
    { selector:'edge[confirmed="false"]', style:{ opacity:1,'line-style':'dashed','line-color':v('--cy-edge-bad'),'target-arrow-color':v('--cy-edge-bad') } },
    { selector:'edge[kind="pointer"]',    style:{ 'line-style':'dashed','line-color':v('--cy-edge-ptr'),'target-arrow-color':v('--cy-edge-ptr'),label:'data(label)',opacity:1 } },
    { selector:'edge[kind="virtualCandidate"]', style:{ 'line-style':'dotted','line-color':v('--cy-edge-virt'),'target-arrow-color':v('--cy-edge-virt'),opacity:1 } },
    { selector:'edge.hovered', style:{ width:3, opacity:1 } },
    { selector:'edge.highlighted', style:{ width:3, opacity:1,'line-color':v('--cy-hi-edge'),'target-arrow-color':v('--cy-hi-edge') } },
  ];
}

cy = cytoscape({ container: document.getElementById('cy'), style: buildCyStyle() });

// ── Cytoscape event handlers ──────────────────────────────────────────────
cy.on('tap', 'node', (evt: any) => {
  if (uiMode !== 'callgraph') return;
  const id = evt.target.id();
  const d = evt.target.data();
  if (d.isCluster === 'true') {
    showClusterSidebar(id, d.clusterLabel as string, d.memberIds ? JSON.parse(d.memberIds) : []);
  } else if (id === selectedNodeId) {
    cyclCallSite(+1);
  } else {
    selectNode(id, /*cycleToFirst*/ false);
  }
});

cy.on('tap', 'edge', (evt: any) => {
  const d = evt.target.data();
  // Cluster-mode cluster→cluster edges carry a callSites JSON blob
  if (d.callSitesJson) {
    const sites: Array<{ file: string; line: number; col: number }> = JSON.parse(d.callSitesJson);
    const pairKey = d.id as string;
    if (selectedEdgePairKey !== pairKey) {
      // First tap on this edge pair — go to site 0
      selectedEdgePairKey = pairKey;
      selectedEdgeSiteIdx = 0;
      selectedEdgeCallSites = sites;
    } else {
      // Subsequent taps — cycle
      selectedEdgeSiteIdx = (selectedEdgeSiteIdx + 1) % sites.length;
    }
    const site = sites[selectedEdgeSiteIdx];
    showBanner(`Call site ${selectedEdgeSiteIdx + 1} of ${sites.length} — ${site.file}:${site.line}`);
    send({ type:'openLocation', location:{ file: site.file, line: site.line, column: site.col } });
  } else if (d.callFile) {
    send({ type:'openLocation', location:{ file:d.callFile, line:d.callLine, column:d.callCol } });
  }
});

cy.on('mouseover', 'edge', (evt: any) => evt.target.addClass('hovered'));
cy.on('mouseout',  'edge', (evt: any) => evt.target.removeClass('hovered'));

let hoveredNodeId: string | null = null;
let hoveredMouseX = 0, hoveredMouseY = 0;

cy.on('mouseover', 'node', (evt: any) => {
  const id = evt.target.id();
  const oe = evt.originalEvent as MouseEvent;
  hoveredNodeId = fullGraph?.nodes[id] ? id : null;
  hoveredMouseX = oe.clientX;
  hoveredMouseY = oe.clientY;
  if (oe.ctrlKey && hoveredNodeId) triggerSourcePopup(hoveredNodeId, oe.clientX, oe.clientY);
});

cy.on('mousemove', 'node', (evt: any) => {
  const oe = evt.originalEvent as MouseEvent;
  hoveredMouseX = oe.clientX;
  hoveredMouseY = oe.clientY;
});

cy.on('mouseout', 'node', () => {
  hoveredNodeId = null;
  if (!popupPinned && !popupHovered) hidePopupDelayed();
});

// ── Keyboard tracking ─────────────────────────────────────────────────────
window.addEventListener('keydown', (e) => {
  if (e.key === 'Control' && hoveredNodeId) triggerSourcePopup(hoveredNodeId, hoveredMouseX, hoveredMouseY);
  if (e.key === 'Escape') { popupPinned = false; hidePopup(); }
});

// ── Toolbar wiring ────────────────────────────────────────────────────────
depthSlider.addEventListener('input', () => {
  currentDepth = parseInt(depthSlider.value, 10);
  depthValueEl.textContent = String(currentDepth);
  if (uiMode === 'classDiagram' && classUmlData) { renderUmlDiagram(); saveState(); return; }
  renderCallGraphSlice();
  saveState();
  if (depthFetchTimer) window.clearTimeout(depthFetchTimer);
  depthFetchTimer = window.setTimeout(() => {
    if (fullGraph && currentDepth > fullGraph.computedDepth)
      send({ type:'requestDepth', depth:currentDepth });
  }, 350);
});

layoutSel.addEventListener('change', () => {
  currentLayout = layoutSel.value as UiState['layout'];
  saveState();
  if (uiMode === 'classDiagram' && classUmlData) renderUmlDiagram();
  else if (uiMode === 'callgraph') renderCallGraphSlice();
  else renderClassHierarchy();
});

document.getElementById('themeToggle')!.addEventListener('click', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  (document.getElementById('themeToggle') as HTMLButtonElement).textContent = theme === 'dark' ? '☀️' : '🌙';
  applyTheme(theme);
  // UML edge styles use getComputedStyle so must re-render after theme change
  if (uiMode === 'classDiagram' && classUmlData) renderUmlDiagram();
  saveState();
});

document.getElementById('sidebarToggle')!.addEventListener('click', toggleSidebar);

document.getElementById('exportDot')!.addEventListener('click',     () => send({type:'exportGraph',format:'dot'}));
document.getElementById('exportMermaid')!.addEventListener('click', () => send({type:'exportGraph',format:'mermaid'}));
document.getElementById('exportSvg')!.addEventListener('click',     () => send({type:'exportGraph',format:'svg'}));

// ── Sidebar resize via drag handle ────────────────────────────────────────
resizeHandle.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startW = sidebar.offsetWidth;
  const onMove = (me: MouseEvent) => {
    const newW = Math.max(180, Math.min(600, startW - (me.clientX - startX)));
    sidebar.style.width = newW + 'px';
    sidebarWidth = newW;
    if (sidebarCollapsed) { sidebarCollapsed = false; sidebar.classList.remove('collapsed'); }
  };
  const onUp = () => {
    saveState();
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  if (sidebarCollapsed) {
    sidebar.classList.add('collapsed');
    sidebar.style.width = '0';
  } else {
    sidebar.classList.remove('collapsed');
    sidebar.style.width = sidebarWidth + 'px';
  }
  saveState();
}

// ── Source popup wiring ───────────────────────────────────────────────────
popupClose.addEventListener('click', () => { popupPinned = false; hidePopup(); });
popupPin.addEventListener('click', () => pinPopup());

sourcePopup.addEventListener('mouseenter', () => { popupHovered = true; });
sourcePopup.addEventListener('mouseleave', () => {
  popupHovered = false;
  if (!popupPinned) hidePopupDelayed();
});

// Ctrl+click on popup body → pin
sourcePopup.addEventListener('click', (e) => {
  if (e.ctrlKey) pinPopup();
});

// drag the popup by its header
popupHeader.addEventListener('mousedown', (e) => {
  if ((e.target as Element).closest('.popup-pin,.popup-close')) return;
  e.preventDefault();
  const rect = sourcePopup.getBoundingClientRect();
  popupDragOffX = e.clientX - rect.left;
  popupDragOffY = e.clientY - rect.top;
  const onMove = (me: MouseEvent) => {
    sourcePopup.style.left = Math.max(0, me.clientX - popupDragOffX) + 'px';
    sourcePopup.style.top  = Math.max(0, me.clientY - popupDragOffY) + 'px';
  };
  const onUp = () => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
});

function triggerSourcePopup(nodeId: string, mouseX: number, mouseY: number) {
  // Don't flash-refresh if the popup is already open for this exact node
  if (popupNodeId === nodeId && !sourcePopup.classList.contains('hidden')) return;
  popupNodeId = nodeId;
  const node = fullGraph?.nodes[nodeId];
  popupTitle.textContent = node?.qualifiedName ?? node?.name ?? nodeId;
  popupHint.textContent = popupPinned ? '' : 'Ctrl+click to pin';
  popupSrcInner.innerHTML = '<div style="padding:8px;color:var(--text-muted)">Loading…</div>';
  positionPopup(mouseX, mouseY);
  sourcePopup.classList.remove('hidden');
  send({ type:'requestSource', nodeId });
}

function positionPopup(x: number, y: number) {
  const pw = 440, ph = 280;
  let left = x + 18, top = y + 12;
  if (left + pw > window.innerWidth - 8)  left = Math.max(8, x - pw - 8);
  if (top  + ph > window.innerHeight - 8) top  = Math.max(8, window.innerHeight - ph - 8);
  sourcePopup.style.left = left + 'px';
  sourcePopup.style.top  = top  + 'px';
}

function pinPopup() {
  popupPinned = true;
  popupPin.classList.add('pinned');
  popupHint.textContent = 'Pinned — Esc or ✕ to close';
}

let hideTimer: number | undefined;
function hidePopupDelayed() {
  hideTimer = window.setTimeout(() => {
    if (!popupPinned && !popupHovered) hidePopup();
  }, 200);
}
function hidePopup() {
  if (hideTimer) window.clearTimeout(hideTimer);
  sourcePopup.classList.add('hidden');
  popupPinned = false;
  popupHovered = false;
  popupPin.classList.remove('pinned');
  popupNodeId = null;
}

// ── Extension message handling ────────────────────────────────────────────
window.addEventListener('message', (event: MessageEvent<ExtensionToWebviewMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'graph': {
      uiMode = 'callgraph';
      fullGraph = msg.data;

      // Seed depth from settings the first time (or if no saved depth yet)
      if (!depthSeeded || currentDepth === 0) {
        currentDepth = msg.data.defaultDepth;
        depthSeeded = true;
        saveState();
      }
      depthSlider.value = String(currentDepth);
      depthValueEl.textContent = String(currentDepth);

      modeBadge.textContent = msg.data.semanticEnrichmentApplied ? 'heuristic + clang-verified' : `${msg.data.mode} mode`;
      depthControl.hidden = false;
      legendEl.hidden = false;
      showBanner(msg.data.truncated ? 'Graph truncated — narrow depth or raise callgraph.maxVisibleNodes.' : null);
      renderCallGraphSlice(); // syncFilterButtons called inside
      if (selectedNodeId && fullGraph.nodes[selectedNodeId]) renderSidebar(fullGraph.nodes[selectedNodeId]);
      return;
    }

    case 'classHierarchy':
      uiMode = 'classDiagram';
      classHierarchy = msg.data;
      modeBadge.textContent = msg.data.mode === 'semantic' ? 'heuristic + clang-verified — class hierarchy' : `${msg.data.mode} mode — class hierarchy`;
      depthControl.hidden = true;
      legendEl.hidden = true;
      renderClassHierarchy();
      return;

    case 'classUml':
      uiMode = 'classDiagram';
      classUmlData = msg.data;
      classHierarchy = null;
      classNsFilters  = new Set(); // reset ns filter so it repopulates from new data
      classFileFilters = new Set(); // reset file filter
      const dtLabel = msg.data.diagramType === 'uml' ? 'UML' : msg.data.diagramType === 'usage' ? 'Usage' : 'Hierarchy';
      modeBadge.textContent = `${msg.data.mode} mode — Class ${dtLabel}`;
      depthControl.hidden = false;  // enable depth slider for class diagrams
      legendEl.hidden = true;
      renderUmlDiagram();
      return;

    case 'sourceSnippet': {
      if (msg.nodeId !== popupNodeId) return;
      // msg.startLine is the 1-based line number where the snippet starts
      renderPopupSource(msg.source, msg.startLine);
      return;
    }

    case 'enrichmentStatus':
      enrichStatusEl.hidden = msg.status !== 'checking';
      return;

    case 'uiConfig':
      applyPopupConfig(msg.popup);
      return;

    case 'error':
      showBanner(msg.message);
      return;
  }
});

send({ type:'ready' });

// ── Theme ────────────────────────────────────────────────────────────────

function applyPopupConfig(popup: { fontSize: number; width: number; height: number }) {
  sourcePopup.style.setProperty('--popup-font-size', popup.fontSize + 'px');
  sourcePopup.style.width  = popup.width  + 'px';
  sourcePopup.style.height = popup.height + 'px';
  (popupBody as HTMLElement).style.fontSize = popup.fontSize + 'px';
}

function applyTheme(t: 'dark'|'light') {
  document.documentElement.setAttribute('data-theme', t);
  if (cy) cy.style(buildCyStyle()).update();
}

// ── Render helpers ────────────────────────────────────────────────────────
function showBanner(text: string | null) {
  bannerEl.hidden = !text;
  if (text) bannerEl.textContent = text;
}

// ── Filter bar ────────────────────────────────────────────────────────────

function syncFilterButtons() {
  document.querySelectorAll<HTMLButtonElement>('.filter-btn').forEach(btn => {
    const f = btn.dataset.filter as FilterId;
    btn.classList.toggle('active', activeFilters.has(f));
  });
  // Show count of hidden edges/nodes
  if (fullGraph) {
    const totalEdges = fullGraph.edges.length;
    const shownEdges = fullGraph.edges.filter(edgePassesFilter).length;
    const totalNodes = Object.keys(fullGraph.nodes).length;
    const shownNodes = Object.values(fullGraph.nodes).filter(nodePassesFilter).length;
    const hiddenEdges = totalEdges - shownEdges;
    const hiddenNodes = totalNodes - shownNodes;
    const parts: string[] = [];
    if (hiddenEdges > 0) parts.push(`${hiddenEdges} edge${hiddenEdges!==1?'s':''} hidden`);
    if (hiddenNodes > 0) parts.push(`${hiddenNodes} node${hiddenNodes!==1?'s':''} hidden`);
    filterCount.textContent = parts.length ? `(${parts.join(', ')})` : '';
  } else {
    filterCount.textContent = '';
  }
}

function edgePassesFilter(e: { kind: string; confirmed?: boolean }): boolean {
  if (e.kind === 'direct'          && !activeFilters.has('direct'))       return false;
  if (e.kind === 'pointer'         && !activeFilters.has('pointer'))      return false;
  if (e.kind === 'virtualCandidate'&& !activeFilters.has('virtual'))      return false;
  if (e.confirmed === true         && !activeFilters.has('confirmed'))    return false;
  if (e.confirmed === false        && !activeFilters.has('contradicted')) return false;
  if (e.confirmed === undefined    && !activeFilters.has('unchecked'))    return false;
  return true;
}

function nodePassesFilter(n: FunctionNode): boolean {
  if (!n.active                    && !activeFilters.has('inactive')) return false;
  if (n.name === '<lambda>'        && !activeFilters.has('lambda'))   return false;
  return true;
}

// Toggle filter on/off
document.querySelectorAll<HTMLButtonElement>('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const f = btn.dataset.filter as FilterId;
    if (activeFilters.has(f)) activeFilters.delete(f);
    else activeFilters.add(f);
    saveState();
    syncFilterButtons();
    renderCallGraphSlice();
  });
});

document.getElementById('filterAllOn')!.addEventListener('click', () => {
  for (const f of ALL_FILTERS) activeFilters.add(f);
  saveState(); syncFilterButtons(); renderCallGraphSlice();
});

document.getElementById('filterAllOff')!.addEventListener('click', () => {
  activeFilters.clear();
  saveState(); syncFilterButtons(); renderCallGraphSlice();
});

document.getElementById('filterBarToggle')!.addEventListener('click', () => {
  filtersCollapsed = !filtersCollapsed;
  filterBar.hidden = filtersCollapsed;
  saveState();
});

clusterToggleBtn.addEventListener('click', () => {
  clustered = !clustered;
  clusterToggleBtn.classList.toggle('active', clustered);
  clusterColorMap.clear();
  clusterColorIdx = 0;
  saveState();
  if (uiMode === 'classDiagram' && classUmlData) renderUmlDiagram();
  else renderCallGraphSlice();
});

pathToggleBtn.addEventListener('click', () => {
  pathMode = !pathMode;
  pathToggleBtn.classList.toggle('active', pathMode);
  saveState();
  renderCallGraphSlice();
});

// Initial button state
syncFilterButtons();

// ── Cluster helpers ───────────────────────────────────────────────────────

function clusterKeyOf(fn: FunctionNode): string {
  if (fn.className) return `class:${fn.className}`;
  const filename = (fn.location.file.split('/').pop() ?? fn.location.file).replace(/\.(c|cpp|cc|cxx|h|hh|hpp|hxx)$/i, '');
  return `file:${filename}`;
}

function clusterDisplay(key: string): string {
  if (key.startsWith('class:')) return `◈ ${key.slice(6)}`;
  return `▪ ${key.slice(5)}`;
}

// ── Edge deduplication ────────────────────────────────────────────────────

interface DedupEdge {
  pairKey: string;  // `${callerId}→${calleeId}`
  callerId: string;
  calleeId: string;
  kind: string;
  confirmed: 'true' | 'false' | undefined;
  via: string | undefined;
  callSites: Array<{ file: string; line: number; col: number }>;
}

const KIND_RANK: Record<string, number> = { pointer:3, virtual:2, virtualCandidate:2, direct:1 };

function deduplicateEdges(rawEdges: Array<{ callerId: string; calleeId: string; kind: string; confirmed?: boolean; via?: string; callSite: { file: string; line: number; column: number } }>): DedupEdge[] {
  const map = new Map<string, DedupEdge>();
  for (const e of rawEdges) {
    const pairKey = `${e.callerId}→${e.calleeId}`;
    const existing = map.get(pairKey);
    const site = { file: e.callSite.file, line: e.callSite.line, col: e.callSite.column };
    if (!existing) {
      map.set(pairKey, {
        pairKey, callerId: e.callerId, calleeId: e.calleeId,
        kind: e.kind,
        confirmed: e.confirmed === true ? 'true' : e.confirmed === false ? 'false' : undefined,
        via: e.via,
        callSites: [site],
      });
    } else {
      existing.callSites.push(site);
      // Promote to higher-rank kind if applicable
      if ((KIND_RANK[e.kind] ?? 0) > (KIND_RANK[existing.kind] ?? 0)) existing.kind = e.kind;
      // If any site is confirmed, promote
      if (e.confirmed === true) existing.confirmed = 'true';
    }
  }
  return [...map.values()];
}

// ── Layout ────────────────────────────────────────────────────────────────

function layoutOptions(nodeCount = 0, rootId?: string) {
  const dagre = (dir: string) => ({
    name: 'dagre', rankDir: dir,
    nodeSep: 50, rankSep: 90, ranker: 'network-simplex', animate: false,
  });
  const bf = (r?: string) => ({
    name: 'breadthfirst', directed: false,
    roots: r ? `[id="${CSS.escape(r)}"]` : undefined,
    spacingFactor: 1.6, animate: false, padding: 20,
  });
  switch (currentLayout) {
    case 'radial':       return { name: 'concentric', concentric: (n: any) => n.degree(), levelWidth: () => 2, animate: false };
    case 'cose':         return { name: 'cose', animate: false, randomize: false, nodeDimensionsIncludeLabels: true, padding: 20 };
    case 'circle':       return { name: 'circle', animate: false, padding: 30 };
    case 'breadthfirst': return bf(rootId);
    case 'dagre-bt':     return dagre('BT');
    case 'dagre-tb':     return dagre('TB');
    default: // dagre-lr
      if (nodeCount > 200) return bf(rootId);
      return dagre('LR');
  }
}

// ── Freeze limits ─────────────────────────────────────────────────────────

const WARN_NODES  = 300;
const HARD_NODES  = 800;
const BLOCK_NODES = 1600;

// ── Path finder ───────────────────────────────────────────────────────────

function findPathFromRoot(graph: CallGraphData, targetId: string): { nodeIds: Set<string>; pairKeys: Set<string> } | null {
  if (targetId === graph.rootId) return { nodeIds: new Set([graph.rootId]), pairKeys: new Set() };

  // Build adjacency list (both directions — callers AND callees)
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    (adj.get(e.callerId) ?? adj.set(e.callerId, []).get(e.callerId)!).push(e.calleeId);
    (adj.get(e.calleeId) ?? adj.set(e.calleeId, []).get(e.calleeId)!).push(e.callerId);
  }

  // BFS
  const parent = new Map<string, string | null>([[graph.rootId, null]]);
  const queue = [graph.rootId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === targetId) {
      const nodeIds = new Set<string>();
      const pairKeys = new Set<string>();
      let n: string | undefined = cur;
      while (n !== undefined) {
        nodeIds.add(n);
        const p = parent.get(n);
        if (p != null) { pairKeys.add(`${p}→${n}`); pairKeys.add(`${n}→${p}`); n = p; }
        else break;
      }
      return { nodeIds, pairKeys };
    }
    for (const neighbor of adj.get(cur) ?? []) {
      if (!parent.has(neighbor)) {
        parent.set(neighbor, cur);
        queue.push(neighbor);
      }
    }
  }
  return null;
}

// ── Main render ───────────────────────────────────────────────────────────

function renderCallGraphSlice() {
  if (!fullGraph) return;
  if (clustered) { renderClusteredSlice(); return; }

  // ── depth + node filter ────────────────────────────────
  const depthIds = Object.keys(fullGraph.nodes).filter(
    id => (fullGraph!.nodeDepths[id] ?? Infinity) <= currentDepth);
  const visIds = depthIds.filter(id => nodePassesFilter(fullGraph!.nodes[id]));
  const visSet = new Set(visIds);

  // ── edge deduplication + filter ────────────────────────
  const filtered = fullGraph.edges.filter(e =>
    visSet.has(e.callerId) && visSet.has(e.calleeId) && edgePassesFilter(e));
  const deduped = deduplicateEdges(filtered);

  // ── path filter (optional) ─────────────────────────────
  let pathNodeIds: Set<string> | null = null;
  let pathPairKeys: Set<string> | null = null;
  if (pathMode && selectedNodeId && selectedNodeId !== fullGraph.rootId) {
    const path = findPathFromRoot(fullGraph, selectedNodeId);
    if (path) {
      pathNodeIds = path.nodeIds;
      pathPairKeys = path.pairKeys;
      showBanner(`⤴ Path mode: showing shortest path to ${fullGraph.nodes[selectedNodeId]?.name ?? selectedNodeId}`);
    } else {
      showBanner(`⤴ Path mode: no path found from root to selected node`);
    }
  } else if (pathMode) {
    showBanner('⤴ Path mode ON — click a node to show the shortest path to it');
  }

  // ── orphan removal ─────────────────────────────────────
  const connectedIds = new Set<string>([fullGraph.rootId]);
  for (const e of deduped) { connectedIds.add(e.callerId); connectedIds.add(e.calleeId); }

  // ── freeze guard ───────────────────────────────────────
  const nodeCount = visIds.filter(id => connectedIds.has(id)).length;
  const edgeCount = deduped.length;

  if (nodeCount > BLOCK_NODES) {
    showBanner(`⛔ ${nodeCount} nodes is above the ${BLOCK_NODES} render limit. ` +
      `Enable ⬡ Group mode, reduce depth, or add filters.`);
    nodeCountEl.textContent = `${nodeCount} nodes — not rendered`;
    syncFilterButtons();
    return;
  }
  if (!pathMode) {
    if (nodeCount > WARN_NODES) {
      showBanner(`⚠ Large graph (${nodeCount} nodes) — using hierarchical layout. ` +
        `Enable ⬡ Group mode for a cleaner view.`);
    } else {
      showBanner(fullGraph.truncated ? 'Graph truncated — narrow depth or raise callgraph.maxVisibleNodes.' : null);
    }
  }

  // ── build elements ─────────────────────────────────────
  const nodeEls: any[] = [];
  for (const id of visIds) {
    if (!connectedIds.has(id)) continue;
    if (pathNodeIds && !pathNodeIds.has(id)) continue; // path filter
    const n = fullGraph!.nodes[id];
    const clusterKey = clusterKeyOf(n);
    const borderCol = getClusterColor(clusterKey);
    const nodeLabel = (n.isIsr ? '⚡ ' : '') + (n.qualifiedName ?? n.name);
    nodeEls.push({ data:{
        id, label: nodeLabel,
        isRoot: id === fullGraph!.rootId ? 'true' : undefined,
        inactive: !n.active ? 'true' : undefined,
        virtualConfirmed: n.virtualConfirmed ? 'true' : undefined,
        isIsr: n.isIsr ? 'true' : undefined,
      },
      style: { 'border-color': borderCol, 'border-width': 2.5 },
    });
  }

  const edgeEls: any[] = [];
  for (const de of deduped) {
    // Path filter: only keep edges on the path
    if (pathPairKeys && !pathPairKeys.has(de.pairKey)) continue;
    // Also drop edges whose endpoints were removed by path filter
    if (pathNodeIds && (!pathNodeIds.has(de.callerId) || !pathNodeIds.has(de.calleeId))) continue;
    const count = de.callSites.length;
    const label = count > 1 ? `×${count}` : (de.via ? `via ${de.via}` : '');
    edgeEls.push({ data:{
      id: de.pairKey,
      source: de.callerId, target: de.calleeId,
      kind: de.kind,
      confirmed: de.confirmed,
      label,
      callSitesJson: JSON.stringify(de.callSites),
      callFile: de.callSites[0]?.file, callLine: de.callSites[0]?.line, callCol: de.callSites[0]?.col,
    }});
  }

  // ── render synchronously using cy.batch() to prevent partial-render flicker ──
  cy.batch(() => {
    cy.elements().remove();
    cy.add([...nodeEls, ...edgeEls]);
  });
  cy.layout(layoutOptions(nodeEls.length, fullGraph.rootId)).run();
  if (selectedNodeId) cy.getElementById(selectedNodeId).addClass('selected');
  highlightCallSiteEdge();

  const total = Object.keys(fullGraph.nodes).length;
  const shownCount = pathNodeIds ? pathNodeIds.size : nodeEls.length;
  const parts: string[] = [`${shownCount}/${total} nodes`];
  if (total - depthIds.length > 0) parts.push(`${total - depthIds.length} beyond depth`);
  if (depthIds.length - nodeCount > 0) parts.push(`${depthIds.length - nodeCount} filtered`);
  nodeCountEl.textContent = parts.join(' · ');
  syncFilterButtons();
}

// ── Cluster mode renderer ─────────────────────────────────────────────────

function renderClusteredSlice() {
  if (!fullGraph) return;

  const depthIds = Object.keys(fullGraph.nodes).filter(
    id => (fullGraph!.nodeDepths[id] ?? Infinity) <= currentDepth);
  const visIds = depthIds.filter(id => nodePassesFilter(fullGraph!.nodes[id]));
  const visSet = new Set(visIds);

  const nodeCluster = new Map<string, string>();
  const clusterMembers = new Map<string, string[]>();
  for (const id of visIds) {
    const fn = fullGraph!.nodes[id];
    const key = clusterKeyOf(fn);
    nodeCluster.set(id, key);
    const arr = clusterMembers.get(key) ?? [];
    arr.push(id);
    clusterMembers.set(key, arr);
  }

  const filteredEdges = fullGraph.edges.filter(e =>
    visSet.has(e.callerId) && visSet.has(e.calleeId) && edgePassesFilter(e));

  const clusterEdgeMap = new Map<string, { sites: Array<{file:string;line:number;col:number}>; selfLoop: boolean }>();
  for (const e of filteredEdges) {
    const ck = nodeCluster.get(e.callerId);
    const tk = nodeCluster.get(e.calleeId);
    if (!ck || !tk) continue;
    const pairKey = `${ck}~~~${tk}`;
    const existing = clusterEdgeMap.get(pairKey) ?? { sites: [], selfLoop: ck === tk };
    existing.sites.push({ file: e.callSite.file, line: e.callSite.line, col: e.callSite.column });
    clusterEdgeMap.set(pairKey, existing);
  }

  const nodeEls: any[] = [];
  const rootCluster = nodeCluster.get(fullGraph.rootId) ?? '';

  for (const [key, members] of clusterMembers) {
    const color = getClusterColor(key);
    const isRoot = key === rootCluster;
    const label = `${clusterDisplay(key)}\n${members.length} fn${members.length !== 1 ? 's' : ''}`;
    nodeEls.push({
      data: { id: `cluster:${key}`, label,
        isCluster: 'true', clusterLabel: label,
        isRoot: isRoot ? 'true' : undefined,
        memberIds: JSON.stringify(members),
      },
      classes: 'clusterNode',
      style: { 'border-color': color, 'border-width': isRoot ? 4 : 2.5,
               'background-color': color + '22' },
    });
  }

  const edgeEls: any[] = [];
  for (const [pairKey, { sites, selfLoop }] of clusterEdgeMap) {
    if (selfLoop) continue;
    const sepIdx = pairKey.indexOf('~~~');
    const ck = pairKey.slice(0, sepIdx);
    const tk = pairKey.slice(sepIdx + 3);
    const count = sites.length;
    edgeEls.push({ data:{
      id: `cedge:${pairKey}`,
      source: `cluster:${ck}`, target: `cluster:${tk}`,
      kind: 'direct',
      label: `${count} call${count !== 1 ? 's' : ''}`,
      callSitesJson: JSON.stringify(sites),
    }});
  }

  if (nodeEls.length > BLOCK_NODES) {
    showBanner(`⛔ Too many clusters (${nodeEls.length}) — reduce depth.`);
    return;
  }
  showBanner(nodeEls.length > WARN_NODES ? `⚠ ${nodeEls.length} clusters — consider reducing depth.` : null);

  // Synchronous batch render — no requestAnimationFrame
  cy.batch(() => {
    cy.elements().remove();
    cy.add([...nodeEls, ...edgeEls]);
  });
  cy.layout(layoutOptions(nodeEls.length, `cluster:${rootCluster}`)).run();

  nodeCountEl.textContent = `${nodeEls.length} groups · ${edgeEls.length} connections`;
  syncFilterButtons();
}

// ── Cluster sidebar ───────────────────────────────────────────────────────

function showClusterSidebar(clusterId: string, label: string, memberIds: string[]) {
  selectedNodeId = null;
  cy.nodes().removeClass('selected');
  cy.getElementById(clusterId).addClass('selected');

  const fns = memberIds
    .map(id => fullGraph?.nodes[id])
    .filter((fn): fn is FunctionNode => !!fn)
    .sort((a, b) => (a.qualifiedName ?? a.name).localeCompare(b.qualifiedName ?? b.name));

  sidebarInner.innerHTML = `
    <div class="sidebar-section">
      <div class="fn-name" style="font-size:14px">${esc(label)}</div>
      <div class="fn-flags">${fns.length} function${fns.length !== 1 ? 's' : ''} — click to open in editor</div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-title">Functions</div>
      ${fns.map(fn => `
        <div class="call-site-entry" data-fn-id="${esc(fn.id)}">
          <span class="cs-caller">${fn.isIsr ? '⚡ ' : ''}${esc(fn.qualifiedName ?? fn.name)}</span>
          <span class="cs-loc">${fn.location.line}</span>
        </div>`).join('')}
    </div>`;

  sidebarInner.querySelectorAll('[data-fn-id]').forEach(el => {
    el.addEventListener('click', () => {
      const fn = fullGraph?.nodes[(el as HTMLElement).dataset.fnId!];
      if (fn) send({ type:'openLocation', location: fn.location });
    });
    el.addEventListener('dblclick', () => {
      const fn = fullGraph?.nodes[(el as HTMLElement).dataset.fnId!];
      if (fn) {
        clustered = false;
        clusterToggleBtn.classList.remove('active');
        saveState();
        renderCallGraphSlice();
        setTimeout(() => {
          if (fullGraph?.nodes[fn.id]) selectNode(fn.id, false);
        }, 200);
      }
    });
  });

  if (sidebarCollapsed) toggleSidebar(); // auto-open sidebar if collapsed
}

function renderClassHierarchy() {
  if (!classHierarchy) return;
  const els: any[] = [];
  const byName = new Map<string,string>();
  for (const c of Object.values(classHierarchy.classes)) byName.set(c.name, c.id);
  for (const c of Object.values(classHierarchy.classes)) {
    const methodLines = c.methods.slice(0,8).map((m:FunctionNode)=>`+ ${m.name}()`).join('\n');
    const more = c.methods.length>8?`\n… +${c.methods.length-8} more`:'';
    els.push({ data:{ id:c.id, label:`${c.name}\n${methodLines}${more}`, inactive:!c.active?'true':undefined }, classes:'classNode' });
  }
  for (const c of Object.values(classHierarchy.classes))
    for (const base of c.bases) {
      const bid = byName.get(base); if(!bid) continue;
      els.push({ data:{ id:`${c.id}→${bid}`, source:c.id, target:bid, kind:'direct', label:'extends' } });
    }
  cy.batch(() => { cy.elements().remove(); cy.add(els); });
  cy.layout(currentLayout === 'radial'
    ? { name:'concentric', concentric:(n:any)=>n.degree(), levelWidth:()=>2, animate:false }
    : layoutOptions(els.length)
  ).run();
  nodeCountEl.textContent = `${Object.keys(classHierarchy.classes).length} classes`;
}

// ── UML Class Diagram renderer ────────────────────────────────────────────

/** Build a compact 3-section UML node label (name ∕ members ∕ methods). */
// ── UML edge style (applied inline so each edge can have different arrowheads) ─

function umlEdgeStyle(kind: string) {
  const v = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  switch (kind) {
    case 'inheritance':
      return { 'curve-style':'bezier','line-style':'solid','target-arrow-shape':'triangle','target-arrow-fill':'hollow',
               'target-arrow-color':v('--cy-edge'),'line-color':v('--cy-edge'),width:2 };
    case 'composition':
      return { 'curve-style':'bezier','line-style':'solid','source-arrow-shape':'diamond','source-arrow-fill':'filled',
               'source-arrow-color':v('--cy-edge-ok'),'target-arrow-shape':'none','line-color':v('--cy-edge-ok'),width:2 };
    case 'aggregation':
      return { 'curve-style':'bezier','line-style':'solid','source-arrow-shape':'diamond','source-arrow-fill':'hollow',
               'source-arrow-color':v('--cy-edge-ptr'),'target-arrow-shape':'none','line-color':v('--cy-edge-ptr'),width:1.5 };
    case 'dependency':
      return { 'curve-style':'bezier','line-style':'dashed','target-arrow-shape':'triangle','target-arrow-fill':'hollow',
               'target-arrow-color':v('--cy-edge'),'line-color':v('--cy-edge'),width:1.5 };
    default:
      return { 'curve-style':'bezier','line-style':'solid','target-arrow-shape':'triangle','line-color':v('--cy-edge'),width:1.5 };
  }
}

// ── UML 3-section label builder ──────────────────────────────────────────────

let umlShowMembers = true;
let umlShowMethods = true;
let umlRelFilters = new Set(['inheritance','composition','aggregation','dependency']);

/** Build a compact left-justified multi-line label for a UML class node. */
function buildUmlLabel(cls: ClassGraphData['classes'][string]): string {
  const parts: string[] = [];
  if (cls.isStruct) parts.push('«struct»');
  parts.push(cls.name);   // just the simple name — namespace shown via border colour

  if (umlShowMembers && cls.members.length > 0) {
    parts.push('─────────────');
    for (const m of cls.members.slice(0, 7)) {
      const a = m.access === 'public' ? '+' : m.access === 'protected' ? '#' : '−';
      const ptr = m.isPointer ? '*' : m.isReference ? '&' : '';
      parts.push(`${a} ${m.name}: ${(m.type+ptr).replace(/\s+/g,' ').slice(0, 24)}`);
    }
    if (cls.members.length > 7) parts.push(`  … +${cls.members.length - 7} more`);
  }

  if (umlShowMethods && cls.methods.length > 0) {
    parts.push('─────────────');
    const ctors   = cls.methods.filter(m => m.name === cls.name || m.name === `~${cls.name}`);
    const virts   = cls.methods.filter(m => m.isVirtual && m.name !== cls.name && m.name !== `~${cls.name}`);
    const regular = cls.methods.filter(m => !m.isVirtual && m.name !== cls.name && m.name !== `~${cls.name}`);
    for (const m of [...ctors, ...virts, ...regular].slice(0, 9)) {
      const a = m.isVirtual ? '∿' : '+';
      parts.push(`${a} ${m.name}()`);
    }
    if (cls.methods.length > 9) parts.push(`  … +${cls.methods.length - 9} more`);
  }

  return parts.join('\n');
}

// ── Main UML renderer ────────────────────────────────────────────────────────

function renderUmlDiagram() {
  if (!classUmlData) return;

  const depths = classUmlData.classNodeDepths ?? null;
  const rootId = classUmlData.rootClassId;

  // Show depth slider — class diagrams use it too
  depthControl.hidden = false;

  // Build namespace filter state the first time we see this dataset
  const allNs = new Set<string>();
  for (const cls of Object.values(classUmlData.classes)) {
    if (cls.namespace) allNs.add(cls.namespace);
  }
  if (classNsFilters.size === 0) classNsFilters = new Set(allNs); // default all on

  // ── namespace colour map ─────────────────────────────────────────────────
  let nsColorIdx2 = 0;
  const nsColorMap2 = new Map<string, string>();
  for (const ns of allNs) {
    nsColorMap2.set(ns, CLUSTER_PALETTE[nsColorIdx2++ % CLUSTER_PALETTE.length]);
  }

  // ── filter classes ───────────────────────────────────────────────────────
  const visibleClasses = Object.values(classUmlData.classes).filter(cls => {
    // file filter (empty = show all)
    if (classFileFilters.size > 0 && !classFileFilters.has(cls.location.file)) return false;
    // namespace filter
    if (cls.namespace && classNsFilters.size > 0 && !classNsFilters.has(cls.namespace)) return false;
    // depth filter (only when a root is set)
    if (depths && rootId) {
      const d = depths[cls.id];
      if (d === undefined || d > currentDepth) return false;
    }
    return true;
  });
  const visibleIds = new Set(visibleClasses.map(c => c.id));

  // ── cluster (Group) mode ─────────────────────────────────────────────────
  if (clustered) {
    renderUmlClustered(visibleClasses, visibleIds, nsColorMap2);
    return;
  }

  // ── normal UML render ────────────────────────────────────────────────────
  const nodeEls: any[] = [];
  for (const cls of visibleClasses) {
    const label = buildUmlLabel(cls);
    const borderColor = nsColorMap2.get(cls.namespace ?? '') ?? undefined;
    const isRoot = cls.id === rootId;
    nodeEls.push({
      data: { id: cls.id, label, inactive: !cls.active ? 'true' : undefined },
      classes: 'umlClassNode' + (isRoot ? ' umlRoot' : ''),
      ...(borderColor ? { style: { 'border-color': borderColor, 'border-width': 2.5 } } : {}),
    });
  }

  const edgeEls: any[] = [];
  for (const edge of classUmlData.edges) {
    if (!visibleIds.has(edge.fromId) || !visibleIds.has(edge.toId)) continue;
    if (!umlRelFilters.has(edge.kind)) continue;
    const kindLabel = edge.kind === 'composition' ? `◆${edge.memberName ? ' '+edge.memberName : ''}` :
                      edge.kind === 'aggregation'  ? `◇${edge.memberName ? ' '+edge.memberName : ''}` : '';
    edgeEls.push({
      data: { id: `${edge.fromId}→${edge.toId}:${edge.kind}`, source: edge.fromId, target: edge.toId, kind: edge.kind, label: kindLabel },
      style: umlEdgeStyle(edge.kind),
    });
  }

  if (nodeEls.length > BLOCK_NODES) {
    showBanner(`⛔ ${nodeEls.length} classes — too many. Reduce depth, add namespace filters, or enable ⬡ Group.`);
    nodeCountEl.textContent = `${nodeEls.length} classes — not rendered`;
    return;
  }
  showBanner(nodeEls.length > WARN_NODES ? `⚠ ${nodeEls.length} classes — consider reducing depth or enabling ⬡ Group.` : null);

  cy.batch(() => { cy.elements().remove(); cy.add([...nodeEls, ...edgeEls]); });
  // Use dagre-bt for hierarchy so parent classes sit above children
  const layoutOverride = classUmlData.diagramType === 'hierarchy' && currentLayout === 'dagre-lr'
    ? { ...layoutOptions(nodeEls.length, rootId), rankDir: 'BT' }
    : layoutOptions(nodeEls.length, rootId);
  (cy.layout(layoutOverride) as any).run();

  // Stats
  const relCounts = new Map<string, number>();
  for (const e of edgeEls) relCounts.set(e.data.kind, (relCounts.get(e.data.kind) ?? 0) + 1);
  const relSummary = [...relCounts.entries()].map(([k, n]) => `${n} ${k}`).join(' · ');
  nodeCountEl.textContent = `${nodeEls.length} classes · ${relSummary}`;

  buildUmlSidebar(nsColorMap2, allNs);
}

// ── UML cluster (Group) render ───────────────────────────────────────────────

function renderUmlClustered(
  visibleClasses: ClassGraphData['classes'][string][],
  visibleIds: Set<string>,
  nsColorMap: Map<string, string>,
) {
  const clusterMembers = new Map<string, string[]>(); // clusterKey → [classIds]
  const classToCluster = new Map<string, string>();

  for (const cls of visibleClasses) {
    const key = cls.namespace ? `ns:${cls.namespace}` : `file:${cls.location.file.split('/').pop()?.replace(/\.[^.]+$/, '') ?? 'global'}`;
    classToCluster.set(cls.id, key);
    const arr = clusterMembers.get(key) ?? [];
    arr.push(cls.id);
    clusterMembers.set(key, arr);
  }

  const rootClusterKey = classUmlData?.rootClassId ? classToCluster.get(classUmlData.rootClassId) : undefined;

  const nodeEls: any[] = [];
  for (const [key, members] of clusterMembers) {
    const isNs = key.startsWith('ns:');
    const displayName = isNs ? `◈ ${key.slice(3)}` : `▪ ${key.slice(5)}`;
    const col = isNs ? (nsColorMap.get(key.slice(3)) ?? '#6b7080') : '#6b7080';
    nodeEls.push({
      data: { id: `cluster:${key}`, label: `${displayName}\n${members.length} class${members.length !== 1 ? 'es' : ''}`,
              isCluster: 'true', clusterLabel: displayName, memberIds: JSON.stringify(members),
              isRoot: key === rootClusterKey ? 'true' : undefined },
      classes: 'clusterNode',
      style: { 'border-color': col, 'border-width': key === rootClusterKey ? 4 : 2.5, 'background-color': col + '22' },
    });
  }

  const clusterEdgeMap = new Map<string, number>();
  for (const edge of (classUmlData?.edges ?? [])) {
    const fc = classToCluster.get(edge.fromId);
    const tc = classToCluster.get(edge.toId);
    if (!fc || !tc || fc === tc) continue;
    const pk = `${fc}|||${tc}`;
    clusterEdgeMap.set(pk, (clusterEdgeMap.get(pk) ?? 0) + 1);
  }

  const edgeEls: any[] = [];
  for (const [pk, count] of clusterEdgeMap) {
    const [fc, tc] = pk.split('|||');
    edgeEls.push({ data: { id: `ce:${pk}`, source: `cluster:${fc}`, target: `cluster:${tc}`,
      kind: 'direct', label: `${count}`, callSitesJson: '[]' } });
  }

  cy.batch(() => { cy.elements().remove(); cy.add([...nodeEls, ...edgeEls]); });
  cy.layout(layoutOptions(nodeEls.length, rootClusterKey ? `cluster:${rootClusterKey}` : undefined)).run();
  nodeCountEl.textContent = `${nodeEls.length} groups · ${edgeEls.length} connections`;
  buildUmlSidebar(nsColorMap, new Set([...nsColorMap.keys()]));
}

// ── UML sidebar with filters ─────────────────────────────────────────────────

function buildUmlSidebar(nsColorMap: Map<string, string>, allNs: Set<string>) {
  // Build sorted/grouped file list from classUmlData
  const allFiles = classUmlData?.availableFiles ?? [];
  const fileByFolder = new Map<string, string[]>();
  for (const f of allFiles) {
    const parts = f.split('/');
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    const arr = fileByFolder.get(folder) ?? [];
    arr.push(f);
    fileByFolder.set(folder, arr);
  }

  const fileSection = allFiles.length > 0 ? `
    <div class="sidebar-section">
      <div class="sidebar-section-title">📁 Filter by file (${classFileFilters.size === 0 ? 'all' : classFileFilters.size + ' of ' + allFiles.length})</div>
      <div style="max-height:180px;overflow-y:auto;font-size:11px">
        ${[...fileByFolder.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([folder, files]) => `
          <div style="color:var(--text-muted);padding:2px 0;font-size:10px">${esc(folder)}/</div>
          ${files.sort().map(f => {
            const fname = f.split('/').pop() ?? f;
            const on = classFileFilters.size === 0 || classFileFilters.has(f);
            return `<div class="call-site-entry file-filter-btn ${on?'active':''}" data-file="${esc(f)}"
              style="cursor:pointer;padding:2px 4px 2px 12px;opacity:${on?1:0.4}">
              ${esc(fname)}
            </div>`;
          }).join('')}
        `).join('')}
      </div>
      <div style="margin-top:6px;display:flex;gap:6px">
        <button class="filter-action-btn" id="fileAllOn">All files</button>
        <button class="filter-action-btn" id="fileCurOnly">Current file</button>
      </div>
    </div>` : '';

  const nsSection = allNs.size > 0 ? `
    <div class="sidebar-section">
      <div class="sidebar-section-title">Namespaces — click to filter</div>
      ${[...allNs].map(ns => {
        const col = nsColorMap.get(ns) ?? '#6b7080';
        const on = classNsFilters.size === 0 || classNsFilters.has(ns);
        return `<div class="call-site-entry ns-filter-btn ${on?'active':''}" data-ns="${esc(ns)}" style="border-left:4px solid ${col};padding-left:6px;cursor:pointer;opacity:${on?1:0.45}">
                  ${esc(ns)}
                </div>`;
      }).join('')}
      <div style="margin-top:6px;display:flex;gap:6px">
        <button class="filter-action-btn" id="nsAllOn">All on</button>
        <button class="filter-action-btn" id="nsAllOff">All off</button>
      </div>
    </div>` : '';

  const relSection = `
    <div class="sidebar-section">
      <div class="sidebar-section-title">Relationships</div>
      ${(['inheritance','composition','aggregation','dependency'] as const).map(kind => {
        const labels: Record<string, string> = { inheritance:'⟵ Inheritance', composition:'◆ Composition', aggregation:'◇ Aggregation', dependency:'- - Dependency' };
        const on = umlRelFilters.has(kind);
        return `<label class="checkbox-control" style="margin-bottom:4px">
          <input type="checkbox" class="rel-filter" data-kind="${kind}" ${on?'checked':''}> ${labels[kind]}
        </label>`;
      }).join('')}
    </div>`;

  const viewSection = `
    <div class="sidebar-section">
      <div class="sidebar-section-title">Show in nodes</div>
      <label class="checkbox-control" style="margin-bottom:4px"><input type="checkbox" id="umlMembers" ${umlShowMembers?'checked':''}> Members</label>
      <label class="checkbox-control"><input type="checkbox" id="umlMethods" ${umlShowMethods?'checked':''}> Methods</label>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-title">Legend</div>
      <div style="font-size:11px;line-height:1.9;color:var(--text-muted)">
        ◁── Inheritance<br>◆── Composition (owns)<br>◇── Aggregation (ref)<br>- → Dependency
      </div>
    </div>`;

  sidebarInner.innerHTML = fileSection + nsSection + relSection + viewSection;

  // Wire file filter buttons
  sidebarInner.querySelectorAll<HTMLElement>('.file-filter-btn').forEach(el => {
    el.addEventListener('click', () => {
      const f = el.dataset.file!;
      if (classFileFilters.size === 0) {
        // Was "all" — switch to single-file mode
        classFileFilters = new Set(allFiles.filter(x => x !== f));
      } else if (classFileFilters.has(f)) {
        classFileFilters.delete(f);
      } else {
        classFileFilters.add(f);
      }
      renderUmlDiagram();
    });
  });
  document.getElementById('fileAllOn')?.addEventListener('click', () => {
    classFileFilters.clear(); renderUmlDiagram();
  });
  document.getElementById('fileCurOnly')?.addEventListener('click', () => {
    // Show only classes from the currently active editor file
    // We use the rootClassId's file as the "current" file
    const rootFile = classUmlData?.classes[classUmlData?.rootClassId ?? '']?.location.file;
    if (rootFile) {
      classFileFilters = new Set(allFiles.filter(f => f !== rootFile));
      renderUmlDiagram();
    }
  });

  // Wire namespace filter buttons
  sidebarInner.querySelectorAll<HTMLElement>('.ns-filter-btn').forEach(el => {
    el.addEventListener('click', () => {
      const ns = el.dataset.ns!;
      if (classNsFilters.has(ns)) classNsFilters.delete(ns);
      else classNsFilters.add(ns);
      renderUmlDiagram();
    });
  });
  document.getElementById('nsAllOn')?.addEventListener('click',  () => { classNsFilters = new Set(allNs); renderUmlDiagram(); });
  document.getElementById('nsAllOff')?.addEventListener('click', () => { classNsFilters.clear(); renderUmlDiagram(); });

  // Wire relationship filter checkboxes
  sidebarInner.querySelectorAll<HTMLInputElement>('.rel-filter').forEach(el => {
    el.addEventListener('change', () => {
      const kind = el.dataset.kind!;
      if (el.checked) umlRelFilters.add(kind as any);
      else umlRelFilters.delete(kind as any);
      renderUmlDiagram();
    });
  });

  // Wire view toggles
  document.getElementById('umlMembers')?.addEventListener('change', (e) => { umlShowMembers = (e.target as HTMLInputElement).checked; renderUmlDiagram(); });
  document.getElementById('umlMethods')?.addEventListener('change', (e) => { umlShowMethods = (e.target as HTMLInputElement).checked; renderUmlDiagram(); });

  if (sidebarCollapsed) toggleSidebar();
}

// ── Tap handler for UML class nodes ─────────────────────────────────────────

cy.on('tap', 'node.umlClassNode', (evt: any) => {
  const id = evt.target.id();
  if (!classUmlData?.classes[id]) return;
  const cls = classUmlData.classes[id];

  // Re-root: if user clicks a different class, make it the depth-0 origin
  // by sending a new graph request to the extension
  send({ type: 'openLocation', location: cls.location });

  const relList = cls.relationships
    .filter(r => classUmlData!.classes[r.targetClassId])
    .map(r => `<div class="call-site-entry" data-goto-id="${esc(r.targetClassId)}">
      <span class="cs-caller">${r.kind}: ${esc(r.targetName)}${r.memberName ? ` (${esc(r.memberName)})` : ''}</span>
      <span class="cs-loc">${esc(classUmlData!.classes[r.targetClassId]?.location.file.split('/').pop() ?? '')}</span>
    </div>`)
    .join('');

  const methodList = cls.methods.slice(0, 15).map(m =>
    `<div class="call-site-entry"><span class="cs-caller">${m.isVirtual?'∿':'+'}${esc(m.name)}()</span><span class="cs-loc">${m.location.line}</span></div>`
  ).join('');

  sidebarInner.innerHTML = `
    <div class="sidebar-section">
      <div class="fn-name">${esc(cls.qualifiedName)}</div>
      ${cls.namespace ? `<div class="fn-flags">namespace ${esc(cls.namespace)}</div>` : ''}
      <div class="fn-loc" id="umlGoto">📍 ${esc(cls.location.file)}:${cls.location.line}</div>
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-title">Relationships (${cls.relationships.length})</div>
      ${relList || '<div class="empty-msg">None detected</div>'}
    </div>
    <div class="sidebar-section">
      <div class="sidebar-section-title">Methods (${cls.methods.length})</div>
      ${methodList || '<div class="empty-msg">None</div>'}
    </div>`;

  document.getElementById('umlGoto')?.addEventListener('click', () =>
    send({ type:'openLocation', location:cls.location }));

  sidebarInner.querySelectorAll('[data-goto-id]').forEach(el => {
    el.addEventListener('click', () => {
      const targetCls = classUmlData?.classes[(el as HTMLElement).dataset.gotoId!];
      if (targetCls) send({ type:'openLocation', location: targetCls.location });
    });
  });

  if (sidebarCollapsed) toggleSidebar();
});


// ── Node selection + call site cycling ────────────────────────────────────
function selectNode(id: string, cycleToFirst: boolean) {
  if (!fullGraph) return;
  const node = fullGraph.nodes[id];
  if (!node) return;

  selectedNodeId = id;
  cy.nodes().removeClass('selected');
  cy.getElementById(id).addClass('selected');

  // Build caller list from raw edges (pre-dedup) for cycling
  callSiteCycle = fullGraph.edges
    .filter(e => e.calleeId === id && fullGraph!.nodes[e.callerId])
    .map(e => e.callSite);

  // Deduplicate by file:line
  const seen = new Set<string>();
  callSiteCycle = callSiteCycle.filter(loc => {
    const key = `${loc.file}:${loc.line}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  callSiteIndex = cycleToFirst ? 0 : -1;
  highlightCallSiteEdge();
  renderSidebar(node);

  // Navigate editor
  if (callSiteIndex >= 0 && callSiteCycle[callSiteIndex]) {
    send({ type:'openLocation', location:callSiteCycle[callSiteIndex] });
  } else {
    send({ type:'openLocation', location:node.location });
  }

  // If path mode is active, re-render to highlight the new path
  if (pathMode) renderCallGraphSlice();
}

function cyclCallSite(dir: number) {
  if (!selectedNodeId || callSiteCycle.length === 0) return;
  callSiteIndex = (callSiteIndex + dir + callSiteCycle.length) % callSiteCycle.length;
  highlightCallSiteEdge();
  updateSidebarActiveEntry();
  send({ type:'openLocation', location: callSiteCycle[callSiteIndex] });
}

function highlightCallSiteEdge() {
  if (!selectedNodeId) return;
  cy.edges().removeClass('highlighted');
  if (callSiteIndex < 0 || !callSiteCycle[callSiteIndex]) return;
  const loc = callSiteCycle[callSiteIndex];
  // Find edge whose call site matches
  const match = cy.edges().filter((e: any) =>
    e.data('callLine') === loc.line && e.data('callFile') === loc.file &&
    e.data('target') === selectedNodeId
  );
  match.addClass('highlighted');
}

// ── Sidebar rendering ─────────────────────────────────────────────────────
function renderSidebar(node: FunctionNode) {
  if (!fullGraph) return;

  // Callers visible in the graph — deduplicate by callSite file:line
  const rawCallerEdges = fullGraph.edges.filter(e =>
    e.calleeId === node.id && fullGraph!.nodes[e.callerId]);
  const seenCallerSites = new Set<string>();
  const callerEdges = rawCallerEdges.filter(e => {
    const key = `${e.callSite.file}:${e.callSite.line}`;
    if (seenCallerSites.has(key)) return false;
    seenCallerSites.add(key);
    return true;
  });

  // Callees visible in the graph
  const calleeEdges = fullGraph.edges.filter(e =>
    e.callerId === node.id && fullGraph!.nodes[e.calleeId]);

  const flags: string[] = [];
  if (!node.active) flags.push('inactive (#ifdef / #if 0)');
  if (node.isVirtual) flags.push('virtual');
  if (node.virtualConfirmed) flags.push('override (clang-confirmed)');

  // ── Aliases section (macros that expand to this function) ────────────────
  const aliasSection = (node.aliases && node.aliases.length > 0)
    ? `<div class="sidebar-section">
        <div class="sidebar-section-title">⬡ Interface macros (${node.aliases.length})</div>
        ${node.aliases.map(a =>
          `<div class="call-site-entry">
             <span class="cs-caller" style="font-family:monospace;font-size:11px">#define ${esc(a)}(…)</span>
           </div>`
        ).join('')}
        <div style="font-size:10px;color:var(--text-muted);padding:2px 6px">These macro calls are resolved to this function</div>
      </div>`
    : '';

  // ── ISR section ───────────────────────────────────────────────────────────
  const isrSection = node.isIsr
    ? `<div class="sidebar-section">
        <div class="fn-isr-badge">⚡ ISR — ${esc(node.isrAttribute ?? 'interrupt handler')}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Interrupt Service Routine. This function runs in interrupt context.</div>
      </div>`
    : '';

  sidebarInner.innerHTML = `
    <div class="sidebar-section">
      <div class="fn-name">${esc(node.qualifiedName ?? node.name)}</div>
      <div class="fn-sig">${esc(node.signature)}</div>
      <div class="fn-loc" id="sbDefLink">📍 ${esc(node.location.file)}:${node.location.line}</div>
      ${flags.length ? `<div class="fn-flags">${esc(flags.join(' · '))}</div>` : ''}
    </div>

    ${isrSection}
    ${aliasSection}

    <div class="sidebar-section">
      <div class="sidebar-section-title">Called from (${callerEdges.length}) <span style="font-weight:normal;font-size:10px;color:var(--text-muted)">— click or click node to cycle</span></div>
      <div id="callersList">
        ${callerEdges.length === 0
          ? '<div class="empty-msg">Not called by any visible node</div>'
          : callerEdges.map((e,i) => {
              const caller = fullGraph!.nodes[e.callerId];
              const loc = e.callSite;
              const viaBadge = e.kind === 'pointer' && e.via
                ? ` <span style="font-size:10px;color:var(--cy-edge-ptr)">[via ${esc(e.via)}]</span>` : '';
              const klass = i === callSiteIndex ? 'call-site-entry active' : 'call-site-entry';
              return `<div class="${klass}" data-cs-index="${i}">
                <span class="cs-caller">${esc(caller.qualifiedName ?? caller.name)}${viaBadge}</span>
                <span class="cs-loc">${esc(loc.file.split('/').pop()??loc.file)}:${loc.line}</span>
              </div>`;
            }).join('')}
      </div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-section-title">Calls (${calleeEdges.length})</div>
      <div id="calleesList">
        ${calleeEdges.length === 0
          ? '<div class="empty-msg">Calls nothing visible at this depth</div>'
          : calleeEdges.map(e => {
              const callee = fullGraph!.nodes[e.calleeId];
              const kindBadge = e.kind === 'pointer'
                ? ` <span style="font-size:10px;color:var(--cy-edge-ptr)">[ptr${e.via ? ' via ' + e.via : ''}]</span>`
                : e.kind === 'virtualCandidate'
                  ? ` <span style="font-size:10px;color:var(--cy-edge-virt)">[virtual]</span>`
                  : '';
              return `<div class="call-site-entry" data-callee-id="${esc(callee.id)}">
                <span class="cs-caller">${esc(callee.qualifiedName ?? callee.name)}${kindBadge}</span>
                <span class="cs-loc">${esc(callee.location.file.split('/').pop()??callee.location.file)}:${callee.location.line}</span>
              </div>`;
            }).join('')}
      </div>
    </div>
  `;

    // ISRs visible in the current graph slice
  if (fullGraph) {
    const visibleIsrs = Object.values(fullGraph.nodes)
      .filter(n => n.isIsr && (fullGraph!.nodeDepths[n.id] ?? Infinity) <= currentDepth);
    if (visibleIsrs.length > 0) {
      const isrHtml = visibleIsrs.map(n =>
        `<div class="call-site-entry" data-goto-id="${esc(n.id)}">` +
        `<span class="cs-caller">⚡ ${esc(n.qualifiedName ?? n.name)}</span>` +
        `<span class="cs-loc" style="font-size:10px">${esc(n.isrAttribute ?? '')}</span></div>`
      ).join('');
      sidebarInner.innerHTML += `<div class="sidebar-section"><div class="sidebar-section-title">⚡ ISRs in graph (${visibleIsrs.length})</div>${isrHtml}</div>`;
      sidebarInner.querySelectorAll('[data-goto-id]').forEach(el => {
        el.addEventListener('click', () => {
          const gid = (el as HTMLElement).dataset.gotoId!;
          const fn = fullGraph?.nodes[gid];
          if (fn) { selectNode(gid, false); send({ type:'openLocation', location:fn.location }); }
        });
      });
    }
  }

  // Wire events
  document.getElementById('sbDefLink')?.addEventListener('click', () =>
    send({ type:'openLocation', location:node.location }));

  sidebarInner.querySelectorAll('[data-cs-index]').forEach(el => {
    el.addEventListener('click', () => {
      const i = parseInt((el as HTMLElement).dataset.csIndex!, 10);
      callSiteIndex = i;
      highlightCallSiteEdge();
      updateSidebarActiveEntry();
      send({ type:'openLocation', location: callerEdges[i].callSite });
    });
  });

  sidebarInner.querySelectorAll('[data-callee-id]').forEach(el => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.calleeId!;
      const callee = fullGraph?.nodes[id];
      if (callee) send({ type:'openLocation', location:callee.location });
    });
  });
}

function updateSidebarActiveEntry() {
  sidebarInner.querySelectorAll('[data-cs-index]').forEach(el => {
    const i = parseInt((el as HTMLElement).dataset.csIndex!, 10);
    el.classList.toggle('active', i === callSiteIndex);
  });
  // scroll into view
  const active = sidebarInner.querySelector('.call-site-entry.active') as HTMLElement | null;
  active?.scrollIntoView({ block:'nearest' });
}

// ── Source popup rendering ────────────────────────────────────────────────
const CPP_KEYWORDS = new Set(['if','else','for','while','do','switch','case','break','continue','return',
  'void','int','char','float','double','long','short','unsigned','signed','bool','true','false','nullptr',
  'NULL','const','static','extern','inline','auto','register','volatile','struct','class','union','enum',
  'typedef','namespace','using','template','typename','virtual','override','final','public','private',
  'protected','new','delete','operator','sizeof','this','explicit','mutable','friend','try','catch','throw',
  'noexcept','constexpr','decltype','static_assert','alignas','alignof']);

function esc(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function highlightCpp(raw: string): string {
  let r = '', i = 0, n = raw.length;
  while (i < n) {
    if (raw[i]==='/'&&raw[i+1]==='*') { const e=raw.indexOf('*/',i+2); const chunk=e<0?raw.slice(i):raw.slice(i,e+2); r+=`<span class="tok-cm">${esc(chunk)}</span>`; i=e<0?n:e+2; continue; }
    if (raw[i]==='/'&&raw[i+1]==='/') { const e=raw.indexOf('\n',i); r+=`<span class="tok-cm">${esc(e<0?raw.slice(i):raw.slice(i,e))}</span>`; i=e<0?n:e; continue; }
    if (raw[i]==='#') { let e=i; while(e<n){if(raw[e]==='\n'&&raw[e-1]!=='\\')break;e++;} r+=`<span class="tok-pp">${esc(raw.slice(i,e))}</span>`; i=e; continue; }
    if (raw[i]==='"') { let j=i+1; while(j<n&&raw[j]!=='"'){if(raw[j]==='\\')j++;j++;} r+=`<span class="tok-st">${esc(raw.slice(i,j+1))}</span>`; i=j+1; continue; }
    if (raw[i]==="'") { let j=i+1; while(j<n&&raw[j]!=="'"){if(raw[j]==='\\')j++;j++;} r+=`<span class="tok-st">${esc(raw.slice(i,j+1))}</span>`; i=j+1; continue; }
    if (/[0-9]/.test(raw[i])||(raw[i]==='.'&&/[0-9]/.test(raw[i+1]??''))) { let j=i; while(j<n&&/[0-9a-fA-FxX._uUlLfF]/.test(raw[j]))j++; r+=`<span class="tok-nm">${esc(raw.slice(i,j))}</span>`; i=j; continue; }
    if (/[A-Za-z_]/.test(raw[i])) { let j=i; while(j<n&&/[A-Za-z0-9_]/.test(raw[j]))j++; const w=raw.slice(i,j); let k=j; while(k<n&&raw[k]===' ')k++; r+=CPP_KEYWORDS.has(w)?`<span class="tok-kw">${esc(w)}</span>`:raw[k]==='('?`<span class="tok-fn">${esc(w)}</span>`:esc(w); i=j; continue; }
    r+=esc(raw[i]); i++;
  }
  return r;
}

// Returns true for the first non-comment/non-blank line (the function signature line).
function isAnchorLine(lines: string[], idx: number): boolean {
  for (let i = 0; i < idx; i++) {
    const t = lines[i].trim();
    if (t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('#')) return false;
  }
  const t = lines[idx]?.trim() ?? '';
  return !!(t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('#'));
}

function renderPopupSource(source: string, startLine: number) {
  const startNo = startLine;
  const lines = source.split('\n');
  popupSrcInner.innerHTML = '';
  for (let i=0; i<lines.length; i++) {
    const ln = startNo + i;
    const row = document.createElement('div');
    row.className = 'source-line' + (isAnchorLine(lines, i) ? ' anchor' : '');
    row.innerHTML = `<div class="ln">${ln}</div><div class="lc">${highlightCpp(lines[i])}</div>`;
    popupSrcInner.appendChild(row);
  }
  const anchor = popupSrcInner.querySelector('.anchor') as HTMLElement | null;
  anchor?.scrollIntoView({ block:'nearest' });
}
