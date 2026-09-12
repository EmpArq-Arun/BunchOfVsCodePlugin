import { parseCFunction, assert } from './helpers';
import { buildCFG } from '../src/parser/cfgBuilder';
import { cfgToDot, extractNodeMetadata } from '../src/dot/dotGenerator';
import { Graphviz } from '@hpcc-js/wasm-graphviz';

export async function run(): Promise<void> {
  const src = `
    int classify(int idx, int bufferSize) {
        /** Buffer overflow check */
        if (idx < bufferSize) { process(idx); }
        else if (idx == bufferSize) { return -1; }
        switch (idx) {
            case 0: case 1: doSomething(); break;
            case 2:  doOther();
            default: fallback();
        }
        for (int i = 0; i < bufferSize; i++) {
            if (skip(i)) continue;
            if (stop(i)) break;
            use(i);
        }
        return 0;
    }`;

  const fn = await parseCFunction(src);
  const graph = buildCFG(fn);
  const dot = cfgToDot(graph);
  const meta = extractNodeMetadata(graph);

  // #10 — entry node shows function name
  const entryNode = graph.nodes.get(graph.entryId)!;
  assert(entryNode.label.includes('classify'), `entry label must include function name, got: "${entryNode.label}"`);

  // #5 — no explicit break/continue process nodes
  const breakNodes = [...graph.nodes.values()].filter(n => n.rawText === 'break' || n.rawText === 'continue');
  assert(breakNodes.length === 0, `found ${breakNodes.length} explicit break/continue nodes — these should not exist`);

  // break/continue EDGES must still route correctly
  const breakEdges = graph.edges.filter(e => e.kind === 'break');
  const continueEdges = graph.edges.filter(e => e.kind === 'continue');
  assert(breakEdges.length > 0, 'break edges must still be present even without break nodes');
  assert(continueEdges.length > 0, 'continue edges must still be present even without continue nodes');

  // #1 — ortho splines
  assert(dot.includes('splines=spline'), 'dot must request spline routing');

  // Yes/No edge labels with explicit fontcolor
  assert(dot.includes('taillabel="Yes"') && dot.includes('taillabel="No"'), 'must use taillabel for true/false edges');
  assert(dot.includes('labelfontcolor="#28a745"'), 'Yes edge must have labelfontcolor');

  // metadata must cover every node
  for (const id of graph.nodes.keys()) {
    assert(meta[id]?.fullLabel !== undefined, `nodeData missing for node ${id}`);
    assert(typeof meta[id].anchorRow === 'number', `anchorRow missing for ${id}`);
  }

  // #4 — switch WITH default should NOT have a no-match edge
  const switchNode = [...graph.nodes.values()].find(n => n.kind === 'switch')!;
  const noMatchEdges = graph.edges.filter(e => e.from === switchNode.id && e.label === 'no match');
  assert(noMatchEdges.length === 0, 'switch with default should not have a no-match edge');

  // render via real Graphviz WASM
  const gv = await Graphviz.load();
  const svg = gv.dot(dot, 'svg');
  assert(svg.includes('<svg'), 'must produce valid SVG');
  assert(svg.includes('classify'), 'SVG must contain function name in entry node');
  assert(svg.includes('Buffer overflow check'), 'annotation label must reach the SVG');
  // Graphviz puts id= on <g> elements for nodes with dot id attr
  assert(svg.includes('id="n'), 'SVG must have per-node id attributes for JS lookup');

  console.log('  all improvements verified: OK');
  console.log(`  nodes=${graph.nodes.size}, edges=${graph.edges.length}, SVG=${(svg.length/1024).toFixed(1)}KB`);
}
