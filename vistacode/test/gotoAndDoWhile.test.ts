import { parseCFunction, assert } from './helpers';
import { buildCFG } from '../src/parser/cfgBuilder';

export async function run(): Promise<void> {
  // forward goto: label is defined AFTER the goto that jumps to it
  const fn = await parseCFunction(`
    int retryLoop() {
      int attempts = 0;
    retry:
      attempts++;
      if (attempts < 3) {
        goto retry;
      }
      return attempts;
    }
  `);
  const g = buildCFG(fn);

  const labelNode = [...g.nodes.values()].find((n) => n.kind === 'label');
  assert(!!labelNode, 'expected a label node for "retry:"');

  const gotoEdges = g.edges.filter((e) => e.kind === 'goto');
  assert(gotoEdges.length === 1, `expected 1 goto edge, got ${gotoEdges.length}`);
  assert(gotoEdges[0].to === labelNode!.id, 'goto must resolve to the label node, including backward jumps');

  // --- forward goto: jump to a label defined later ---
  const fn2 = await parseCFunction(`
    void f(int x) {
      if (x < 0) {
        goto bail;
      }
      use(x);
    bail:
      cleanup();
    }
  `);
  const g2 = buildCFG(fn2);
  const label2 = [...g2.nodes.values()].find((n) => n.kind === 'label')!;
  const gotoEdge2 = g2.edges.find((e) => e.kind === 'goto')!;
  assert(gotoEdge2.to === label2.id, 'forward goto must resolve to the later-defined label');

  // --- do-while loop-back target ---
  const fn3 = await parseCFunction(`
    void drain() {
      do {
        step();
      } while (hasMore());
    }
  `);
  const g3 = buildCFG(fn3);
  const loopBack = g3.edges.find((e) => e.kind === 'loop-back')!;
  assert(!!loopBack, 'expected a loop-back edge in do-while');
  const condNode = [...g3.nodes.values()].find((n) => n.kind === 'loop')!;
  assert(loopBack.from === condNode.id, 'do-while loop-back must originate from the condition node');
  assert(loopBack.to !== condNode.id, 'do-while loop-back must target the start of the body, not itself');

  console.log('  goto/labels + do-while: OK');
}
