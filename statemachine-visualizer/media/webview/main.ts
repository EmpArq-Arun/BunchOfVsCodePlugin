// @ts-nocheck
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
cytoscape.use(dagre);

declare function acquireVsCodeApi(): { postMessage(msg: any): void };
const vscode = acquireVsCodeApi();

interface SourceLocation { file: string; line: number }
interface StateNode { name: string; value?: string; isInitial?: boolean; location: SourceLocation }
interface Transition  { from: string; to: string; label?: string; kind: string; location: SourceLocation }
interface StateMachine {
  id: string; name: string; file: string; enumName: string;
  stateVariable?: string; states: StateNode[]; transitions: Transition[];
  confidence: number; detectionKind: string;
}

const graphEl     = document.getElementById('graph')!;
const backBtn     = document.getElementById('backBtn') as HTMLButtonElement;
const titleEl     = document.getElementById('title')!;
const confidenceEl = document.getElementById('confidence')!;

let cy: cytoscape.Core | undefined;
let currentLayout: 'lr'|'tb' = 'lr';

window.addEventListener('message', evt => {
  const msg = evt.data;
  if (msg?.type === 'load') render(msg.machine as StateMachine);
});

// Layout toggle buttons
document.querySelectorAll<HTMLButtonElement>('.sm-layout-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sm-layout-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentLayout = btn.dataset.layout as any;
    if (cy) cy.layout(layoutConfig()).run();
  });
});

backBtn.style.display = 'none'; // State machine panel is single-level now

function layoutConfig(): any {
  return { name:'dagre', rankDir: currentLayout === 'lr' ? 'LR' : 'TB', nodeSep:40, rankSep:90, animate:true, animationDuration:300 };
}

function render(m: StateMachine) {
  if (!m) return;
  titleEl.textContent = `${m.name}  (${m.enumName})`;
  confidenceEl.textContent = `${m.detectionKind} · ${Math.round(m.confidence * 100)}% confidence · ${m.states.length} states · ${m.transitions.length} transitions`;
  if (cy) { cy.destroy(); cy = undefined; }
  graphEl.innerHTML = '';

  if (m.states.length === 0) {
    graphEl.innerHTML = '<div style="padding:20px;opacity:.6">No states found — enum may have been detected but no dispatch logic was recognised.</div>';
    renderLegend(m, 'No transitions were resolved for this state machine.');
    return;
  }

  const elements: cytoscape.ElementDefinition[] = [];
  for (const s of m.states) {
    elements.push({
      data: { id: s.name, label: buildStateLabel(s), location: s.location },
      classes: s.isInitial ? 'state initial' : 'state',
    });
  }
  let i = 0;
  for (const t of m.transitions) {
    elements.push({
      data: { id: `tr${i++}`, source: t.from, target: t.to, label: t.label ?? '', location: t.location },
    });
  }

  cy = cytoscape({
    container: graphEl,
    elements,
    style: stateStyle(),
    layout: layoutConfig(),
  });

  cy.on('tap', 'node.state', evt => {
    const loc = evt.target.data('location');
    if (loc?.file) vscode.postMessage({ type:'revealLocation', location: loc });
  });
  cy.on('tap', 'edge', evt => {
    const loc = evt.target.data('location');
    if (loc?.file) vscode.postMessage({ type:'revealLocation', location: loc });
  });

  // Tooltip on nodes/edges
  cy.on('mouseover', 'node.state', evt => {
    const d = evt.target.data();
    showTooltip(`${d.label}\nLine ${d.location?.line ?? '?'} in ${d.location?.file?.split(/[/\\]/).pop() ?? ''}\n\nClick to jump to source`, evt.target.renderedPosition());
  });
  cy.on('mouseout', 'node.state', hideTooltip);
  cy.on('mouseover', 'edge', evt => {
    const d = evt.target.data();
    const mp = evt.target.midpoint();
    const pan = cy!.pan(); const z = cy!.zoom();
    showTooltipPx(d.label || '(unconditional)', mp.x*z+pan.x, mp.y*z+pan.y);
  });
  cy.on('mouseout', 'edge', hideTooltip);

  const unreached = m.states.filter(s => !m.transitions.some(t=>t.to===s.name) && !s.isInitial);
  const note = m.transitions.length === 0
    ? 'No transitions resolved — enum detected but dispatch pattern not recognised (heavy macro use, bit-fields, or multi-file dispatch).'
    : unreached.length > 0
      ? `${unreached.length} state(s) have no detected incoming transition: ${unreached.map(s=>s.name).join(', ')}.`
      : 'Click a state or arrow to jump to the source line.';
  renderLegend(m, note);
}

function buildStateLabel(s: StateNode): string {
  return s.value !== undefined ? `${s.name}\n= ${s.value}` : s.name;
}

const tooltip = document.createElement('div');
tooltip.style.cssText = 'position:fixed;background:#252526;border:1px solid #555;border-radius:4px;padding:5px 9px;font-size:11px;max-width:280px;pointer-events:none;display:none;white-space:pre-wrap;z-index:999;line-height:1.5;color:#ddd';
document.body.appendChild(tooltip);

function showTooltip(text: string, pos: {x:number;y:number}) {
  const b = graphEl.getBoundingClientRect();
  showTooltipPx(text, b.left + pos.x, b.top + pos.y);
}
function showTooltipPx(text: string, x: number, y: number) {
  tooltip.textContent = text;
  tooltip.style.display = 'block';
  tooltip.style.left = `${Math.min(x+12, window.innerWidth-290)}px`;
  tooltip.style.top  = `${Math.min(y+12, window.innerHeight-160)}px`;
}
function hideTooltip() { tooltip.style.display = 'none'; }

function stateStyle(): cytoscape.Stylesheet[] {
  return [
    {
      selector: 'node.state',
      style: {
        shape: 'round-rectangle',
        'background-color': '#cfe0ff',
        'border-color': '#4f8cff', 'border-width': 2,
        label: 'data(label)',
        'text-valign': 'center', 'text-halign': 'center',
        'font-size': 11, 'font-weight': 'bold',
        color: '#1e1e1e',
        width: 'label', height: 40, padding: '14px',
        'text-wrap': 'wrap', 'text-max-width': 140,
      },
    },
    {
      selector: 'node.initial',
      style: { 'background-color': '#c6f3d8', 'border-color': '#37b873', 'border-width': 3 },
    },
    {
      selector: 'node.state:selected',
      style: { 'border-width': 3, 'background-opacity': 0.9 },
    },
    {
      selector: 'edge',
      style: {
        width: 2,
        'line-color': '#9aa3b2', 'target-arrow-color': '#9aa3b2',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        label: 'data(label)',
        'font-size': 10, color: '#666',
        'text-background-color': '#fff', 'text-background-opacity': 0.85, 'text-background-padding': '2px',
        'text-wrap': 'wrap', 'text-max-width': 120,
      },
    },
    {
      selector: 'edge:selected',
      style: { 'line-color': '#4f8cff', 'target-arrow-color': '#4f8cff', width: 3 },
    },
  ];
}

function renderLegend(m: StateMachine, note: string) {
  const legend = document.getElementById('legend')!;
  legend.innerHTML = `
    <div class="legend-row">
      <span class="legend-chip"><i style="background:#c6f3d8;border:2px solid #37b873"></i> Initial state</span>
      <span class="legend-chip"><i style="background:#cfe0ff;border:2px solid #4f8cff"></i> State</span>
      ${m.stateVariable ? `<span class="legend-chip" style="opacity:.7">variable: <code>${m.stateVariable}</code></span>` : ''}
    </div>
    <div class="legend-note">${note}</div>`;
}
