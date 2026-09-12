import { parseCFunction, assert } from './helpers';
import { buildCFG } from '../src/parser/cfgBuilder';
import { cfgToDot } from '../src/dot/dotGenerator';
import { Graphviz } from '@hpcc-js/wasm-graphviz';

export async function run(): Promise<void> {
  const fn = await parseCFunction(`
    int classify(int idx, int bufferSize) {
      /** Buffer overflow check */
      if (idx < bufferSize) {
        process(idx);
      } else if (idx == bufferSize) {
        handleEdge();
      } else {
        return -1;
      }
      switch (idx) {
        case 0:
        case 1:
          doSomething();
          break;
        default:
          fallback();
      }
      for (int i = 0; i < bufferSize; i++) {
        if (skip(i)) continue;
        if (stop(i)) break;
      }
      return 0;
    }
  `);
  const graph = buildCFG(fn);
  const dot = cfgToDot(graph);

  assert(dot.startsWith('digraph'), 'dot output must start with "digraph"');
  assert(dot.includes('Buffer overflow check'), 'annotated label must appear in the dot output');

  const graphviz = await Graphviz.load();
  const svg = graphviz.dot(dot, 'svg');
  assert(svg.includes('<svg'), 'Graphviz must produce a valid SVG document from the generated dot source');
  assert(svg.includes('Buffer overflow check'), 'the annotated label must survive into the rendered SVG');

  console.log('  dot generation + real Graphviz render: OK');
}
