import type { Finding } from './constructs.js';
import { allocatedSections, isDefined, sectionCategory, type ElfFile, type ElfSymbol } from './elf.js';
import { classifySymbol, type ArtifactKind, type Classified } from './mangling.js';

/**
 * Cost attribution.
 *
 * The claim this module has to earn is that a number in the ledger is real. Two
 * disciplines make that possible.
 *
 * First, nothing is dropped. Every defined symbol lands in exactly one bucket,
 * including the ones that could not be demangled, and the totals are reconciled
 * against the ELF's own allocated section sizes. An attribution that does not add
 * up is wrong in a way that is otherwise completely invisible — it looks like a
 * tidy report.
 *
 * Second, unattributed bytes are named rather than hidden. The gap between the
 * sum of symbol sizes and the section total is real: alignment padding, literal
 * pools, linker-generated content. Reporting it as a category is honest;
 * silently normalising it away is not.
 */

/** The construct a group of symbols exists because of. */
export type CostCategory =
  | 'virtual-dispatch'
  | 'virtual-inheritance'
  | 'rtti'
  | 'exceptions'
  | 'static-init'
  | 'heap'
  | 'templates'
  | 'your-code'
  | 'c-code'
  | 'runtime'
  | 'linking'
  | 'unattributed';

export interface AttributedSymbol {
  symbol: ElfSymbol;
  classified: Classified;
  category: CostCategory;
  sectionCategory: ReturnType<typeof sectionCategory>;
}

export interface CostGroup {
  category: CostCategory;
  label: string;
  bytes: number;
  count: number;
  /** What the bytes are for, in the reader's language. */
  because: string;
  /** Largest contributors, for drilling in. */
  top: { name: string; bytes: number; kind: ArtifactKind }[];
}

export interface CostReport {
  groups: CostGroup[];
  total: number;
  /** Allocated section totals straight from the ELF, by category. */
  sections: Record<string, number>;
  reconciliation: {
    sectionTotal: number;
    symbolTotal: number;
    /** Bytes in allocated sections that no symbol claims. */
    unclaimed: number;
    /** Fraction of allocated bytes the ledger accounts for. */
    coverage: number;
  };
  stripped: boolean;
  perOwner: { owner: string; bytes: number; artifacts: ArtifactKind[] }[];
}

const CATEGORY_LABEL: Record<CostCategory, string> = {
  'virtual-dispatch': 'Virtual dispatch',
  'virtual-inheritance': 'Virtual inheritance',
  rtti: 'RTTI',
  exceptions: 'Exceptions',
  'static-init': 'Static initialisation',
  heap: 'Heap',
  templates: 'Template instantiations',
  'your-code': 'Your C++ code',
  'c-code': 'C code and startup',
  runtime: 'C++ runtime support',
  linking: 'Dynamic linking',
  unattributed: 'Unattributed',
};

const CATEGORY_BECAUSE: Record<CostCategory, string> = {
  'virtual-dispatch':
    'Vtables and this-adjusting thunks. One table per polymorphic class, in .rodata, plus a pointer in every object.',
  'virtual-inheritance':
    'VTTs and construction vtables. These exist only because a base is inherited virtually, and they are pure overhead if it need not be.',
  rtti: 'Typeinfo records and the type-name strings they compare. -fno-rtti removes all of it.',
  exceptions:
    'Unwind tables and the runtime that walks them. Enabling exceptions costs this whether or not anything throws.',
  'static-init':
    'Guard variables for function-local statics, and the machinery that runs constructors before main and destructors after it.',
  heap: 'operator new, operator delete, and the allocator they pull in.',
  templates: 'One copy per distinct instantiation. Near-identical bodies here are the classic source of code bloat.',
  'your-code': 'Ordinary functions you wrote. This is the part that would look the same in C.',
  'c-code': 'Symbols with C linkage: startup code, vendor SDK, and anything extern "C".',
  runtime: 'Support routines the C++ runtime requires, distinct from the features that pulled them in.',
  linking:
    'Relocation tables, the GOT and PLT, and the dynamic symbol tables. Present because this image is dynamically linked; a statically linked firmware ELF has almost none of it.',
  unattributed: 'Bytes in allocated sections that no symbol claims: alignment padding, literal pools, linker output.',
};

function categorise(c: Classified, sym: ElfSymbol): CostCategory {
  switch (c.kind) {
    case 'vtable':
    case 'thunk':
    case 'covariant-thunk':
      return 'virtual-dispatch';
    case 'vtt':
    case 'construction-vtable':
      return 'virtual-inheritance';
    case 'typeinfo':
    case 'typeinfo-name':
      return 'rtti';
    case 'guard-variable':
      return 'static-init';
    case 'runtime-support':
      return runtimeCategory(c.because);
    case 'unmangled':
      return 'c-code';
    default:
      break;
  }
  if (c.entity.includes('<...>')) {
    return 'templates';
  }
  // Symbols in unwind sections belong to exceptions regardless of their name.
  if (sym.section && sectionCategory(sym.section) === 'unwind') {
    return 'exceptions';
  }
  return 'your-code';
}

function runtimeCategory(because: string): CostCategory {
  if (because.startsWith('exceptions')) {
    return 'exceptions';
  }
  if (because.startsWith('RTTI')) {
    return 'rtti';
  }
  if (because.startsWith('thread-safe') || because.startsWith('destructors for objects')) {
    return 'static-init';
  }
  if (because.startsWith('operator new') || because.startsWith('the heap')) {
    return 'heap';
  }
  return 'runtime';
}

export function attribute(elf: ElfFile): AttributedSymbol[] {
  const seen = new Set<string>();
  const out: AttributedSymbol[] = [];

  for (const symbol of elf.symbols) {
    if (!isDefined(symbol) || symbol.size === 0 || symbol.type === 'file' || symbol.type === 'section') {
      continue;
    }
    // Weak and COMDAT symbols legitimately appear more than once; counting a
    // template instantiation twice would inflate exactly the category most
    // likely to be scrutinised.
    const key = `${symbol.name}@${symbol.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const classified = classifySymbol(symbol.name);
    out.push({
      symbol,
      classified,
      category: categorise(classified, symbol),
      sectionCategory: symbol.section ? sectionCategory(symbol.section) : 'other',
    });
  }
  return out;
}

export function buildReport(elf: ElfFile): CostReport {
  const attributed = attribute(elf);
  const sections = allocatedSections(elf);

  const sectionTotals: Record<string, number> = {};
  let sectionTotal = 0;
  for (const [name, size] of sections) {
    const cat = sectionCategory(name);
    sectionTotals[cat] = (sectionTotals[cat] ?? 0) + size;
    sectionTotal += size;
  }

  const buckets = new Map<CostCategory, AttributedSymbol[]>();
  let symbolTotal = 0;
  for (const a of attributed) {
    (buckets.get(a.category) ?? buckets.set(a.category, []).get(a.category)!).push(a);
    symbolTotal += a.symbol.size;
  }

  const groups: CostGroup[] = [...buckets.entries()]
    .map(([category, list]) => ({
      category,
      label: CATEGORY_LABEL[category],
      bytes: list.reduce((a, s) => a + s.symbol.size, 0),
      count: list.length,
      because: CATEGORY_BECAUSE[category],
      top: [...list]
        .sort((a, b) => b.symbol.size - a.symbol.size)
        .slice(0, 8)
        .map((s) => ({ name: s.classified.entity, bytes: s.symbol.size, kind: s.classified.kind })),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  // Attribute the shortfall per section rather than as one lump, so that
  // "unattributed" means genuinely unexplained bytes and not simply bytes in a
  // section whose contents were never going to carry symbols.
  const claimedBySection = new Map<string, number>();
  for (const a of attributed) {
    if (a.symbol.section) {
      claimedBySection.set(a.symbol.section, (claimedBySection.get(a.symbol.section) ?? 0) + a.symbol.size);
    }
  }
  let linkingGap = 0;
  let otherGap = 0;
  for (const [name, size] of sections) {
    const gap = Math.max(0, size - (claimedBySection.get(name) ?? 0));
    if (sectionCategory(name) === 'linking') {
      linkingGap += gap;
    } else {
      otherGap += gap;
    }
  }

  const unclaimed = Math.max(0, sectionTotal - symbolTotal);
  for (const [category, bytes] of [
    ['linking', linkingGap],
    ['unattributed', otherGap],
  ] as [CostCategory, number][]) {
    if (bytes > 0) {
      groups.push({
        category,
        label: CATEGORY_LABEL[category],
        bytes,
        count: 0,
        because: CATEGORY_BECAUSE[category],
        top: [],
      });
    }
  }

  // Per-owner rollup: what one class costs across every artifact it caused.
  const owners = new Map<string, { bytes: number; artifacts: Set<ArtifactKind> }>();
  for (const a of attributed) {
    const owner = a.classified.owner;
    if (!owner) {
      continue;
    }
    const hit = owners.get(owner) ?? { bytes: 0, artifacts: new Set<ArtifactKind>() };
    hit.bytes += a.symbol.size;
    hit.artifacts.add(a.classified.kind);
    owners.set(owner, hit);
  }

  return {
    groups,
    total: sectionTotal,
    sections: sectionTotals,
    reconciliation: {
      sectionTotal,
      symbolTotal,
      unclaimed,
      // Coverage is what the ledger *explains*, which includes bytes correctly
      // accounted for as linking machinery. Only genuinely unexplained bytes
      // count against it.
      coverage: sectionTotal > 0 ? (sectionTotal - otherGap) / sectionTotal : 0,
    },
    stripped: elf.stripped,
    perOwner: [...owners.entries()]
      .map(([owner, v]) => ({ owner, bytes: v.bytes, artifacts: [...v.artifacts] }))
      .sort((a, b) => b.bytes - a.bytes),
  };
}

/**
 * Cost findings.
 *
 * Framed as "here is what this feature costs in your image", never as advice to
 * remove it. Whether exceptions are worth 12 KB is a judgement about the product,
 * not something a reading tool gets to decide.
 */
export function detectCostConstructs(report: CostReport): Finding[] {
  const out: Finding[] = [];
  const push = (f: Omit<Finding, 'typeId' | 'qualifiedName'>, id: string) =>
    out.push({ ...f, typeId: id, qualifiedName: id });
  const pct = (b: number) => (report.total > 0 ? Math.round((b / report.total) * 100) : 0);
  const group = (c: CostCategory) => report.groups.find((g) => g.category === c);

  const exceptions = group('exceptions');
  if (exceptions) {
    push(
      {
        construct: 'exception_cost',
        severity: 'new',
        title: `Exceptions cost ${exceptions.bytes} bytes (${pct(exceptions.bytes)}% of the image)`,
        emits: exceptions.because,
        cEquivalent:
          'Error codes checked at every level. Rebuild with -fno-exceptions and compare the two images — that ' +
          'difference is the real number for this project, not a rule of thumb.',
      },
      'exceptions',
    );
  }

  const rtti = group('rtti');
  if (rtti) {
    push(
      {
        construct: 'rtti_cost',
        severity: 'new',
        title: `RTTI costs ${rtti.bytes} bytes (${pct(rtti.bytes)}%)`,
        emits: rtti.because,
        cEquivalent:
          'A type tag field and a switch. -fno-rtti removes this entirely, but also removes dynamic_cast, so ' +
          'check what uses it first.',
      },
      'rtti',
    );
  }

  const vi = group('virtual-inheritance');
  if (vi) {
    push(
      {
        construct: 'virtual_inheritance_cost',
        severity: 'trap',
        title: `Virtual inheritance costs ${vi.bytes} bytes in VTTs and construction vtables`,
        emits: vi.because,
        cEquivalent:
          'No C equivalent. This is overhead that exists purely to make a diamond hierarchy work, and it is worth ' +
          'confirming the diamond is necessary.',
      },
      'virtual-inheritance',
    );
  }

  const templates = group('templates');
  if (templates && templates.count >= 3) {
    push(
      {
        construct: 'template_bloat',
        severity: 'new',
        title: `${templates.count} template instantiations, ${templates.bytes} bytes`,
        emits: templates.because,
        cEquivalent:
          'The same struct and functions pasted once per type by a macro. Where several instantiations differ only ' +
          'in a type that does not affect the code, a non-template base can hold the shared part.',
      },
      'templates',
    );
  }

  if (report.reconciliation.coverage < 0.6 && report.total > 0) {
    push(
      {
        construct: 'low_attribution_coverage',
        severity: 'trap',
        title: `Only ${Math.round(report.reconciliation.coverage * 100)}% of allocated bytes are claimed by a symbol`,
        emits:
          `${report.reconciliation.unclaimed} bytes sit in allocated sections that no symbol accounts for. Every ` +
          'number in this ledger should be read as a lower bound.',
        cEquivalent:
          'Usually a partially stripped image, or one linked without -ffunction-sections -fdata-sections so that ' +
          'symbol sizes do not cover their sections. Rebuild with both to get a ledger that reconciles.',
      },
      'coverage',
    );
  }

  if (report.stripped) {
    push(
      {
        construct: 'stripped_image',
        severity: 'trap',
        title: 'This image has no .symtab',
        emits:
          'Attribution fell back to .dynsym, which holds only exported symbols. Most of the image is invisible to ' +
          'this analysis.',
        cEquivalent: 'Point the Cost lens at the unstripped ELF your linker produced, before the strip step.',
      },
      'stripped',
    );
  }

  return out;
}
