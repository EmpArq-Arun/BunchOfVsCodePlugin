import type { Finding, Severity } from './constructs.js';
import type { StructureModel, TypeNode } from './structure.js';

/**
 * Layout and rendering.
 *
 * P1 renders static SVG built in the extension host rather than driving an
 * interactive graph library. Class diagrams for a firmware module are tens of
 * nodes, where a deterministic layered layout is both adequate and testable —
 * and testable matters more here, because a rendering bug in a comprehension
 * tool teaches you something false. The Flow lens at P2 deals in call graphs an
 * order of magnitude larger, which is where an interactive canvas starts
 * earning its dependency; that is the right place to bring Cytoscape in.
 *
 * Edges are straight lines between computed anchor points. Orthogonal routing
 * looks tidier on paper and piles up badly on shared paths in dense graphs.
 */

const NODE_W = 190;
const NODE_H = 62;
const H_GAP = 34;
const V_GAP = 78;
const PAD = 28;

export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rank: number;
}

export interface Layout {
  nodes: Map<string, LaidOutNode>;
  width: number;
  height: number;
}

/**
 * Rank by longest path from a root, so a base always sits above every class
 * that derives from it however many intermediate hops there are. Cycles cannot
 * occur in an inheritance graph, but the visited set guards against a malformed
 * model rather than trusting the input.
 */
function rankNodes(model: StructureModel): Map<string, number> {
  const bases = new Map<string, string[]>();
  for (const t of model.types) {
    bases.set(t.id, []);
  }
  for (const r of model.relations) {
    if (r.kind === 'inheritance' && bases.has(r.from)) {
      bases.get(r.from)!.push(r.to);
    }
  }

  const rank = new Map<string, number>();
  const inProgress = new Set<string>();

  const resolve = (id: string): number => {
    const cached = rank.get(id);
    if (cached !== undefined) {
      return cached;
    }
    if (inProgress.has(id)) {
      return 0;
    }
    inProgress.add(id);
    let best = 0;
    for (const b of bases.get(id) ?? []) {
      if (bases.has(b)) {
        best = Math.max(best, resolve(b) + 1);
      }
    }
    inProgress.delete(id);
    rank.set(id, best);
    return best;
  };

  for (const t of model.types) {
    resolve(t.id);
  }
  return rank;
}

/** Barycentre sweeps to reduce edge crossings. Two passes is enough at this scale. */
function orderRanks(model: StructureModel, rank: Map<string, number>): string[][] {
  const rows: string[][] = [];
  for (const t of model.types) {
    const r = rank.get(t.id) ?? 0;
    (rows[r] ??= []).push(t.id);
  }
  for (let i = 0; i < rows.length; i++) {
    rows[i] ??= [];
  }

  const adjacency = new Map<string, string[]>();
  for (const r of model.relations) {
    (adjacency.get(r.from) ?? adjacency.set(r.from, []).get(r.from)!).push(r.to);
    (adjacency.get(r.to) ?? adjacency.set(r.to, []).get(r.to)!).push(r.from);
  }

  for (let pass = 0; pass < 2; pass++) {
    const position = new Map<string, number>();
    rows.forEach((row) => row.forEach((id, i) => position.set(id, i)));
    for (const row of rows) {
      const bary = new Map<string, number>();
      for (const id of row) {
        const linked = (adjacency.get(id) ?? []).map((n) => position.get(n)).filter((p): p is number => p !== undefined);
        bary.set(id, linked.length > 0 ? linked.reduce((a, b) => a + b, 0) / linked.length : position.get(id) ?? 0);
      }
      row.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0) || a.localeCompare(b));
    }
  }
  return rows;
}

export function layout(model: StructureModel): Layout {
  const rank = rankNodes(model);
  const rows = orderRanks(model, rank);
  const widest = Math.max(1, ...rows.map((r) => r.length));
  const width = PAD * 2 + widest * NODE_W + (widest - 1) * H_GAP;

  const nodes = new Map<string, LaidOutNode>();
  rows.forEach((row, r) => {
    const rowWidth = row.length * NODE_W + (row.length - 1) * H_GAP;
    const left = (width - rowWidth) / 2;
    row.forEach((id, i) => {
      nodes.set(id, {
        id,
        x: left + i * (NODE_W + H_GAP),
        y: PAD + r * (NODE_H + V_GAP),
        w: NODE_W,
        h: NODE_H,
        rank: r,
      });
    });
  });

  return {
    nodes,
    width,
    height: PAD * 2 + rows.length * NODE_H + Math.max(0, rows.length - 1) * V_GAP,
  };
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}...`;
}

function stereotype(t: TypeNode): string {
  if (t.isAbstract) {
    return '<<abstract>>';
  }
  if (t.isTemplate) {
    return '<<template>>';
  }
  if (t.kind === 'struct') {
    return '<<struct>>';
  }
  if (t.kind === 'union') {
    return '<<union>>';
  }
  return '';
}

/** One-line summary of what is inside the box, so the box itself stays readable. */
function badges(t: TypeNode): string {
  const bits: string[] = [];
  const virtuals = t.methods.filter((m) => m.isVirtual).length;
  if (virtuals > 0) {
    bits.push(`${virtuals} virtual`);
  }
  const plain = t.methods.length - virtuals;
  if (plain > 0) {
    bits.push(`${plain} method${plain === 1 ? '' : 's'}`);
  }
  if (t.members.length > 0) {
    bits.push(`${t.members.length} field${t.members.length === 1 ? '' : 's'}`);
  }
  return bits.join('  ');
}

const SEVERITY_STROKE: Record<Severity, string> = {
  trap: 'var(--lens-trap)',
  new: 'var(--lens-new)',
  familiar: 'var(--lens-familiar)',
};

export interface RenderOptions {
  findings?: Finding[];
  annotated?: Set<string>;
}

/**
 * Render to standalone SVG. Colours are CSS custom properties so the webview can
 * bind them to VS Code theme variables without this function knowing anything
 * about themes.
 */
export function renderSvg(model: StructureModel, opts: RenderOptions = {}): string {
  const l = layout(model);
  const types = new Map(model.types.map((t) => [t.id, t]));

  const worst = new Map<string, Severity>();
  for (const f of opts.findings ?? []) {
    const current = worst.get(f.typeId);
    if (f.severity === 'trap' || (f.severity === 'new' && current !== 'trap')) {
      worst.set(f.typeId, f.severity);
    } else if (!current) {
      worst.set(f.typeId, f.severity);
    }
  }

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${l.width} ${l.height}" width="${l.width}" height="${l.height}" font-family="var(--vscode-font-family, sans-serif)">`,
    '<defs>',
    '<marker id="inherit" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="11" markerHeight="11" orient="auto">',
    '<path d="M0 0 L12 6 L0 12 z" fill="var(--lens-bg)" stroke="var(--lens-edge)" stroke-width="1.2"/>',
    '</marker>',
    '<marker id="assoc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">',
    '<path d="M0 0 L10 5 L0 10" fill="none" stroke="var(--lens-edge)" stroke-width="1.4"/>',
    '</marker>',
    '</defs>',
  );

  // Edges first so boxes paint over the line ends.
  for (const r of model.relations) {
    const a = l.nodes.get(r.from);
    const b = l.nodes.get(r.to);
    if (!a || !b) {
      continue;
    }
    const inheritance = r.kind === 'inheritance';
    const from = { x: a.x + a.w / 2, y: a.rank <= b.rank ? a.y : a.y };
    const to = { x: b.x + b.w / 2, y: b.y };
    // Leave the derived box from the top edge, enter the base at its bottom,
    // unless the two share a rank, in which case go side to side.
    const sameRank = a.rank === b.rank;
    const x1 = sameRank ? (a.x < b.x ? a.x + a.w : a.x) : from.x;
    const y1 = sameRank ? a.y + a.h / 2 : a.y;
    const x2 = sameRank ? (a.x < b.x ? b.x : b.x + b.w) : to.x;
    const y2 = sameRank ? b.y + b.h / 2 : b.y + b.h;

    const dash = r.kind === 'dependency' || r.kind === 'instantiation' ? ' stroke-dasharray="5 4"' : '';
    parts.push(
      `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" ` +
        `stroke="var(--lens-edge)" stroke-width="1.3"${dash} marker-end="url(#${inheritance ? 'inherit' : 'assoc'})"/>`,
    );
    if (r.label) {
      parts.push(
        `<text x="${((x1 + x2) / 2).toFixed(1)}" y="${((y1 + y2) / 2 - 4).toFixed(1)}" text-anchor="middle" ` +
          `font-size="10" fill="var(--lens-muted)">${escapeXml(truncate(r.label, 18))}</text>`,
      );
    }
  }

  for (const [id, n] of l.nodes) {
    const t = types.get(id);
    if (!t) {
      continue;
    }
    const severity = worst.get(id);
    const stroke = severity ? SEVERITY_STROKE[severity] : 'var(--lens-border)';
    const strokeWidth = severity === 'trap' ? 2 : 1.2;
    const marked = opts.annotated?.has(t.qualifiedName) ?? false;
    const st = stereotype(t);
    const badge = badges(t);

    parts.push(
      `<g class="node" data-id="${escapeXml(id)}" data-qname="${escapeXml(t.qualifiedName)}" tabindex="0" role="button" ` +
        `aria-label="${escapeXml(t.qualifiedName)}">`,
      `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="5" fill="var(--lens-node)" ` +
        `stroke="${stroke}" stroke-width="${strokeWidth}"/>`,
    );
    let textY = n.y + (st ? 19 : 26);
    if (st) {
      parts.push(
        `<text x="${n.x + n.w / 2}" y="${textY}" text-anchor="middle" font-size="10" fill="var(--lens-muted)">${st}</text>`,
      );
      textY += 16;
    }
    parts.push(
      `<text x="${n.x + n.w / 2}" y="${textY}" text-anchor="middle" font-size="13" font-weight="600" ` +
        `fill="var(--lens-fg)">${escapeXml(truncate(t.name, 22))}</text>`,
    );
    if (badge) {
      parts.push(
        `<text x="${n.x + n.w / 2}" y="${n.y + n.h - 10}" text-anchor="middle" font-size="10" ` +
          `fill="var(--lens-muted)">${escapeXml(badge)}</text>`,
      );
    }
    if (marked) {
      parts.push(
        `<circle cx="${n.x + n.w - 10}" cy="${n.y + 10}" r="3.5" fill="var(--lens-annotated)"><title>You have notes on this class</title></circle>`,
      );
    }
    parts.push(`<title>${escapeXml(t.qualifiedName)}${t.brief ? ` — ${escapeXml(t.brief)}` : ''}</title>`, '</g>');
  }

  parts.push('</svg>');
  return parts.join('\n');
}
