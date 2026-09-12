import { escapeXml } from './render.js';
import { CERTAINTY, depths, type CallGraph, type Certainty } from './flow.js';

/**
 * Call graph rendering.
 *
 * Laid out left to right by depth from the root, because call chains are read
 * as sequences and a vertical layout wastes the axis that matters.
 *
 * The one rule this renderer exists to enforce: certainty is visible without
 * clicking anything. A resolved call and a guess must never look alike. Solid
 * lines are calls that go exactly where they appear to; dashed lines are a
 * bounded set of possibilities; dotted lines ending in a question mark are calls
 * Lens could not follow at all. Drawing that last case as a normal arrow — or
 * omitting it — is the failure this whole lens is built to avoid.
 */

const NODE_W = 200;
const NODE_H = 46;
const H_GAP = 74;
const V_GAP = 18;
const PAD = 24;

const EDGE_STYLE: Record<Certainty, { dash: string; opacity: string }> = {
  certain: { dash: '', opacity: '1' },
  bounded: { dash: ' stroke-dasharray="7 4"', opacity: '0.85' },
  unknown: { dash: ' stroke-dasharray="2 4"', opacity: '0.7' },
};

export interface FlowRenderOptions {
  annotated?: Set<string>;
  /** Ids to draw as highlighted, e.g. a traced path. */
  highlight?: Set<string>;
}

interface Placed {
  x: number;
  y: number;
  column: number;
}

export function layoutFlow(graph: CallGraph): { places: Map<string, Placed>; width: number; height: number } {
  const depth = depths(graph);
  const columns: string[][] = [];

  for (const id of graph.nodes.keys()) {
    // Nodes unreachable from the root still get drawn, parked in the last
    // column, because dropping them would silently hide a disconnected callee.
    const d = depth.get(id) ?? -1;
    const col = d >= 0 ? d : Math.max(0, ...depth.values()) + 1;
    (columns[col] ??= []).push(id);
  }
  for (let i = 0; i < columns.length; i++) {
    columns[i] ??= [];
    columns[i].sort();
  }

  const places = new Map<string, Placed>();
  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * V_GAP;

  columns.forEach((col, i) => {
    const colHeight = col.length * NODE_H + (col.length - 1) * V_GAP;
    const top = (height - colHeight) / 2;
    col.forEach((id, j) => {
      places.set(id, { x: PAD + i * (NODE_W + H_GAP), y: top + j * (NODE_H + V_GAP), column: i });
    });
  });

  return {
    places,
    width: PAD * 2 + columns.length * NODE_W + Math.max(0, columns.length - 1) * H_GAP,
    height,
  };
}

export function renderFlowSvg(graph: CallGraph, opts: FlowRenderOptions = {}): string {
  const { places, width, height } = layoutFlow(graph);
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="var(--vscode-font-family, sans-serif)">`,
    '<defs>',
    '<marker id="call" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">',
    '<path d="M0 0 L10 5 L0 10 z" fill="var(--lens-edge)"/>',
    '</marker>',
    '<marker id="maybe" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">',
    '<path d="M0 0 L10 5 L0 10" fill="none" stroke="var(--lens-edge)" stroke-width="1.4"/>',
    '</marker>',
    '</defs>',
  );

  for (const e of graph.edges) {
    const a = places.get(e.from);
    const b = places.get(e.to);
    if (!a || !b) {
      continue;
    }
    const certainty = CERTAINTY[e.resolution];
    const style = EDGE_STYLE[certainty];
    const forward = b.column > a.column;
    const x1 = forward ? a.x + NODE_W : a.x;
    const y1 = a.y + NODE_H / 2;
    const x2 = forward ? b.x : b.x + NODE_W;
    const y2 = b.y + NODE_H / 2;
    // A gentle curve rather than orthogonal routing: shared paths pile up badly
    // when several edges converge on one callee.
    const mid = (x1 + x2) / 2;
    const stroke = certainty === 'unknown' ? 'var(--lens-unknown)' : 'var(--lens-edge)';

    parts.push(
      `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} C${mid.toFixed(1)} ${y1.toFixed(1)}, ${mid.toFixed(1)} ${y2.toFixed(
        1,
      )}, ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="1.4" ` +
        `opacity="${style.opacity}"${style.dash} marker-end="url(#${certainty === 'certain' ? 'call' : 'maybe'})">` +
        `<title>${escapeXml(e.resolution)}${e.evidence ? ` — ${escapeXml(e.evidence)}` : ''}</title></path>`,
    );

    if (certainty === 'unknown') {
      parts.push(
        `<text x="${((x1 + x2) / 2).toFixed(1)}" y="${((y1 + y2) / 2 - 5).toFixed(
          1,
        )}" text-anchor="middle" font-size="13" font-weight="700" fill="var(--lens-unknown)">?</text>`,
      );
    }
  }

  for (const [id, p] of places) {
    const n = graph.nodes.get(id);
    if (!n) {
      continue;
    }
    const isRoot = id === graph.root;
    const stroke = n.isr ? 'var(--lens-trap)' : isRoot ? 'var(--lens-new)' : 'var(--lens-border)';
    const highlighted = opts.highlight?.has(id) ?? false;

    parts.push(
      `<g class="node" data-id="${escapeXml(id)}" data-qname="${escapeXml(id)}" tabindex="0" role="button" aria-label="${escapeXml(
        n.name,
      )}">`,
      `<rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="4" ` +
        `fill="${highlighted ? 'var(--lens-highlight)' : 'var(--lens-node)'}" stroke="${stroke}" ` +
        `stroke-width="${n.isr || isRoot ? 1.9 : 1.1}"/>`,
    );

    const label = n.name.length > 26 ? `${n.name.slice(0, 25)}...` : n.name;
    parts.push(
      `<text x="${p.x + 10}" y="${p.y + (n.isr ? 20 : 27)}" font-size="12.5" font-weight="${
        isRoot ? 700 : 500
      }" fill="var(--lens-fg)">${escapeXml(label)}</text>`,
    );
    if (n.isr) {
      parts.push(
        `<text x="${p.x + 10}" y="${p.y + 36}" font-size="9.5" fill="var(--lens-trap)">${escapeXml(
          n.isr.confidence === 'certain' ? 'ISR' : 'ISR?',
        )} ${escapeXml(n.isr.reason)}</text>`,
      );
    }
    if (opts.annotated?.has(id)) {
      parts.push(`<circle cx="${p.x + NODE_W - 9}" cy="${p.y + 9}" r="3.5" fill="var(--lens-annotated)"/>`);
    }
    parts.push(
      `<title>${escapeXml(n.name)}${n.file ? `\n${escapeXml(n.file)}:${n.line ?? 1}` : ''}</title>`,
      '</g>',
    );
  }

  parts.push('</svg>');
  return parts.join('\n');
}

/** Legend text, rendered beside the graph so the line styles are self-explaining. */
export const FLOW_LEGEND: { certainty: Certainty; label: string; meaning: string }[] = [
  { certainty: 'certain', label: 'solid', meaning: 'goes exactly here — direct call, or the only possible target' },
  { certainty: 'bounded', label: 'dashed', meaning: 'one of a known set — virtual call, targets enumerated' },
  { certainty: 'unknown', label: 'dotted, marked ?', meaning: 'Lens could not follow this — read the code' },
];
