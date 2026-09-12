import { namespaceAt, NamespaceRange } from './namespaceTracker';

// ── Output types ─────────────────────────────────────────────────────────────

export type AccessLevel = 'public' | 'private' | 'protected';

export interface RawMemberVar {
  name: string;
  type: string;         // raw type string as written, e.g. "std::vector<Foo*>"
  access: AccessLevel;
  isStatic: boolean;
  isConst: boolean;
  isPointer: boolean;   // type includes *  → aggregation / optional ownership
  isReference: boolean; // type includes &  → non-owning reference
  isSmartPtr: boolean;  // unique_ptr/shared_ptr/weak_ptr → ownership semantics
}

export type RelationshipKind =
  | 'inheritance'   // "class A : B" — already in bases[]
  | 'composition'   // A has B by value or unique_ptr → A owns B
  | 'aggregation'   // A has B* / B& / shared_ptr<B> → A knows B
  | 'dependency';   // B appears in A's method signatures only, not as a member

export interface RawClassRelationship {
  targetClass: string;
  kind: RelationshipKind;
  memberName?: string;   // the field name for composition/aggregation
  access: AccessLevel;
}

export interface RawClassSpan {
  name: string;
  namespace?: string;     // enclosing namespace
  qualifiedName: string;  // namespace::name if namespace is set
  bases: string[];
  members: RawMemberVar[];
  relationships: RawClassRelationship[];
  bodyStart: number;
  bodyEnd: number;
  headerStart: number;
  isStruct: boolean;       // struct defaults to public
}

// ── Regex patterns ────────────────────────────────────────────────────────────

// class Foo [: access Base, ...] {   /   struct Foo : Base {
const CLASS_RE =
  /(^|[\n;}])[ \t]*(class|struct)\s+([A-Za-z_]\w*)\s*(?:final\s*)?(?::\s*([^{]+))?\{/g;

// Access specifier lines inside a class body
const ACCESS_RE = /^\s*(public|private|protected)\s*:/;

// Member variable: [static] [const] type [*&] name [= ...] ;
// Deliberately loose — filters out methods (which have '(') downstream.
const MEMBER_RE = /^\s*(static\s+)?((?:const\s+|mutable\s+|volatile\s+)*)((?:[A-Za-z_][\w:<>*& ,]*?))\s+([*&\s]*)([A-Za-z_]\w*)\s*(?:=[^;{]*)?\s*;/;

const SMART_PTR_RE = /\b(?:unique_ptr|shared_ptr|weak_ptr|auto_ptr)\b/;

// Known types to exclude from relationship detection (STL containers etc.)
const STDLIB_NAMES = new Set([
  'string', 'wstring', 'vector', 'list', 'deque', 'set', 'map', 'unordered_map',
  'unordered_set', 'queue', 'stack', 'priority_queue', 'array', 'pair', 'tuple',
  'optional', 'variant', 'any', 'function', 'thread', 'mutex', 'atomic', 'future',
  'promise', 'exception', 'runtime_error', 'logic_error', 'ios', 'iostream',
  'fstream', 'sstream', 'ostream', 'istream', 'size_t', 'int8_t', 'uint8_t',
  'int16_t', 'uint16_t', 'int32_t', 'uint32_t', 'int64_t', 'uint64_t',
]);

const PRIMITIVE_RE = /^(?:bool|char|short|int|long|float|double|void|wchar_t|auto|nullptr_t)$/;

// ── Helpers ────────────────────────────────────────────────────────────────

function findMatchingBrace(src: string, openOffset: number): number {
  let depth = 0;
  for (let i = openOffset; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Extract all class-like identifier names from a type string. */
function classNamesInType(typeStr: string, knownClasses: Set<string>): string[] {
  const names = new Set<string>();
  for (const m of typeStr.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
    const n = m[1];
    if (PRIMITIVE_RE.test(n) || STDLIB_NAMES.has(n)) continue;
    if (knownClasses.has(n)) names.add(n);
  }
  return [...names];
}

function isPointerLike(typeStr: string, modifiers: string): boolean {
  return typeStr.includes('*') || modifiers.includes('*') ||
    /\b(?:unique_ptr|shared_ptr|weak_ptr|auto_ptr)\b/.test(typeStr);
}

function isReferenceLike(typeStr: string, modifiers: string): boolean {
  return typeStr.includes('&') || modifiers.includes('&');
}

// ── Main extractor ────────────────────────────────────────────────────────────

/**
 * First pass: find all class spans in the source.
 * The `knownClassNames` set is used for relationship detection;
 * pass an empty set on the first call and re-run with the full set if needed.
 */
export function extractClassSpans(
  cleanedSrc: string,
  nsRanges: NamespaceRange[] = [],
  knownClassNames: Set<string> = new Set(),
): RawClassSpan[] {
  const out: RawClassSpan[] = [];
  CLASS_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = CLASS_RE.exec(cleanedSrc))) {
    const isStruct = m[2] === 'struct';
    const name = m[3];
    const baseList = m[4];
    const braceOffset = m.index + m[0].length - 1;
    const bodyEnd = findMatchingBrace(cleanedSrc, braceOffset);
    if (bodyEnd === -1) continue;

    const ns = nsRanges.length > 0 ? namespaceAt(m.index, nsRanges) : undefined;
    const qualifiedName = ns ? `${ns}::${name}` : name;

    const bases = baseList
      ? baseList
          .split(',')
          .map(b => b.replace(/\b(public|private|protected|virtual)\b/g, '').trim())
          .filter(Boolean)
      : [];

    // Parse the class body for members and relationships
    const body = cleanedSrc.slice(braceOffset + 1, bodyEnd - 1);
    const { members, relationships } = parseClassBody(body, isStruct, knownClassNames);

    // Add inheritance as explicit relationships
    for (const base of bases) {
      relationships.unshift({ targetClass: base, kind: 'inheritance', access: 'public' });
    }

    out.push({
      name,
      namespace: ns,
      qualifiedName,
      bases,
      members,
      relationships,
      headerStart: m.index,
      bodyStart: braceOffset,
      bodyEnd,
      isStruct,
    });

    CLASS_RE.lastIndex = braceOffset + 1;
  }

  return out;
}

/** Scan class body lines for member variables and detect relationships. */
function parseClassBody(
  body: string,
  isStruct: boolean,
  knownClasses: Set<string>,
): { members: RawMemberVar[]; relationships: RawClassRelationship[] } {
  const members: RawMemberVar[] = [];
  const relMap = new Map<string, RawClassRelationship>();

  let currentAccess: AccessLevel = isStruct ? 'public' : 'private';

  const lines = body.split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Access specifier
    const accM = ACCESS_RE.exec(line);
    if (accM) { currentAccess = accM[1] as AccessLevel; continue; }

    // Skip nested classes, typedefs, enums, friend declarations
    if (/^\s*(class|struct|union|enum|typedef|friend|template)\b/.test(line)) continue;
    // Skip method declarations (have '(') and pure virtuals (have '=')
    if (line.includes('(') || line.includes('}')) continue;
    // Skip preprocessor
    if (line.startsWith('#')) continue;

    // Member variable candidate
    const mm = MEMBER_RE.exec(line);
    if (!mm) continue;

    const [, staticKw, qualifiers, typeRaw, ptrMods, varName] = mm;
    const type = (typeRaw + ' ' + ptrMods).trim();
    const isPointer = isPointerLike(typeRaw, ptrMods);
    const isReference = isReferenceLike(typeRaw, ptrMods);
    const isSmartPtr = SMART_PTR_RE.test(typeRaw);

    const member: RawMemberVar = {
      name: varName,
      type: type.trim(),
      access: currentAccess,
      isStatic: !!staticKw,
      isConst: qualifiers.includes('const'),
      isPointer,
      isReference,
      isSmartPtr,
    };
    members.push(member);

    // Detect relationships from member type
    const relatedClasses = classNamesInType(typeRaw, knownClasses)
      .filter(cn => cn !== 'this');

    for (const targetClass of relatedClasses) {
      if (relMap.has(targetClass)) continue; // take first occurrence

      let kind: RelationshipKind;
      if (isSmartPtr && !typeRaw.includes('weak_ptr') && !typeRaw.includes('shared_ptr')) {
        kind = 'composition';  // unique_ptr = exclusive ownership
      } else if (isPointer || isReference || isSmartPtr) {
        kind = 'aggregation'; // non-owning or shared reference
      } else {
        kind = 'composition'; // value member = strong ownership
      }

      relMap.set(targetClass, { targetClass, kind, memberName: varName, access: currentAccess });
    }
  }

  return { members, relationships: [...relMap.values()] };
}
