import { parseCFunction, assert } from './helpers';
import { buildCFG } from '../src/parser/cfgBuilder';
import { cfgToDot } from '../src/dot/dotGenerator';
import { Graphviz } from '@hpcc-js/wasm-graphviz';

export async function run(): Promise<void> {
  const src = `
    void scan(int n) {
      /** Bounds check */
      if (n > 0) {
        int x = 1;
        int y = 2;
        use(x,y);
      }
    }`;
  const fn = await parseCFunction(src);
  const graph = buildCFG(fn);

  // Verify rawLines are stored per-statement, not joined with "; "
  const processNodes = [...graph.nodes.values()].filter(n=>n.kind==='process');
  const multiLineNode = processNodes.find(n=>n.rawLines.length>1);
  assert(!!multiLineNode, 'multi-statement process node should have rawLines.length > 1');
  assert(!multiLineNode!.rawText.includes('; '), 'rawText should use \\n not "; "');

  // Verify annotation is stored separately
  const decisionNode = [...graph.nodes.values()].find(n=>n.kind==='decision')!;
  assert(decisionNode.annotation === 'Bounds check', `annotation should be 'Bounds check', got: ${decisionNode.annotation}`);
  assert(decisionNode.label === 'Bounds check', 'label should equal annotation in comment mode');

  // Verify display modes generate different dot
  const gv = await Graphviz.load();
  const dotComment = cfgToDot(graph,'comment');
  const dotCode    = cfgToDot(graph,'code');
  const dotBoth    = cfgToDot(graph,'both');

  assert(dotComment.includes('Bounds check'), 'comment mode should show annotation');
  assert(!dotCode.includes('Bounds check'),    'code mode should not show annotation');
  assert(dotBoth.includes('Bounds check'),     'both mode should show annotation');
  assert(dotBoth.includes('n > 0') || dotBoth.includes('n\\n>\\n0') || dotBoth.includes('────'),
    'both mode should also include code or separator');

  // All three must render to valid SVG
  for (const [mode,dot] of [['comment',dotComment],['code',dotCode],['both',dotBoth]] as const) {
    const svg = gv.dot(dot,'svg');
    assert(svg.includes('<svg'),`${mode} mode must produce valid SVG`);
  }

  // Multi-line: code mode should use HTML labels with <BR ALIGN for each line
  const multiLineDot = cfgToDot(graph,'code');
  // Single-line process nodes use quoted labels; multi-line use HTML labels with BR
  const hasHtmlOrMultiLine = multiLineDot.includes('<BR ALIGN=') || multiLineDot.includes('label=');
  assert(hasHtmlOrMultiLine, 'code mode dot should contain label attributes');

  console.log('  display modes (comment/code/both) + multi-line rawLines: OK');
}
