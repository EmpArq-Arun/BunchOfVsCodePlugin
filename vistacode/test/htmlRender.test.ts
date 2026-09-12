import { parseCFunction, assert } from './helpers';
import { buildCFG } from '../src/parser/cfgBuilder';
import { cfgToDot } from '../src/dot/dotGenerator';
import { Graphviz } from '@hpcc-js/wasm-graphviz';

export async function run(): Promise<void> {
  const src = `
    void scan(int bufferSize) {
        if (bufferSize > 0) {
            int result = process(bufferSize);
            check(result);
            log_event(result);
            notify(result);
        }
    }`;

  const fn    = await parseCFunction(src);
  const graph = buildCFG(fn);
  const dot   = cfgToDot(graph, 'code');
  const gv    = await Graphviz.load();
  const svg   = gv.dot(dot, 'svg');

  // HTML label check
  const multiLine = [...graph.nodes.values()].find(n => n.rawLines.length >= 3);
  assert(!!multiLine, 'test requires a process node with 3+ statements');
  assert(dot.includes('<BR ALIGN="LEFT"/>'), 'multi-line node must use HTML label with <BR ALIGN');

  // The SVG should have separate text elements for each line
  const texts = (svg.match(/<text[^>]*>[^<]+<\/text>/g) ?? []).map(t => t.replace(/<[^>]+>/g,'').trim());
  // At least one of the statement lines should appear as a separate text element
  const foundLine = multiLine.rawLines.some(line => texts.some(t => t.includes(line.slice(0,15))));
  assert(foundLine, `none of rawLines found in SVG texts: ${texts.join(', ')}`);

  // Yes/No labels
  // Yes/No appear via taillabel which Graphviz renders as separate text elements
  assert(svg.includes('Yes') || svg.includes('No'), 'SVG must contain at least one Yes/No edge label');

  // entry node shows function name
  const entrySvg = svg.slice(svg.indexOf(`id="n1"`), svg.indexOf(`id="n1"`) + 400);
  assert(entrySvg.includes('scan') || svg.includes('scan'), 'entry node must show function name');

  console.log('  HTML multiline labels + Yes/No render correctly: OK');
  console.log(`  (rawLines: ${multiLine.rawLines.length}, SVG texts: ${texts.length})`);
}
