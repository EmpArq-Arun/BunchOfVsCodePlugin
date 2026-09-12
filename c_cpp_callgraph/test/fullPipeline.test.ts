import * as path from 'path';
import { WorkspaceIndex } from '../src/parser/workspaceIndex';
import { buildCallGraph } from '../src/parser/heuristicGraphBuilder';
import { CompileCommandsDb } from '../src/semantic/compileCommands';
import { enrichCallGraph, SemanticEngineConfig } from '../src/semantic/semanticEnrichment';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ok  - ${label}`);
  else {
    console.log(`FAIL  - ${label}`);
    failures++;
  }
}

const FIXTURES = path.join(__dirname, 'fixtures');

async function main() {
  // Mirrors test/fixtures/proj/main.cpp + util.cpp via the mock vscode fs,
  // matching exactly what's registered in test/fixtures/compile_commands.json.
  (global as any).__mockFiles = {
    'sample.cpp': require('fs').readFileSync(path.join(FIXTURES, 'sample.cpp'), 'utf8'),
  };

  const index = new WorkspaceIndex();
  await index.ensureFresh();

  const allFns = index.getAllFunctions();
  const computeFn = allFns.find((f) => f.name === 'compute');
  check('heuristic engine found compute()', !!computeFn);
  if (!computeFn) {
    process.exit(1);
  }

  const heuristicGraph = buildCallGraph(index, computeFn.id, 5, 500);
  check('heuristic graph includes helper as a callee of compute', Object.values(heuristicGraph.nodes).some((n) => n.name === 'helper'));
  check('heuristic edges have no confirmed flag yet', heuristicGraph.edges.every((e) => e.confirmed === undefined));

  const db = CompileCommandsDb.load(path.join(FIXTURES, 'compile_commands.json'));
  if (!db) throw new Error('fixture compile_commands.json failed to load');

  const cfg: SemanticEngineConfig = {
    clangBinary: 'clang++',
    compileCommandsDb: db,
    workspaceRoot: FIXTURES,
    maxCallerConfirmations: 10,
    timeoutMs: 8000,
  };

  const enriched = await enrichCallGraph(heuristicGraph, index, cfg);

  check('semanticEnrichmentApplied set on the real pipeline output', enriched.semanticEnrichmentApplied === true);

  const helperNode = Object.values(enriched.nodes).find((n) => n.name === 'helper')!;
  const edgeToHelper = enriched.edges.find((e) => e.callerId === computeFn.id && e.calleeId === helperNode.id);
  check('compute()->helper() edge survived enrichment and is confirmed', edgeToHelper?.confirmed === true);

  const recursiveEdge = enriched.edges.find((e) => e.callerId === computeFn.id && e.calleeId === computeFn.id);
  check('recursive compute()->compute() edge also confirmed', recursiveEdge?.confirmed === true);

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
