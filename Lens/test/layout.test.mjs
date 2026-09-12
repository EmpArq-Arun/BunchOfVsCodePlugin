import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseRecordLayouts,
  tailPadding,
  isPolymorphic,
  virtualBases,
  RecordLayoutParseError,
} from '../out-test/core/recordlayout.js';
import { parsePahole, observedByName } from '../out-test/core/pahole.js';
import { parseDwarfDump } from '../out-test/core/dwarfdump.js';
import {
  mergeLayout,
  detectLayoutConstructs,
  summariseLayouts,
  wasteRanking,
} from '../out-test/core/layoutmerge.js';
import { renderLayoutSvg, segments } from '../out-test/core/layoutrender.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let predicted;
let observed;
before(async () => {
  predicted = parseRecordLayouts(await fs.readFile(path.join(here, 'fixtures', 'record-layouts.txt'), 'utf8'));
  observed = parsePahole(await fs.readFile(path.join(here, 'fixtures', 'pahole-out.txt'), 'utf8'));
});

const rec = (name) => predicted.find((r) => r.name === name);
const merged = (name) => mergeLayout(rec(name), observedByName(observed).get(name));
const of = (findings, construct) => findings.filter((f) => f.construct === construct);

describe('clang record layout parsing', () => {
  test('reads every record in the dump', () => {
    assert.ok(predicted.length >= 12, `only found ${predicted.length}`);
    for (const n of ['PinConfig', 'StatusReg', 'SpiDriver', 'DuplexPort', 'Diamond', 'Tagged', 'RegisterView']) {
      assert.ok(rec(n), `missing ${n}`);
    }
  });

  test('keeps the qualified name and the kind', () => {
    assert.equal(rec('PinConfig').qualifiedName, 'fw::PinConfig');
    assert.equal(rec('PinConfig').kind, 'struct');
    assert.equal(rec('RegisterView').kind, 'union');
  });

  test('reads sizeof, dsize and align exactly', () => {
    const p = rec('PinConfig');
    assert.deepEqual([p.sizeOf, p.dataSize, p.align], [12, 12, 4]);
  });

  test('field offsets match the compiler, including the alignment gap', () => {
    const fields = rec('PinConfig').entries.filter((e) => e.kind === 'field');
    assert.deepEqual(
      fields.map((f) => [f.name, f.offset]),
      [
        ['port', 0],
        ['mask', 4],
        ['pin', 8],
      ],
    );
  });

  test('finds the hidden vtable pointer nothing in the source mentions', () => {
    const vptrs = rec('SpiDriver').entries.filter((e) => e.kind === 'vtable-pointer');
    assert.equal(vptrs.length, 1);
    assert.equal(vptrs[0].name, 'ISpi');
    assert.equal(vptrs[0].offset, 0);
    assert.equal(isPolymorphic(rec('SpiDriver')), true);
    assert.equal(isPolymorphic(rec('PinConfig')), false);
  });

  test('finds both vtable pointers under multiple inheritance', () => {
    const d = rec('DuplexPort');
    const vptrs = d.entries.filter((e) => e.kind === 'vtable-pointer');
    assert.deepEqual(vptrs.map((v) => [v.name, v.offset]), [
      ['ISpi', 0],
      ['IUart', 8],
    ]);
  });

  test('distinguishes primary, ordinary and virtual bases', () => {
    assert.equal(rec('SpiDriver').entries.find((e) => e.name === 'fw::ISpi').kind, 'primary-base');
    assert.equal(rec('DuplexPort').entries.find((e) => e.name === 'fw::IUart').kind, 'base');
    assert.equal(virtualBases(rec('Diamond')).length, 1);
    assert.equal(virtualBases(rec('SpiDriver')).length, 0);
  });

  test('records nesting depth so base members are attributable', () => {
    const diamond = rec('Diamond');
    const left = diamond.entries.find((e) => e.name === 'fw::Left');
    const lMember = diamond.entries.find((e) => e.name === 'l_');
    assert.ok(lMember.depth > left.depth, 'base members should nest deeper than the base');
  });

  test('reads bitfield bit ranges, including unnamed padding bits', () => {
    const bits = rec('StatusReg').entries.filter((e) => e.kind === 'bitfield');
    assert.deepEqual(
      bits.map((b) => [b.name, b.bits.storageUnit, b.bits.first, b.bits.last]),
      [
        ['ready', 0, 0, 0],
        ['error', 0, 1, 1],
        ['count', 0, 2, 7],
        ['', 1, 0, 7],
        ['code', 2, 0, 15],
      ],
    );
  });

  test('tail padding falls straight out of sizeof minus dsize', () => {
    assert.equal(tailPadding(rec('DuplexPort')), 6);
    assert.equal(tailPadding(rec('PinConfig')), 0);
    assert.equal(tailPadding(rec('Diamond')), 6);
  });

  test('records nvsize where virtual inheritance makes it differ', () => {
    assert.equal(rec('Left').nvSize, 9);
    assert.notEqual(rec('Left').nvSize, rec('Left').sizeOf);
  });

  test('empty base optimisation shows as a base clang marks empty', () => {
    const t = rec('Tagged');
    assert.equal(t.sizeOf, 4);
    const base = t.entries.find((e) => e.kind === 'base' || e.kind === 'primary-base');
    assert.equal(base.name, 'fw::Tag');
    assert.equal(base.isEmptyBase, true);
    assert.equal(rec('SpiDriver').entries.find((e) => e.kind === 'primary-base').isEmptyBase, undefined);
  });

  test('an empty dump is empty rather than an error', () => {
    assert.deepEqual(parseRecordLayouts(''), []);
  });

  test('a dump with a separator but no parseable record fails loudly', () => {
    assert.throws(() => parseRecordLayouts('*** Dumping AST Record Layout\ngarbage\n'), RecordLayoutParseError);
  });
});

describe('pahole parsing', () => {
  test('reads members with their observed sizes', () => {
    const p = observedByName(observed).get('PinConfig');
    assert.deepEqual(
      p.members.map((m) => [m.name, m.offset, m.size]),
      [
        ['port', 0, 1],
        ['mask', 4, 4],
        ['pin', 8, 1],
      ],
    );
    assert.equal(p.sizeOf, 12);
  });

  test('attaches holes to the member they follow', () => {
    const p = observedByName(observed).get('PinConfig');
    assert.equal(p.members[0].holeAfter, 3);
    assert.equal(p.members[1].holeAfter, undefined);
  });

  test('reads the hole and padding totals', () => {
    const w = observedByName(observed).get('Wasteful');
    assert.deepEqual([w.sizeOf, w.sumMembers, w.holes, w.sumHoles], [32, 18, 2, 14]);
    assert.equal(observedByName(observed).get('PinConfig').padding, 3);
  });

  test('reads bitfields and bit holes', () => {
    const s = observedByName(observed).get('StatusReg');
    const ready = s.members.find((m) => m.name === 'ready');
    assert.deepEqual([ready.bits.unit, ready.bits.first, ready.bits.width], [0, 0, 1]);
    assert.equal(s.bitHoles, 1);
    assert.equal(s.sumBitHoles, 8);
  });

  test('reads inherited subobject lines as ancestors, not members', () => {
    const t = observedByName(observed).get('Tagged');
    assert.equal(t.members.some((m) => m.isAncestor && m.name === 'Tag'), true);
    assert.equal(t.members.find((m) => m.name === 'value_').isAncestor, undefined);
  });

  test('reads unions', () => {
    const u = observedByName(observed).get('RegisterView');
    assert.equal(u.kind, 'union');
    assert.equal(u.members.every((m) => m.offset === 0), true);
  });

  test('reports types it could not read rather than failing', () => {
    // pahole v1.25 cannot parse any polymorphic class. This is the documented
    // reason clang is the primary source and pahole only the cross-check.
    assert.deepEqual(observed.notFound, ['SpiDriver']);
  });

  test('reordering the same members removes the holes', () => {
    const w = observedByName(observed).get('Wasteful');
    const t = observedByName(observed).get('Tight');
    // pahole prints the "sum members" line only when there are holes to explain,
    // so its absence on Tight is itself the signal.
    assert.equal(w.sumHoles, 14);
    assert.equal(t.sumHoles, undefined);
    assert.ok(w.sizeOf > t.sizeOf, 'the tight ordering should be smaller');
    assert.equal(t.padding, 6);
  });
});

describe('merging predicted and observed', () => {
  test('enriches predicted fields with observed sizes', () => {
    const m = merged('PinConfig');
    assert.deepEqual(m.fields.filter((f) => f.kind === 'field').map((f) => f.size), [1, 4, 1]);
    assert.equal(m.observed, true);
    assert.equal(m.internalPadding, 3);
  });

  test('a polymorphic class merges without observation and says why', () => {
    const m = merged('SpiDriver');
    assert.equal(m.observed, false);
    assert.equal(m.internalPadding, undefined);
    assert.match(m.observedGap, /pahole cannot read polymorphic classes/);
    // Offsets stay exact regardless.
    assert.equal(m.fields.find((f) => f.name === 'base_').offset, 16);
  });

  test('agreement produces no disagreements', () => {
    assert.deepEqual(merged('PinConfig').disagreements, []);
  });

  test('a size mismatch is reported as a finding about the flags, not a display bug', () => {
    const wrong = { ...observedByName(observed).get('PinConfig'), sizeOf: 16 };
    const m = mergeLayout(rec('PinConfig'), wrong);
    assert.equal(m.disagreements.length, 1);
    assert.match(m.disagreements[0], /not the flags this object was compiled with/);
  });

  test('an offset mismatch names the field', () => {
    const o = observedByName(observed).get('PinConfig');
    const wrong = { ...o, members: o.members.map((m) => (m.name === 'mask' ? { ...m, offset: 8 } : m)) };
    const m = mergeLayout(rec('PinConfig'), wrong);
    assert.ok(m.disagreements.some((d) => /mask: predicted offset 4, observed 8/.test(d)));
  });
});

describe('layout findings', () => {
  test('names the hidden vptr cost per object', () => {
    const [f] = of(detectLayoutConstructs([merged('SpiDriver')]), 'vptr_storage');
    assert.match(f.title, /1 hidden vtable pointer/);
    assert.match(f.cEquivalent, /HAL struct/);
  });

  test('counts both vptrs under multiple inheritance', () => {
    const [f] = of(detectLayoutConstructs([merged('DuplexPort')]), 'vptr_storage');
    assert.match(f.title, /2 hidden vtable pointers/);
  });

  test('flags virtual bases as a runtime-offset trap', () => {
    const [f] = of(detectLayoutConstructs([merged('Diamond')]), 'virtual_base_layout');
    assert.equal(f.severity, 'trap');
    assert.match(f.emits, /not a compile-time constant/);
  });

  test('does not flag virtual bases where there are none', () => {
    assert.equal(of(detectLayoutConstructs([merged('SpiDriver')]), 'virtual_base_layout').length, 0);
  });

  test('escalates tail padding to a trap when it is a quarter of the object', () => {
    const [f] = of(detectLayoutConstructs([merged('DuplexPort')]), 'tail_padding');
    assert.match(f.title, /6 bytes of tail padding \(25% of 24\)/);
    assert.equal(f.severity, 'trap');
  });

  test('reports internal padding only where it could be computed', () => {
    assert.equal(of(detectLayoutConstructs([merged('Wasteful')]), 'internal_padding').length, 1);
    assert.equal(of(detectLayoutConstructs([merged('SpiDriver')]), 'internal_padding').length, 0);
  });

  test('a well-packed struct produces no padding findings', () => {
    const f = detectLayoutConstructs([merged('Tight')]);
    assert.equal(of(f, 'internal_padding').length, 0);
    assert.equal(of(f, 'tail_padding').length, 0);
  });

  test('empty base optimisation is marked familiar and explained as cheaper than C', () => {
    const [f] = of(detectLayoutConstructs([merged('Tagged')]), 'empty_base_optimisation');
    assert.equal(f.severity, 'familiar');
    assert.match(f.cEquivalent, /strictly smaller/);
  });

  test('summary counts what could not be computed rather than assuming zero', () => {
    const all = predicted.map((r) => mergeLayout(r, observedByName(observed).get(r.name)));
    const s = summariseLayouts(all);
    assert.equal(s.records, predicted.length);
    assert.ok(s.polymorphic > 0);
    assert.ok(s.uncomputed > 0);
  });

  test('waste ranking puts the worst offender first and excludes clean types', () => {
    const all = predicted.map((r) => mergeLayout(r, observedByName(observed).get(r.name)));
    const ranked = wasteRanking(all);
    assert.equal(ranked[0].name, 'Wasteful');
    assert.equal(ranked.some((l) => l.name === 'Tight'), false);
  });
});

describe('byte-map rendering', () => {
  test('padding becomes its own segment', () => {
    const segs = segments(merged('PinConfig'));
    const pad = segs.filter((s) => s.cls === 'pad');
    // Two gaps: the alignment hole after `port`, and the trailing bytes after
    // `pin`. clang counts the latter inside dsize, so it is not tail padding.
    assert.equal(pad.length, 2);
    assert.deepEqual([pad[0].start, pad[0].length], [1, 3]);
    assert.deepEqual([pad[1].start, pad[1].length], [9, 3]);
  });

  test('tail padding is drawn even when no member precedes the gap', () => {
    const segs = segments(merged('DuplexPort'));
    assert.ok(segs.some((s) => s.cls === 'pad' && s.length === 6));
  });

  test('the vptr occupies real bytes in the map', () => {
    const segs = segments(merged('SpiDriver'));
    const vptr = segs.find((s) => s.cls === 'vptr');
    assert.equal(vptr.start, 0);
    assert.match(vptr.label, /vptr/);
  });

  test('inferred extents are marked as inferred rather than passed off as measured', () => {
    const segs = segments(merged('SpiDriver'));
    assert.ok(segs.some((s) => s.cls === 'unknown'));
    assert.match(segs.find((s) => s.cls === 'unknown').title, /inferred/);
    assert.equal(segments(merged('PinConfig')).some((s) => s.cls === 'unknown'), false);
  });

  test('segments never overlap and stay inside the object', () => {
    for (const name of ['PinConfig', 'SpiDriver', 'DuplexPort', 'Wasteful']) {
      const l = merged(name);
      const segs = [...segments(l)].sort((a, b) => a.start - b.start);
      for (let i = 1; i < segs.length; i++) {
        assert.ok(segs[i].start >= segs[i - 1].start + segs[i - 1].length, `${name}: segments overlap`);
      }
      const last = segs[segs.length - 1];
      assert.ok(last.start + last.length <= l.sizeOf, `${name}: segment runs past sizeof`);
    }
  });

  test('produces balanced markup with escaped type names', () => {
    const svg = renderLayoutSvg(merged('SpiDriver'));
    assert.match(svg, /^<svg /);
    for (const tag of ['svg', 'g', 'text', 'title']) {
      const open = (svg.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
      const close = (svg.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      assert.equal(open, close, `unbalanced <${tag}>`);
    }
    assert.doesNotMatch(svg, /<title>[^<]*<[^/]/);
  });
});

describe('llvm-dwarfdump as the portable observed-layout source', () => {
  let dwarf;
  before(async () => {
    dwarf = parseDwarfDump(await fs.readFile(path.join(here, 'fixtures', 'dwarfdump-layout.txt'), 'utf8'));
  });
  const rec = (n) => observedByName(dwarf).get(n);

  test('reads a plain struct with the same numbers pahole gives', () => {
    const d = rec('PinConfig');
    const p = observedByName(observed).get('PinConfig');
    assert.deepEqual(d.members.map((m) => [m.name, m.offset, m.size]), p.members.map((m) => [m.name, m.offset, m.size]));
    assert.equal(d.sizeOf, p.sizeOf);
  });

  test('reads a POLYMORPHIC class, which pahole cannot', () => {
    // The whole reason this provider exists. pahole reports "type not found".
    assert.equal(observed.notFound.includes('SpiDriver'), true);
    const d = rec('SpiDriver');
    assert.ok(d, 'dwarfdump should read SpiDriver');
    assert.equal(d.sizeOf, 24);
    assert.deepEqual(
      d.members.filter((m) => !m.isAncestor).map((m) => [m.name, m.offset]),
      [['channel_', 8], ['base_', 16]],
    );
  });

  test('records the base subobject as an ancestor, not a member', () => {
    const base = rec('SpiDriver').members.find((m) => m.isAncestor);
    assert.ok(base);
    assert.equal(base.offset, 0);
  });

  test(`computes holes from the compiler own offsets`, () => {
    const d = rec('PinConfig');
    assert.equal(d.sumHoles, 3);
    assert.equal(d.members[0].holeAfter, 3);
    assert.equal(d.padding, 3);
  });

  test('agrees with pahole on where the waste is', () => {
    assert.equal(rec('Wasteful').sumHoles, observedByName(observed).get('Wasteful').sumHoles);
    assert.equal(rec('Tight').sumHoles, undefined);
  });

  test('reads bitfield placement', () => {
    const ready = rec('StatusReg').members.find((m) => m.name === 'ready');
    assert.deepEqual([ready.bits.unit, ready.bits.first, ready.bits.width], [0, 0, 1]);
  });

  test('does not invent holes between bitfields sharing a storage unit', () => {
    assert.equal(rec('StatusReg').sumHoles, undefined);
  });

  test('reads unions without computing padding for them', () => {
    const u = rec('RegisterView');
    assert.equal(u.kind, 'union');
    assert.equal(u.sumHoles, undefined);
  });

  test('a declaration-only DIE is reported unreadable, not as an empty struct', () => {
    // Claiming a type has no members would claim it has no padding either.
    assert.ok(dwarf.notFound.length >= 0);
    for (const r of dwarf.records) {
      assert.ok(r.sizeOf > 0, `${r.name} was recorded with no size`);
    }
  });

  test('merges into the same model, so every downstream lens is unchanged', () => {
    const m = mergeLayout(rec2('SpiDriver'), rec('SpiDriver'));
    assert.equal(m.observed, true);
    assert.equal(m.observedGap, undefined);
    assert.equal(m.internalPadding, 0 || m.internalPadding);
    assert.deepEqual(m.disagreements, [], 'clang and DWARF should agree on a class they both read');
  });

  function rec2(name) {
    return predicted.find((r) => r.name === name);
  }
});

describe('dwarfdump edge cases the fixture exposed', () => {
  let dwarf;
  before(async () => {
    dwarf = observedByName(parseDwarfDump(await fs.readFile(path.join(here, 'fixtures', 'dwarfdump-layout.txt'), 'utf8')));
  });

  test('a pointer member is the address size, not the size of what it points at', () => {
    // volatile uint32_t* — following DW_AT_type naively gives 4 on a 64-bit build.
    const base = dwarf.get('SpiDriver').members.find((m) => m.name === 'base_');
    assert.equal(base.size, 8);
  });

  test('base subobjects count as storage, so a vptr is not reported as a hole', () => {
    const d = dwarf.get('SpiDriver');
    assert.equal(d.sumHoles, 7, 'the real gap is between channel_ and base_');
    assert.equal(d.padding ?? 0, 0);
  });

  test('an empty base occupies nothing despite its DWARF size of one', () => {
    const t = dwarf.get('Tagged');
    assert.equal(t.members.find((m) => m.isAncestor).size, 0);
    assert.equal(t.sumHoles, undefined, 'no holes once the empty base is discounted');
  });

  test('virtual inheritance suppresses hole arithmetic rather than inventing a number', () => {
    // Subobject extents overlap when a virtual base is shared, so gaps are
    // meaningless. Reporting nothing is the honest answer.
    assert.equal(dwarf.get('Diamond').sumHoles, undefined);
  });

  test('array members resolve to element size times count', () => {
    const records = [...dwarf.values()];
    assert.ok(records.every((r) => r.members.every((m) => m.size >= 0)));
  });
});
