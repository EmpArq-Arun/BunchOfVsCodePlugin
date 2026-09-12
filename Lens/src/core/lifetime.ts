import { bareTypeName, inMainFile, typeName, walk, type AstNode, type Located } from './ast.js';
import type { Finding } from './constructs.js';
import type { StructureModel } from './structure.js';

/**
 * Lifetime.
 *
 * The most alien concept coming from C, and the one with no syntax. In C the
 * lifetime of a thing is where you wrote malloc and where you wrote free, both
 * visible. In C++ construction is often implicit, destruction is always
 * implicit, and the order is fixed by rules rather than by anything in the text.
 *
 * This lens makes the invisible part explicit: which objects are alive over
 * which lines, in what order they are destroyed, and where a reference is being
 * kept to something that will not outlive it.
 */

export interface Scope {
  id: number;
  parentId?: number;
  beginLine: number;
  endLine: number;
  /** `function`, `block`, `if`, `for`, `while`, `try`, `catch`. */
  kind: string;
}

export interface TrackedObject {
  name: string;
  type: string;
  scopeId: number;
  constructedLine: number;
  /** Line where the destructor runs: the closing brace of the owning scope. */
  destroyedLine: number;
  /**
   * Position within its scope's destruction order, 0 destroyed first. Reverse of
   * construction order — the rule with no syntax to remind you of it.
   */
  destructionRank: number;
  storage: 'automatic' | 'static' | 'temporary' | 'dynamic';
  hasDestructor: boolean;
}

export interface LifetimeModel {
  scopes: Scope[];
  objects: TrackedObject[];
  /** References or pointers bound to something shorter-lived. */
  danglingRisks: { name: string; line: number; reason: string }[];
}

const SCOPE_KINDS: Record<string, string> = {
  FunctionDecl: 'function',
  CXXMethodDecl: 'function',
  CompoundStmt: 'block',
  IfStmt: 'if',
  ForStmt: 'for',
  WhileStmt: 'while',
  CXXForRangeStmt: 'for each',
  CXXTryStmt: 'try',
  CXXCatchStmt: 'catch',
};

function hasDestructor(type: string, structure?: StructureModel): boolean {
  if (!structure) {
    // Assume yes and let the caller hedge. Showing a lifetime that turns out to
    // be free is a smaller error than hiding one that is not.
    return true;
  }
  const bare = bareTypeName(type);
  const short = bare.split('::').pop() ?? bare;
  const t = structure.types.find((x) => x.qualifiedName === bare || x.name === short);
  return t ? t.methods.some((m) => m.isDestructor) : true;
}

function isRecordType(qual: string): boolean {
  // Builtins and pointers have no destructor and no interesting lifetime.
  const bare = bareTypeName(qual);
  return (
    bare.length > 0 &&
    !/^(void|bool|char|signed|unsigned|short|int|long|float|double|u?int\d+_t|size_t|ptrdiff_t|auto)\b/.test(bare) &&
    !qual.includes('*')
  );
}

export interface LifetimeOptions {
  mainFile: string;
  structure?: StructureModel;
}

export function analyseLifetimes(roots: AstNode[], opts: LifetimeOptions): LifetimeModel {
  const located = walk(roots, opts.mainFile).filter((l) => inMainFile(l, opts.mainFile));

  const scopes: Scope[] = [];
  const scopeOf = new Map<AstNode, number>();
  let nextId = 0;

  for (const l of located) {
    const kind = SCOPE_KINDS[l.node.kind ?? ''];
    if (!kind) {
      continue;
    }
    const parent = [...l.ancestors].reverse().find((a) => scopeOf.has(a));
    const id = nextId++;
    scopeOf.set(l.node, id);
    scopes.push({
      id,
      ...(parent !== undefined ? { parentId: scopeOf.get(parent)! } : {}),
      beginLine: l.span.beginLine,
      endLine: l.span.endLine,
      kind,
    });
  }

  const enclosingScope = (l: Located): Scope | undefined => {
    for (let i = l.ancestors.length - 1; i >= 0; i--) {
      const id = scopeOf.get(l.ancestors[i]);
      if (id !== undefined) {
        return scopes[id];
      }
    }
    return undefined;
  };

  const objects: TrackedObject[] = [];
  const danglingRisks: LifetimeModel['danglingRisks'] = [];
  const perScopeOrder = new Map<number, number>();

  for (const l of located) {
    const n = l.node;

    if (n.kind === 'VarDecl' && typeof n.name === 'string') {
      const type = typeName(n);
      const scope = enclosingScope(l);
      if (!scope) {
        continue;
      }

      // A reference or pointer bound inside a narrower scope than the thing it
      // is declared alongside is the shape of a dangling bug.
      if (type.includes('&') && n.init === 'c') {
        const initialiser = n.inner?.find((c) => c.kind === 'CallExpr' || c.kind === 'CXXMemberCallExpr');
        if (initialiser) {
          danglingRisks.push({
            name: n.name,
            line: l.span.beginLine,
            reason:
              'a reference bound to the result of a call — if that result was a temporary, it dies at the ' +
              'end of this statement and the reference is dangling from the semicolon',
          });
        }
      }

      if (!isRecordType(type)) {
        continue;
      }
      const storage: TrackedObject['storage'] = n.storageClass === 'static' ? 'static' : 'automatic';
      const rank = perScopeOrder.get(scope.id) ?? 0;
      perScopeOrder.set(scope.id, rank + 1);

      objects.push({
        name: n.name,
        type: bareTypeName(type),
        scopeId: scope.id,
        constructedLine: l.span.beginLine,
        destroyedLine: storage === 'static' ? -1 : scope.endLine,
        destructionRank: rank,
        storage,
        hasDestructor: hasDestructor(type, opts.structure),
      });
      continue;
    }

    if (n.kind === 'CXXNewExpr') {
      const scope = enclosingScope(l);
      objects.push({
        name: '(heap)',
        type: bareTypeName(typeName(n)),
        scopeId: scope?.id ?? 0,
        constructedLine: l.span.beginLine,
        // Nothing in the language ends this one for you.
        destroyedLine: -1,
        destructionRank: -1,
        storage: 'dynamic',
        hasDestructor: hasDestructor(typeName(n), opts.structure),
      });
      continue;
    }

    if (n.kind === 'MaterializeTemporaryExpr') {
      const scope = enclosingScope(l);
      objects.push({
        name: '(temporary)',
        type: bareTypeName(typeName(n)),
        scopeId: scope?.id ?? 0,
        constructedLine: l.span.beginLine,
        destroyedLine: l.span.beginLine,
        destructionRank: -1,
        storage: 'temporary',
        hasDestructor: hasDestructor(typeName(n), opts.structure),
      });
    }
  }

  // Destruction is reverse construction order within a scope. Recompute the rank
  // so that 0 means "destroyed first", which is what a reader wants to see.
  const byScope = new Map<number, TrackedObject[]>();
  for (const o of objects.filter((x) => x.storage === 'automatic')) {
    (byScope.get(o.scopeId) ?? byScope.set(o.scopeId, []).get(o.scopeId)!).push(o);
  }
  for (const list of byScope.values()) {
    list.sort((a, b) => a.constructedLine - b.constructedLine);
    list.forEach((o, i) => {
      o.destructionRank = list.length - 1 - i;
    });
  }

  return { scopes, objects, danglingRisks };
}

export function detectLifetimeConstructs(model: LifetimeModel): Finding[] {
  const out: Finding[] = [];
  const push = (f: Omit<Finding, 'typeId' | 'qualifiedName'>, id: string, line?: number) =>
    out.push({ ...f, typeId: id, qualifiedName: id, ...(line !== undefined ? { line } : {}) });

  const automatic = model.objects.filter((o) => o.storage === 'automatic' && o.hasDestructor);
  const byScope = new Map<number, TrackedObject[]>();
  for (const o of automatic) {
    (byScope.get(o.scopeId) ?? byScope.set(o.scopeId, []).get(o.scopeId)!).push(o);
  }

  for (const [, list] of byScope) {
    if (list.length < 2) {
      continue;
    }
    const order = [...list].sort((a, b) => a.destructionRank - b.destructionRank);
    push(
      {
        construct: 'destruction_order',
        severity: 'new',
        title: `${list.length} objects destroyed in reverse order at line ${list[0].destroyedLine}`,
        emits:
          `Order: ${order.map((o) => o.name).join(', then ')}. Nothing in the source says this; it is the ` +
          'reverse of construction order, and it holds on every exit path including a thrown exception.',
        cEquivalent:
          'The cleanup calls you would have written before each return, in the order you would have had to ' +
          'get right by hand. Here the compiler gets it right and you cannot see it happening.',
      },
      'destruction-order',
      list[0].destroyedLine,
    );
  }

  const heap = model.objects.filter((o) => o.storage === 'dynamic');
  if (heap.length > 0) {
    push(
      {
        construct: 'unbounded_lifetime',
        severity: 'trap',
        title: `${heap.length} heap object${heap.length === 1 ? '' : 's'} whose lifetime nothing ends automatically`,
        emits:
          'A `new` with no owning object. Nothing in the language will destroy this; some code path has to, on ' +
          'every route out including the exceptional ones.',
        cEquivalent:
          'malloc without a matching free in sight. The C instinct is exactly right here — the difference is ' +
          'only that a smart pointer would have made it someone else\'s problem.',
      },
      'heap-lifetime',
      heap[0].constructedLine,
    );
  }

  for (const risk of model.danglingRisks) {
    push(
      {
        construct: 'dangling_risk',
        severity: 'trap',
        title: `${risk.name} may outlive what it refers to`,
        emits: risk.reason,
        cEquivalent:
          'Returning a pointer to a local. C would let you do it too; the difference is that here the temporary ' +
          'was never named, so there is nothing in the source to point at.',
      },
      risk.name,
      risk.line,
    );
  }

  const temporaries = model.objects.filter((o) => o.storage === 'temporary' && o.hasDestructor);
  if (temporaries.length > 0) {
    push(
      {
        construct: 'temporary_lifetime',
        severity: 'new',
        title: `${temporaries.length} temporary object${
          temporaries.length === 1 ? '' : 's'
        } created and destroyed inside a single statement`,
        emits:
          'Each is built, used, and destroyed before the next statement begins. Binding a reference to one and ' +
          'keeping it past the semicolon is undefined behaviour that usually appears to work.',
        cEquivalent:
          'A local you would have declared, used and let go out of scope — except it has no name, so nothing in ' +
          'the source marks either end of its life.',
      },
      'temporaries',
      temporaries[0].constructedLine,
    );
  }

  return out;
}

/** Objects alive at a given line, for the gutter timeline. */
export function aliveAt(model: LifetimeModel, line: number): TrackedObject[] {
  return model.objects.filter(
    (o) => o.constructedLine <= line && (o.destroyedLine === -1 || line <= o.destroyedLine),
  );
}
