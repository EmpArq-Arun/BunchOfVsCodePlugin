/**
 * ELF reading.
 *
 * Implemented directly rather than shelling out to nm or readelf. Those are not
 * reliably present on a Windows development machine, and every external tool is
 * one more thing that has to be installed before the lens says anything. The
 * symbol table is a fixed, well-specified structure; reading it is a couple of
 * hundred lines and removes a dependency entirely.
 *
 * Both classes and both byte orders are handled, because the object under
 * analysis is a cross-compiled firmware image and the host is not. Note that the
 * field order inside a symbol entry *differs* between ELF32 and ELF64 — it is
 * not merely a width change — which is the sort of detail that produces
 * plausible nonsense rather than an error if it is got wrong.
 */

export class ElfParseError extends Error {}

export interface ElfSection {
  index: number;
  name: string;
  type: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  entSize: number;
}

export type SymbolType = 'notype' | 'object' | 'func' | 'section' | 'file' | 'common' | 'tls' | 'other';
export type SymbolBinding = 'local' | 'global' | 'weak' | 'other';

export interface ElfSymbol {
  name: string;
  value: number;
  size: number;
  type: SymbolType;
  binding: SymbolBinding;
  /** Section index; 0 is undefined, 0xfff1 absolute, 0xfff2 common. */
  sectionIndex: number;
  /** Resolved section name, or undefined for undefined/absolute symbols. */
  section?: string;
}

export interface ElfFile {
  class: 32 | 64;
  littleEndian: boolean;
  machine: number;
  sections: ElfSection[];
  symbols: ElfSymbol[];
  /** True when the symbol table came from .dynsym because .symtab was stripped. */
  stripped: boolean;
}

const SHT_SYMTAB = 2;
const SHT_DYNSYM = 11;
const SHN_UNDEF = 0;
const SHN_ABS = 0xfff1;
const SHN_COMMON = 0xfff2;

const SYMBOL_TYPES: SymbolType[] = ['notype', 'object', 'func', 'section', 'file', 'common', 'tls'];
const SYMBOL_BINDINGS: SymbolBinding[] = ['local', 'global', 'weak'];

class Reader {
  private readonly view: DataView;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly little: boolean,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  u8(at: number): number {
    this.check(at, 1);
    return this.view.getUint8(at);
  }

  u16(at: number): number {
    this.check(at, 2);
    return this.view.getUint16(at, this.little);
  }

  u32(at: number): number {
    this.check(at, 4);
    return this.view.getUint32(at, this.little);
  }

  u64(at: number): number {
    this.check(at, 8);
    const v = this.view.getBigUint64(at, this.little);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ElfParseError('64-bit value exceeds safe integer range');
    }
    return Number(v);
  }

  /** Read an address-sized field: 4 bytes on ELF32, 8 on ELF64. */
  addr(at: number, wide: boolean): number {
    return wide ? this.u64(at) : this.u32(at);
  }

  cstring(at: number): string {
    if (at < 0 || at >= this.bytes.length) {
      return '';
    }
    let end = at;
    while (end < this.bytes.length && this.bytes[end] !== 0) {
      end += 1;
    }
    return new TextDecoder('utf-8').decode(this.bytes.subarray(at, end));
  }

  private check(at: number, len: number): void {
    if (at < 0 || at + len > this.bytes.length) {
      throw new ElfParseError(`read past end of file at offset ${at}`);
    }
  }
}

export function parseElf(bytes: Uint8Array): ElfFile {
  if (bytes.length < 64 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new ElfParseError('not an ELF file — the magic bytes are missing');
  }
  const elfClass = bytes[4] === 2 ? 64 : bytes[4] === 1 ? 32 : undefined;
  if (!elfClass) {
    throw new ElfParseError(`unknown ELF class byte ${bytes[4]}`);
  }
  const dataByte = bytes[5];
  if (dataByte !== 1 && dataByte !== 2) {
    throw new ElfParseError(`unknown ELF data encoding byte ${dataByte}`);
  }
  const little = dataByte === 1;
  const wide = elfClass === 64;
  const r = new Reader(bytes, little);

  const machine = r.u16(18);
  const shoff = wide ? r.u64(0x28) : r.u32(0x20);
  const shentsize = r.u16(wide ? 0x3a : 0x2e);
  const shnum = r.u16(wide ? 0x3c : 0x30);
  const shstrndx = r.u16(wide ? 0x3e : 0x32);

  if (shoff === 0 || shnum === 0) {
    throw new ElfParseError('ELF has no section headers — it may be stripped to the point of uselessness');
  }

  // Read raw section headers first; names need the string table, which is
  // itself a section.
  const raw: Omit<ElfSection, 'name'>[] = [];
  for (let i = 0; i < shnum; i++) {
    const at = shoff + i * shentsize;
    raw.push({
      index: i,
      type: r.u32(at + 4),
      flags: wide ? r.u64(at + 8) : r.u32(at + 8),
      addr: r.addr(at + (wide ? 16 : 12), wide),
      offset: r.addr(at + (wide ? 24 : 16), wide),
      size: r.addr(at + (wide ? 32 : 20), wide),
      link: r.u32(at + (wide ? 40 : 24)),
      entSize: r.addr(at + (wide ? 56 : 36), wide),
    });
  }

  const shstrOffset = raw[shstrndx]?.offset ?? 0;
  const sections: ElfSection[] = raw.map((s, i) => ({
    ...s,
    name: r.cstring(shstrOffset + r.u32(shoff + i * shentsize)),
  }));

  // Prefer .symtab; fall back to .dynsym on a stripped image and say so, because
  // .dynsym holds only exported symbols and any attribution from it is partial.
  let table = sections.find((s) => s.type === SHT_SYMTAB);
  let stripped = false;
  if (!table) {
    table = sections.find((s) => s.type === SHT_DYNSYM);
    stripped = true;
  }

  const symbols: ElfSymbol[] = [];
  if (table && table.entSize > 0) {
    const strtab = sections[table.link];
    const strOffset = strtab?.offset ?? 0;
    const count = Math.floor(table.size / table.entSize);

    for (let i = 0; i < count; i++) {
      const at = table.offset + i * table.entSize;
      const nameOffset = r.u32(at);
      // ELF32 and ELF64 order these fields differently, not just their widths.
      const info = wide ? r.u8(at + 4) : r.u8(at + 12);
      const sectionIndex = wide ? r.u16(at + 6) : r.u16(at + 14);
      const value = wide ? r.u64(at + 8) : r.u32(at + 4);
      const size = wide ? r.u64(at + 16) : r.u32(at + 8);
      const name = r.cstring(strOffset + nameOffset);
      if (name.length === 0) {
        continue;
      }

      symbols.push({
        name,
        value,
        size,
        type: SYMBOL_TYPES[info & 0xf] ?? 'other',
        binding: SYMBOL_BINDINGS[info >> 4] ?? 'other',
        sectionIndex,
        ...(sectionIndex !== SHN_UNDEF && sectionIndex !== SHN_ABS && sectionIndex !== SHN_COMMON
          ? { section: sections[sectionIndex]?.name }
          : {}),
      });
    }
  }

  return { class: elfClass, littleEndian: little, machine, sections, symbols, stripped };
}

export function isDefined(sym: ElfSymbol): boolean {
  return sym.sectionIndex !== SHN_UNDEF;
}

/**
 * Allocated section sizes, keyed by name. These are the totals every attribution
 * has to reconcile against — an attribution that does not add up is wrong in a
 * way that is otherwise invisible.
 */
export function allocatedSections(elf: ElfFile): Map<string, number> {
  const SHF_ALLOC = 0x2;
  const out = new Map<string, number>();
  for (const s of elf.sections) {
    if ((s.flags & SHF_ALLOC) !== 0 && s.size > 0) {
      out.set(s.name, s.size);
    }
  }
  return out;
}

/**
 * Group section names into the categories an embedded engineer budgets in.
 * `-ffunction-sections` splits `.text` into thousands of `.text.*`, so grouping
 * by prefix is what makes the numbers comparable to a map file.
 */
export type SectionCategory = 'text' | 'rodata' | 'data' | 'bss' | 'unwind' | 'init' | 'linking' | 'other';

const LINKING = /^\.(dynamic|got|plt|got\.plt|rela?|interp|dynsym|dynstr|hash|gnu\.hash|gnu\.version|note)/;

export function sectionCategory(name: string): SectionCategory {
  // Dynamic-linking machinery holds few or no sized symbols. On a hosted PIE it
  // is a large share of the image; on a statically linked firmware ELF it is
  // usually absent. Either way it is a named cost rather than a shortfall in
  // the attribution.
  if (LINKING.test(name)) {
    return 'linking';
  }
  if (name.startsWith('.text')) {
    return 'text';
  }
  if (name.startsWith('.rodata')) {
    return 'rodata';
  }
  if (name.startsWith('.data.rel.ro')) {
    return 'rodata';
  }
  if (name.startsWith('.data')) {
    return 'data';
  }
  if (name.startsWith('.bss')) {
    return 'bss';
  }
  if (name.startsWith('.ARM.ex') || name.startsWith('.eh_frame') || name.startsWith('.gcc_except')) {
    return 'unwind';
  }
  if (name.startsWith('.init_array') || name.startsWith('.fini_array') || name.startsWith('.preinit')) {
    return 'init';
  }
  return 'other';
}
