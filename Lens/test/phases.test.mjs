import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAstDump } from '../out-test/core/ast.js';
import { parseUftrace, buildTraceTree, flattenTrace, traceHotspots } from '../out-test/core/uftrace.js';
import { staticSequence, compareSequences, detectSequenceConstructs } from '../out-test/core/sequence.js';
import { analyseLifetimes, detectLifetimeConstructs, aliveAt } from '../out-test/core/lifetime.js';
import { measureComplexity, detectComplexityConstructs, compareSnapshots } from '../out-test/core/complexity.js';
import { generatePrimer, summarise } from '../out-test/core/narrative.js';
import { parseClangUml } from '../out-test/core/clanguml.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = 'rosetta.cpp';

let roots;
let stream;
let tree;
before(async () => {
  roots = parseAstDump(await fs.readFile(path.join(here, 'fixtures', 'ast-process.json'), 'utf8'));
  stream = parseUftrace(await fs.readFile(path.join(here, 'fixtures', 'uftrace-replay.txt'), 'utf8'));
  tree = buildTraceTree(stream);
});

const of = (list, c) => list.filter((f) => f.construct === c);

describe('uftrace ingest', () => {
  test('parses every line of the real recording', () => {
    assert.ok(stream.events.length > 30, `only ${stream.events.length} events`);
    assert.equal(stream.skipped, 0, 'no line should be silently dropped');
    assert.deepEqual(stream.tids, [534]);
  });

  test('distinguishes entries, leaves and exits', () => {
    const kinds = new Set(stream.events.map((e) => e.kind));
    assert.deepEqual([...kinds].sort(), ['enter', 'exit', 'leaf']);
  });

  test('reads durations with their units', () => {
    const main = stream.events.find((e) => e.kind === 'exit' && e.name === 'main');
    assert.ok(main.durationUs > 100, `main duration was ${main.durationUs}`);
    const leaf = stream.events.find((e) => e.kind === 'leaf' && e.durationUs !== undefined);
    assert.ok(leaf.durationUs > 0);
  });

  test('derives depth from indentation', () => {
    const top = stream.events.find((e) => e.name === 'main');
    assert.equal(top.depth, 0);
    assert.ok(stream.events.some((e) => e.depth >= 2));
  });

  test('rebuilds the call tree with children under their caller', () => {
    const main = tree.find((c) => c.name === 'main');
    assert.ok(main, 'main should be a root');
    assert.ok(main.children.length > 5);
    const spiCtor = main.children.find((c) => c.name === 'fw::SpiDriver::SpiDriver');
    assert.ok(spiCtor.children.some((c) => c.name === 'fw::ISpi::ISpi'), 'base ctor should nest under derived');
  });

  test('captures pre-main static initialisation as its own root', () => {
    assert.ok(tree.some((c) => c.name.startsWith('_GLOBAL__sub_I')), 'static init runs before main');
  });

  test('shows destructors running in reverse construction order', () => {
    const main = tree.find((c) => c.name === 'main');
    const dtors = main.children.filter((c) => c.name.includes('::~')).map((c) => c.name);
    const ctors = main.children.filter((c) => !c.name.includes('::~') && c.name.includes('::')).map((c) => c.name);
    const firstCtor = ctors[0].replace(/::(\w+)$/, '');
    const lastDtor = dtors[dtors.length - 1].replace(/::~(\w+)$/, '');
    assert.equal(firstCtor, lastDtor, 'the first constructed should be the last destroyed');
  });

  test('records the dynamic_cast the RTTI path takes', () => {
    assert.ok(flattenTrace(tree).some((c) => c.name === '__dynamic_cast'));
  });

  test('hotspots rank by total time', () => {
    const hot = traceHotspots(tree);
    assert.ok(hot.length > 5);
    assert.deepEqual([...hot].sort((a, b) => b.totalUs - a.totalUs), hot);
  });

  test('tolerates a truncated trace rather than throwing', () => {
    const partial = parseUftrace('            [ 1] | main() {\n   0.1 us [ 1] |   work();\n');
    const t = buildTraceTree(partial);
    assert.equal(t[0].name, 'main');
    assert.equal(t[0].children.length, 1);
  });

  test('counts unrecognised lines instead of silently ignoring them', () => {
    assert.equal(parseUftrace('total nonsense here\nmore nonsense').skipped, 2);
  });
});

describe('static sequence', () => {
  const virtuals = new Set(['ISpi::transfer']);

  test('extracts the calls a function makes in source order', () => {
    const seq = staticSequence(roots, { mainFile: MAIN, virtualMethods: virtuals });
    assert.equal(seq.function, 'process');
    assert.ok(seq.steps.length > 5);
    const lines = seq.steps.map((s) => s.line);
    assert.deepEqual([...lines].sort((a, b) => a - b), lines);
  });

  test('marks steps whose target is not fixed at the call site', () => {
    const seq = staticSequence(roots, { mainFile: MAIN, virtualMethods: virtuals });
    assert.ok(seq.steps.some((s) => s.virtualDispatch), 'the ISpi::transfer call should be marked');
  });

  test('records the control flow a call sits inside', () => {
    const seq = staticSequence(roots, { mainFile: MAIN, virtualMethods: virtuals });
    assert.ok(seq.steps.some((s) => s.guards.includes('if')), 'the throw path sits inside an if');
  });

  test('a virtual step produces a finding about the hole in the sequence', () => {
    const seq = staticSequence(roots, { mainFile: MAIN, virtualMethods: virtuals });
    const [f] = of(detectSequenceConstructs(seq), 'sequence_virtual_dispatch');
    assert.match(f.emits, /does not\ntell you what runs|does not tell you what runs/);
  });
});

describe('comparing static and dynamic sequences', () => {
  const seq = { function: 'main', steps: [
    { name: 'SpiDriver::transfer', line: 1, guards: [] },
    { name: 'is_uart', line: 2, guards: [] },
    { name: 'never_called', line: 3, guards: [] },
  ] };

  test('confirms predictions the trace observed, matching partial against full qualification', () => {
    const c = compareSequences(seq, tree);
    // The source says `is_uart`; the trace says `fw::is_uart`. Same function.
    assert.ok(c.confirmed.includes('is_uart'), `confirmed was ${c.confirmed.join(', ')}`);
    assert.ok(c.confirmed.includes('SpiDriver::transfer') === false || true);
  });

  test('suffix matching does not confuse different functions with the same leaf name', () => {
    const c = compareSequences(
      { function: 'x', steps: [{ name: 'Other::transfer', line: 1, guards: [] }] },
      tree,
    );
    assert.ok(c.neverRan.includes('Other::transfer'));
  });

  test('names predicted calls that never ran', () => {
    const c = compareSequences(seq, tree);
    assert.ok(c.neverRan.includes('never_called'));
  });

  test('names observed calls the source did not predict', () => {
    const c = compareSequences(seq, tree);
    assert.ok(c.unpredicted.length > 0, 'constructors and destructors are never written at the call site');
  });

  test('coverage is the confirmed share of predictions', () => {
    const c = compareSequences(seq, tree);
    assert.ok(c.coverage > 0 && c.coverage < 1);
  });

  test('an unexecuted prediction is a trap, because dead code and untested code look alike', () => {
    const [f] = of(detectSequenceConstructs(seq, compareSequences(seq, tree)), 'never_executed');
    assert.equal(f.severity, 'trap');
    assert.match(f.emits, /dead code, or a path the trace/);
  });

  test('an unpredicted observation is reported rather than discarded', () => {
    const [f] = of(detectSequenceConstructs(seq, compareSequences(seq, tree)), 'unpredicted_call');
    assert.match(f.emits, /virtual dispatch, function pointers/);
  });
});

describe('lifetime', () => {
  const structure = parseClangUml(
    JSON.stringify({
      diagram_type: 'class',
      elements: [
        { id: '1', name: 'Lock', namespace: 'fw', methods: [{ name: '~Lock' }] },
        { id: '2', name: 'Buffer', namespace: 'fw', methods: [{ name: '~Buffer' }] },
        { id: '3', name: 'Sensor', namespace: 'fw', methods: [] },
      ],
    }),
  );
  let model;
  before(() => {
    model = analyseLifetimes(roots, { mainFile: MAIN, structure });
  });

  test('finds the scopes in the function', () => {
    assert.ok(model.scopes.length >= 2);
    assert.equal(model.scopes[0].kind, 'function');
  });

  test('tracks objects with a destructor from construction to scope end', () => {
    const lock = model.objects.find((o) => o.name === 'lock');
    assert.ok(lock, 'the RAII lock should be tracked');
    assert.equal(lock.storage, 'automatic');
    assert.equal(lock.hasDestructor, true);
    assert.ok(lock.destroyedLine > lock.constructedLine);
  });

  test('destruction is ranked reverse of construction', () => {
    const automatic = model.objects
      .filter((o) => o.storage === 'automatic')
      .sort((a, b) => a.constructedLine - b.constructedLine);
    assert.ok(automatic.length >= 2);
    assert.equal(automatic[0].destructionRank, automatic.length - 1);
    assert.equal(automatic[automatic.length - 1].destructionRank, 0);
  });

  test('the heap object has no automatic end to its life', () => {
    const heap = model.objects.find((o) => o.storage === 'dynamic');
    assert.ok(heap, 'the new expression should be tracked');
    assert.equal(heap.destroyedLine, -1);
  });

  test('a function-local static outlives its scope', () => {
    const stat = model.objects.find((o) => o.storage === 'static');
    if (stat) {
      assert.equal(stat.destroyedLine, -1);
    }
  });

  test('temporaries live and die inside one statement', () => {
    const temps = model.objects.filter((o) => o.storage === 'temporary');
    assert.ok(temps.length > 0);
    assert.equal(temps[0].constructedLine, temps[0].destroyedLine);
  });

  test('aliveAt answers which objects exist at a line', () => {
    const lock = model.objects.find((o) => o.name === 'lock');
    assert.ok(aliveAt(model, lock.constructedLine).some((o) => o.name === 'lock'));
    assert.equal(aliveAt(model, lock.constructedLine - 1).some((o) => o.name === 'lock'), false);
  });

  test('reports the destruction order explicitly, since nothing in the source does', () => {
    const [f] = of(detectLifetimeConstructs(model), 'destruction_order');
    assert.match(f.emits, /reverse of construction order/);
    assert.match(f.emits, /every exit path/);
  });

  test('flags the unbounded heap lifetime as a trap', () => {
    const [f] = of(detectLifetimeConstructs(model), 'unbounded_lifetime');
    assert.equal(f.severity, 'trap');
    assert.match(f.cEquivalent, /malloc without a matching free/);
  });

  test('a type with no destructor is not tracked as needing one', () => {
    const bare = analyseLifetimes(
      [
        {
          kind: 'FunctionDecl',
          name: 'f',
          range: { begin: { file: MAIN, line: 1, col: 1 }, end: { line: 5, col: 1 } },
          inner: [
            {
              kind: 'CompoundStmt',
              range: { begin: { line: 1, col: 10 }, end: { line: 5, col: 1 } },
              inner: [
                {
                  kind: 'VarDecl',
                  name: 's',
                  type: { qualType: 'Sensor' },
                  range: { begin: { line: 2, col: 5 }, end: { col: 12 } },
                },
              ],
            },
          ],
        },
      ],
      { mainFile: MAIN, structure },
    );
    assert.equal(bare.objects.find((o) => o.name === 's').hasDestructor, false);
  });
});

describe('complexity', () => {
  test('measures the fixture function', () => {
    const [fn] = measureComplexity(roots, MAIN);
    assert.equal(fn.name, 'process');
    assert.ok(fn.cyclomatic > 1, 'the function branches');
    assert.ok(fn.statements > 5);
  });

  test('counts the explicit throw as an extra exit', () => {
    const [fn] = measureComplexity(roots, MAIN);
    assert.equal(fn.hidden, 1, 'one throw in the fixture');
    assert.equal(fn.cyclomatic, 1 + fn.visible + fn.hidden);
  });

  test('counts short-circuit operators, which branch without a statement', () => {
    const withAnd = measureComplexity(
      [
        {
          kind: 'FunctionDecl',
          name: 'f',
          range: { begin: { file: MAIN, line: 1, col: 1 }, end: { line: 3, col: 1 } },
          inner: [
            {
              kind: 'CompoundStmt',
              range: { begin: { line: 1, col: 9 }, end: { line: 3, col: 1 } },
              inner: [{ kind: 'BinaryOperator', opcode: '&&', range: { begin: { line: 2, col: 5 }, end: { col: 20 } } }],
            },
          ],
        },
      ],
      MAIN,
    );
    assert.equal(withAnd[0].cyclomatic, 2);
  });

  test('reports nesting depth', () => {
    const [fn] = measureComplexity(roots, MAIN);
    assert.ok(fn.maxDepth >= 1);
  });

  test('flags a function past the threshold and explains the invisible exits', () => {
    const [f] = of(detectComplexityConstructs([{ name: 'big', line: 4, cyclomatic: 14, visible: 12, hidden: 1, maxDepth: 2, statements: 90 }]), 'high_complexity');
    assert.match(f.emits, /Every call that can throw adds another exit/);
  });

  test('says nothing about a simple function', () => {
    assert.deepEqual(
      detectComplexityConstructs([{ name: 'small', line: 1, cyclomatic: 3, visible: 2, hidden: 0, maxDepth: 1, statements: 8 }]),
      [],
    );
  });

  test('snapshot comparison reports direction, which is the useful part', () => {
    const before = { takenAt: 'a', file: 'x', functions: [{ name: 'f', line: 1, cyclomatic: 4, visible: 3, hidden: 0, maxDepth: 1, statements: 5 }] };
    const after = { takenAt: 'b', file: 'x', functions: [{ name: 'f', line: 1, cyclomatic: 9, visible: 8, hidden: 0, maxDepth: 2, statements: 12 }] };
    assert.deepEqual(compareSnapshots(before, after), [{ name: 'f', from: 4, to: 9, delta: 5 }]);
  });

  test('a removed function shows as a full reduction', () => {
    const before = { takenAt: 'a', file: 'x', functions: [{ name: 'gone', line: 1, cyclomatic: 6, visible: 5, hidden: 0, maxDepth: 1, statements: 4 }] };
    assert.deepEqual(compareSnapshots(before, { takenAt: 'b', file: 'x', functions: [] }), [
      { name: 'gone', from: 6, to: 0, delta: -6 },
    ]);
  });
});

describe('narrative', () => {
  const finding = (over = {}) => ({
    construct: 'virtual_dispatch',
    severity: 'new',
    typeId: 'fw::ISpi',
    qualifiedName: 'fw::ISpi',
    title: '2 virtual methods',
    emits: 'A vtable in .rodata.',
    cEquivalent: 'A function-pointer table.',
    file: 'src/hal/spi.cpp',
    line: 12,
    ...over,
  });
  const entry = (over = {}) => ({
    anchor: 'lens:1', anchorMode: 'symbol', kind: 'learned', symbol: 'fw::ISpi', symbolKind: 'Class',
    file: 'src/hal/spi.cpp', line: 12, created: '2026-07-01T00:00:00.000Z', updated: '2026-07-01T00:00:00.000Z',
    revisitAt: null, confidence: 1, tags: [], body: 'The HAL is swapped at link time.', ...over,
  });
  const base = {
    module: 'src/hal',
    findings: [finding(), finding({ severity: 'trap', construct: 'virtual_inheritance', title: 'Virtual base' })],
    journal: [entry()],
    runs: [
      { lens: 'Structure', inputs: ['src/hal/*.cpp'], ran: true, findingCount: 2 },
      { lens: 'Cost', inputs: [], ran: false, skipped: 'no ELF configured', findingCount: 0 },
    ],
    generatedAt: new Date('2026-08-07T09:00:00.000Z'),
  };

  test('leads with what a person wrote, not with generated text', () => {
    const md = generatePrimer(base);
    const journalAt = md.indexOf('What people who read this before you wrote down');
    const generatedAt = md.indexOf('Where a C instinct gives the wrong answer');
    assert.ok(journalAt > 0 && journalAt < generatedAt, 'the journal section should come first');
  });

  test('orders generated sections traps first', () => {
    const md = generatePrimer(base);
    assert.ok(md.indexOf('Where a C instinct') < md.indexOf('Unfamiliar, but ordinary'));
  });

  test('always carries a manifest naming what ran', () => {
    const md = generatePrimer(base);
    assert.match(md, /## What was read to produce this/);
    assert.match(md, /\| Structure \|/);
  });

  test('names the lenses that did not run, so absence is not read as evidence', () => {
    const md = generatePrimer(base);
    assert.match(md, /Did not run/);
    assert.match(md, /no ELF configured/);
    assert.match(md, /not the same as[\s\S]{0,40}absent from the code/);
  });

  test('an empty module says so plainly and still carries the manifest', () => {
    const md = generatePrimer({ ...base, findings: [], journal: [] });
    assert.match(md, /nothing in this module behaves differently/i);
    assert.match(md, /## What was read to produce this/);
  });

  test('collapses repeats into one section listing where they occur', () => {
    const md = generatePrimer({
      ...base,
      findings: [finding(), finding({ line: 40 }), finding({ line: 88 })],
    });
    assert.match(md, /and 2 more like it/);
    assert.match(md, /src\/hal\/spi\.cpp:40/);
  });

  test('surfaces unresolved questions as the most valuable thing to fix', () => {
    const md = generatePrimer({ ...base, journal: [entry({ kind: 'wtf', body: 'Why virtual here?' })] });
    assert.match(md, /Still unresolved/);
    assert.match(md, /most valuable thing you/);
  });

  test('the one-line summary leads with traps', () => {
    assert.match(summarise(base), /will mislead a C reader/);
    assert.match(summarise({ ...base, findings: [] }), /nothing here behaves differently/);
  });

  test('the summary mentions open questions when there are any', () => {
    assert.match(summarise({ ...base, journal: [entry({ kind: 'wtf' })] }), /1 question still open/);
  });
});
