import { parseCFunction, assert } from './helpers';
import { buildCFG } from '../src/parser/cfgBuilder';

export async function run(): Promise<void> {
  // --- if / else if / else ---
  const fn1 = await parseCFunction(`
    int classify(int idx, int bufferSize) {
      /** Buffer overflow check */
      if (idx < bufferSize) {
        process(idx);
      } else if (idx == bufferSize) {
        handleEdge();
      } else {
        return -1;
      }
      return 0;
    }
  `);
  const g1 = buildCFG(fn1);

  const decisionNodes = [...g1.nodes.values()].filter((n) => n.kind === 'decision');
  assert(decisionNodes.length === 2, `expected 2 decision nodes, got ${decisionNodes.length}`);

  const annotated = decisionNodes.find((n) => n.labelFromAnnotation);
  assert(!!annotated, 'expected one decision node to carry the comment annotation');
  assert(annotated!.label === 'Buffer overflow check', `unexpected annotated label: "${annotated!.label}"`);

  const trueEdges = g1.edges.filter((e) => e.kind === 'true');
  const falseEdges = g1.edges.filter((e) => e.kind === 'false');
  assert(trueEdges.length === 2, `expected 2 true edges, got ${trueEdges.length}`);
  assert(falseEdges.length === 2, `expected 2 false edges, got ${falseEdges.length}`);

  // every node must be reachable from entry (no orphans) — quick sanity walk
  const reachable = new Set<string>([g1.entryId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of g1.edges) {
      if (reachable.has(e.from) && !reachable.has(e.to)) {
        reachable.add(e.to);
        changed = true;
      }
    }
  }
  assert(reachable.has(g1.exitId), 'exit node must be reachable');
  for (const n of g1.nodes.values()) {
    assert(reachable.has(n.id), `node ${n.id} ("${n.label}") is unreachable from entry`);
  }

  console.log('  if/else-if/else: OK');
}
