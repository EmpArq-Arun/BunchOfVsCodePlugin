import { CallGraphData } from '../types';

function sanitizeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

function escapeLabel(label: string): string {
  return label.replace(/"/g, '\\"');
}

export function toDot(graph: CallGraphData): string {
  const lines: string[] = ['digraph CallGraph {', '  rankdir=LR;', '  node [shape=box, fontname="Helvetica"];'];

  for (const node of Object.values(graph.nodes)) {
    const label = escapeLabel(node.qualifiedName ?? node.name);
    const style = node.id === graph.rootId ? ', style=filled, fillcolor="#2f6fed", fontcolor=white' : !node.active ? ', style=dashed, color=gray' : '';
    lines.push(`  ${sanitizeId(node.id)} [label="${label}"${style}];`);
  }

  for (const edge of graph.edges) {
    const style = edge.kind === 'pointer' ? ' [style=dashed, label="via ' + escapeLabel(edge.via ?? '') + '"]'
      : edge.kind === 'virtualCandidate' ? ' [style=dotted, color="#a64dff"]'
      : '';
    lines.push(`  ${sanitizeId(edge.callerId)} -> ${sanitizeId(edge.calleeId)}${style};`);
  }

  lines.push('}');
  return lines.join('\n');
}

export function toMermaid(graph: CallGraphData): string {
  const lines: string[] = ['flowchart LR'];

  for (const node of Object.values(graph.nodes)) {
    const label = (node.qualifiedName ?? node.name).replace(/"/g, "'");
    const shape = node.id === graph.rootId ? `["${label}"]` : `("${label}")`;
    lines.push(`  ${sanitizeId(node.id)}${shape}`);
  }

  for (const edge of graph.edges) {
    const arrow = edge.kind === 'pointer' ? '-.->' : edge.kind === 'virtualCandidate' ? '-..->' : '-->';
    const label = edge.via ? `|via ${edge.via}|` : '';
    lines.push(`  ${sanitizeId(edge.callerId)} ${arrow}${label} ${sanitizeId(edge.calleeId)}`);
  }

  return lines.join('\n');
}
