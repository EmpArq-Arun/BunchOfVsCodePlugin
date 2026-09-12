import { assert } from './helpers';

/** Pure-logic tests for the layout dot-transformation (no DOM, no Graphviz needed) */

type LayoutMode = 'vertical' | 'horizontal' | 'radial';

function transformDotForLayout(originalDot: string, mode: LayoutMode): { dot: string; engine: 'dot' | 'twopi' } {
  if (mode === 'vertical') {
    return { dot: originalDot.replace(/rankdir=\w+;/, 'rankdir=TB;'), engine: 'dot' };
  }
  if (mode === 'horizontal') {
    return { dot: originalDot.replace(/rankdir=\w+;/, 'rankdir=LR;'), engine: 'dot' };
  }
  const entryMatch = originalDot.match(/\{rank=min;\s*"([^"]+)";\s*\}/);
  const entryId    = entryMatch?.[1] ?? 'n1';
  let dot = originalDot
    .replace(/\s*rankdir=\w+;/g,       '')
    .replace(/\s*splines=\w+;/g,       '')
    .replace(/\s*nodesep=[^;]+;/g,     '')
    .replace(/\s*ranksep=[^;]+;/g,     '')
    .replace(/\s*\{rank=\w+;\s*"[^"]+";?\s*\}/g, '');
  const braceIdx = dot.indexOf('{');
  if (braceIdx !== -1) {
    dot = dot.slice(0, braceIdx + 1)
      + `\n  root="${entryId}";\n  overlap=false;\n  sep="0.5";\n`
      + dot.slice(braceIdx + 1);
  }
  return { dot, engine: 'twopi' };
}

export async function run(): Promise<void> {
  const sample = `digraph "fn" {
  rankdir=TB;
  splines=ortho;
  nodesep=0.55;
  ranksep=0.65;
  {rank=min; "n1";}
  {rank=max; "n2";}
  "n1" [id="n1", label="fn\\nEntry"];
  "n2" [id="n2", label="Exit"];
  "n1" -> "n2";
}`;

  const { dot: vtDot, engine: vtEng } = transformDotForLayout(sample, 'vertical');
  assert(vtEng === 'dot',              'vertical uses dot engine');
  assert(vtDot.includes('rankdir=TB'), 'vertical preserves TB rankdir');
  assert(vtDot.includes('splines=ortho'), 'vertical keeps splines=ortho');

  const { dot: lrDot, engine: lrEng } = transformDotForLayout(sample, 'horizontal');
  assert(lrEng === 'dot',              'horizontal uses dot engine');
  assert(lrDot.includes('rankdir=LR'), 'horizontal sets LR rankdir');
  assert(!lrDot.includes('rankdir=TB'), 'horizontal removes TB rankdir');
  assert(lrDot.includes('splines=ortho'), 'horizontal keeps splines=ortho');

  const { dot: rdDot, engine: rdEng } = transformDotForLayout(sample, 'radial');
  assert(rdEng === 'twopi',                    'radial uses twopi engine');
  assert(!rdDot.includes('splines='),          'radial removes splines (twopi rejects it)');
  assert(!rdDot.includes('rankdir='),          'radial removes rankdir');
  assert(!rdDot.includes('nodesep='),          'radial removes nodesep');
  assert(!rdDot.includes('rank=min'),          'radial removes rank constraints');
  assert(rdDot.includes('root="n1"'),          'radial inserts root="n1" (extracted from rank=min)');
  assert(rdDot.includes('overlap=false'),      'radial adds overlap=false');
  assert(rdDot.includes('"n1" [id="n1"'),      'radial keeps all node definitions');

  console.log('  layout transformation (vertical/horizontal/radial): OK');
}
