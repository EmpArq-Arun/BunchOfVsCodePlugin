import { inMainFile, walk, type AstNode, type Located } from './ast.js';
import type { Finding } from './constructs.js';

/**
 * Complexity, computed from the AST.
 *
 * The design had this coming from lizard, carried over from Complexity Cosmos.
 * Once clang's AST is already being parsed for the Rosetta lens, lizard is a
 * Python runtime to install in order to re-derive something the AST states
 * directly — and lizard counts tokens, so it cannot see the branches C++
 * generates rather than spells: an implicit conversion that calls a constructor,
 * a destructor running on an exceptional path.
 *
 * Cyclomatic complexity here is the standard count: one, plus one for every
 * point where control can take a different route.
 */

/** Nodes that introduce a decision point. */
const DECISION_KINDS = new Set([
  'IfStmt',
  'ForStmt',
  'WhileStmt',
  'DoStmt',
  'CXXForRangeStmt',
  'CaseStmt',
  'CXXCatchStmt',
  'ConditionalOperator',
  'BinaryConditionalOperator',
]);

/** Short-circuit operators branch without a statement to show for it. */
function isShortCircuit(n: AstNode): boolean {
  return n.kind === 'BinaryOperator' && (n.opcode === '&&' || n.opcode === '||');
}

/**
 * Paths a C reader would not count.
 *
 * A `throw` adds a route out of the function. So does any call that might throw,
 * but counting those would make every line a branch, so only the explicit ones
 * are counted and the implicit ones are named in the finding instead.
 */
const HIDDEN_PATH_KINDS = new Set(['CXXThrowExpr']);

export interface FunctionComplexity {
  name: string;
  line: number;
  /** Standard cyclomatic complexity. */
  cyclomatic: number;
  /** Decision points a C reader would recognise from the source text. */
  visible: number;
  /** Additional exits C++ introduces: throws, and destructors on unwind paths. */
  hidden: number;
  /** Nesting depth of the deepest decision. */
  maxDepth: number;
  statements: number;
}

function functionsIn(located: Located[]): Located[] {
  return located.filter(
    (l) =>
      (l.node.kind === 'FunctionDecl' || l.node.kind === 'CXXMethodDecl') &&
      l.node.inner?.some((c) => c.kind === 'CompoundStmt'),
  );
}

function within(inner: Located, outer: Located): boolean {
  return inner.ancestors.includes(outer.node);
}

export function measureComplexity(roots: AstNode[], mainFile: string): FunctionComplexity[] {
  const located = walk(roots, mainFile).filter((l) => inMainFile(l, mainFile));
  const out: FunctionComplexity[] = [];

  for (const fn of functionsIn(located)) {
    const body = located.filter((l) => within(l, fn));
    let visible = 0;
    let hidden = 0;
    let maxDepth = 0;
    let statements = 0;

    for (const l of body) {
      const kind = l.node.kind ?? '';
      if (DECISION_KINDS.has(kind) || isShortCircuit(l.node)) {
        visible += 1;
        const depth = l.ancestors.filter(
          (a) => DECISION_KINDS.has(a.kind ?? '') || isShortCircuit(a),
        ).length;
        maxDepth = Math.max(maxDepth, depth + 1);
      }
      if (HIDDEN_PATH_KINDS.has(kind)) {
        hidden += 1;
      }
      if (kind.endsWith('Stmt')) {
        statements += 1;
      }
    }

    out.push({
      name: typeof fn.node.name === 'string' ? fn.node.name : '(anonymous)',
      line: fn.span.beginLine,
      cyclomatic: 1 + visible + hidden,
      visible,
      hidden,
      maxDepth,
      statements,
    });
  }

  return out.sort((a, b) => b.cyclomatic - a.cyclomatic);
}

export interface ComplexityThresholds {
  /** Above this, a function is worth breaking up. */
  warn: number;
  /** Nesting beyond this is hard to hold in your head. */
  depth: number;
}

export const DEFAULT_THRESHOLDS: ComplexityThresholds = { warn: 10, depth: 4 };

export function detectComplexityConstructs(
  functions: FunctionComplexity[],
  thresholds: ComplexityThresholds = DEFAULT_THRESHOLDS,
): Finding[] {
  const out: Finding[] = [];

  for (const f of functions) {
    if (f.cyclomatic > thresholds.warn) {
      out.push({
        construct: 'high_complexity',
        severity: 'new',
        typeId: f.name,
        qualifiedName: f.name,
        line: f.line,
        title: `${f.name} has cyclomatic complexity ${f.cyclomatic}`,
        emits:
          `${f.visible} decision points you can see in the source` +
          (f.hidden > 0 ? `, plus ${f.hidden} explicit throw${f.hidden === 1 ? '' : 's'}` : '') +
          '. Every call that can throw adds another exit on top of this, which is why a C++ function is harder ' +
          'to reason about than its branch count suggests.',
        cEquivalent:
          'The same count you would get in C, except that in C the exits are all visible as return statements ' +
          'and here some of them are not written down.',
      });
    }
    if (f.maxDepth > thresholds.depth) {
      out.push({
        construct: 'deep_nesting',
        severity: 'new',
        typeId: f.name,
        qualifiedName: f.name,
        line: f.line,
        title: `${f.name} nests control flow ${f.maxDepth} levels deep`,
        emits: 'Reading the innermost statement means holding every enclosing condition in mind at once.',
        cEquivalent: 'Identical in C, and the same early-return remedy applies.',
      });
    }
  }

  return out;
}

export interface ComplexitySnapshot {
  takenAt: string;
  file: string;
  functions: FunctionComplexity[];
}

/**
 * Compare two snapshots. Tracking direction over time is the point — an absolute
 * number is an opinion, a trend is evidence.
 */
export function compareSnapshots(
  before: ComplexitySnapshot,
  after: ComplexitySnapshot,
): { name: string; from: number; to: number; delta: number }[] {
  const previous = new Map(before.functions.map((f) => [f.name, f.cyclomatic]));
  const out: { name: string; from: number; to: number; delta: number }[] = [];

  for (const f of after.functions) {
    const from = previous.get(f.name);
    if (from !== undefined && from !== f.cyclomatic) {
      out.push({ name: f.name, from, to: f.cyclomatic, delta: f.cyclomatic - from });
    }
  }
  for (const [name, from] of previous) {
    if (!after.functions.some((f) => f.name === name)) {
      out.push({ name, from, to: 0, delta: -from });
    }
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}
