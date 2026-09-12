import { parseCFunction, assert } from './helpers';
import { buildCFG } from '../src/parser/cfgBuilder';

export async function run(): Promise<void> {
  const fn = await parseCFunction(`
    void route(int idx) {
      switch (idx) {
        case 0:
        case 1:
          doSomething();
          break;
        case 2:
          doOther();
        default:
          fallback();
      }
    }
  `);
  const g = buildCFG(fn);

  const switchNode = [...g.nodes.values()].find((n) => n.kind === 'switch');
  assert(!!switchNode, 'expected a switch node');

  // case 0, case 1, case 2, and default each get their own direct edge from the switch node
  // (a real possible jump target for some value of idx) — 4 total, not 3.
  const caseEdges = g.edges.filter((e) => e.from === switchNode!.id && e.kind === 'case');
  assert(caseEdges.length === 4, `expected 4 "case" edges out of the switch node (0, 1, 2, default), got ${caseEdges.length}`);
  const case0 = caseEdges.find((e) => e.label === '0');
  const case1 = caseEdges.find((e) => e.label === '1');
  const caseDefault = caseEdges.find((e) => e.label === 'default');
  assert(!!case0 && !!case1, 'expected case 0 and case 1 edges');
  assert(!!caseDefault, 'expected a default-case edge');
  assert(case0!.to === case1!.to, 'empty "case 0:" must fall through to the same node as "case 1:"');

  // case 2 has no break, so it must ALSO fall through into "default" via a `fallthrough` edge.
  const fallthroughEdges = g.edges.filter((e) => e.kind === 'fallthrough');
  assert(fallthroughEdges.length === 1, `expected exactly 1 fallthrough edge (case 2 -> default), got ${fallthroughEdges.length}`);
  assert(fallthroughEdges[0].to === caseDefault!.to, 'case 2 must fall through into the same node default\'s case-edge targets');

  // the case-0/1 group ends with `break;`, which must route to the switch's overall exit,
  // same merge point as wherever default's fall-off-the-end goes.
  const breakEdges = g.edges.filter((e) => e.kind === 'break');
  assert(breakEdges.length === 1, `expected 1 break edge, got ${breakEdges.length}`);

  console.log('  switch fallthrough/default: OK');
}
