/**
 * pahole ingest.
 *
 * pahole reads the DWARF your real compiler emitted, so where it works it is
 * ground truth rather than prediction. It supplies the one thing clang's record
 * layout dump cannot: per-member sizes, and therefore internal holes.
 *
 * Where it does not work is the important caveat. pahole v1.25 reports "type not
 * found" for every polymorphic class — the types are present in the DWARF, it
 * simply will not parse them — so it is a secondary, best-effort source rather
 * than the primary one. See ADR 0006.
 *
 * The parser therefore treats a missing type as an ordinary outcome to be
 * reported, not an error.
 */

export interface ObservedMember {
  name: string;
  type: string;
  offset: number;
  size: number;
  /** Bit placement for bitfield members. */
  bits?: { unit: number; first: number; width: number };
  /** Bytes of hole immediately after this member, if pahole flagged one. */
  holeAfter?: number;
  /** Bits of hole after this bitfield member. */
  bitHoleAfter?: number;
  /** True for an inherited subobject line rather than a declared member. */
  isAncestor?: boolean;
}

export interface ObservedRecord {
  name: string;
  kind: 'struct' | 'union' | 'class';
  members: ObservedMember[];
  sizeOf: number;
  /** Sum of declared member sizes, as pahole computes it. */
  sumMembers?: number;
  holes?: number;
  sumHoles?: number;
  bitHoles?: number;
  sumBitHoles?: number;
  padding?: number;
  source: 'pahole';
}

export interface PaholeResult {
  records: ObservedRecord[];
  /** Types pahole was asked for and could not read. Expected for polymorphic classes. */
  notFound: string[];
}

const HEAD = /^(struct|union|class)\s+([A-Za-z_]\w*)(?:\s*:\s*[^{]+)?\s*\{/;
const MEMBER = /^\s*(.+?)\s{2,}([A-Za-z_]\w*)(?::(\d+))?;\s*\/\*\s*(\d+)(?::\s*(\d+))?\s+(\d+)\s*\*\/\s*$/;
const ANON_BITFIELD = /^\s*(.+?)\s+:(\d+);\s*$/;
const ANCESTOR = /^\s*\/\*\s*(struct|class)\s+(\S+)\s+<ancestor>;\s*\*\/\s*\/\*\s*(\d+)\s+(\d+)\s*\*\/\s*$/;
const HOLE = /\/\* XXX (\d+) bytes? hole/;
const BIT_HOLE = /\/\* XXX (\d+) bits? hole/;
const SIZE = /\/\* size: (\d+),/;
const SUM = /\/\* sum members: (\d+), holes: (\d+), sum holes: (\d+)/;
const BIT_SUM = /bit holes: (\d+), sum bit holes: (\d+) bits/;
const PADDING = /\/\* padding: (\d+) \*\//;
const NOT_FOUND = /^pahole: type '([^']+)' not found/;

export function parsePahole(text: string): PaholeResult {
  const records: ObservedRecord[] = [];
  const notFound: string[] = [];

  let current: ObservedRecord | undefined;
  let pendingHole: number | undefined;
  let pendingBitHole: number | undefined;

  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const missing = NOT_FOUND.exec(raw);
    if (missing) {
      notFound.push(missing[1]);
      continue;
    }

    if (!current) {
      const head = HEAD.exec(raw);
      if (head) {
        current = { name: head[2], kind: head[1] as ObservedRecord['kind'], members: [], sizeOf: 0, source: 'pahole' };
      }
      continue;
    }

    // Holes are announced on their own line *before* the member that follows,
    // but describe the gap after the previous one.
    const hole = HOLE.exec(raw);
    if (hole) {
      pendingHole = Number(hole[1]);
      const last = current.members[current.members.length - 1];
      if (last) {
        last.holeAfter = pendingHole;
      }
      continue;
    }
    const bitHole = BIT_HOLE.exec(raw);
    if (bitHole) {
      pendingBitHole = Number(bitHole[1]);
      const last = current.members[current.members.length - 1];
      if (last) {
        last.bitHoleAfter = pendingBitHole;
      }
      continue;
    }

    const ancestor = ANCESTOR.exec(raw);
    if (ancestor) {
      current.members.push({
        name: ancestor[2],
        type: `${ancestor[1]} ${ancestor[2]}`,
        offset: Number(ancestor[3]),
        size: Number(ancestor[4]),
        isAncestor: true,
      });
      continue;
    }

    const member = MEMBER.exec(raw);
    if (member) {
      const [, type, name, bitWidth, offset, bitOffset, size] = member;
      current.members.push({
        name,
        type: type.trim(),
        offset: Number(offset),
        size: Number(size),
        ...(bitWidth !== undefined
          ? { bits: { unit: Number(offset), first: Number(bitOffset ?? 0), width: Number(bitWidth) } }
          : {}),
      });
      continue;
    }

    // An unnamed bitfield carries no offset comment at all.
    const anon = ANON_BITFIELD.exec(raw);
    if (anon && !raw.includes('/*')) {
      current.members.push({ name: '', type: anon[1].trim(), offset: 0, size: 0, bits: { unit: 0, first: 0, width: Number(anon[2]) } });
      continue;
    }

    const size = SIZE.exec(raw);
    if (size) {
      current.sizeOf = Number(size[1]);
    }
    const sum = SUM.exec(raw);
    if (sum) {
      current.sumMembers = Number(sum[1]);
      current.holes = Number(sum[2]);
      current.sumHoles = Number(sum[3]);
    }
    const bitSum = BIT_SUM.exec(raw);
    if (bitSum) {
      current.bitHoles = Number(bitSum[1]);
      current.sumBitHoles = Number(bitSum[2]);
    }
    const padding = PADDING.exec(raw);
    if (padding) {
      current.padding = Number(padding[1]);
    }

    if (raw.trimStart().startsWith('}')) {
      records.push(current);
      current = undefined;
      pendingHole = undefined;
      pendingBitHole = undefined;
    }
  }

  return { records, notFound };
}

export function observedByName(result: PaholeResult): Map<string, ObservedRecord> {
  return new Map(result.records.map((r) => [r.name, r]));
}
