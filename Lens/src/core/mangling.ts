/**
 * Itanium ABI name classification.
 *
 * This is the join. Every artifact the C++ ABI emits carries a prefix naming
 * what it is and, embedded in the rest of the symbol, the class or function that
 * caused it. `_ZTVN2fw4ISpiE` is not an opaque blob taking 40 bytes of .rodata;
 * it is the vtable for `fw::ISpi`, which exists because somebody wrote `virtual`.
 * Turning the first statement into the second is the whole point of the lens.
 *
 * What is implemented is *name* demangling, not signature demangling. The entity
 * name is what attribution needs, and it is the part that avoids the genuinely
 * hard machinery — substitutions, template argument packs, expression encodings —
 * which appear almost entirely in parameter types. Where the parser cannot make
 * sense of a name it says so and falls back to the raw symbol, rather than
 * guessing a prettier one.
 */

export type ArtifactKind =
  | 'vtable'
  | 'vtt'
  | 'construction-vtable'
  | 'typeinfo'
  | 'typeinfo-name'
  | 'thunk'
  | 'covariant-thunk'
  | 'guard-variable'
  | 'local-static'
  | 'constructor'
  | 'destructor'
  | 'function'
  | 'variable'
  | 'runtime-support'
  | 'unmangled';

export interface Classified {
  kind: ArtifactKind;
  /** Demangled entity name where it could be recovered, else the raw symbol. */
  entity: string;
  /** The class or function the artifact belongs to, for grouping. */
  owner?: string;
  /** Plain-language reason this artifact exists at all. */
  because: string;
  /** True when the name could not be fully demangled. */
  partial: boolean;
}

/** Runtime support entry points, recognised by name rather than by prefix. */
const RUNTIME_SUPPORT: { match: RegExp; because: string }[] = [
  { match: /^__cxa_throw$/, because: 'exceptions: throwing' },
  { match: /^__cxa_allocate_exception$|^__cxa_free_exception$/, because: 'exceptions: exception object storage' },
  { match: /^__cxa_begin_catch$|^__cxa_end_catch$|^__cxa_rethrow$/, because: 'exceptions: catching' },
  { match: /^__cxa_call_unexpected$|^__cxa_bad_cast$|^__cxa_bad_typeid$/, because: 'exceptions: failure paths' },
  { match: /^_Unwind_/, because: 'exceptions: stack unwinding' },
  { match: /^__gxx_personality/, because: 'exceptions: the personality routine that drives unwinding' },
  { match: /^__cxa_guard_(acquire|release|abort)$/, because: 'thread-safe function-local statics' },
  { match: /^__dynamic_cast$/, because: 'RTTI: dynamic_cast' },
  { match: /^__cxa_pure_virtual$/, because: 'the trap called if a pure virtual is ever dispatched to' },
  { match: /^__cxa_atexit$|^__cxa_finalize$/, because: 'destructors for objects with static storage duration' },
  { match: /^_Znw|^_Zna|^_Zdl|^_Zda/, because: 'operator new / operator delete' },
  { match: /^malloc$|^free$|^realloc$|^calloc$/, because: 'the heap, pulled in by operator new' },
  { match: /^_ZSt9terminate|^_ZSt13set_terminate|^_ZSt10unexpected/, because: 'the terminate handler' },
];

interface Cursor {
  s: string;
  i: number;
}

/** `<length><chars>` — the Itanium source-name encoding. */
function readSourceName(c: Cursor): string | undefined {
  const start = c.i;
  let len = 0;
  while (c.i < c.s.length && c.s[c.i] >= '0' && c.s[c.i] <= '9') {
    len = len * 10 + (c.s.charCodeAt(c.i) - 48);
    c.i += 1;
  }
  if (c.i === start || len === 0 || c.i + len > c.s.length) {
    c.i = start;
    return undefined;
  }
  const name = c.s.slice(c.i, c.i + len);
  c.i += len;
  return name;
}

const CTOR_DTOR = /^([CD])([0-9])/;

/**
 * Read a nested name `N ... E`, or a bare source name.
 * Returns the qualified name plus, for constructors and destructors, which kind.
 */
function readName(c: Cursor): { name: string; special?: 'ctor' | 'dtor'; complete: boolean } | undefined {
  if (c.s[c.i] === 'N') {
    c.i += 1;
    // CV-qualifiers and ref-qualifiers on the enclosing type precede components.
    while ('rVK'.includes(c.s[c.i] ?? '')) {
      c.i += 1;
    }
    const parts: string[] = [];
    let special: 'ctor' | 'dtor' | undefined;

    while (c.i < c.s.length && c.s[c.i] !== 'E') {
      const cd = CTOR_DTOR.exec(c.s.slice(c.i));
      if (cd) {
        special = cd[1] === 'C' ? 'ctor' : 'dtor';
        // A constructor's own name repeats the innermost class.
        parts.push(cd[1] === 'C' ? (parts[parts.length - 1] ?? '') : `~${parts[parts.length - 1] ?? ''}`);
        c.i += cd[0].length;
        continue;
      }
      if (c.s[c.i] === 'I') {
        // Template arguments: skipped to the matching E. Their content belongs
        // to the signature, which this parser deliberately does not decode.
        let depth = 0;
        while (c.i < c.s.length) {
          if (c.s[c.i] === 'I') {
            depth += 1;
          } else if (c.s[c.i] === 'E') {
            depth -= 1;
            if (depth === 0) {
              c.i += 1;
              break;
            }
          }
          c.i += 1;
        }
        if (parts.length > 0) {
          parts[parts.length - 1] += '<...>';
        }
        continue;
      }
      const part = readSourceName(c);
      if (!part) {
        return parts.length > 0 ? { name: parts.join('::'), special, complete: false } : undefined;
      }
      parts.push(part);
    }
    const complete = c.s[c.i] === 'E';
    if (complete) {
      c.i += 1;
    }
    return parts.length > 0 ? { name: parts.join('::'), special, complete } : undefined;
  }

  const bare = readSourceName(c);
  return bare ? { name: bare, complete: true } : undefined;
}

/** Drop the innermost component to get the owning class. */
function ownerOf(qualified: string): string | undefined {
  const i = qualified.lastIndexOf('::');
  return i > 0 ? qualified.slice(0, i) : undefined;
}

const ARTIFACT_PREFIXES: { prefix: string; kind: ArtifactKind; because: string }[] = [
  {
    prefix: '_ZTV',
    kind: 'vtable',
    because: 'this class has virtual functions, so it needs a table of them in .rodata',
  },
  {
    prefix: '_ZTT',
    kind: 'vtt',
    because: 'this class has virtual bases, so construction needs a table of vtable pointers',
  },
  {
    prefix: '_ZTC',
    kind: 'construction-vtable',
    because: 'a virtual base means a separate vtable is used partway through construction',
  },
  {
    prefix: '_ZTI',
    kind: 'typeinfo',
    because: 'RTTI is enabled and something can dynamic_cast or typeid this type',
  },
  {
    prefix: '_ZTS',
    kind: 'typeinfo-name',
    because: 'the type name string RTTI compares against, stored in full in .rodata',
  },
  {
    prefix: '_ZGV',
    kind: 'guard-variable',
    because: 'a function-local static with a runtime initialiser needs a flag saying whether it has run',
  },
];

export function classifySymbol(name: string): Classified {
  for (const r of RUNTIME_SUPPORT) {
    if (r.match.test(name)) {
      return { kind: 'runtime-support', entity: name, because: r.because, partial: false };
    }
  }

  if (!name.startsWith('_Z')) {
    return {
      kind: 'unmangled',
      entity: name,
      because: 'C linkage or a compiler-generated symbol',
      partial: false,
    };
  }

  // Thunks carry one or two offsets before the function they adjust for, and
  // the inner name is a bare <encoding> — it does not repeat the _Z prefix, so
  // it has to be restored before recursing.
  const thunk = /^_ZT([hv])([n0-9_]*?)_(N.*)$/.exec(name);
  if (thunk) {
    const inner = classifySymbol(`_Z${thunk[3]}`);
    return {
      kind: thunk[1] === 'h' ? 'thunk' : 'covariant-thunk',
      entity: inner.entity,
      ...(inner.owner ? { owner: inner.owner } : {}),
      because:
        'multiple inheritance: calling through a secondary base needs the this pointer adjusted before the ' +
        'real function runs',
      partial: inner.partial,
    };
  }

  for (const p of ARTIFACT_PREFIXES) {
    if (!name.startsWith(p.prefix)) {
      continue;
    }
    const c: Cursor = { s: name, i: p.prefix.length };
    // A guard variable wraps the mangled name of the variable it guards.
    if (p.kind === 'guard-variable') {
      const inner = classifySymbol(`_Z${name.slice(p.prefix.length)}`);
      return {
        kind: 'guard-variable',
        entity: inner.entity,
        ...(inner.owner ? { owner: inner.owner } : {}),
        because: p.because,
        partial: inner.partial,
      };
    }
    const parsed = readName(c);
    if (!parsed) {
      return { kind: p.kind, entity: name, because: p.because, partial: true };
    }
    return {
      kind: p.kind,
      entity: parsed.name,
      owner: parsed.name,
      because: p.because,
      partial: !parsed.complete,
    };
  }

  // Function-local entities are _ZZ<function encoding>E<name>, where the
  // function encoding includes its parameter types. Walking forward stops at
  // the E closing the nested name and leaves the parameters unconsumed, so the
  // split is made from the right: the last E followed by a length-prefixed
  // source name is the one that separates the two halves.
  if (name.startsWith('_ZZ')) {
    const split = /^_ZZ(.+)E(\d.*)$/.exec(name);
    if (split) {
      const enclosing = readName({ s: `_Z${split[1]}`, i: 2 });
      const local = readSourceName({ s: split[2], i: 0 });
      if (enclosing && local) {
        return {
          kind: 'local-static',
          entity: `${enclosing.name}::${local}`,
          owner: enclosing.name,
          because: 'a static declared inside a function still needs storage for the whole program',
          partial: !enclosing.complete,
        };
      }
    }
    const c: Cursor = { s: name, i: 3 };
    const enclosing = readName(c);
    const local = readSourceName(c);
    if (enclosing && local) {
      return {
        kind: 'local-static',
        entity: `${enclosing.name}::${local}`,
        owner: enclosing.name,
        because: 'a static declared inside a function still needs storage for the whole program',
        partial: !enclosing.complete,
      };
    }
    return { kind: 'local-static', entity: name, because: 'a function-local static', partial: true };
  }

  const c: Cursor = { s: name, i: 2 };
  const parsed = readName(c);
  if (!parsed) {
    return { kind: 'function', entity: name, because: 'a C++ function', partial: true };
  }

  if (parsed.special === 'ctor') {
    return {
      kind: 'constructor',
      entity: parsed.name,
      ...(ownerOf(parsed.name) ? { owner: ownerOf(parsed.name)! } : {}),
      because: 'a constructor. The compiler emits several variants of each one, which is why you see near-duplicates',
      partial: !parsed.complete,
    };
  }
  if (parsed.special === 'dtor') {
    return {
      kind: 'destructor',
      entity: parsed.name,
      ...(ownerOf(parsed.name) ? { owner: ownerOf(parsed.name)! } : {}),
      because:
        'a destructor. Up to three variants exist — complete, base, and deleting — so one written destructor can ' +
        'cost three functions',
      partial: !parsed.complete,
    };
  }

  const owner = ownerOf(parsed.name);
  return {
    kind: 'function',
    entity: parsed.name,
    ...(owner ? { owner } : {}),
    because: owner ? 'a member function' : 'a free function',
    partial: !parsed.complete,
  };
}

/** Best-effort readable name for display. */
export function demangle(name: string): string {
  return classifySymbol(name).entity;
}
