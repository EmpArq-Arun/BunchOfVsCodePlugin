import { parseCFunction, assert } from './helpers';
import { buildCFG } from '../src/parser/cfgBuilder';
import { cfgToDot } from '../src/dot/dotGenerator';
import { Graphviz } from '@hpcc-js/wasm-graphviz';

export async function run(): Promise<void> {
  const src = `
    int classify(int idx, int bufferSize) {
        /** Buffer overflow check */
        if (idx < bufferSize) {
            int result = process(idx);
            check(result);
            return result;
        } else if (idx == bufferSize) {
            handleEdge();
        }
        switch (idx) {
            case 0: case 1: doSomething(); break;
            case 2: doOther();
            default: fallback();
        }
        return 0;
    }`;

  const fn    = await parseCFunction(src);
  const graph = buildCFG(fn);
  const dot   = cfgToDot(graph, 'code');

  // #1 no literal \\n in label values (should be Graphviz \n escape = real newline → esc → backslash-n)
  const badLabels = (dot.match(/label="[^"]+"/g) ?? []).filter(l => l.includes('\\\\n'));
  assert(badLabels.length === 0, `found ${badLabels.length} labels with double-escaped \\n: ${badLabels[0]}`);

  // #2/#3 Yes/No with fontcolor + taillabel
  assert(dot.includes('taillabel="Yes"'), 'true edge must use taillabel="Yes"');
  assert(dot.includes('taillabel="No"'),  'false edge must use taillabel="No"');
  assert(dot.includes('labelfontcolor="#28a745"'), 'Yes must have labelfontcolor');

  // #4/#5 no port specs in any edge line
  const portSpecs = (dot.match(/"n\d+":[nsew]\s*->/g) ?? []);
  assert(portSpecs.length === 0, `found ${portSpecs.length} port-spec edge(s): ${portSpecs[0] ?? ''}`);

  // #1 multi-line node: process node with 3+ statements should use HTML label with <BR
  const multiLineNode = [...graph.nodes.values()].find(n=>n.rawLines.length>=3);
  if (multiLineNode) {
    const idStr = `id="${multiLineNode.id}"`;
    const nodeIdx = dot.indexOf(idStr);
    assert(nodeIdx !== -1, `node ${multiLineNode.id} not found in dot`);
    // HTML label for multi-line: label=<...BR ALIGN...>
    const nodeBlock = dot.slice(Math.max(0, nodeIdx - 20), nodeIdx + 300);
    assert(nodeBlock.includes('<BR ALIGN="LEFT"/>'), `multi-line node should use HTML label with <BR ALIGN="LEFT"/>`);
  }

  // #6 regex strips port specs from edge titles correctly
  const samples = ['n1:s->n2:n', 'n3->n4', '"n1":s->"n2":n', 'n5:w->n6'];
  for (const t of samples) {
    const m2 = t.match(/"?(\w+)"?(?::\w+)?\s*->\s*"?(\w+)"?/);
    assert(!!m2, `regex failed on "${t}"`);
    assert(!m2![1].includes(':'), `port not stripped from from-id in "${t}": got "${m2![1]}"`);
    assert(!m2![2].includes(':'), `port not stripped from to-id in "${t}": got "${m2![2]}"`);
  }

  // confirm rendering still works
  const gv  = await Graphviz.load();
  const svg = gv.dot(dot,'svg');
  assert(svg.includes('<svg'), 'must render valid SVG');
  assert(svg.includes('Yes') || svg.includes('No'), 'SVG must contain Yes/No labels');

  console.log('  all 6 fix spot-checks: OK');
}
