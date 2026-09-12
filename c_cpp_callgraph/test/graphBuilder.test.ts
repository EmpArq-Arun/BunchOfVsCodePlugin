import { buildCallGraph } from '../src/parser/heuristicGraphBuilder';
import { FunctionNode, CallEdge } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ok  - ${label}`);
  else {
    console.log(`FAIL  - ${label}`);
    failures++;
  }
}

function fn(id: string): FunctionNode {
  return {
    id,
    name: id,
    location: { file: 'test.c', line: 1, column: 1 },
    signature: `void ${id}()`,
    active: true,
  };
}

function edge(callerId: string, calleeId: string, kind: CallEdge['kind'] = 'direct'): CallEdge {
  return { callerId, calleeId, kind, callSite: { file: 'test.c', line: 1, column: 1 } };
}

// Graph shape:
//   D -> root -> A -> B -> C -> A   (cycle: A <-> C via B)
//                A -> X (pointer call)
const nodes: Record<string, FunctionNode> = Object.fromEntries(
  ['root', 'A', 'B', 'C', 'D', 'X'].map((id) => [id, fn(id)]),
);

const edges: CallEdge[] = [
  edge('D', 'root'),
  edge('root', 'A'),
  edge('A', 'B'),
  edge('B', 'C'),
  edge('C', 'A'), // cycle back to A
  edge('A', 'X', 'pointer'),
];

const outgoing = new Map<string, CallEdge[]>();
const incoming = new Map<string, CallEdge[]>();
for (const e of edges) {
  (outgoing.get(e.callerId) ?? outgoing.set(e.callerId, []).get(e.callerId)!).push(e);
  (incoming.get(e.calleeId) ?? incoming.set(e.calleeId, []).get(e.calleeId)!).push(e);
}

const mockIndex = {
  getFunction: (id: string) => nodes[id],
  getOutgoing: (id: string) => outgoing.get(id) ?? [],
  getIncoming: (id: string) => incoming.get(id) ?? [],
} as any;

// ---------------------------------------------------------------------------
console.log('\n[1] Depth-bounded BFS in both directions, with per-node depth tracking');
{
  const g = buildCallGraph(mockIndex, 'root', 20, 500);
  check('root included at depth 0', g.nodeDepths['root'] === 0);
  check('D (caller) found at depth 1', g.nodeDepths['D'] === 1);
  check('A (callee) found at depth 1', g.nodeDepths['A'] === 1);
  check('B found at depth 2', g.nodeDepths['B'] === 2);
  check('C found at depth 3', g.nodeDepths['C'] === 3);
  check('X (pointer callee of A) found at depth 2', g.nodeDepths['X'] === 2);
  check('pointer edge A->X kept with kind=pointer', g.edges.some((e) => e.callerId === 'A' && e.calleeId === 'X' && e.kind === 'pointer'));
  check('did not infinite-loop on the A<->C cycle (terminated, finite edge count)', g.edges.length === edges.length);
  check('cycle-closing edge C->A is present exactly once', g.edges.filter((e) => e.callerId === 'C' && e.calleeId === 'A').length === 1);
}

// ---------------------------------------------------------------------------
console.log('\n[2] Shallow depth limits how far the graph extends');
{
  const g = buildCallGraph(mockIndex, 'root', 1, 500);
  check('depth=1 includes A and D but not B/C', 'A' in g.nodes && 'D' in g.nodes && !('B' in g.nodes) && !('C' in g.nodes));
  check('computedDepth reported as 1', g.computedDepth === 1);
}

// ---------------------------------------------------------------------------
console.log('\n[3] maxVisibleNodes caps growth and sets truncated=true');
{
  const g = buildCallGraph(mockIndex, 'root', 20, 2); // root + 1 more, then cap
  check('node count respects the cap', Object.keys(g.nodes).length <= 2);
  check('truncated flag set', g.truncated === true);
}

// ---------------------------------------------------------------------------
console.log('\n[4] Unknown root throws a clear error rather than silently returning empty');
{
  let threw = false;
  try {
    buildCallGraph(mockIndex, 'does-not-exist', 5, 500);
  } catch {
    threw = true;
  }
  check('throws on unknown root id', threw);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
