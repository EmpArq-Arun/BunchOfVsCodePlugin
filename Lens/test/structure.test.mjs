import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseClangUml, ClangUmlParseError, relationKind } from '../out-test/core/clanguml.js';
import { contextSubset, filterModel, neighbours, byId } from '../out-test/core/structure.js';
import { detectConstructs, summarise, draftEntry } from '../out-test/core/constructs.js';
import { layout, renderSvg, escapeXml } from '../out-test/core/render.js';
import { resolveVirtualCall } from '../out-test/core/flow.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = async (name) => parseClangUml(await fs.readFile(path.join(here, 'fixtures', name), 'utf8'));

const findingsFor = (model, qname, construct) =>
  detectConstructs(model).filter((f) => f.qualifiedName === qname && f.construct === construct);

describe('clang-uml parser — documented t00002 fixture', () => {
  test('reads every element', async () => {
    const m = await load('t00002-class.json');
    assert.equal(m.types.length, 5);
    assert.deepEqual(m.types.map((t) => t.name).sort(), ['A', 'B', 'C', 'D', 'E']);
    assert.equal(m.title, 'Basic class diagram example');
    assert.equal(m.usingNamespace, 'clanguml::t00002');
    assert.equal(m.provenance.provider, 'clang-uml');
  });

  test('builds qualified names from namespace and name', async () => {
    const m = await load('t00002-class.json');
    assert.equal(byId(m).get('7901073918843258388').qualifiedName, 'clanguml::t00002::A');
  });

  test('maps clang-uml "extension" to inheritance', async () => {
    assert.equal(relationKind('extension'), 'inheritance');
    assert.equal(relationKind('association'), 'association');
    assert.equal(relationKind('something_new_in_a_later_release'), 'other');
  });

  test('preserves pure virtual and abstract flags', async () => {
    const m = await load('t00002-class.json');
    const a = byId(m).get('7901073918843258388');
    assert.equal(a.isAbstract, true);
    assert.equal(a.methods.every((x) => x.isPureVirtual && x.isVirtual), true);
  });

  test('preserves virtual inheritance, which the relationship list alone does not carry', async () => {
    const m = await load('t00002-class.json');
    const e = byId(m).get('17903093362471729766');
    assert.equal(e.bases.length, 2);
    assert.equal(e.bases.every((b) => b.isVirtual), true);
    const d = byId(m).get('487603959843317797');
    assert.equal(d.bases.every((b) => b.isVirtual), false);
  });

  test('does not duplicate inheritance edges declared in both places', async () => {
    const m = await load('t00002-class.json');
    const edges = m.relations.filter((r) => r.kind === 'inheritance').map((r) => `${r.from}>${r.to}`);
    assert.equal(new Set(edges).size, edges.length);
    assert.equal(edges.length, 6);
  });

  test('reads members with their types', async () => {
    const m = await load('t00002-class.json');
    const d = byId(m).get('487603959843317797');
    assert.deepEqual(d.members.map((x) => [x.name, x.type, x.access]), [['as', 'std::vector<A *>', 'private']]);
  });

  test('records source locations for navigation', async () => {
    const m = await load('t00002-class.json');
    assert.deepEqual(byId(m).get('7901073918843258388').location, {
      file: 't00002.cc',
      line: 7,
      column: 7,
    });
  });

  test('extracts a brief from the doc comment', async () => {
    const m = await load('t00002-class.json');
    assert.match(byId(m).get('7901073918843258388').brief, /This is class A/);
  });

  test('neighbours resolves both directions', async () => {
    const m = await load('t00002-class.json');
    const n = neighbours(m, '4753875669499007606'); // B
    assert.deepEqual(n.bases, ['7901073918843258388']);
    assert.deepEqual(n.derived.sort(), ['17903093362471729766', '487603959843317797']);
  });
});

describe('clang-uml parser — robustness', () => {
  test('rejects non-JSON with a message naming the tool', () => {
    assert.throws(() => parseClangUml('clang-uml: error: no such diagram'), ClangUmlParseError);
  });

  test('rejects a sequence diagram rather than silently producing nothing', () => {
    assert.throws(
      () => parseClangUml(JSON.stringify({ diagram_type: 'sequence', elements: [] })),
      /expected a class diagram/,
    );
  });

  test('rejects output with no elements array', () => {
    assert.throws(() => parseClangUml(JSON.stringify({ diagram_type: 'class' })), /elements/);
  });

  test('accepts an empty diagram', () => {
    const m = parseClangUml(JSON.stringify({ diagram_type: 'class', elements: [] }));
    assert.equal(m.types.length, 0);
  });

  test('tolerates numeric ids from older releases', () => {
    const m = parseClangUml(
      JSON.stringify({
        diagram_type: 'class',
        elements: [{ id: 42, name: 'X', bases: [{ id: 43, access: 'public' }] }, { id: 43, name: 'Y' }],
      }),
    );
    assert.deepEqual(m.types.map((t) => t.id), ['42', '43']);
    assert.equal(m.relations.length, 1);
  });

  test('drops edges pointing outside the diagram and says so', async () => {
    const m = await load('fw-class.json');
    assert.equal(m.relations.some((r) => r.to === '999999'), false);
    assert.equal(m.provenance.missing.some((x) => /outside this diagram/.test(x)), true);
  });

  test('records missing method and member arrays instead of assuming empty', () => {
    const m = parseClangUml(JSON.stringify({ diagram_type: 'class', elements: [{ id: '1', name: 'X' }] }));
    assert.deepEqual(m.provenance.missing.sort(), ['members', 'methods']);
    assert.deepEqual(m.types[0].methods, []);
  });

  test('skips malformed elements without losing the rest', () => {
    const m = parseClangUml(
      JSON.stringify({ diagram_type: 'class', elements: [{ name: 'NoId' }, null, 7, { id: '2', name: 'Good' }] }),
    );
    assert.deepEqual(m.types.map((t) => t.name), ['Good']);
  });

  test('infers a destructor from the leading tilde, since there is no flag for it', async () => {
    const m = await load('fw-class.json');
    const spi = m.types.find((t) => t.name === 'SpiDriver');
    const dtor = spi.methods.find((x) => x.isDestructor);
    assert.equal(dtor.name, '~SpiDriver');
    assert.equal(spi.methods.filter((x) => x.isDestructor).length, 1);
  });
});

describe('construct detection', () => {
  test('names virtual dispatch and explains the C equivalent', async () => {
    const m = await load('t00002-class.json');
    const [f] = findingsFor(m, 'clanguml::t00002::B', 'virtual_dispatch');
    assert.equal(f.severity, 'new');
    assert.match(f.emits, /vtable in \.rodata/);
    assert.match(f.cEquivalent, /function pointers/);
  });

  test('flags virtual inheritance as a trap, and only where it occurs', async () => {
    const m = await load('t00002-class.json');
    assert.equal(findingsFor(m, 'clanguml::t00002::E', 'virtual_inheritance').length, 1);
    assert.equal(findingsFor(m, 'clanguml::t00002::E', 'virtual_inheritance')[0].severity, 'trap');
    assert.equal(findingsFor(m, 'clanguml::t00002::D', 'virtual_inheritance').length, 0);
  });

  test('flags multiple inheritance separately from virtual inheritance', async () => {
    const m = await load('t00002-class.json');
    assert.equal(findingsFor(m, 'clanguml::t00002::D', 'multiple_inheritance').length, 1);
  });

  test('catches a declared non-virtual destructor on a polymorphic class', async () => {
    const m = await load('fw-class.json');
    const f = findingsFor(m, 'fw::hal::IUart', 'non_virtual_destructor');
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'trap');
  });

  test('catches the harder case: a polymorphic class with no destructor at all', async () => {
    const m = await load('fw-class.json');
    const f = findingsFor(m, 'fw::hal::ITimer', 'implicit_non_virtual_destructor');
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, 'trap');
  });

  test('does not flag a class whose destructor is correctly virtual', async () => {
    const m = await load('fw-class.json');
    assert.equal(findingsFor(m, 'fw::hal::ISpi', 'non_virtual_destructor').length, 0);
    assert.equal(findingsFor(m, 'fw::hal::SpiDriver', 'non_virtual_destructor').length, 0);
  });

  test('reports deleted special members by name', async () => {
    const m = await load('fw-class.json');
    const [f] = findingsFor(m, 'fw::hal::SpiDriver', 'deleted_special_member');
    assert.match(f.title, /2 deleted/);
    assert.match(f.title, /operator=/);
  });

  test('reports move assignment separately from operator overloading', async () => {
    const m = await load('fw-class.json');
    assert.equal(findingsFor(m, 'fw::hal::SpiDriver', 'move_semantics').length, 1);
    // operator= is copy/move assignment and must not double-count as an overload.
    assert.equal(findingsFor(m, 'fw::hal::SpiDriver', 'operator_overload').length, 0);
    assert.equal(findingsFor(m, 'fw::hal::RingBuffer', 'operator_overload').length, 1);
  });

  test('flags coroutines as a trap on constrained targets', async () => {
    const m = await load('fw-class.json');
    const [f] = findingsFor(m, 'fw::app::SensorTask', 'coroutine');
    assert.equal(f.severity, 'trap');
    assert.match(f.emits, /operator new/);
  });

  test('flags static data members and their pre-main construction', async () => {
    const m = await load('fw-class.json');
    const [f] = findingsFor(m, 'fw::hal::SpiDriver', 'static_data_member');
    assert.match(f.emits, /\.init_array/);
  });

  test('flags private inheritance as composition in disguise', async () => {
    const m = await load('fw-class.json');
    const [f] = findingsFor(m, 'fw::hal::RingBuffer', 'non_public_inheritance');
    assert.match(f.title, /private inheritance from PinConfig/);
  });

  test('marks unions and plain structs as familiar, not alien', async () => {
    const m = await load('fw-class.json');
    assert.equal(findingsFor(m, 'fw::hal::RegisterView', 'union')[0].severity, 'familiar');
    assert.equal(findingsFor(m, 'fw::hal::PinConfig', 'plain_data')[0].severity, 'familiar');
  });

  test('does not call a class with methods plain data', async () => {
    const m = await load('fw-class.json');
    assert.equal(findingsFor(m, 'fw::hal::SpiDriver', 'plain_data').length, 0);
  });

  test('summary orders traps first', async () => {
    const m = await load('fw-class.json');
    const s = summarise(detectConstructs(m));
    assert.equal(s.byConstruct[0].severity, 'trap');
    assert.equal(s.traps > 0, true);
    assert.equal(s.familiar + s.neu + s.traps, s.total);
  });

  test('a draft journal entry carries both halves of the explanation', async () => {
    const m = await load('fw-class.json');
    const draft = draftEntry(findingsFor(m, 'fw::hal::ITimer', 'implicit_non_virtual_destructor')[0]);
    assert.match(draft, /What the compiler emits/);
    assert.match(draft, /In C you would write/);
  });

  test('an empty model produces no findings', () => {
    const m = parseClangUml(JSON.stringify({ diagram_type: 'class', elements: [] }));
    assert.deepEqual(detectConstructs(m), []);
  });
});

describe('context filtering', () => {
  test('radius 1 pulls in direct relations only', async () => {
    const m = await load('t00002-class.json');
    const keep = contextSubset(m, ['4753875669499007606'], 1); // B
    assert.equal(keep.has('7901073918843258388'), true); // A, its base
    assert.equal(keep.has('487603959843317797'), true); // D, derives from it
    assert.equal(keep.has('9139995436788700062'), false); // C, two hops away
  });

  test('radius 2 reaches siblings', async () => {
    const m = await load('t00002-class.json');
    assert.equal(contextSubset(m, ['4753875669499007606'], 2).has('9139995436788700062'), true);
  });

  test('radius 0 keeps only the seed', async () => {
    const m = await load('t00002-class.json');
    assert.deepEqual([...contextSubset(m, ['4753875669499007606'], 0)], ['4753875669499007606']);
  });

  test('filtering drops edges whose endpoints left the set', async () => {
    const m = await load('t00002-class.json');
    const sub = filterModel(m, contextSubset(m, ['4753875669499007606'], 1));
    const ids = new Set(sub.types.map((t) => t.id));
    assert.equal(sub.relations.every((r) => ids.has(r.from) && ids.has(r.to)), true);
  });
});

describe('layout', () => {
  test('places every base strictly above every class deriving from it', async () => {
    const m = await load('t00002-class.json');
    const l = layout(m);
    for (const r of m.relations.filter((x) => x.kind === 'inheritance')) {
      assert.ok(
        l.nodes.get(r.to).rank < l.nodes.get(r.from).rank,
        `base ${r.to} should outrank derived ${r.from}`,
      );
    }
  });

  test('assigns a position to every type', async () => {
    const m = await load('fw-class.json');
    const l = layout(m);
    assert.equal(l.nodes.size, m.types.length);
    assert.ok(l.width > 0 && l.height > 0);
  });

  test('nodes on a rank do not overlap', async () => {
    const m = await load('fw-class.json');
    const l = layout(m);
    const rows = new Map();
    for (const n of l.nodes.values()) {
      (rows.get(n.rank) ?? rows.set(n.rank, []).get(n.rank)).push(n);
    }
    for (const row of rows.values()) {
      row.sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) {
        assert.ok(row[i].x >= row[i - 1].x + row[i - 1].w, 'boxes overlap');
      }
    }
  });

  test('is deterministic', async () => {
    const m = await load('fw-class.json');
    assert.deepEqual([...layout(m).nodes], [...layout(m).nodes]);
  });

  test('handles a model with no relations', () => {
    const m = parseClangUml(
      JSON.stringify({ diagram_type: 'class', elements: [{ id: '1', name: 'A' }, { id: '2', name: 'B' }] }),
    );
    const l = layout(m);
    assert.equal(l.nodes.get('1').rank, 0);
    assert.equal(l.nodes.get('2').rank, 0);
  });
});

describe('svg rendering', () => {
  test('escapes markup in identifiers', () => {
    assert.equal(escapeXml('Buffer<T, N> & "x"'), 'Buffer&lt;T, N&gt; &amp; &quot;x&quot;');
  });

  test('template arguments in a class name do not break the document', async () => {
    const m = parseClangUml(
      JSON.stringify({
        diagram_type: 'class',
        elements: [{ id: '1', name: 'Ring<uint8_t,64>', namespace: 'fw' }],
      }),
    );
    const svg = renderSvg(m);
    assert.match(svg, /Ring&lt;uint8_t,64&gt;/);
    assert.doesNotMatch(svg, /<text[^>]*>[^<]*<uint8_t/);
  });

  test('emits one addressable group per type', async () => {
    const m = await load('fw-class.json');
    const svg = renderSvg(m);
    assert.equal((svg.match(/class="node"/g) ?? []).length, m.types.length);
    assert.match(svg, /data-qname="fw::hal::SpiDriver"/);
  });

  test('marks classes carrying findings and leaves the rest neutral', async () => {
    const m = await load('fw-class.json');
    const svg = renderSvg(m, { findings: detectConstructs(m) });
    assert.match(svg, /var\(--lens-trap\)/);
  });

  test('shows an annotation dot only for classes with journal entries', async () => {
    const m = await load('fw-class.json');
    assert.doesNotMatch(renderSvg(m), /lens-annotated/);
    assert.match(renderSvg(m, { annotated: new Set(['fw::hal::SpiDriver']) }), /lens-annotated/);
  });

  test('produces a well-formed document for an empty model', () => {
    const m = parseClangUml(JSON.stringify({ diagram_type: 'class', elements: [] }));
    const svg = renderSvg(m);
    assert.match(svg, /^<svg /);
    assert.match(svg, /<\/svg>$/);
  });

  test('every opened tag is closed', async () => {
    const m = await load('t00002-class.json');
    const svg = renderSvg(m, { findings: detectConstructs(m) });
    for (const tag of ['svg', 'g', 'defs', 'text', 'title']) {
      const open = (svg.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
      const close = (svg.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      assert.equal(open, close, `unbalanced <${tag}>`);
    }
  });
});

describe('real clang-uml 0.6.3 output', () => {
  let real;
  before(async () => {
    real = await load('clanguml-real.json');
  });

  test('parses a genuine run with nothing unaccounted for', () => {
    assert.equal(real.types.length, 14);
    assert.deepEqual(real.provenance.missing, []);
    assert.equal(real.title, 'Firmware HAL');
  });

  test('ids arrive as strings in this release', () => {
    assert.ok(real.types.every((t) => typeof t.id === 'string' && /^\d+$/.test(t.id)));
  });

  test('destructors are reported, with their virtuality', () => {
    const ispi = real.types.find((t) => t.name === 'ISpi');
    const dtor = ispi.methods.find((m) => m.isDestructor);
    assert.ok(dtor, 'clang-uml should report ~ISpi');
    assert.equal(dtor.isVirtual, true);
  });

  test('virtual inheritance survives the round trip', () => {
    const left = real.types.find((t) => t.name === 'Left');
    assert.equal(left.bases.every((b) => b.isVirtual), true);
    const diamond = real.types.find((t) => t.name === 'Diamond');
    assert.equal(diamond.bases.some((b) => b.isVirtual), false);
  });

  test('a derived class is NOT flagged when a base destructor is virtual', () => {
    // The regression this fixture exists for. SpiDriver declares no destructor,
    // but inherits ISpi's virtual one, so its implicit destructor is virtual.
    const findings = detectConstructs(real);
    assert.equal(
      findings.some((f) => /destructor/.test(f.construct)),
      false,
      'no destructor findings: this source has no destructor bug',
    );
  });

  test('still flags a genuine missing virtual destructor', () => {
    const broken = parseClangUml(
      JSON.stringify({
        diagram_type: 'class',
        elements: [
          { id: '1', name: 'Iface', namespace: 'x', methods: [{ name: 'go', is_virtual: true, is_pure_virtual: true }] },
          {
            id: '2',
            name: 'Impl',
            namespace: 'x',
            bases: [{ id: '1', access: 'public' }],
            methods: [{ name: 'go', is_virtual: true }],
          },
        ],
      }),
    );
    const findings = detectConstructs(broken);
    assert.ok(findings.some((f) => f.construct === 'implicit_non_virtual_destructor' && f.qualifiedName === 'x::Iface'));
  });

  test('a base outside the diagram is assumed to behave, rather than warned about', () => {
    const partial = parseClangUml(
      JSON.stringify({
        diagram_type: 'class',
        elements: [
          {
            id: '2',
            name: 'Impl',
            namespace: 'x',
            bases: [{ id: '999', access: 'public' }],
            methods: [{ name: 'go', is_virtual: true }],
          },
        ],
      }),
    );
    assert.equal(detectConstructs(partial).some((f) => /destructor/.test(f.construct)), false);
  });

  test('resolves the honest override set from real data', () => {
    const r = resolveVirtualCall(real, { staticType: 'fw::ISpi', methodName: 'transfer' });
    assert.equal(r.certainty, 'bounded');
    assert.deepEqual(r.candidates.map((c) => c.typeQualifiedName).sort(), [
      'fw::Diamond',
      'fw::DuplexPort',
      'fw::SpiDriver',
    ]);
  });
});
