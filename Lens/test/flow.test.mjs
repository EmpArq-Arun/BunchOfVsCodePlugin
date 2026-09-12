import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseClangUml } from '../out-test/core/clanguml.js';
import {
  CERTAINTY,
  classifyIsr,
  deepestChain,
  depths,
  findCycles,
  instantiationEvidence,
  resolveVirtualCall,
} from '../out-test/core/flow.js';
import { detectFlowConstructs, summariseFlow } from '../out-test/core/flowfindings.js';
import { layoutFlow, renderFlowSvg, FLOW_LEGEND } from '../out-test/core/flowrender.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = async (name) => parseClangUml(await fs.readFile(path.join(here, 'fixtures', name), 'utf8'));

function graph(root, nodes, edges) {
  return { root, nodes: new Map(nodes.map((n) => [n.id, n])), edges };
}
const fn = (id, over = {}) => ({ id, name: id, file: 'x.cpp', line: 1, ...over });

describe('CHA / RTA resolution', () => {
  test('a non-virtual method resolves exactly and says so', async () => {
    const m = await load('fw-class.json');
    const r = resolveVirtualCall(m, { staticType: 'fw::hal::RingBuffer', methodName: 'push' });
    assert.equal(r.resolution, 'exact');
    assert.equal(r.certainty, 'certain');
    assert.match(r.note, /like a C function call/);
  });

  test('a base with a non-pure virtual is itself a target, alongside its overriders', async () => {
    const m = await load('fw-class.json');
    const r = resolveVirtualCall(m, { staticType: 'fw::hal::IUart', methodName: 'write' });
    // IUart::write is virtual but not pure, so calling through an IUart* may
    // land on the base implementation. A C reader expecting the derived one
    // every time is exactly who this needs to be spelled out for.
    assert.deepEqual(r.candidates.map((c) => c.typeQualifiedName).sort(), [
      'fw::hal::DuplexPort',
      'fw::hal::IUart',
    ]);
    assert.equal(r.certainty, 'bounded');
  });

  test('a lone non-pure virtual with no overriders is devirtualisable, with the caveat', async () => {
    const m = await load('fw-class.json');
    const r = resolveVirtualCall(m, { staticType: 'fw::hal::ITimer', methodName: 'start' });
    assert.equal(r.resolution, 'devirtualised');
    assert.equal(r.candidates.length, 1);
    assert.match(r.note, /whole-program assumptions/);
  });

  test('a pure virtual with several implementers returns the honest set', async () => {
    const m = await load('fw-class.json');
    const r = resolveVirtualCall(m, { staticType: 'fw::hal::ISpi', methodName: 'transfer' });
    assert.equal(r.certainty, 'bounded');
    assert.deepEqual(
      r.candidates.map((c) => c.typeQualifiedName).sort(),
      ['fw::hal::DuplexPort', 'fw::hal::SpiDriver'],
    );
  });

  test('the abstract base itself is never offered as a target', async () => {
    const m = await load('fw-class.json');
    const r = resolveVirtualCall(m, { staticType: 'fw::hal::ISpi', methodName: 'transfer' });
    assert.equal(r.candidates.some((c) => c.typeQualifiedName === 'fw::hal::ISpi'), false);
  });

  test('candidates with instantiation evidence sort ahead of those without', async () => {
    const m = await load('fw-class.json');
    const r = resolveVirtualCall(m, { staticType: 'fw::hal::ISpi', methodName: 'transfer' });
    const strengths = r.candidates.map((c) => c.evidenceStrength);
    const rank = { strong: 0, weak: 1, none: 2 };
    assert.deepEqual([...strengths].sort((a, b) => rank[a] - rank[b]), strengths);
  });

  test('a candidate with no instantiation evidence is kept and labelled, never dropped', async () => {
    const m = await load('fw-class.json');
    const r = resolveVirtualCall(m, { staticType: 'fw::hal::ISpi', methodName: 'transfer' });
    const weak = r.candidates.filter((c) => c.evidenceStrength === 'none');
    assert.ok(weak.length > 0, 'fixture should contain an unevidenced candidate');
    assert.match(weak[0].evidence, /may be created elsewhere/);
  });

  test('an unknown static type is unresolved rather than empty-but-confident', async () => {
    const m = await load('fw-class.json');
    const r = resolveVirtualCall(m, { staticType: 'fw::nowhere::IThing', methodName: 'go' });
    assert.equal(r.resolution, 'unresolved');
    assert.equal(r.certainty, 'unknown');
    assert.match(r.note, /Widen the scope/);
  });

  test('an interface with no implementers is unresolved, not silently empty', async () => {
    const m = await load('fw-class.json');
    const r = resolveVirtualCall(m, { staticType: 'fw::hal::ITimer', methodName: 'start' });
    // ITimer::start is virtual but not pure, so ITimer itself is a target.
    assert.equal(r.resolution, 'devirtualised');
    const none = resolveVirtualCall(m, { staticType: 'fw::hal::ISpi', methodName: 'noSuchMethod' });
    assert.equal(none.resolution, 'unresolved');
    assert.match(none.note, /outside this diagram|no implementers/);
  });

  test('resolution walks the full subtree, not just direct children', async () => {
    const m = await load('t00002-class.json');
    const r = resolveVirtualCall(m, { staticType: 'clanguml::t00002::A', methodName: 'foo_a' });
    // B, D and E all override foo_a; D and E are two levels below A.
    assert.deepEqual(r.candidates.map((c) => c.typeQualifiedName).sort(), [
      'clanguml::t00002::B',
      'clanguml::t00002::D',
      'clanguml::t00002::E',
    ]);
  });

  test('an abstract class reports why it can never be instantiated', async () => {
    const m = await load('fw-class.json');
    const spi = m.types.find((t) => t.name === 'ISpi');
    assert.match(instantiationEvidence(m, spi).evidence, /abstract/);
    assert.equal(instantiationEvidence(m, spi).strength, 'none');
  });

  test('a type held as a member counts as strong instantiation evidence', async () => {
    const m = await load('fw-class.json');
    const cfg = m.types.find((t) => t.name === 'PinConfig');
    assert.equal(instantiationEvidence(m, cfg).strength, 'none');
    const reg = m.types.find((t) => t.name === 'RegisterView');
    assert.equal(instantiationEvidence(m, reg).strength, 'strong');
  });
});

describe('ISR classification', () => {
  test('recognises Cortex-M core handlers with certainty', () => {
    assert.equal(classifyIsr('SysTick_Handler').confidence, 'certain');
    assert.equal(classifyIsr('HardFault_Handler').confidence, 'certain');
  });

  test('recognises vendor IRQ handlers as likely, not certain', () => {
    const c = classifyIsr('DMA1_Channel3_IRQHandler');
    assert.equal(c.confidence, 'likely');
    assert.match(c.reason, /_IRQHandler\$/);
  });

  test('does not mistake ordinary handlers for interrupts', () => {
    assert.equal(classifyIsr('ErrorHandler'), undefined);
    assert.equal(classifyIsr('onMessageHandler'), undefined);
    assert.equal(classifyIsr('fw::app::process'), undefined);
  });

  test('strips qualification before matching', () => {
    assert.ok(classifyIsr('fw::hal::SysTick_Handler'));
  });

  test('accepts project-specific patterns', () => {
    assert.equal(classifyIsr('vPortSVCHandler'), undefined);
    assert.ok(classifyIsr('vPortSVCHandler', ['^vPort']));
  });

  test('a malformed user pattern is skipped rather than breaking classification', () => {
    assert.ok(classifyIsr('SysTick_Handler', ['([unclosed']));
    assert.equal(classifyIsr('ordinary', ['([unclosed']), undefined);
  });
});

describe('graph traversal', () => {
  const g = graph(
    'main',
    [fn('main'), fn('a'), fn('b'), fn('c'), fn('orphan')],
    [
      { from: 'main', to: 'a', resolution: 'exact' },
      { from: 'a', to: 'b', resolution: 'cha' },
      { from: 'b', to: 'c', resolution: 'exact' },
      { from: 'main', to: 'c', resolution: 'exact' },
    ],
  );

  test('depths are breadth-first shortest, not path length', () => {
    const d = depths(g);
    assert.equal(d.get('c'), 1);
    assert.equal(d.get('b'), 2);
  });

  test('unreachable nodes have no depth', () => {
    assert.equal(depths(g).has('orphan'), false);
  });

  test('deepest chain follows the longest simple path', () => {
    assert.deepEqual(deepestChain(g), ['main', 'a', 'b', 'c']);
  });

  test('finds direct recursion', () => {
    const r = graph('f', [fn('f')], [{ from: 'f', to: 'f', resolution: 'exact' }]);
    assert.deepEqual(findCycles(r), [['f', 'f']]);
  });

  test('finds mutual recursion', () => {
    const r = graph(
      'f',
      [fn('f'), fn('g')],
      [
        { from: 'f', to: 'g', resolution: 'exact' },
        { from: 'g', to: 'f', resolution: 'exact' },
      ],
    );
    assert.deepEqual(findCycles(r), [['f', 'g', 'f']]);
  });

  test('a diamond is not mistaken for a cycle', () => {
    assert.deepEqual(findCycles(g), []);
  });

  test('terminates on a cycle when computing the deepest chain', () => {
    const r = graph(
      'f',
      [fn('f'), fn('g')],
      [
        { from: 'f', to: 'g', resolution: 'exact' },
        { from: 'g', to: 'f', resolution: 'exact' },
      ],
    );
    assert.deepEqual(deepestChain(r), ['f', 'g']);
  });
});

describe('flow findings', () => {
  test('flags indirect dispatch reached from an interrupt handler', () => {
    const g = graph(
      'SysTick_Handler',
      [fn('SysTick_Handler', { isr: classifyIsr('SysTick_Handler') }), fn('ISpi::transfer'), fn('SpiDriver::transfer')],
      [
        { from: 'SysTick_Handler', to: 'ISpi::transfer', resolution: 'exact' },
        { from: 'ISpi::transfer', to: 'SpiDriver::transfer', resolution: 'cha' },
      ],
    );
    const f = detectFlowConstructs(g).find((x) => x.construct === 'indirect_call_in_isr');
    assert.equal(f.severity, 'trap');
    assert.match(f.emits, /vtable/);
  });

  test('does not flag an ISR whose calls are all direct', () => {
    const g = graph(
      'SysTick_Handler',
      [fn('SysTick_Handler', { isr: classifyIsr('SysTick_Handler') }), fn('tick')],
      [{ from: 'SysTick_Handler', to: 'tick', resolution: 'exact' }],
    );
    assert.equal(detectFlowConstructs(g).some((x) => x.construct === 'indirect_call_in_isr'), false);
  });

  test('does not attribute an indirect call to an ISR that cannot reach it', () => {
    const g = graph(
      'main',
      [fn('main'), fn('SysTick_Handler', { isr: classifyIsr('SysTick_Handler') }), fn('a'), fn('b')],
      [
        { from: 'main', to: 'a', resolution: 'exact' },
        { from: 'a', to: 'b', resolution: 'cha' },
      ],
    );
    assert.equal(detectFlowConstructs(g).some((x) => x.construct === 'indirect_call_in_isr'), false);
  });

  test('flags direct and mutual recursion differently', () => {
    const direct = graph('f', [fn('f')], [{ from: 'f', to: 'f', resolution: 'exact' }]);
    assert.equal(detectFlowConstructs(direct)[0].construct, 'direct_recursion');
    const mutual = graph(
      'f',
      [fn('f'), fn('g')],
      [
        { from: 'f', to: 'g', resolution: 'exact' },
        { from: 'g', to: 'f', resolution: 'exact' },
      ],
    );
    assert.equal(detectFlowConstructs(mutual)[0].construct, 'mutual_recursion');
  });

  test('warns on deep chains at the configured threshold', () => {
    const ids = Array.from({ length: 6 }, (_, i) => `f${i}`);
    const g = graph(
      'f0',
      ids.map((i) => fn(i)),
      ids.slice(1).map((to, i) => ({ from: ids[i], to, resolution: 'exact' })),
    );
    assert.equal(detectFlowConstructs(g, { depthWarning: 8 }).some((x) => x.construct === 'deep_call_chain'), false);
    const f = detectFlowConstructs(g, { depthWarning: 4 }).find((x) => x.construct === 'deep_call_chain');
    assert.match(f.title, /6 frames deep/);
  });

  test('flags a call site with three or more possible targets', () => {
    const g = graph(
      'caller',
      [fn('caller'), fn('a'), fn('b'), fn('c')],
      ['a', 'b', 'c'].map((to) => ({ from: 'caller', to, resolution: 'cha', callSite: { file: 'x.cpp', line: 12 } })),
    );
    assert.ok(detectFlowConstructs(g).some((x) => x.construct === 'wide_polymorphic_call'));
  });

  test('reports where analysis stopped instead of hiding it', () => {
    const g = graph(
      'main',
      [fn('main'), fn('callback')],
      [{ from: 'main', to: 'callback', resolution: 'fn_ptr' }],
    );
    const f = detectFlowConstructs(g).find((x) => x.construct === 'unresolved_dispatch');
    assert.match(f.cEquivalent, /where the map ends/);
  });

  test('a fully resolved graph produces no findings', () => {
    const g = graph('main', [fn('main'), fn('a')], [{ from: 'main', to: 'a', resolution: 'exact' }]);
    assert.deepEqual(detectFlowConstructs(g), []);
  });

  test('summary partitions every edge by certainty', () => {
    const g = graph(
      'main',
      [fn('main'), fn('a'), fn('b'), fn('c')],
      [
        { from: 'main', to: 'a', resolution: 'exact' },
        { from: 'main', to: 'b', resolution: 'cha' },
        { from: 'main', to: 'c', resolution: 'unresolved' },
      ],
    );
    const s = summariseFlow(g);
    assert.deepEqual([s.certain, s.bounded, s.unknown], [1, 1, 1]);
    assert.equal(s.certain + s.bounded + s.unknown, s.edges);
  });

  test('every resolution maps to a certainty', () => {
    for (const r of ['exact', 'devirtualised', 'cha', 'rta', 'fn_ptr', 'observed', 'unresolved']) {
      assert.ok(CERTAINTY[r], `no certainty for ${r}`);
    }
  });
});

describe('flow rendering', () => {
  const g = graph(
    'SysTick_Handler',
    [
      fn('SysTick_Handler', { isr: classifyIsr('SysTick_Handler') }),
      fn('fw::hal::ISpi::transfer'),
      fn('fw::hal::SpiDriver::transfer'),
      fn('opaque_callback'),
    ],
    [
      { from: 'SysTick_Handler', to: 'fw::hal::ISpi::transfer', resolution: 'exact' },
      { from: 'fw::hal::ISpi::transfer', to: 'fw::hal::SpiDriver::transfer', resolution: 'cha', evidence: 'sole override' },
      { from: 'SysTick_Handler', to: 'opaque_callback', resolution: 'fn_ptr' },
    ],
  );

  test('columns follow call depth', () => {
    const l = layoutFlow(g);
    assert.equal(l.places.get('SysTick_Handler').column, 0);
    assert.equal(l.places.get('fw::hal::ISpi::transfer').column, 1);
    assert.equal(l.places.get('fw::hal::SpiDriver::transfer').column, 2);
  });

  test('a disconnected node is still placed rather than silently dropped', () => {
    const d = graph('main', [fn('main'), fn('stray')], []);
    assert.equal(layoutFlow(d).places.size, 2);
  });

  test('uncertain edges are dashed and certain ones are not', () => {
    const svg = renderFlowSvg(g);
    // Marker definitions also use <path>; edges are the ones carrying marker-end.
    const edges = svg.split('\n').filter((l) => l.includes('marker-end='));
    assert.equal(edges.length, 3);
    assert.equal(edges.filter((p) => p.includes('stroke-dasharray')).length, 2);
  });

  test('an unfollowable call is marked, never drawn as an ordinary arrow', () => {
    const svg = renderFlowSvg(g);
    assert.match(svg, />\?<\/text>/);
    assert.match(svg, /var\(--lens-unknown\)/);
  });

  test('interrupt handlers are visually distinct and labelled', () => {
    const svg = renderFlowSvg(g);
    assert.match(svg, /ISR Cortex-M core exception handler/);
  });

  test('escapes qualified names containing template markup', () => {
    const t = graph('r', [fn('r'), fn('Ring<uint8_t>::push')], [{ from: 'r', to: 'Ring<uint8_t>::push', resolution: 'exact' }]);
    const svg = renderFlowSvg(t);
    assert.match(svg, /Ring&lt;uint8_t&gt;/);
    assert.doesNotMatch(svg, /<uint8_t>/);
  });

  test('produces balanced markup', () => {
    const svg = renderFlowSvg(g, { annotated: new Set(['SysTick_Handler']) });
    // <path> is excluded: marker definitions are self-closing while edge paths
    // wrap a <title>, so a naive open/close count is not the right check.
    for (const tag of ['svg', 'g', 'defs', 'text', 'title']) {
      const open = (svg.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
      const close = (svg.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      assert.equal(open, close, `unbalanced <${tag}>`);
    }
  });

  test('every edge path that opens a title closes it', () => {
    const svg = renderFlowSvg(g);
    for (const line of svg.split('\n').filter((l) => l.includes('marker-end='))) {
      assert.match(line, /<title>.*<\/title><\/path>$/);
    }
  });

  test('the legend covers every certainty level the renderer can draw', () => {
    assert.deepEqual(FLOW_LEGEND.map((l) => l.certainty), ['certain', 'bounded', 'unknown']);
  });
});
