import * as path from 'path';
import { CompileCommandsDb } from '../src/semantic/compileCommands';
import { enrichCallGraph, SemanticEngineConfig, ClassLookup } from '../src/semantic/semanticEnrichment';
import { CallGraphData, FunctionNode } from '../src/types';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ok  - ${label}`);
  else {
    console.log(`FAIL  - ${label}`);
    failures++;
  }
}

const FIXTURES = path.join(__dirname, 'fixtures');

function fn(name: string, file: string, line: number, opts: Partial<FunctionNode> = {}): FunctionNode {
  return {
    id: `${file}:${line}`,
    name,
    location: { file, line, column: 1 },
    signature: `${name}()`,
    active: true,
    ...opts,
  };
}

async function main() {
  const db = CompileCommandsDb.load(path.join(FIXTURES, 'compile_commands.json'));
  if (!db) throw new Error('failed to load fixture compile_commands.json');

  const cfg: SemanticEngineConfig = {
    clangBinary: 'clang++',
    compileCommandsDb: db,
    workspaceRoot: FIXTURES,
    maxCallerConfirmations: 10,
    timeoutMs: 8000,
  };

  // ---------------------------------------------------------------------
  console.log('\n[1] CompileCommandsDb.argsFor strips -c/-o, keeps -std/-I');
  {
    const args = db.argsFor(path.join(FIXTURES, 'proj', 'main.cpp'));
    check('args resolved', !!args);
    if (args) {
      check('keeps -std=c++17', args.includes('-std=c++17'));
      check('keeps -I include path', args.some((a) => a.startsWith('-I')));
      check('drops -c', !args.includes('-c'));
      check('drops -o and its filename', !args.includes('-o') && !args.includes('main.o'));
      check('drops the original source file (caller supplies it separately)', !args.includes(path.join(FIXTURES, 'proj', 'main.cpp')));
    }
  }

  // ---------------------------------------------------------------------
  console.log('\n[2] enrichCallGraph confirms a genuine edge and flags a fabricated one as unconfirmed');
  {
    const computeNode = fn('compute', 'sample.cpp', 5);
    const helperNode = fn('helper', 'sample.cpp', 1);
    const fakeNode = fn('totally_unrelated_name', 'sample.cpp', 999, { name: 'totally_unrelated_name' });

    const graph: CallGraphData = {
      rootId: computeNode.id,
      nodes: { [computeNode.id]: computeNode, [helperNode.id]: helperNode, [fakeNode.id]: fakeNode },
      edges: [
        { callerId: computeNode.id, calleeId: helperNode.id, kind: 'direct', callSite: { file: 'sample.cpp', line: 7, column: 1 } },
        // fabricated: compute() does not actually call this — heuristic false positive simulation
        { callerId: computeNode.id, calleeId: fakeNode.id, kind: 'direct', callSite: { file: 'sample.cpp', line: 7, column: 1 } },
      ],
      mode: 'heuristic',
      nodeDepths: { [computeNode.id]: 0, [helperNode.id]: 1, [fakeNode.id]: 1 },
      computedDepth: 1,
      defaultDepth: 5,
      truncated: false,
    };

    const classLookup: ClassLookup = { getAllClasses: () => [] };
    const enriched = await enrichCallGraph(graph, classLookup, cfg);

    check('semanticEnrichmentApplied flag set', enriched.semanticEnrichmentApplied === true);
    const realEdge = enriched.edges.find((e) => e.calleeId === helperNode.id)!;
    const fakeEdge = enriched.edges.find((e) => e.calleeId === fakeNode.id)!;
    check('real compute()->helper() edge confirmed', realEdge.confirmed === true);
    check('fabricated edge marked unconfirmed, NOT dropped', fakeEdge.confirmed === false && enriched.edges.length === 2);
  }

  // ---------------------------------------------------------------------
  console.log('\n[3] enrichCallGraph confirms a caller-side edge too (incoming direction)');
  {
    const helperNode = fn('helper', 'sample.cpp', 1);
    const computeNode = fn('compute', 'sample.cpp', 5);

    const graph: CallGraphData = {
      rootId: helperNode.id,
      nodes: { [helperNode.id]: helperNode, [computeNode.id]: computeNode },
      edges: [
        { callerId: computeNode.id, calleeId: helperNode.id, kind: 'direct', callSite: { file: 'sample.cpp', line: 7, column: 1 } },
      ],
      mode: 'heuristic',
      nodeDepths: { [helperNode.id]: 0, [computeNode.id]: 1 },
      computedDepth: 1,
      defaultDepth: 5,
      truncated: false,
    };

    const classLookup: ClassLookup = { getAllClasses: () => [] };
    const enriched = await enrichCallGraph(graph, classLookup, cfg);
    check('compute() confirmed as a real caller of helper()', enriched.edges[0].confirmed === true);
  }

  // ---------------------------------------------------------------------
  console.log('\n[4] Virtual dispatch candidates generated for a confirmed-polymorphic class hierarchy');
  {
    const shapeArea = fn('area', 'sample.cpp', 13, { className: 'Shape', isVirtual: true, qualifiedName: 'Shape::area' });
    const circleArea = fn('area', 'sample.cpp', 18, { className: 'Circle', qualifiedName: 'Circle::area' });
    const callerNode = fn('user_code', 'sample.cpp', 30);

    const graph: CallGraphData = {
      rootId: shapeArea.id,
      nodes: { [shapeArea.id]: shapeArea, [callerNode.id]: callerNode },
      edges: [
        { callerId: callerNode.id, calleeId: shapeArea.id, kind: 'direct', callSite: { file: 'sample.cpp', line: 31, column: 1 } },
      ],
      mode: 'heuristic',
      nodeDepths: { [shapeArea.id]: 0, [callerNode.id]: 1 },
      computedDepth: 1,
      defaultDepth: 5,
      truncated: false,
    };

    const classLookup: ClassLookup = {
      getAllClasses: () => [
        { name: 'Shape', bases: [], methods: [shapeArea] },
        { name: 'Circle', bases: ['Shape'], methods: [circleArea] },
      ],
    };

    const enriched = await enrichCallGraph(graph, classLookup, cfg);
    check('Circle::area added as a node', !!enriched.nodes[circleArea.id]);
    check('Circle::area marked virtualConfirmed', enriched.nodes[circleArea.id]?.virtualConfirmed === true);
    const candidateEdge = enriched.edges.find((e) => e.kind === 'virtualCandidate' && e.calleeId === circleArea.id);
    check('virtualCandidate edge from user_code() to Circle::area added', !!candidateEdge);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
