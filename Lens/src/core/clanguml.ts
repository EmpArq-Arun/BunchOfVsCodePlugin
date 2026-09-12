import type {
  Access,
  BaseRef,
  Member,
  Method,
  Relation,
  RelationKind,
  SourceLocation,
  StructureModel,
  TypeKind,
  TypeNode,
} from './structure.js';

/**
 * clang-uml JSON ingest.
 *
 * The JSON generator emits clang-uml's intermediate model rather than a rendered
 * diagram, which is why it is the ingest format rather than PlantUML or Mermaid:
 * it carries the semantic flags — `is_pure_virtual`, per-base `is_virtual`,
 * `is_deleted`, `is_coroutine` — that the rendered formats throw away and that
 * the construct detector needs.
 *
 * Parsing is total: every field is optional as far as this code is concerned,
 * because the schema moves between clang-uml releases and a missing flag must
 * degrade one construct hint rather than lose the whole diagram. Anything that
 * could not be read is recorded in `provenance.missing` so the UI can say what
 * it does not know instead of implying completeness.
 */

export class ClangUmlParseError extends Error {}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function bool(v: unknown): boolean {
  return v === true;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function access(v: unknown): Access {
  const s = str(v, 'public');
  return s === 'private' || s === 'protected' ? s : 'public';
}

/**
 * Ids arrive as decimal strings on current releases and as numbers on older
 * ones. Normalising to string keeps the join key stable across both.
 */
function id(v: unknown): string {
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number') {
    return String(v);
  }
  return '';
}

function location(v: unknown): SourceLocation | undefined {
  const o = obj(v);
  if (!o) {
    return undefined;
  }
  const file = str(o.file);
  const line = num(o.line);
  if (file.length === 0 || line === undefined) {
    return undefined;
  }
  const column = num(o.column);
  return column === undefined ? { file, line } : { file, line, column };
}

function brief(v: unknown): string | undefined {
  const o = obj(v);
  if (!o) {
    return undefined;
  }
  const briefs = arr(o.brief)
    .map((b) => str(b).trim())
    .filter((b) => b.length > 0);
  if (briefs.length > 0) {
    return briefs.join(' ');
  }
  const formatted = str(o.formatted).trim();
  return formatted.length > 0 ? formatted.split('\n')[0] : undefined;
}

function typeKind(v: unknown, o: Json): TypeKind {
  if (bool(o.is_union)) {
    return 'union';
  }
  if (bool(o.is_struct)) {
    return 'struct';
  }
  const t = str(v, 'class');
  if (t === 'enum' || t === 'concept' || t === 'class' || t === 'struct' || t === 'union') {
    return t;
  }
  return 'unknown';
}

const RELATION_MAP: Record<string, RelationKind> = {
  // clang-uml calls inheritance "extension", following the PlantUML arrow name.
  extension: 'inheritance',
  inheritance: 'inheritance',
  association: 'association',
  aggregation: 'aggregation',
  composition: 'composition',
  dependency: 'dependency',
  instantiation: 'instantiation',
  containment: 'containment',
  friendship: 'friendship',
};

export function relationKind(v: unknown): RelationKind {
  return RELATION_MAP[str(v)] ?? 'other';
}

function parseMethod(v: unknown): Method | undefined {
  const o = obj(v);
  if (!o) {
    return undefined;
  }
  const name = str(o.name);
  if (name.length === 0) {
    return undefined;
  }
  return {
    name,
    displayName: str(o.display_name, name),
    returns: str(o.type),
    parameters: arr(o.parameters)
      .map((p) => obj(p))
      .filter((p): p is Json => p !== undefined)
      .map((p) => ({ name: str(p.name), type: str(p.type) })),
    access: access(o.access),
    isVirtual: bool(o.is_virtual),
    isPureVirtual: bool(o.is_pure_virtual),
    isStatic: bool(o.is_static),
    isConst: bool(o.is_const),
    isConstructor: bool(o.is_constructor),
    // clang-uml has no `is_destructor` flag; the leading tilde is the signal.
    isDestructor: name.startsWith('~'),
    isDefaulted: bool(o.is_defaulted),
    isDeleted: bool(o.is_deleted),
    isNoexcept: bool(o.is_noexcept),
    isConstexpr: bool(o.is_constexpr),
    isConsteval: bool(o.is_consteval),
    isCoroutine: bool(o.is_coroutine),
    isOperator: bool(o.is_operator),
    isCopyAssignment: bool(o.is_copy_assignment),
    isMoveAssignment: bool(o.is_move_assignment),
    location: location(o.source_location),
  };
}

function parseMember(v: unknown): Member | undefined {
  const o = obj(v);
  if (!o) {
    return undefined;
  }
  const name = str(o.name);
  if (name.length === 0) {
    return undefined;
  }
  return {
    name,
    type: str(o.type, '?'),
    access: access(o.access),
    isStatic: bool(o.is_static),
    location: location(o.source_location),
  };
}

function parseBase(v: unknown): BaseRef | undefined {
  const o = obj(v);
  if (!o) {
    return undefined;
  }
  const baseId = id(o.id);
  return baseId.length === 0
    ? undefined
    : { id: baseId, access: access(o.access), isVirtual: bool(o.is_virtual) };
}

function parseType(v: unknown, missing: Set<string>): TypeNode | undefined {
  const o = obj(v);
  if (!o) {
    return undefined;
  }
  const nodeId = id(o.id);
  const name = str(o.name);
  if (nodeId.length === 0 || name.length === 0) {
    return undefined;
  }
  if (o.methods === undefined) {
    missing.add('methods');
  }
  if (o.members === undefined) {
    missing.add('members');
  }

  const ns = str(o.namespace);
  return {
    id: nodeId,
    name,
    displayName: str(o.display_name, name),
    namespace: ns,
    qualifiedName: ns.length > 0 ? `${ns}::${name}` : name,
    kind: typeKind(o.type, o),
    isAbstract: bool(o.is_abstract),
    isTemplate: bool(o.is_template),
    isNested: bool(o.is_nested),
    bases: arr(o.bases)
      .map(parseBase)
      .filter((b): b is BaseRef => b !== undefined),
    members: arr(o.members)
      .map(parseMember)
      .filter((m): m is Member => m !== undefined),
    methods: arr(o.methods)
      .map(parseMethod)
      .filter((m): m is Method => m !== undefined),
    location: location(o.source_location),
    brief: brief(o.comment),
  };
}

function parseRelation(v: unknown): Relation | undefined {
  const o = obj(v);
  if (!o) {
    return undefined;
  }
  const from = id(o.source);
  const to = id(o.destination);
  if (from.length === 0 || to.length === 0) {
    return undefined;
  }
  const rel: Relation = { from, to, kind: relationKind(o.type) };
  if (o.access !== undefined) {
    rel.access = access(o.access);
  }
  const label = str(o.label);
  if (label.length > 0) {
    rel.label = label;
  }
  return rel;
}

export function parseClangUml(text: string): StructureModel {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    throw new ClangUmlParseError(`clang-uml output is not valid JSON: ${(err as Error).message}`);
  }
  const o = obj(root);
  if (!o) {
    throw new ClangUmlParseError('clang-uml output is not a JSON object');
  }
  const diagramType = str(o.diagram_type);
  if (diagramType.length > 0 && diagramType !== 'class') {
    throw new ClangUmlParseError(
      `expected a class diagram, got "${diagramType}" — check the diagram name passed to clang-uml`,
    );
  }
  if (o.elements === undefined) {
    throw new ClangUmlParseError('clang-uml output has no "elements" array');
  }

  const missing = new Set<string>();
  const types = arr(o.elements)
    .map((e) => parseType(e, missing))
    .filter((t): t is TypeNode => t !== undefined);

  const known = new Set(types.map((t) => t.id));
  const declared = arr(o.relationships)
    .map(parseRelation)
    .filter((r): r is Relation => r !== undefined);

  // Relationships can point outside the filtered element set; dropping those
  // edges is correct, but silently dropping them is not.
  const relations = declared.filter((r) => known.has(r.from) && known.has(r.to));
  if (relations.length !== declared.length) {
    missing.add(`${declared.length - relations.length} relationship(s) to elements outside this diagram`);
  }

  // Inheritance also appears on each element's `bases`, which carries the
  // virtual-inheritance flag that the relationship list does not. Merge, taking
  // `bases` as authoritative where both describe the same edge.
  const seen = new Set(relations.filter((r) => r.kind === 'inheritance').map((r) => `${r.from}>${r.to}`));
  for (const t of types) {
    for (const b of t.bases) {
      if (known.has(b.id) && !seen.has(`${t.id}>${b.id}`)) {
        relations.push({ from: t.id, to: b.id, kind: 'inheritance', access: b.access });
        seen.add(`${t.id}>${b.id}`);
      }
    }
  }

  return {
    title: str(o.title) || str(o.name, 'Structure'),
    usingNamespace: str(o.using_namespace),
    types,
    relations,
    provenance: { provider: 'clang-uml', missing: [...missing] },
  };
}
