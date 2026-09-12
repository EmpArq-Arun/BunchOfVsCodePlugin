import type { StructureModel, TypeNode } from './structure.js';

/**
 * Construct detection, class-level.
 *
 * clang-uml's JSON model already carries the semantic flags that matter — pure
 * virtual, per-base virtual, deleted, defaulted, coroutine, operator — so a
 * useful slice of the Rosetta catalogue falls out of the P1 data with no extra
 * parsing pass. Statement-level constructs (RAII scopes, lambdas, `std::function`
 * call sites, temporaries) need the AST matcher pass and arrive at P3.
 *
 * `severity` is about distance from a C mental model, not about code quality.
 * Lens explains; it does not judge. `trap` marks the places where a C engineer's
 * correct instinct produces a wrong answer in C++ — those are worth a warning
 * because the failure is silent, not because the code is bad.
 */

export type Severity = 'familiar' | 'new' | 'trap';

export interface Finding {
  construct: string;
  severity: Severity;
  typeId: string;
  qualifiedName: string;
  title: string;
  /** What the compiler materialises. */
  emits: string;
  /** What you would have written in C for the same machine behaviour. */
  cEquivalent: string;
  file?: string;
  line?: number;
}

function at(node: TypeNode): Pick<Finding, 'file' | 'line'> {
  return node.location ? { file: node.location.file, line: node.location.line } : {};
}

function make(node: TypeNode, f: Omit<Finding, 'typeId' | 'qualifiedName' | 'file' | 'line'>): Finding {
  return { ...f, typeId: node.id, qualifiedName: node.qualifiedName, ...at(node) };
}

/**
 * Does this type inherit a virtual destructor from any ancestor?
 *
 * A derived class's destructor is implicitly virtual whenever a base's is, so
 * the absence of `virtual` — or of a destructor at all — says nothing on its own.
 * Checking only the class itself flags every well-formed derived class in a
 * hierarchy, which is a false positive on the single most alarming detector Lens
 * has. Found by running real clang-uml output through it.
 */
function inheritsVirtualDestructor(
  node: TypeNode,
  known: Map<string, TypeNode>,
  seen = new Set<string>(),
): boolean {
  if (seen.has(node.id)) {
    return false;
  }
  seen.add(node.id);
  for (const base of node.bases) {
    const b = known.get(base.id);
    if (!b) {
      // A base outside the diagram might well have a virtual destructor. Assume
      // it does: a missed warning is far cheaper than a confident wrong one.
      return true;
    }
    if (b.methods.some((m) => m.isDestructor && m.isVirtual)) {
      return true;
    }
    if (inheritsVirtualDestructor(b, known, seen)) {
      return true;
    }
  }
  return false;
}

export function detectConstructs(model: StructureModel): Finding[] {
  const out: Finding[] = [];
  const known = new Map(model.types.map((t) => [t.id, t]));

  for (const t of model.types) {
    const virtuals = t.methods.filter((m) => m.isVirtual);
    const pureVirtuals = virtuals.filter((m) => m.isPureVirtual);
    const dtor = t.methods.find((m) => m.isDestructor);
    const polymorphic = virtuals.length > 0 || t.bases.some((b) => known.get(b.id)?.isAbstract);

    if (virtuals.length > 0) {
      out.push(
        make(t, {
          construct: 'virtual_dispatch',
          severity: 'new',
          title: `${virtuals.length} virtual method${virtuals.length === 1 ? '' : 's'}`,
          emits:
            'A vtable in .rodata for the class, and a vptr as the first hidden member of every object. ' +
            'Calls through a base pointer become an indirect load-and-jump, so they cannot be inlined.',
          cEquivalent:
            'A struct whose first member is a pointer to a const table of function pointers — the same ' +
            'pattern hand-rolled in HAL layers. C++ writes the table and wires the pointer for you.',
        }),
      );
    }

    if (t.isAbstract || pureVirtuals.length > 0) {
      out.push(
        make(t, {
          construct: 'abstract_interface',
          severity: 'new',
          title: `Abstract — ${pureVirtuals.length} pure virtual method${pureVirtuals.length === 1 ? '' : 's'}`,
          emits:
            'No instances can exist. The vtable slot for a pure virtual points at __cxa_pure_virtual, ' +
            'which aborts if it is ever reached.',
          cEquivalent:
            'A header declaring a table of function pointers with no default implementations, and a ' +
            'convention that every driver must fill in every slot. The compiler now enforces the convention.',
        }),
      );
    }

    if (t.bases.length > 1) {
      out.push(
        make(t, {
          construct: 'multiple_inheritance',
          severity: 'new',
          title: `Inherits from ${t.bases.length} bases`,
          emits:
            'One vptr per polymorphic base, laid out as separate subobjects. Calling through the second ' +
            'or later base needs a this-adjusting thunk (_ZThn...), so the pointer value changes on cast.',
          cEquivalent:
            'A struct that embeds two other structs by value, plus manual pointer arithmetic every time ' +
            'you hand a pointer to code expecting the second one.',
        }),
      );
    }

    const virtualBases = t.bases.filter((b) => b.isVirtual);
    if (virtualBases.length > 0) {
      out.push(
        make(t, {
          construct: 'virtual_inheritance',
          severity: 'trap',
          title: `${virtualBases.length} virtual base${virtualBases.length === 1 ? '' : 's'}`,
          emits:
            'A VTT (_ZTT) alongside the vtable, and virtual-base offsets consulted at runtime. The offset ' +
            'from an object to its virtual base is not a compile-time constant.',
          cEquivalent:
            'No clean equivalent. The nearest is a struct holding a pointer to a shared sub-struct rather ' +
            'than embedding it, with every access going through that pointer — including during construction, ' +
            'which is where this gets genuinely subtle.',
        }),
      );
    }

    const dtorIsVirtualByInheritance = inheritsVirtualDestructor(t, known);

    if (polymorphic && dtor && !dtor.isVirtual && !dtorIsVirtualByInheritance) {
      out.push(
        make(t, {
          construct: 'non_virtual_destructor',
          severity: 'trap',
          title: 'Polymorphic class with a non-virtual destructor',
          emits:
            'Deleting through a base pointer runs only the base destructor. Derived members are never ' +
            'destroyed; the standard calls this undefined behaviour and in practice it leaks silently.',
          cEquivalent:
            'A cleanup function pointer that was left out of the vtable, so the generic teardown path calls ' +
            'the wrong one. The difference is that in C you would see the missing slot.',
        }),
      );
    } else if (polymorphic && !dtor && !dtorIsVirtualByInheritance) {
      out.push(
        make(t, {
          construct: 'implicit_non_virtual_destructor',
          severity: 'trap',
          title: 'Polymorphic class with no declared destructor',
          emits:
            'The compiler supplies a destructor and it is non-virtual. Same consequence as declaring a ' +
            'non-virtual one, but with nothing in the source to notice.',
          cEquivalent:
            'Forgetting the teardown entry in a function-pointer table — except the table is generated, so ' +
            'there is nothing to grep for.',
        }),
      );
    }

    const deleted = t.methods.filter((m) => m.isDeleted);
    if (deleted.length > 0) {
      out.push(
        make(t, {
          construct: 'deleted_special_member',
          severity: 'new',
          title: `${deleted.length} deleted member function${deleted.length === 1 ? '' : 's'}: ${deleted
            .map((m) => m.displayName)
            .join(', ')}`,
          emits:
            'Nothing at runtime. The declaration exists purely so that using it is a compile error rather ' +
            'than a link error or a silent shallow copy.',
          cEquivalent:
            'A comment saying "do not copy this struct", enforced by code review. This is the same rule ' +
            'moved from the comment into the compiler.',
        }),
      );
    }

    const moves = t.methods.filter((m) => m.isMoveAssignment);
    if (moves.length > 0) {
      out.push(
        make(t, {
          construct: 'move_semantics',
          severity: 'new',
          title: 'Move assignment defined',
          emits:
            'A second assignment operator selected when the source is a temporary. Typically it steals a ' +
            'pointer and nulls the source rather than copying the buffer.',
          cEquivalent:
            'Swapping two pointers and setting one to NULL, which is what you would have written by hand. ' +
            'Usually cheaper than the copy, not more expensive.',
        }),
      );
    }

    const coroutines = t.methods.filter((m) => m.isCoroutine);
    if (coroutines.length > 0) {
      out.push(
        make(t, {
          construct: 'coroutine',
          severity: 'trap',
          title: `${coroutines.length} coroutine${coroutines.length === 1 ? '' : 's'}`,
          emits:
            'A coroutine frame holding all state that lives across a suspend point. Unless the compiler ' +
            'elides the allocation, the frame comes from operator new — a heap allocation on every call.',
          cEquivalent:
            'A hand-written state machine with an explicit context struct you allocated yourself. You knew ' +
            'exactly where that struct lived; here you have to check.',
        }),
      );
    }

    const operators = t.methods.filter((m) => m.isOperator && !m.isCopyAssignment && !m.isMoveAssignment);
    if (operators.length > 0) {
      out.push(
        make(t, {
          construct: 'operator_overload',
          severity: 'new',
          title: `Overloads ${operators.map((m) => m.displayName).join(', ')}`,
          emits: 'Ordinary function calls. The syntax hides the call; the codegen does not.',
          cEquivalent:
            'Named functions like vec_add(a, b). Same machine code, but at the call site you can no longer ' +
            'tell by looking whether something is arithmetic or a function call.',
        }),
      );
    }

    if (t.isTemplate) {
      out.push(
        make(t, {
          construct: 'template_class',
          severity: 'new',
          title: 'Class template',
          emits:
            'Nothing until instantiated. Each distinct set of template arguments produces a separate copy ' +
            'of every method used, deduplicated across translation units by COMDAT.',
          cEquivalent:
            'A macro that pastes the whole struct and its functions for each type, with a name suffix. ' +
            'Same code duplication, but type-checked and without the preprocessor.',
        }),
      );
    }

    const statics = t.members.filter((m) => m.isStatic);
    if (statics.length > 0) {
      out.push(
        make(t, {
          construct: 'static_data_member',
          severity: 'new',
          title: `${statics.length} static data member${statics.length === 1 ? '' : 's'}`,
          emits:
            'One object in .data or .bss for the whole program, not one per instance. If it has a ' +
            'constructor it runs before main via .init_array, in an order not fixed across translation units.',
          cEquivalent:
            'A file-scope variable, with the name scoped to the type. The pre-main constructor is the part ' +
            'with no C analogue and the part worth checking on a resource-constrained target.',
        }),
      );
    }

    const constexprs = t.methods.filter((m) => m.isConstexpr || m.isConsteval);
    if (constexprs.length > 0) {
      out.push(
        make(t, {
          construct: 'constexpr_method',
          severity: 'new',
          title: `${constexprs.length} constexpr/consteval method${constexprs.length === 1 ? '' : 's'}`,
          emits:
            'Potentially nothing. When the arguments are known at compile time the result is computed then ' +
            'and lands in .rodata, moving cost out of .text entirely.',
          cEquivalent:
            'A #define computing a constant, or a lookup table generated by a build script — but written as ' +
            'ordinary code, type-checked, and debuggable.',
        }),
      );
    }

    if (t.kind === 'union') {
      out.push(
        make(t, {
          construct: 'union',
          severity: 'familiar',
          title: 'Union',
          emits: 'Overlapping storage, exactly as in C.',
          cEquivalent: 'The same union. Note that C++ forbids reading through an inactive member, which C tolerates.',
        }),
      );
    }

    if (
      (t.kind === 'struct' || t.kind === 'class') &&
      t.bases.length === 0 &&
      t.methods.length === 0 &&
      !t.isTemplate
    ) {
      out.push(
        make(t, {
          construct: 'plain_data',
          severity: 'familiar',
          title: 'Plain data — no bases, no methods',
          emits: 'A struct. Same layout, same size, same alignment as the C equivalent.',
          cEquivalent: 'Exactly this struct. Nothing to unlearn.',
        }),
      );
    }
  }

  const nonPublic = model.relations.filter((r) => r.kind === 'inheritance' && r.access && r.access !== 'public');
  for (const r of nonPublic) {
    const t = known.get(r.from);
    const base = known.get(r.to);
    if (!t || !base) {
      continue;
    }
    out.push(
      make(t, {
        construct: 'non_public_inheritance',
        severity: 'new',
        title: `${r.access} inheritance from ${base.name}`,
        emits:
          'The same layout as public inheritance, but the base interface is not visible to callers and no ' +
          'implicit conversion to the base pointer is allowed outside the class.',
        cEquivalent:
          'Embedding a struct as a private implementation detail rather than exposing it — composition ' +
          'written with inheritance syntax.',
      }),
    );
  }

  return out;
}

export interface ConstructSummary {
  total: number;
  familiar: number;
  neu: number;
  traps: number;
  byConstruct: { construct: string; count: number; severity: Severity }[];
}

export function summarise(findings: Finding[]): ConstructSummary {
  const counts = new Map<string, { count: number; severity: Severity }>();
  for (const f of findings) {
    const hit = counts.get(f.construct);
    if (hit) {
      hit.count += 1;
    } else {
      counts.set(f.construct, { count: 1, severity: f.severity });
    }
  }
  const order: Record<Severity, number> = { trap: 0, new: 1, familiar: 2 };
  return {
    total: findings.length,
    familiar: findings.filter((f) => f.severity === 'familiar').length,
    neu: findings.filter((f) => f.severity === 'new').length,
    traps: findings.filter((f) => f.severity === 'trap').length,
    byConstruct: [...counts.entries()]
      .map(([construct, v]) => ({ construct, ...v }))
      .sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count),
  };
}

/**
 * Draft body text for a journal entry seeded from a finding. The user edits or
 * dismisses it; auto-seeded notes are a prompt to think, never a substitute.
 */
export function draftEntry(f: Finding): string {
  return [
    `${f.title}.`,
    '',
    `**What the compiler emits:** ${f.emits}`,
    '',
    `**In C you would write:** ${f.cEquivalent}`,
  ].join('\n');
}
