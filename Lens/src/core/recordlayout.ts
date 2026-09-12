/**
 * clang record layout ingest.
 *
 * `clang++ -Xclang -fdump-record-layouts -fsyntax-only` prints the exact layout
 * the compiler will use, for the target the flags describe. It is the primary
 * source rather than the cross-check, for a reason established empirically and
 * recorded in ADR 0006: pahole cannot read polymorphic C++ classes, which are
 * precisely the ones whose layout surprises a C engineer.
 *
 * What this dump gives exactly: every field offset, vptr positions, base
 * subobject positions and their kind, bitfield bit ranges, `sizeof`, `dsize`,
 * and therefore tail padding. What it does not give is per-field sizes, so
 * internal holes cannot be computed from it alone — see `layoutmerge`.
 */

export type EntryKind =
  | 'field'
  | 'bitfield'
  | 'vtable-pointer'
  | 'vbase-offset'
  | 'base'
  | 'primary-base'
  | 'virtual-base'
  | 'primary-virtual-base';

export interface LayoutEntry {
  /** Byte offset from the start of the most-derived object. */
  offset: number;
  /** Nesting depth: 0 is a direct member, 1 a member of a base subobject. */
  depth: number;
  kind: EntryKind;
  /** Member name, base class name, or empty for an unnamed bitfield. */
  name: string;
  /** Declared type as clang printed it. */
  type: string;
  /** Bitfield placement, when `kind` is `bitfield`. */
  bits?: { storageUnit: number; first: number; last: number };
  /**
   * clang marks a base contributing no storage as `(empty)`. That marker is the
   * reliable signal for empty base optimisation — inferring it from offsets
   * cannot distinguish an empty base from one that merely starts at zero.
   */
  isEmptyBase?: boolean;
}

export interface LayoutRecord {
  /** Fully qualified, e.g. `fw::SpiDriver`. */
  qualifiedName: string;
  name: string;
  kind: 'struct' | 'class' | 'union';
  entries: LayoutEntry[];
  sizeOf: number;
  /** Data size: `sizeof` minus tail padding. */
  dataSize: number;
  align: number;
  /** Size ignoring virtual bases. Differs from `sizeOf` only with virtual inheritance. */
  nvSize?: number;
  nvAlign?: number;
  source: 'clang';
}

export class RecordLayoutParseError extends Error {}

const SEPARATOR = '*** Dumping AST Record Layout';
const HEADER = /^\s*(\d+)\s*\|\s*(struct|class|union)\s+(\S.*?)\s*$/;
const ENTRY = /^(\s*)(?:(\d+)|(\d+):(\d+)-(\d+))\s*\|(\s*)(.*?)\s*$/;
const FOOTER = /\[?sizeof=(\d+),\s*dsize=(\d+),\s*align=(\d+)/;
const NV = /nvsize=(\d+),\s*nvalign=(\d+)/;

/** Indentation inside the dump is two spaces per nesting level after the bar. */
function depthOf(afterBar: string): number {
  return Math.max(0, Math.floor((afterBar.length - 1) / 2));
}

function classifyBase(label: string): { kind: EntryKind; name: string; empty: boolean } | undefined {
  const m = /^(struct|class|union)\s+(\S+)\s+\((primary base|base|primary virtual base|virtual base)\)(.*)$/.exec(
    label,
  );
  if (!m) {
    return undefined;
  }
  const kind = (
    {
      'primary base': 'primary-base',
      base: 'base',
      'primary virtual base': 'primary-virtual-base',
      'virtual base': 'virtual-base',
    } as const
  )[m[3] as 'base'];
  return { kind, name: m[2], empty: /\(empty\)/.test(m[4] ?? '') };
}

function parseEntry(line: string): LayoutEntry | undefined {
  const m = ENTRY.exec(line);
  if (!m) {
    return undefined;
  }
  const [, , byteOffset, unit, firstBit, lastBit, afterBar, label] = m;
  if (label.length === 0) {
    return undefined;
  }
  const depth = depthOf(afterBar);

  // A vtable pointer is printed as a parenthesised note, not a member.
  const vptr = /^\((.+) vtable pointer\)$/.exec(label);
  if (vptr) {
    return { offset: Number(byteOffset ?? 0), depth, kind: 'vtable-pointer', name: vptr[1], type: 'vptr' };
  }
  const vbase = /^\(vbase offset|^\((.+) vbtable pointer\)$/.exec(label);
  if (vbase) {
    return { offset: Number(byteOffset ?? 0), depth, kind: 'vbase-offset', name: label, type: 'vbase' };
  }

  const base = classifyBase(label);
  if (base) {
    return {
      offset: Number(byteOffset ?? 0),
      depth,
      kind: base.kind,
      name: base.name,
      type: label,
      ...(base.empty ? { isEmptyBase: true } : {}),
    };
  }

  if (unit !== undefined) {
    // `0:2-7 |   uint32_t count` — the name may be absent for padding bits.
    const split = label.lastIndexOf(' ');
    const type = split > 0 ? label.slice(0, split) : label;
    const name = split > 0 ? label.slice(split + 1) : '';
    return {
      offset: Number(unit),
      depth,
      kind: 'bitfield',
      name,
      type: type.trim(),
      bits: { storageUnit: Number(unit), first: Number(firstBit), last: Number(lastBit) },
    };
  }

  const split = label.lastIndexOf(' ');
  return {
    offset: Number(byteOffset ?? 0),
    depth,
    kind: 'field',
    name: split > 0 ? label.slice(split + 1) : '',
    type: split > 0 ? label.slice(0, split).trim() : label,
  };
}

export function parseRecordLayouts(text: string): LayoutRecord[] {
  const blocks = text
    .split(SEPARATOR)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const records: LayoutRecord[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const head = HEADER.exec(lines[0]);
    if (!head) {
      continue;
    }
    const qualifiedName = head[3];
    const entries: LayoutEntry[] = [];
    let sizeOf: number | undefined;
    let dataSize: number | undefined;
    let align: number | undefined;
    let nvSize: number | undefined;
    let nvAlign: number | undefined;

    for (const line of lines.slice(1)) {
      const footer = FOOTER.exec(line);
      if (footer) {
        sizeOf = Number(footer[1]);
        dataSize = Number(footer[2]);
        align = Number(footer[3]);
        continue;
      }
      const nv = NV.exec(line);
      if (nv) {
        nvSize = Number(nv[1]);
        nvAlign = Number(nv[2]);
        continue;
      }
      const entry = parseEntry(line);
      if (entry) {
        entries.push(entry);
      }
    }

    if (sizeOf === undefined || dataSize === undefined || align === undefined) {
      // A record with no footer is a nested dump fragment, not a record.
      continue;
    }

    records.push({
      qualifiedName,
      name: qualifiedName.split('::').pop() ?? qualifiedName,
      kind: head[2] as LayoutRecord['kind'],
      entries,
      sizeOf,
      dataSize,
      align,
      ...(nvSize !== undefined ? { nvSize, nvAlign } : {}),
      source: 'clang',
    });
  }

  if (records.length === 0 && text.includes(SEPARATOR)) {
    throw new RecordLayoutParseError('record layout dump contained no parseable records');
  }
  return records;
}

/** Bytes of padding after the last member — exact, straight from the dump. */
export function tailPadding(r: LayoutRecord): number {
  return Math.max(0, r.sizeOf - r.dataSize);
}

/** True when the record carries at least one vptr, directly or in a base. */
export function isPolymorphic(r: LayoutRecord): boolean {
  return r.entries.some((e) => e.kind === 'vtable-pointer');
}

export function virtualBases(r: LayoutRecord): LayoutEntry[] {
  return r.entries.filter((e) => e.kind === 'virtual-base' || e.kind === 'primary-virtual-base');
}
