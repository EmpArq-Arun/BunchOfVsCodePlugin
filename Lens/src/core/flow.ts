import type { StructureModel, TypeNode } from './structure.js';

/**
 * Flow model and virtual dispatch resolution.
 *
 * The failure mode this module exists to prevent is confident wrongness. A C
 * engineer reading unfamiliar C++ can follow a direct call by eye; what they
 * cannot do is see where `port->transfer()` actually goes. A tool that draws one
 * clean edge there is worse than no tool, because it teaches a wrong model of
 * the program that will survive until something breaks in the field.
 *
 * So every edge carries how it was resolved, and "I do not know" is a rendered
 * state rather than an omission.
 */

export type Resolution =
  /** Direct call to a named, non-virtual function. */
  | 'exact'
  /** Virtual, but the hierarchy admits exactly one target. */
  | 'devirtualised'
  /** Virtual, narrowed to the overriders in the subtree of the static type. */
  | 'cha'
  /** CHA, with candidates ranked by evidence that the type is ever instantiated. */
  | 'rta'
  /** Through a function pointer or a type-erased callable. */
  | 'fn_ptr'
  /** Seen in an execution trace. */
  | 'observed'
  /** Lens does not know. */
  | 'unresolved';

/** How much the resolution can be trusted, collapsed for rendering. */
export type Certainty = 'certain' | 'bounded' | 'unknown';

export const CERTAINTY: Record<Resolution, Certainty> = {
  exact: 'certain',
  devirtualised: 'certain',
  observed: 'certain',
  cha: 'bounded',
  rta: 'bounded',
  fn_ptr: 'unknown',
  unresolved: 'unknown',
};

export interface CallNode {
  /** Qualified name — the join key against journal anchors and structure types. */
  id: string;
  name: string;
  file?: string;
  line?: number;
  isVirtual?: boolean;
  isr?: IsrClassification;
}

export interface CallEdge {
  from: string;
  to: string;
  resolution: Resolution;
  /** Why this target is here, in the user's language. */
  evidence?: string;
  callSite?: { file: string; line: number };
}

export interface CallGraph {
  root: string;
  nodes: Map<string, CallNode>;
  edges: CallEdge[];
}

// ---------------------------------------------------------------------------
// Class hierarchy analysis
// ---------------------------------------------------------------------------

export interface Candidate {
  /** `ns::Derived::method` */
  qualifiedName: string;
  typeQualifiedName: string;
  isPureVirtual: boolean;
  /** Why RTA believes this type is ever instantiated, or why it doubts it. */
  evidence: string;
  evidenceStrength: 'strong' | 'weak' | 'none';
  file?: string;
  line?: number;
}

export interface CallResolution {
  resolution: Resolution;
  candidates: Candidate[];
  note: string;
  certainty: Certainty;
}

function subtree(model: StructureModel, rootId: string): TypeNode[] {
  const derivedOf = new Map<string, string[]>();
  for (const r of model.relations) {
    if (r.kind === 'inheritance') {
      (derivedOf.get(r.to) ?? derivedOf.set(r.to, []).get(r.to)!).push(r.from);
    }
  }
  const byId = new Map(model.types.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const out: TypeNode[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const t = byId.get(id);
    if (t) {
      out.push(t);
    }
    stack.push(...(derivedOf.get(id) ?? []));
  }
  return out;
}

/**
 * Evidence that a concrete type is ever instantiated.
 *
 * Note what this deliberately does *not* do: a type with no evidence is kept and
 * labelled, never dropped. Silently removing a candidate because no instantiation
 * was spotted is precisely the confident-wrongness failure — the instantiation
 * may be in a factory, a vendor SDK, or a translation unit outside the diagram.
 * RTA here ranks; it does not prune.
 */
export function instantiationEvidence(
  model: StructureModel,
  type: TypeNode,
): { evidence: string; strength: Candidate['evidenceStrength'] } {
  if (type.isAbstract) {
    return { evidence: 'abstract — cannot be instantiated', strength: 'none' };
  }

  const mentions = (t: string) => new RegExp(`\\b${type.name}\\b`).test(t);
  for (const holder of model.types) {
    const member = holder.members.find((m) => mentions(m.type));
    if (member) {
      return {
        evidence: `${holder.name}::${member.name} is declared as ${member.type}`,
        strength: 'strong',
      };
    }
  }

  const owned = model.relations.find(
    (r) => r.to === type.id && (r.kind === 'composition' || r.kind === 'aggregation' || r.kind === 'association'),
  );
  if (owned) {
    const from = model.types.find((t) => t.id === owned.from);
    return {
      evidence: `held by ${from?.name ?? 'another type'} (${owned.kind})`,
      strength: 'strong',
    };
  }

  return {
    evidence: 'no instantiation seen in this diagram — it may be created elsewhere',
    strength: 'none',
  };
}

/**
 * Does `method` on `type` override `name`? Arity is compared when both sides
 * report parameters, because language servers and clang-uml disagree about how
 * much signature detail they supply and a name-only match is the safer floor.
 */
function overrides(type: TypeNode, name: string, arity: number | undefined): TypeNode['methods'][number] | undefined {
  return type.methods.find(
    (m) => m.name === name && (arity === undefined || m.parameters.length === 0 || m.parameters.length === arity),
  );
}

export interface ResolveRequest {
  /** Qualified name of the static type at the call site, e.g. `fw::hal::ISpi`. */
  staticType: string;
  methodName: string;
  arity?: number;
}

/**
 * Resolve a virtual call against the class hierarchy.
 *
 * Returns the honest candidate set: every non-pure override reachable in the
 * subtree of the static type, ordered by how much reason there is to believe the
 * owning type is ever created.
 */
export function resolveVirtualCall(model: StructureModel, req: ResolveRequest): CallResolution {
  const base = model.types.find((t) => t.qualifiedName === req.staticType);
  if (!base) {
    return {
      resolution: 'unresolved',
      candidates: [],
      note: `${req.staticType} is not in this diagram, so its overriders cannot be enumerated. Widen the scope to find out.`,
      certainty: 'unknown',
    };
  }

  const declared = overrides(base, req.methodName, req.arity);
  if (declared && !declared.isVirtual) {
    return {
      resolution: 'exact',
      candidates: [
        {
          qualifiedName: `${base.qualifiedName}::${declared.name}`,
          typeQualifiedName: base.qualifiedName,
          isPureVirtual: false,
          evidence: 'non-virtual — the target is fixed at compile time',
          evidenceStrength: 'strong',
          ...(declared.location ? { file: declared.location.file, line: declared.location.line } : {}),
        },
      ],
      note: 'Not a virtual call. This resolves like a C function call and can be inlined.',
      certainty: 'certain',
    };
  }

  const candidates: Candidate[] = [];
  for (const t of subtree(model, base.id)) {
    const m = overrides(t, req.methodName, req.arity);
    if (!m || m.isPureVirtual) {
      continue;
    }
    const { evidence, strength } = instantiationEvidence(model, t);
    if (strength === 'none' && t.isAbstract) {
      continue;
    }
    candidates.push({
      qualifiedName: `${t.qualifiedName}::${m.name}`,
      typeQualifiedName: t.qualifiedName,
      isPureVirtual: false,
      evidence,
      evidenceStrength: strength,
      ...(m.location ? { file: m.location.file, line: m.location.line } : {}),
    });
  }

  const order = { strong: 0, weak: 1, none: 2 };
  candidates.sort(
    (a, b) => order[a.evidenceStrength] - order[b.evidenceStrength] || a.qualifiedName.localeCompare(b.qualifiedName),
  );

  if (candidates.length === 0) {
    return {
      resolution: 'unresolved',
      candidates: [],
      note:
        `No non-abstract override of ${req.methodName} was found below ${req.staticType}. ` +
        'Either the implementation lives outside this diagram, or this interface has no implementers yet.',
      certainty: 'unknown',
    };
  }

  if (candidates.length === 1) {
    return {
      resolution: 'devirtualised',
      candidates,
      note:
        'Exactly one possible target in this hierarchy. The compiler may turn this into a direct call, but only ' +
        'under whole-program assumptions — with separate compilation it still goes through the vtable. Adding a ' +
        'second implementer silently changes the cost of every call site.',
      certainty: 'certain',
    };
  }

  const grounded = candidates.filter((c) => c.evidenceStrength === 'strong').length;
  return {
    resolution: grounded > 0 && grounded < candidates.length ? 'rta' : 'cha',
    candidates,
    note:
      `${candidates.length} possible targets. This is the honest set from the class hierarchy, not a guess at which ` +
      'one runs. Candidates with no instantiation evidence are kept rather than dropped, because the object may be ' +
      'created in a factory or a translation unit outside this scope.',
    certainty: 'bounded',
  };
}

// ---------------------------------------------------------------------------
// Interrupt handlers
// ---------------------------------------------------------------------------

export interface IsrClassification {
  reason: string;
  /** `cmsis` names are certain; `pattern` names are a naming convention and may be wrong. */
  confidence: 'certain' | 'likely';
}

/** Cortex-M core exception handlers. These names are fixed by CMSIS startup code. */
const CMSIS_HANDLERS = new Set([
  'Reset_Handler',
  'NMI_Handler',
  'HardFault_Handler',
  'MemManage_Handler',
  'BusFault_Handler',
  'UsageFault_Handler',
  'SVC_Handler',
  'DebugMon_Handler',
  'PendSV_Handler',
  'SysTick_Handler',
]);

export const DEFAULT_ISR_PATTERNS = ['_IRQHandler$', '_IRQn_Handler$', '^ISR_', '_isr$', '_ISR$'];

export function classifyIsr(name: string, extraPatterns: string[] = []): IsrClassification | undefined {
  const bare = name.split('::').pop() ?? name;
  if (CMSIS_HANDLERS.has(bare)) {
    return { reason: 'Cortex-M core exception handler', confidence: 'certain' };
  }
  for (const p of [...DEFAULT_ISR_PATTERNS, ...extraPatterns]) {
    let re: RegExp;
    try {
      re = new RegExp(p);
    } catch {
      continue; // a bad user-supplied pattern must not break classification
    }
    if (re.test(bare)) {
      return { reason: `name matches /${p}/`, confidence: 'likely' };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Graph traversal
// ---------------------------------------------------------------------------

export function outgoing(graph: CallGraph, id: string): CallEdge[] {
  return graph.edges.filter((e) => e.from === id);
}

/** Depth of every node from the root, breadth-first. Unreachable nodes are absent. */
export function depths(graph: CallGraph): Map<string, number> {
  const out = new Map<string, number>([[graph.root, 0]]);
  let frontier = [graph.root];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of outgoing(graph, id)) {
        if (!out.has(e.to)) {
          out.set(e.to, out.get(id)! + 1);
          next.push(e.to);
        }
      }
    }
    frontier = next;
  }
  return out;
}

/** Every cycle reachable from the root, as node id sequences. */
export function findCycles(graph: CallGraph): string[][] {
  const cycles: string[][] = [];
  const path: string[] = [];
  const onPath = new Set<string>();
  const done = new Set<string>();

  const walk = (id: string): void => {
    if (onPath.has(id)) {
      cycles.push([...path.slice(path.indexOf(id)), id]);
      return;
    }
    if (done.has(id)) {
      return;
    }
    onPath.add(id);
    path.push(id);
    for (const e of outgoing(graph, id)) {
      walk(e.to);
    }
    path.pop();
    onPath.delete(id);
    done.add(id);
  };

  walk(graph.root);
  return cycles;
}

/** Longest simple path from the root, as a proxy for worst-case call depth. */
export function deepestChain(graph: CallGraph): string[] {
  let best: string[] = [];
  const walk = (id: string, path: string[], onPath: Set<string>): void => {
    const next = [...path, id];
    if (next.length > best.length) {
      best = next;
    }
    onPath.add(id);
    for (const e of outgoing(graph, id)) {
      if (!onPath.has(e.to)) {
        walk(e.to, next, onPath);
      }
    }
    onPath.delete(id);
  };
  walk(graph.root, [], new Set());
  return best;
}
