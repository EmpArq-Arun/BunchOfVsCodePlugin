import type { ObservedMember, ObservedRecord, PaholeResult } from './pahole.js';

/**
 * llvm-dwarfdump ingest — the portable observed-layout source.
 *
 * pahole is Linux-only and, worse, refuses every polymorphic class (ADR 0006):
 * exactly the types whose layout a C engineer most needs explained. llvm-dwarfdump
 * has neither problem. It ships with LLVM on Windows, macOS and Linux — the same
 * LLVM already required for `lens.clang.path` — and it reads a class with a vptr
 * as readily as a plain struct.
 *
 * It also produces something pahole cannot: because the raw DIE tree carries a
 * type reference per member, sizes and holes are *computed here* from the
 * compiler's own numbers rather than read out of another tool's formatting.
 *
 * One caveat worth stating in the UI: clang's default `-g` emits limited debug
 * info, so a type used only by pointer may appear as a declaration with no
 * members. `-fstandalone-debug` (clang) or `-fno-eliminate-unused-debug-types`
 * (gcc) makes every type complete. GCC-built firmware is usually complete already.
 */

interface Die {
  offset: number;
  tag: string;
  depth: number;
  attrs: Map<string, string>;
  children: Die[];
}

const DIE_LINE = /^(0x[0-9a-f]+):(\s+)(DW_TAG_\w+|NULL)/;
const ATTR_LINE = /^\s+(DW_AT_\w+)\s+\((.*)\)\s*$/;

function parseNumber(raw: string): number | undefined {
  const m = /^(0x[0-9a-f]+|\d+)/.exec(raw.trim());
  if (!m) {
    return undefined;
  }
  const v = m[1].startsWith('0x') ? Number.parseInt(m[1], 16) : Number.parseInt(m[1], 10);
  return Number.isFinite(v) ? v : undefined;
}

function quoted(raw: string): string | undefined {
  const m = /"([^"]*)"/.exec(raw);
  return m ? m[1] : undefined;
}

/** `DW_AT_type (0x00000340 "uint8_t")` — the reference and the printed name. */
function typeRef(raw: string): { offset?: number; name: string } {
  return { offset: parseNumber(raw), name: quoted(raw) ?? raw.trim() };
}

/**
 * Rebuild the DIE tree from the flat dump.
 *
 * Nesting comes from the indentation between the offset and the tag, which
 * llvm-dwarfdump increases by two spaces per level. `NULL` entries terminate a
 * sibling chain and carry no information of their own.
 */
export function parseDies(text: string): Die[] {
  const roots: Die[] = [];
  const stack: Die[] = [];
  let current: Die | undefined;

  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const head = DIE_LINE.exec(raw);
    if (head) {
      if (head[3] === 'NULL') {
        current = undefined;
        continue;
      }
      const depth = Math.max(0, Math.floor((head[2].length - 1) / 2));
      const die: Die = {
        offset: Number.parseInt(head[1], 16),
        tag: head[3],
        depth,
        attrs: new Map(),
        children: [],
      };
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(die);
      } else {
        roots.push(die);
      }
      stack.push(die);
      current = die;
      continue;
    }

    const attr = ATTR_LINE.exec(raw);
    if (attr && current) {
      current.attrs.set(attr[1], attr[2]);
    }
  }
  return roots;
}

function flatten(dies: Die[]): Die[] {
  const out: Die[] = [];
  const walk = (list: Die[]) => {
    for (const d of list) {
      out.push(d);
      walk(d.children);
    }
  };
  walk(dies);
  return out;
}

const RECORD_TAGS: Record<string, ObservedRecord['kind']> = {
  DW_TAG_structure_type: 'struct',
  DW_TAG_class_type: 'class',
  DW_TAG_union_type: 'union',
};

/**
 * Parse a dump into the same `ObservedRecord` shape pahole produces, so the
 * merge, the findings and the byte-map renderer are all unchanged. Two providers,
 * one observed plane.
 */
export function parseDwarfDump(text: string): PaholeResult {
  const all = flatten(parseDies(text));

  // A pointer DIE frequently omits DW_AT_byte_size because the address size is
  // a property of the compilation unit. Following its DW_AT_type instead would
  // size the pointer as its pointee — four bytes for a uint32_t* on a 64-bit
  // build, which is wrong in a way that quietly moves every later offset.
  const addrSize = (() => {
    const m = /addr_size\s*=\s*(0x[0-9a-f]+|\d+)/i.exec(text);
    const v = m ? parseNumber(m[1]) : undefined;
    return v && v > 0 ? v : 4;
  })();

  const byOffset = new Map<number, Die>(all.map((d) => [d.offset, d]));

  /**
   * Size of a type, following the DW_AT_type chain.
   *
   * A member's type is very often a typedef — `uint8_t` on any embedded target —
   * and a typedef DIE carries no `DW_AT_byte_size`; the size is on whatever it
   * eventually names. Reading the size off the immediate reference yields zero
   * for almost every member on a firmware project, which then silently produces
   * a layout with no padding anywhere.
   */
  const sizeCache = new Map<number, number>();
  const resolveSize = (offset: number | undefined, seen = new Set<number>()): number => {
    if (offset === undefined || seen.has(offset)) {
      return 0;
    }
    const cached = sizeCache.get(offset);
    if (cached !== undefined) {
      return cached;
    }
    seen.add(offset);
    const die = byOffset.get(offset);
    if (!die) {
      return 0;
    }

    const direct = parseNumber(die.attrs.get('DW_AT_byte_size') ?? '');
    if (direct !== undefined) {
      sizeCache.set(offset, direct);
      return direct;
    }

    if (die.tag === 'DW_TAG_pointer_type' || die.tag === 'DW_TAG_reference_type') {
      sizeCache.set(offset, addrSize);
      return addrSize;
    }

    // An array is element size times the declared count, which lives on a child.
    if (die.tag === 'DW_TAG_array_type') {
      const element = resolveSize(parseNumber(die.attrs.get('DW_AT_type') ?? ''), seen);
      const bound = die.children
        .filter((c) => c.tag === 'DW_TAG_subrange_type')
        .map((c) => {
          const count = parseNumber(c.attrs.get('DW_AT_count') ?? '');
          if (count !== undefined) {
            return count;
          }
          const upper = parseNumber(c.attrs.get('DW_AT_upper_bound') ?? '');
          return upper !== undefined ? upper + 1 : 0;
        })
        .reduce((a, b) => a * b, 1);
      const total = element * bound;
      sizeCache.set(offset, total);
      return total;
    }

    const through = resolveSize(parseNumber(die.attrs.get('DW_AT_type') ?? ''), seen);
    sizeCache.set(offset, through);
    return through;
  };

  const records: ObservedRecord[] = [];
  const notFound: string[] = [];
  const seen = new Set<string>();

  for (const die of all) {
    const kind = RECORD_TAGS[die.tag];
    if (!kind) {
      continue;
    }
    const name = quoted(die.attrs.get('DW_AT_name') ?? '');
    const sizeRaw = die.attrs.get('DW_AT_byte_size');
    if (!name) {
      continue;
    }
    // A declaration DIE carries no size and no members. Record it as unreadable
    // rather than as an empty struct, which would claim it has no padding.
    if (sizeRaw === undefined || die.attrs.get('DW_AT_declaration') === 'true') {
      if (!seen.has(name)) {
        notFound.push(name);
      }
      continue;
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);

    const members: ObservedMember[] = [];
    let virtualBases = false;
    for (const child of die.children) {
      if (child.tag === 'DW_TAG_inheritance') {
        if (child.attrs.has('DW_AT_virtuality')) {
          virtualBases = true;
        }
        const ref = typeRef(child.attrs.get('DW_AT_type') ?? '');
        members.push({
          name: ref.name.split('::').pop() ?? ref.name,
          type: ref.name,
          offset: parseNumber(child.attrs.get('DW_AT_data_member_location') ?? '0') ?? 0,
          size: resolveSize(ref.offset),
          isAncestor: true,
        });
        continue;
      }
      if (child.tag !== 'DW_TAG_member') {
        continue;
      }
      const memberName = quoted(child.attrs.get('DW_AT_name') ?? '') ?? '';
      const ref = typeRef(child.attrs.get('DW_AT_type') ?? '');
      const bitSize = parseNumber(child.attrs.get('DW_AT_bit_size') ?? '');
      const bitOffset = parseNumber(child.attrs.get('DW_AT_data_bit_offset') ?? '');
      const declaredSize = resolveSize(ref.offset);

      // A static data member has no location: it is not part of the object.
      const locationRaw = child.attrs.get('DW_AT_data_member_location');
      if (locationRaw === undefined && bitOffset === undefined) {
        continue;
      }

      members.push({
        name: memberName,
        type: ref.name,
        offset:
          locationRaw !== undefined
            ? (parseNumber(locationRaw) ?? 0)
            : Math.floor((bitOffset ?? 0) / 8),
        size: declaredSize,
        ...(bitSize !== undefined
          ? { bits: { unit: Math.floor((bitOffset ?? 0) / 8), first: (bitOffset ?? 0) % 8, width: bitSize } }
          : {}),
      });
    }

    records.push(
      withHoles({ name, kind, members, sizeOf: parseNumber(sizeRaw) ?? 0, source: 'pahole' }, virtualBases),
    );
  }

  return { records, notFound: notFound.filter((n) => !seen.has(n)) };
}

/**
 * Compute holes from the members themselves.
 *
 * Bitfields are skipped: several share a storage unit, so treating each as
 * occupying its own bytes would invent holes that are not there. Reporting no
 * internal padding for a bitfield struct is a smaller error than reporting
 * fictional padding.
 */
function withHoles(record: ObservedRecord, virtualBases = false): ObservedRecord {
  // Base subobjects occupy real bytes and must be counted, or every polymorphic
  // class reports its base as a hole. They are still flagged as ancestors for
  // display; only the arithmetic treats them as ordinary storage.
  const laidOut = record.members
    .filter((m) => m.bits === undefined && m.size > 0)
    .sort((a, b) => a.offset - b.offset);

  if (record.kind === 'union' || laidOut.length === 0) {
    return record;
  }

  // An empty base has a DWARF byte_size of 1 but occupies nothing, so it starts
  // at the same offset as the member after it. Left alone it reads as an overlap
  // and suppresses hole detection for the whole record.
  for (let i = 0; i < laidOut.length - 1; i++) {
    if (laidOut[i].isAncestor && laidOut[i].offset === laidOut[i + 1].offset) {
      laidOut[i].size = 0;
    }
  }

  // With virtual inheritance the shared base is counted inside more than one
  // subobject, so extents overlap and gap arithmetic is meaningless. Reporting
  // nothing is correct; reporting a number would be inventing one.
  const overlapping = laidOut.some(
    (m, i) => i > 0 && m.offset < laidOut[i - 1].offset + laidOut[i - 1].size,
  );
  if (virtualBases || overlapping) {
    return record;
  }

  let holes = 0;
  let sumHoles = 0;
  let end = 0;
  for (const m of laidOut) {
    if (m.offset > end) {
      const gap = m.offset - end;
      holes += 1;
      sumHoles += gap;
      const previous = laidOut[laidOut.indexOf(m) - 1];
      if (previous) {
        previous.holeAfter = gap;
      }
    }
    end = Math.max(end, m.offset + m.size);
  }

  const sumMembers = laidOut.reduce((a, m) => a + m.size, 0);
  const padding = Math.max(0, record.sizeOf - end);

  return {
    ...record,
    sumMembers,
    ...(holes > 0 ? { holes, sumHoles } : {}),
    ...(padding > 0 ? { padding } : {}),
  };
}
