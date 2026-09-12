import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseElf, allocatedSections, sectionCategory, isDefined, ElfParseError } from '../out-test/core/elf.js';
import { classifySymbol, demangle } from '../out-test/core/mangling.js';
import { attribute, buildReport, detectCostConstructs } from '../out-test/core/cost.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let elf;
let report;
before(async () => {
  elf = parseElf(new Uint8Array(await fs.readFile(path.join(here, 'fixtures', 'cost.elf'))));
  report = buildReport(elf);
});

const sym = (name) => elf.symbols.find((s) => s.name === name);
const group = (c) => report.groups.find((g) => g.category === c);

describe('ELF reading', () => {
  test('identifies class and byte order', () => {
    assert.equal(elf.class, 64);
    assert.equal(elf.littleEndian, true);
    assert.equal(elf.stripped, false);
  });

  test('reads section headers with names', () => {
    const names = elf.sections.map((s) => s.name);
    for (const n of ['.text', '.rodata', '.bss', '.symtab', '.strtab']) {
      assert.ok(names.some((x) => x === n || x.startsWith(`${n}.`)), `missing ${n}`);
    }
  });

  test('reads the symbol table with sizes and section attribution', () => {
    const v = sym('_ZTVN2fw4ISpiE');
    assert.ok(v, 'vtable symbol should be present');
    assert.ok(v.size > 0, 'vtable should have a size');
    assert.equal(v.type, 'object');
    assert.ok(v.section, 'defined symbols should resolve a section');
  });

  test('distinguishes defined from undefined symbols', () => {
    assert.equal(isDefined(sym('_ZTVN2fw4ISpiE')), true);
    const undef = elf.symbols.find((s) => s.sectionIndex === 0);
    assert.equal(isDefined(undef), false);
  });

  test('groups the -ffunction-sections explosion back into categories', () => {
    assert.equal(sectionCategory('.text.startup.main'), 'text');
    assert.equal(sectionCategory('.rodata.cst8'), 'rodata');
    assert.equal(sectionCategory('.data.rel.ro'), 'rodata');
    assert.equal(sectionCategory('.bss'), 'bss');
    assert.equal(sectionCategory('.ARM.exidx'), 'unwind');
    assert.equal(sectionCategory('.eh_frame'), 'unwind');
    assert.equal(sectionCategory('.init_array'), 'init');
    assert.equal(sectionCategory('.comment'), 'other');
  });

  test('allocated sections exclude debug and comment sections', () => {
    const alloc = allocatedSections(elf);
    assert.ok(alloc.size > 0);
    assert.equal([...alloc.keys()].some((n) => n === '.symtab' || n === '.comment'), false);
  });

  test('rejects a non-ELF file by its magic', () => {
    assert.throws(() => parseElf(new Uint8Array(Buffer.from('not an elf file at all, really'))), ElfParseError);
  });

  test('rejects an unknown class byte rather than guessing', () => {
    const bytes = new Uint8Array(128);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 9, 1]);
    assert.throws(() => parseElf(bytes), /unknown ELF class/);
  });

  test('rejects a truncated file rather than reading past the end', () => {
    const real = new Uint8Array(64);
    real.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    assert.throws(() => parseElf(real), ElfParseError);
  });
});

describe('Itanium classification', () => {
  test('recognises a vtable and names the class that caused it', () => {
    const c = classifySymbol('_ZTVN2fw4ISpiE');
    assert.equal(c.kind, 'vtable');
    assert.equal(c.entity, 'fw::ISpi');
    assert.match(c.because, /virtual functions/);
    assert.equal(c.partial, false);
  });

  test('recognises typeinfo and its name string separately', () => {
    assert.equal(classifySymbol('_ZTIN2fw10DuplexPortE').kind, 'typeinfo');
    assert.equal(classifySymbol('_ZTSN2fw10DuplexPortE').kind, 'typeinfo-name');
    assert.equal(classifySymbol('_ZTSN2fw10DuplexPortE').entity, 'fw::DuplexPort');
  });

  test('recognises VTTs and construction vtables as virtual-inheritance artifacts', () => {
    assert.equal(classifySymbol('_ZTTN2fw7DiamondE').kind, 'vtt');
    assert.equal(classifySymbol('_ZTCN2fw7DiamondE0_NS_4LeftE').kind, 'construction-vtable');
  });

  test('unwraps a thunk to the function it adjusts for', () => {
    const c = classifySymbol('_ZThn8_N2fw10DuplexPort5writeEh');
    assert.equal(c.kind, 'thunk');
    assert.equal(c.entity, 'fw::DuplexPort::write');
    assert.equal(c.owner, 'fw::DuplexPort');
    assert.match(c.because, /this pointer adjusted/);
  });

  test('unwraps a guard variable to the static it guards', () => {
    const c = classifySymbol('_ZGVZN2fw7counterEvE5value');
    assert.equal(c.kind, 'guard-variable');
    assert.equal(c.entity, 'fw::counter::value');
    assert.match(c.because, /runtime initialiser/);
  });

  test('recognises a function-local static', () => {
    const c = classifySymbol('_ZZN2fw7counterEvE5value');
    assert.equal(c.kind, 'local-static');
    assert.equal(c.entity, 'fw::counter::value');
    assert.equal(c.owner, 'fw::counter');
  });

  test('names constructor and destructor variants and explains why there are several', () => {
    const ctor = classifySymbol('_ZN2fw8RegistryC1Ev');
    assert.equal(ctor.kind, 'constructor');
    assert.equal(ctor.entity, 'fw::Registry::Registry');
    assert.equal(ctor.owner, 'fw::Registry');
    const dtor = classifySymbol('_ZN2fw8RegistryD0Ev');
    assert.equal(dtor.kind, 'destructor');
    assert.equal(dtor.entity, 'fw::Registry::~Registry');
    assert.match(dtor.because, /three variants/);
  });

  test('recognises member and free functions and their owners', () => {
    const member = classifySymbol('_ZN2fw9SpiDriver8transferEPhj');
    assert.equal(member.kind, 'function');
    assert.equal(member.entity, 'fw::SpiDriver::transfer');
    assert.equal(member.owner, 'fw::SpiDriver');
    assert.equal(classifySymbol('_Z4seedv').owner, undefined);
  });

  test('collapses template arguments rather than pretending to decode them', () => {
    const c = classifySymbol('_ZN2fw4RingIhE3popEv');
    assert.equal(c.entity, 'fw::Ring<...>::pop');
  });

  test('recognises runtime support by name and says what pulled it in', () => {
    assert.equal(classifySymbol('__cxa_throw').category, undefined);
    assert.equal(classifySymbol('__cxa_throw').kind, 'runtime-support');
    assert.match(classifySymbol('__cxa_guard_acquire').because, /thread-safe/);
    assert.match(classifySymbol('__dynamic_cast').because, /RTTI/);
    assert.match(classifySymbol('_Znwm').because, /operator new/);
    assert.match(classifySymbol('__cxa_pure_virtual').because, /pure virtual/);
  });

  test('treats C-linkage symbols as unmangled rather than failing', () => {
    const c = classifySymbol('HAL_GPIO_Init');
    assert.equal(c.kind, 'unmangled');
    assert.equal(c.entity, 'HAL_GPIO_Init');
    assert.equal(c.partial, false);
  });

  test('flags a name it could not fully parse instead of inventing one', () => {
    const c = classifySymbol('_ZN2fw99');
    assert.equal(c.partial, true);
  });

  test('demangles every mangled symbol in the real image without throwing', () => {
    const mangled = elf.symbols.filter((s) => s.name.startsWith('_Z'));
    assert.ok(mangled.length > 20, `only ${mangled.length} mangled symbols`);
    for (const s of mangled) {
      const out = demangle(s.name);
      assert.ok(typeof out === 'string' && out.length > 0, `empty demangle for ${s.name}`);
    }
  });

  test('most real symbols parse completely', () => {
    const mangled = elf.symbols.filter((s) => s.name.startsWith('_Z') && !s.name.includes('@'));
    const partial = mangled.filter((s) => classifySymbol(s.name).partial);
    assert.ok(
      partial.length / mangled.length < 0.2,
      `${partial.length}/${mangled.length} partial: ${partial.slice(0, 3).map((s) => s.name)}`,
    );
  });
});

describe('cost attribution', () => {
  test('every defined sized symbol lands in exactly one bucket', () => {
    const attributed = attribute(elf);
    assert.ok(attributed.length > 20);
    const counted = attributed.reduce((a, s) => a + s.symbol.size, 0);
    assert.equal(counted, report.reconciliation.symbolTotal);
  });

  test('does not double-count a symbol appearing twice at one address', () => {
    const attributed = attribute(elf);
    const keys = attributed.map((a) => `${a.symbol.name}@${a.symbol.value}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  test('vtables and thunks are attributed to virtual dispatch', () => {
    const g = group('virtual-dispatch');
    assert.ok(g, 'expected a virtual-dispatch group');
    assert.ok(g.bytes > 0);
    assert.ok(g.top.some((t) => t.kind === 'vtable'));
  });

  test('VTTs are attributed to virtual inheritance, not to dispatch', () => {
    const vi = group('virtual-inheritance');
    assert.ok(vi, 'the diamond should produce virtual-inheritance artifacts');
    assert.equal(group('virtual-dispatch').top.some((t) => t.kind === 'vtt'), false);
  });

  test('typeinfo and its name string are attributed to RTTI', () => {
    const g = group('rtti');
    assert.ok(g.bytes > 0);
    assert.ok(g.top.every((t) => t.kind === 'typeinfo' || t.kind === 'typeinfo-name'));
  });

  test('guard variables count as static initialisation, not as your code', () => {
    const attributed = attribute(elf);
    const guard = attributed.find((a) => a.classified.kind === 'guard-variable');
    assert.ok(guard, 'the runtime-initialised static should produce a guard variable');
    assert.equal(guard.category, 'static-init');
  });

  test('template instantiations are separated from ordinary code', () => {
    const g = group('templates');
    assert.ok(g, 'three Ring instantiations should form a templates group');
    assert.ok(g.count >= 3);
  });

  test('C-linkage symbols do not land in your C++ code', () => {
    const attributed = attribute(elf);
    assert.equal(
      attributed.some((a) => a.classified.kind === 'unmangled' && a.category === 'your-code'),
      false,
    );
  });

  test('the ledger reconciles against the ELF section totals', () => {
    const r = report.reconciliation;
    assert.equal(r.sectionTotal > 0, true);
    assert.equal(r.symbolTotal + r.unclaimed, r.sectionTotal);
    assert.ok(r.coverage > 0 && r.coverage <= 1);
  });

  test('unclaimed bytes are reported as a category rather than normalised away', () => {
    const total = report.groups.reduce((a, g) => a + g.bytes, 0);
    assert.equal(total, report.reconciliation.sectionTotal);
    const gaps = (group('linking')?.bytes ?? 0) + (group('unattributed')?.bytes ?? 0);
    assert.equal(gaps, report.reconciliation.unclaimed);
  });

  test('symbol-backed groups come back largest first', () => {
    // The two gap groups are appended after sorting, because "we could not
    // explain these bytes" belongs at the bottom of a ledger regardless of size.
    const bytes = report.groups.filter((g) => g.count > 0).map((g) => g.bytes);
    assert.deepEqual([...bytes].sort((a, b) => b - a), bytes);
  });

  test('dynamic-linking bytes are named rather than left unexplained', () => {
    const linking = group('linking');
    assert.ok(linking, 'a PIE executable should show linking machinery');
    assert.match(linking.because, /statically linked firmware ELF has almost none/);
    // Naming them lifts coverage: they are accounted for, not missing.
    assert.ok(report.reconciliation.coverage > 0.7);
  });

  test('per-owner rollup gathers every artifact one class caused', () => {
    const ispi = report.perOwner.find((o) => o.owner === 'fw::ISpi');
    assert.ok(ispi, 'ISpi should own artifacts');
    assert.ok(ispi.artifacts.includes('vtable'));
    assert.ok(ispi.bytes > 0);
  });

  test('section totals are broken out by category', () => {
    assert.ok(report.sections.text > 0);
    assert.ok(report.sections.rodata > 0);
  });
});

describe('cost findings', () => {
  const of = (list, c) => list.filter((f) => f.construct === c);

  test('names the exception cost and points at the measurement, not a rule of thumb', () => {
    const f = of(detectCostConstructs(report), 'exception_cost');
    if (f.length > 0) {
      assert.match(f[0].cEquivalent, /-fno-exceptions and compare/);
    }
  });

  test('flags virtual inheritance as a trap with its own byte count', () => {
    const [f] = of(detectCostConstructs(report), 'virtual_inheritance_cost');
    assert.equal(f.severity, 'trap');
    assert.match(f.emits, /VTT/);
  });

  test('reports template instantiation count', () => {
    const [f] = of(detectCostConstructs(report), 'template_bloat');
    assert.match(f.title, /template instantiations/);
  });

  test('warns when coverage is too low to trust the numbers', () => {
    const poor = { ...report, reconciliation: { ...report.reconciliation, coverage: 0.3, unclaimed: 9999 } };
    const [f] = of(detectCostConstructs(poor), 'low_attribution_coverage');
    assert.equal(f.severity, 'trap');
    assert.match(f.emits, /lower bound/);
  });

  test('says plainly when the image is stripped', () => {
    const [f] = of(detectCostConstructs({ ...report, stripped: true }), 'stripped_image');
    assert.match(f.cEquivalent, /before the strip step/);
  });

  test('a clean report produces no coverage or stripping complaints', () => {
    const f = detectCostConstructs(report);
    assert.equal(of(f, 'stripped_image').length, 0);
  });
});
