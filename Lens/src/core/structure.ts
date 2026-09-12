/**
 * Normalised structure model.
 *
 * Every structure provider — clang-uml today, the LSP type hierarchy as a
 * fallback, a direct index at P2 — produces this shape. Nothing downstream
 * (layout, rendering, construct detection, journal seeding) is allowed to know
 * which provider it came from, except through `provenance`.
 */

export type Access = 'public' | 'protected' | 'private';

export interface SourceLocation {
  file: string;
  line: number;
  column?: number;
}

export interface Method {
  name: string;
  displayName: string;
  /** Return type. Empty for constructors and destructors. */
  returns: string;
  parameters: { name: string; type: string }[];
  access: Access;
  isVirtual: boolean;
  isPureVirtual: boolean;
  isStatic: boolean;
  isConst: boolean;
  isConstructor: boolean;
  isDestructor: boolean;
  isDefaulted: boolean;
  isDeleted: boolean;
  isNoexcept: boolean;
  isConstexpr: boolean;
  isConsteval: boolean;
  isCoroutine: boolean;
  isOperator: boolean;
  isCopyAssignment: boolean;
  isMoveAssignment: boolean;
  location?: SourceLocation;
}

export interface Member {
  name: string;
  type: string;
  access: Access;
  isStatic: boolean;
  location?: SourceLocation;
}

export interface BaseRef {
  id: string;
  access: Access;
  /** `virtual` inheritance — the VTT-bearing, `this`-adjusting kind. */
  isVirtual: boolean;
}

export type TypeKind = 'class' | 'struct' | 'union' | 'enum' | 'concept' | 'unknown';

export interface TypeNode {
  id: string;
  name: string;
  displayName: string;
  namespace: string;
  /** `ns::Name`, the join key against journal anchors. */
  qualifiedName: string;
  kind: TypeKind;
  isAbstract: boolean;
  isTemplate: boolean;
  isNested: boolean;
  bases: BaseRef[];
  members: Member[];
  methods: Method[];
  location?: SourceLocation;
  brief?: string;
}

export type RelationKind =
  | 'inheritance'
  | 'association'
  | 'aggregation'
  | 'composition'
  | 'dependency'
  | 'instantiation'
  | 'containment'
  | 'friendship'
  | 'other';

export interface Relation {
  /** Derived class / owning class. */
  from: string;
  /** Base class / owned class. */
  to: string;
  kind: RelationKind;
  access?: Access;
  label?: string;
}

export interface StructureModel {
  title: string;
  /** Namespace names are rendered relative to this, as clang-uml does. */
  usingNamespace: string;
  types: TypeNode[];
  relations: Relation[];
  provenance: {
    provider: 'clang-uml' | 'lsp' | 'unknown';
    /** Fields the provider could not supply, so the UI can say so honestly. */
    missing: string[];
  };
}

export function emptyModel(provider: StructureModel['provenance']['provider'] = 'unknown'): StructureModel {
  return {
    title: '',
    usingNamespace: '',
    types: [],
    relations: [],
    provenance: { provider, missing: [] },
  };
}

export function byId(model: StructureModel): Map<string, TypeNode> {
  return new Map(model.types.map((t) => [t.id, t]));
}

/** Direct bases and derived types of a node, in one pass. */
export function neighbours(model: StructureModel, id: string): { bases: string[]; derived: string[] } {
  const bases: string[] = [];
  const derived: string[] = [];
  for (const r of model.relations) {
    if (r.kind !== 'inheritance') {
      continue;
    }
    if (r.from === id) {
      bases.push(r.to);
    } else if (r.to === id) {
      derived.push(r.from);
    }
  }
  return { bases, derived };
}

/**
 * Everything within `radius` relationship hops of a set of seeds, in any
 * direction. Mirrors clang-uml's `context` + `radius` filter so the same mental
 * model applies whether the filtering happens in the tool or in the config.
 */
export function contextSubset(model: StructureModel, seeds: string[], radius: number): Set<string> {
  const keep = new Set(seeds);
  let frontier = new Set(seeds);
  for (let hop = 0; hop < radius; hop++) {
    const next = new Set<string>();
    for (const r of model.relations) {
      if (frontier.has(r.from) && !keep.has(r.to)) {
        next.add(r.to);
      }
      if (frontier.has(r.to) && !keep.has(r.from)) {
        next.add(r.from);
      }
    }
    if (next.size === 0) {
      break;
    }
    for (const id of next) {
      keep.add(id);
    }
    frontier = next;
  }
  return keep;
}

export function filterModel(model: StructureModel, keep: Set<string>): StructureModel {
  return {
    ...model,
    types: model.types.filter((t) => keep.has(t.id)),
    relations: model.relations.filter((r) => keep.has(r.from) && keep.has(r.to)),
  };
}
