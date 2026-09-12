import { parseCFunction } from './helpers';
import { buildCFG } from '../src/parser/cfgBuilder';
import { cfgToDot, prepareDotForLayout, extractNodeMetadata, extractEdgeMetadata } from '../src/dot/dotGenerator';
import { renderSvgWithEngine } from '../src/export/svgRenderer';
import { parsePositionsFromSvg } from '../src/layout/positionParser';

export async function run(): Promise<void> {
  const fn = await parseCFunction(`
    void Predictor_Process(Predictor *predictor) {
        switch (predictor->state) {
            case STATE_INIT:
                if (check_motor_stopped()) { initialise_threads(); }
                if (TimerEnd(t, DELAY)) { predictor->state = STATE_GET; }
                else { stop_prediction_timeout(); }
                break;
            case STATE_AVAILABLE:
                if (!check_active()) break;
                if (predictor->update_required) { predictor->state = STATE_UPDATE; }
                else { stop_prediction(); }
                break;
            case STATE_VALIDATE:
                CommutationTimer();
                if (wait_disabled()) { make_sure_disable(); }
                break;
        }
    }`);

  const graph = buildCFG(fn);
  console.log(`  Graph: ${graph.nodes.size} nodes, ${graph.edges.length} edges`);

  const dot = cfgToDot(graph, 'comment');
  for (const layout of ['vertical','horizontal','radial'] as const) {
    const { dot: ld, engine } = prepareDotForLayout(dot, layout);
    const svg = await renderSvgWithEngine(ld, engine);
    const pos = parsePositionsFromSvg(svg);
    const ys  = Object.values(pos).map(p => p.y);
    const all = Object.keys(pos).length === graph.nodes.size;
    console.log(`    ${layout} (${engine}): ${Object.keys(pos).length}/${graph.nodes.size} nodes${all?'':' ⚠ MISSING'}, y-span=${(Math.max(...ys)-Math.min(...ys)).toFixed(0)}`);
    if (!all) throw new Error(`${layout}: only ${Object.keys(pos).length} of ${graph.nodes.size} positions parsed`);
  }

  const caseEdges = extractEdgeMetadata(graph).filter(e => e.kind === 'case');
  console.log(`    Case edges: ${caseEdges.map(e => `"${e.label}"`).join(', ')}`);
  if (!caseEdges.every(e => e.label)) throw new Error('Case edge missing label');

  const nodeData = extractNodeMetadata(graph);
  const multi = Object.values(nodeData).find(m => m.kind === 'process' && (m.codeLines?.length ?? 0) > 1);
  if (!multi) { console.log('    (no multi-line process node in this function - OK)'); }
  if (multi) console.log(`    Multi-line node: ${multi.codeLines?.length} lines`);
  console.log('  Full pipeline (CFG→dot→positions×3 layouts + edge labels): OK');
}
