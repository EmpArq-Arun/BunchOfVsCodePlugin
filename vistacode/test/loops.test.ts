import { parseCFunction, assert } from './helpers';
import { buildCFG } from '../src/parser/cfgBuilder';

export async function run(): Promise<void> {
  const fn = await parseCFunction(`
    void scan(int n) {
      for (int i = 0; i < n; i++) {
        if (skip(i)) {
          continue;
        }
        if (stop(i)) {
          break;
        }
        use(i);
      }
    }
  `);
  const g = buildCFG(fn);

  const loopNodes = [...g.nodes.values()].filter((n) => n.kind === 'loop');
  assert(loopNodes.length === 1, `expected 1 loop node, got ${loopNodes.length}`);
  const loopId = loopNodes[0].id;

  // continue must NOT target the loop condition directly — it must target the update step.
  const continueEdges = g.edges.filter((e) => e.kind === 'continue');
  assert(continueEdges.length === 1, `expected 1 continue edge, got ${continueEdges.length}`);
  assert(continueEdges[0].to !== loopId, 'continue in a for-loop must target the update step, not the condition directly');

  // that update-step target must itself loop back to the condition.
  const updateId = continueEdges[0].to;
  const loopBackFromUpdate = g.edges.find((e) => e.from === updateId && e.kind === 'loop-back');
  assert(!!loopBackFromUpdate && loopBackFromUpdate.to === loopId, 'update step must loop back to the condition');

  // break must route to the loop's false-edge merge point, i.e. exit eventually, not loop back.
  const breakEdges = g.edges.filter((e) => e.kind === 'break');
  assert(breakEdges.length === 1, `expected 1 break edge, got ${breakEdges.length}`);
  const breakTarget = breakEdges[0].to;
  const falseEdge = g.edges.find((e) => e.from === loopId && e.kind === 'false');
  assert(!!falseEdge, 'expected a false edge out of the loop condition');
  assert(breakTarget === falseEdge!.to, 'break must merge into the same node the loop\'s false-edge flows to');

  // --- while loop: continue SHOULD target the condition directly (no update step) ---
  const fn2 = await parseCFunction(`
    void waitLoop() {
      while (x < 10) {
        if (skip()) {
          continue;
        }
        x++;
      }
    }
  `);
  const g2 = buildCFG(fn2);
  const loop2 = [...g2.nodes.values()].find((n) => n.kind === 'loop')!;
  const continueEdge2 = g2.edges.find((e) => e.kind === 'continue')!;
  assert(continueEdge2.to === loop2.id, 'continue in a while-loop must target the condition directly');

  console.log('  for/while + break/continue: OK');
}
