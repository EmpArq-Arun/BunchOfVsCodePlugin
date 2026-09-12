import type { Finding } from './constructs.js';
import type { ObservedRecord } from './pahole.js';
import { isPolymorphic, tailPadding, type LayoutEntry, type LayoutRecord } from './recordlayout.js';

/**
 * Merging the two layout planes.
 *
 * clang predicts; pahole observes. Where both can see a type, agreement is
 * confirmation and disagreement is a finding rather than an error to suppress —
 * it means the flags Lens analysed with differ from the flags the object was
 * built with, which is worth knowing far more than a tidy diagram is.
 *
 * Where only clang can see the type — every polymorphic class, on pahole v1.25 —
 * the merged record says so. Offsets and tail padding remain exact; internal
 * holes are simply not computed, and the UI reports that rather than implying
 * there are none.
 */

export interface MergedField extends LayoutEntry {
  /** Observed size in bytes, when pahole supplied one. */
  size?: number;
  /** Bytes of padding immediately after this field, when known. */
  padAfter?: number;
}

export interface MergedLayout {
  qualifiedName: string;
  name: string;
  kind: LayoutRecord['kind'];
  fields: MergedField[];
  sizeOf: number;
  dataSize: number;
  align: number;
  tailPadding: number;
  polymorphic: boolean;
  /** Total internal padding, or undefined when it could not be computed. */
  internalPadding?: number;
  observed: boolean;
  /** Why the observed plane is missing, when it is. */
  observedGap?: string;
  disagreements: string[];
}

export function mergeLayout(predicted: LayoutRecord, observed?: ObservedRecord): MergedLayout {
  const fields: MergedField[] = predicted.entries.map((e) => ({ ...e }));
  const disagreements: string[] = [];

  if (observed) {
    if (observed.sizeOf !== predicted.sizeOf) {
      disagreements.push(
        `sizeof differs: clang predicts ${predicted.sizeOf}, the built object has ${observed.sizeOf}. ` +
          'The flags Lens analysed with are not the flags this object was compiled with.',
      );
    }
    const byName = new Map(observed.members.filter((m) => !m.isAncestor).map((m) => [m.name, m]));
    for (const f of fields) {
      const o = byName.get(f.name);
      if (!o) {
        continue;
      }
      f.size = o.size;
      if (o.holeAfter !== undefined) {
        f.padAfter = o.holeAfter;
      }
      if (f.kind === 'field' && o.offset !== f.offset) {
        disagreements.push(`${f.name}: predicted offset ${f.offset}, observed ${o.offset}`);
      }
    }
  }

  const internalPadding = observed?.sumHoles;

  return {
    qualifiedName: predicted.qualifiedName,
    name: predicted.name,
    kind: predicted.kind,
    fields,
    sizeOf: predicted.sizeOf,
    dataSize: predicted.dataSize,
    align: predicted.align,
    tailPadding: tailPadding(predicted),
    polymorphic: isPolymorphic(predicted),
    ...(internalPadding !== undefined ? { internalPadding } : {}),
    observed: observed !== undefined,
    ...(observed
      ? {}
      : {
          observedGap: isPolymorphic(predicted)
            ? 'pahole cannot read polymorphic classes, so internal padding is not computed here. ' +
              'Offsets, sizeof and tail padding are exact.'
            : 'No DWARF for this type — build with -g and point lens.pahole.binary at the object file.',
        }),
    disagreements,
  };
}

/**
 * Layout findings.
 *
 * The theme is that C++ adds storage the source text does not mention, and moves
 * storage the source text appears to order. Both are invisible to someone
 * reading the declaration with a C model in mind.
 */
export function detectLayoutConstructs(layouts: MergedLayout[]): Finding[] {
  const out: Finding[] = [];
  const push = (l: MergedLayout, f: Omit<Finding, 'typeId' | 'qualifiedName'>) =>
    out.push({ ...f, typeId: l.qualifiedName, qualifiedName: l.qualifiedName });

  for (const l of layouts) {
    const vptrs = l.fields.filter((f) => f.kind === 'vtable-pointer');
    if (vptrs.length > 0) {
      const bytes = vptrs.length * l.align;
      push(l, {
        construct: 'vptr_storage',
        severity: 'new',
        title: `${vptrs.length} hidden vtable pointer${vptrs.length === 1 ? '' : 's'} — about ${bytes} bytes per object`,
        emits:
          `A pointer per polymorphic base, at offset${vptrs.length === 1 ? ' ' : 's '}${vptrs
            .map((v) => v.offset)
            .join(', ')}. Nothing in the declaration mentions them, and they are why sizeof is larger than the ` +
          'sum of the members you can see.',
        cEquivalent:
          'The function-table pointer you put first in a HAL struct by hand. Same cost, same position — the ' +
          'difference is that here you have to be told it is there.',
      });
    }

    const vbases = l.fields.filter((f) => f.kind === 'virtual-base' || f.kind === 'primary-virtual-base');
    if (vbases.length > 0) {
      push(l, {
        construct: 'virtual_base_layout',
        severity: 'trap',
        title: `${vbases.length} virtual base${vbases.length === 1 ? '' : 's'} — offsets resolved at runtime`,
        emits:
          'The distance from this object to its virtual base is not a compile-time constant. Reaching a virtual ' +
          'base member costs an extra indirection, and the offset differs between the base and derived views ' +
          'of the same object.',
        cEquivalent:
          'A struct holding a pointer to a shared sub-struct rather than embedding it. In C you would see the ' +
          'pointer in the declaration; here the indirection exists but the declaration does not show it.',
      });
    }

    if (l.tailPadding > 0) {
      const pct = Math.round((l.tailPadding / l.sizeOf) * 100);
      push(l, {
        construct: 'tail_padding',
        severity: pct >= 25 ? 'trap' : 'new',
        title: `${l.tailPadding} bytes of tail padding (${pct}% of ${l.sizeOf})`,
        emits:
          `sizeof is ${l.sizeOf} but the data occupies ${l.dataSize}. The remainder exists to keep alignment ` +
          'correct in arrays. In an array of a thousand of these it is real flash or RAM.',
        cEquivalent:
          'Exactly the same padding a C compiler would insert, for exactly the same reason. Reordering members ' +
          'largest-first usually removes it.',
      });
    }

    if (l.internalPadding !== undefined && l.internalPadding > 0) {
      const pct = Math.round((l.internalPadding / l.sizeOf) * 100);
      push(l, {
        construct: 'internal_padding',
        severity: pct >= 25 ? 'trap' : 'new',
        title: `${l.internalPadding} bytes wasted in holes between members (${pct}% of ${l.sizeOf})`,
        emits:
          'Gaps inserted to satisfy each member\'s alignment. The declaration order chose this cost; a different ' +
          'order would not have.',
        cEquivalent:
          'The same holes a C compiler inserts. This is one of the few places where a C instinct transfers ' +
          'completely — and where pahole --reorganize will tell you the better order.',
      });
    }

    // clang marks these `(empty)` outright, which is far safer than inferring
    // emptiness from a zero offset — every primary base starts at zero.
    const empties = l.fields.filter((f) => f.isEmptyBase === true);
    if (empties.length > 0) {
      push(l, {
        construct: 'empty_base_optimisation',
        severity: 'familiar',
        title: 'Base class occupying no storage',
        emits:
          'An empty base contributes zero bytes. Composition of an empty struct would have cost at least one, so ' +
          'inheritance is genuinely cheaper here.',
        cEquivalent:
          'Nothing — C has no equivalent, because an embedded empty struct always costs a byte. This is one of ' +
          'the rare cases where the C++ form is strictly smaller.',
      });
    }

    for (const d of l.disagreements) {
      push(l, {
        construct: 'layout_disagreement',
        severity: 'trap',
        title: 'Predicted and built layouts disagree',
        emits: d,
        cEquivalent:
          'Treat this as a finding rather than a display bug. It usually means the compilation database records ' +
          'different flags from the build that produced the object — different -D, -m, or standard version.',
      });
    }
  }

  return out;
}

export interface LayoutSummary {
  records: number;
  totalSize: number;
  wasted: number;
  polymorphic: number;
  uncomputed: number;
}

export function summariseLayouts(layouts: MergedLayout[]): LayoutSummary {
  return {
    records: layouts.length,
    totalSize: layouts.reduce((a, l) => a + l.sizeOf, 0),
    wasted: layouts.reduce((a, l) => a + l.tailPadding + (l.internalPadding ?? 0), 0),
    polymorphic: layouts.filter((l) => l.polymorphic).length,
    uncomputed: layouts.filter((l) => l.internalPadding === undefined).length,
  };
}

/** Records ranked by wasted bytes, for the padding report. */
export function wasteRanking(layouts: MergedLayout[]): MergedLayout[] {
  return [...layouts]
    .filter((l) => l.tailPadding + (l.internalPadding ?? 0) > 0)
    .sort(
      (a, b) => b.tailPadding + (b.internalPadding ?? 0) - (a.tailPadding + (a.internalPadding ?? 0)),
    );
}
