import { bareTypeName, inMainFile, typeName, walk, type AstNode, type Located } from './ast.js';
import type { Finding } from './constructs.js';
import { flattenTrace, type TraceCall } from './uftrace.js';

/**
 * Sequence.
 *
 * Two planes, and the gap between them is the point.
 *
 * The static plane comes from the AST already parsed for the Rosetta lens: which
 * calls a function makes, in source order, and under which conditions. No new
 * tool, and it covers the compiled-but-never-run code that a trace by definition
 * cannot.
 *
 * The dynamic plane comes from a trace: what actually ran. It settles the
 * questions static analysis can only bound — which overrider a virtual call
 * reached, whether a branch is ever taken, what the ordering really was.
 *
 * Neither is the truth on its own. A call the static plane predicts and the trace
 * never shows is either dead code or an untested path, and knowing which is worth
 * more than either diagram alone.
 */

export interface StaticStep {
  /** Callee as written, qualified where the AST knew the receiver type. */
  name: string;
  line: number;
  /** Enclosing control flow, outermost first: `if`, `for`, `while`, `try`, `catch`, `switch`. */
  guards: string[];
  /** True when dispatch is virtual and the target is therefore not fixed here. */
  virtualDispatch?: boolean;
}

export interface StaticSequence {
  function: string;
  steps: StaticStep[];
}

const GUARD_KINDS: Record<string, string> = {
  IfStmt: 'if',
  ForStmt: 'for',
  WhileStmt: 'while',
  DoStmt: 'do',
  CXXForRangeStmt: 'for each',
  SwitchStmt: 'switch',
  CaseStmt: 'case',
  CXXTryStmt: 'try',
  CXXCatchStmt: 'catch',
  ConditionalOperator: '?:',
};

function guardsOf(l: Located): string[] {
  return l.ancestors.map((a) => GUARD_KINDS[a.kind ?? '']).filter((g): g is string => g !== undefined);
}

function calleeName(n: AstNode): string | undefined {
  const direct = n.inner?.find((c) => c.kind === 'DeclRefExpr' || c.kind === 'ImplicitCastExpr');
  const ref = direct?.kind === 'DeclRefExpr' ? direct : direct?.inner?.find((c) => c.kind === 'DeclRefExpr');
  const decl = ref?.referencedDecl as AstNode | undefined;
  return typeof decl?.name === 'string' ? decl.name : undefined;
}

function memberCallName(n: AstNode): { name: string; receiver: string } | undefined {
  const member = n.inner?.find((c) => c.kind === 'MemberExpr');
  if (!member || typeof member.name !== 'string') {
    return undefined;
  }
  const receiver = member.inner?.[0];
  return { name: member.name, receiver: receiver ? bareTypeName(typeName(receiver)) : '' };
}

export interface StaticSequenceOptions {
  mainFile: string;
  /** Method names known to be virtual, qualified `Type::method`. */
  virtualMethods?: Set<string>;
}

export function staticSequence(roots: AstNode[], opts: StaticSequenceOptions): StaticSequence {
  const located = walk(roots, opts.mainFile).filter((l) => inMainFile(l, opts.mainFile));
  const fn = located.find((l) => l.node.kind === 'FunctionDecl' || l.node.kind === 'CXXMethodDecl');
  const steps: StaticStep[] = [];

  for (const l of located) {
    const kind = l.node.kind;
    if (kind === 'CXXMemberCallExpr') {
      const m = memberCallName(l.node);
      if (!m) {
        continue;
      }
      const qualified = m.receiver ? `${m.receiver}::${m.name}` : m.name;
      steps.push({
        name: qualified,
        line: l.span.beginLine,
        guards: guardsOf(l),
        ...(opts.virtualMethods?.has(qualified) ? { virtualDispatch: true } : {}),
      });
      continue;
    }
    if (kind === 'CallExpr' || kind === 'CXXOperatorCallExpr') {
      const name = calleeName(l.node);
      if (name) {
        steps.push({ name, line: l.span.beginLine, guards: guardsOf(l) });
      }
      continue;
    }
    if (kind === 'CXXConstructExpr') {
      const type = bareTypeName(typeName(l.node));
      if (type) {
        steps.push({ name: `${type}::${type.split('::').pop()}`, line: l.span.beginLine, guards: guardsOf(l) });
      }
    }
  }

  // The AST emits nodes in source order already, but constructor arguments nest
  // deeper than their statement, so a stable sort by line keeps the sequence
  // readable without disturbing intra-line ordering.
  steps.sort((a, b) => a.line - b.line);
  return { function: typeof fn?.node.name === 'string' ? fn.node.name : 'unknown', steps };
}

// ---------------------------------------------------------------------------
// Comparing the planes
// ---------------------------------------------------------------------------

export interface SequenceComparison {
  /** Predicted and observed. */
  confirmed: string[];
  /** Predicted but never seen running. */
  neverRan: string[];
  /** Observed but not predicted from this function — usually indirect dispatch. */
  unpredicted: string[];
  coverage: number;
}

/**
 * Name matching across the two planes.
 *
 * The static plane sees a call as written — `is_uart`, or `Buffer::data` where
 * the AST knew the receiver type. The trace reports it fully qualified —
 * `fw::is_uart`. Neither is more correct, and comparing them by equality or by
 * a fixed number of trailing components fails in both directions: a free
 * function has one component, a member function two, a nested type more.
 *
 * The rule that works is suffix matching. Two names refer to the same function
 * when one's component list is a suffix of the other's, which is exactly the
 * relationship between a partially and a fully qualified name.
 */
function components(name: string): string[] {
  return name.split('::').filter((c) => c.length > 0);
}

function sameFunction(a: string[], b: string[]): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length === 0) {
    return false;
  }
  return shorter.every((part, i) => part === longer[longer.length - shorter.length + i]);
}

export function compareSequences(sequence: StaticSequence, trace: TraceCall[]): SequenceComparison {
  const observedNames = [...new Set(flattenTrace(trace).map((c) => c.name))];
  const predictedNames = [...new Set(sequence.steps.map((s) => s.name))];
  const observed = observedNames.map(components);
  const predicted = predictedNames.map(components);

  const confirmed = predictedNames.filter((_, i) => observed.some((o) => sameFunction(predicted[i], o))).sort();
  const neverRan = predictedNames.filter((_, i) => !observed.some((o) => sameFunction(predicted[i], o))).sort();
  const unpredicted = observedNames.filter((_, i) => !predicted.some((p) => sameFunction(observed[i], p))).sort();

  return {
    confirmed,
    neverRan,
    unpredicted,
    coverage: predictedNames.length > 0 ? confirmed.length / predictedNames.length : 0,
  };
}

export function detectSequenceConstructs(
  sequence: StaticSequence,
  comparison?: SequenceComparison,
): Finding[] {
  const out: Finding[] = [];
  const push = (f: Omit<Finding, 'typeId' | 'qualifiedName'>) =>
    out.push({ ...f, typeId: sequence.function, qualifiedName: sequence.function });

  const virtuals = sequence.steps.filter((s) => s.virtualDispatch);
  if (virtuals.length > 0) {
    push({
      construct: 'sequence_virtual_dispatch',
      severity: 'new',
      title: `${virtuals.length} step${virtuals.length === 1 ? '' : 's'} in this sequence dispatch virtually`,
      emits:
        `Reading the source in order tells you ${virtuals.map((v) => v.name).join(', ')} is called; it does not ` +
        'tell you what runs. The static sequence has a hole at each of these points.',
      cEquivalent:
        'A call through a function-pointer table. In C the table is in front of you; here the Flow lens has to ' +
        'enumerate it and a trace has to settle it.',
    });
  }

  const guarded = sequence.steps.filter((s) => s.guards.length >= 2);
  if (guarded.length > 0) {
    push({
      construct: 'deeply_guarded_call',
      severity: 'new',
      title: `${guarded.length} call${guarded.length === 1 ? '' : 's'} nested two or more levels deep in control flow`,
      emits:
        `Reached only under ${guarded[0].guards.join(' > ')}. Sequence diagrams flatten this; the guard column ` +
        'keeps it visible.',
      cEquivalent: 'Identical in C. Worth noting only because a flattened diagram would have hidden it.',
    });
  }

  if (comparison) {
    if (comparison.neverRan.length > 0) {
      push({
        construct: 'never_executed',
        severity: 'trap',
        title: `${comparison.neverRan.length} predicted call${
          comparison.neverRan.length === 1 ? '' : 's'
        } never ran in this trace`,
        emits:
          `Not observed: ${comparison.neverRan.slice(0, 6).join(', ')}. Either dead code, or a path the trace ` +
          'never exercised — and which of those it is matters a great deal.',
        cEquivalent:
          'The same question you would ask of a C codebase with coverage data. The difference is that here some ' +
          'of the unexecuted paths are generated rather than written.',
      });
    }
    if (comparison.unpredicted.length > 0) {
      push({
        construct: 'unpredicted_call',
        severity: 'trap',
        title: `${comparison.unpredicted.length} observed call${
          comparison.unpredicted.length === 1 ? '' : 's'
        } the static reading did not predict`,
        emits:
          `Seen running but not visible in this function's source: ${comparison.unpredicted.slice(0, 6).join(', ')}. ` +
          'These arrive through virtual dispatch, function pointers, or compiler-generated code such as ' +
          'constructors and destructors.',
        cEquivalent:
          'The gap between what the source says and what the machine does. In C that gap is narrow; this is a ' +
          'measurement of how wide it has become.',
      });
    }
  }

  return out;
}
