import type { Finding } from './constructs.js';
import {
  CERTAINTY,
  deepestChain,
  depths,
  findCycles,
  outgoing,
  type CallGraph,
  type CallNode,
} from './flow.js';

/**
 * Flow-level findings.
 *
 * These are the things a C engineer would have seen for themselves in a C
 * codebase and cannot see here: where an indirect call sits, how deep the stack
 * goes through a polymorphic chain, and which edges the tool could not follow.
 *
 * The unresolved-edge finding is not an apology for a limitation. On a codebase
 * that dispatches through function pointers and type-erased callables, knowing
 * exactly where analysis stops is load-bearing information — it tells you which
 * parts of the program you must read rather than trust a diagram about.
 */

export interface FlowFindingOptions {
  /** Warn beyond this call depth. Embedded stacks are small. */
  depthWarning?: number;
}

function nodeLoc(n: CallNode | undefined): Pick<Finding, 'file' | 'line'> {
  return n?.file ? { file: n.file, line: n.line ?? 1 } : {};
}

export function detectFlowConstructs(graph: CallGraph, opts: FlowFindingOptions = {}): Finding[] {
  const out: Finding[] = [];
  const depthWarning = opts.depthWarning ?? 8;
  const node = (id: string) => graph.nodes.get(id);

  // --- Indirect dispatch reached from an interrupt handler ------------------
  const isrRoots = [...graph.nodes.values()].filter((n) => n.isr);
  for (const isr of isrRoots) {
    const reachable = reachableFrom(graph, isr.id);
    const indirect = graph.edges.filter(
      (e) => reachable.has(e.from) && CERTAINTY[e.resolution] !== 'certain',
    );
    if (indirect.length === 0) {
      continue;
    }
    out.push({
      construct: 'indirect_call_in_isr',
      severity: 'trap',
      typeId: isr.id,
      qualifiedName: isr.name,
      title: `${isr.isr!.reason} reaches ${indirect.length} indirect call${indirect.length === 1 ? '' : 's'}`,
      emits:
        'Each one loads a vtable pointer from the object, loads a slot from the vtable in flash, then branches. ' +
        'None of it can be inlined, and the flash read is not necessarily fast or deterministic on this part.',
      cEquivalent:
        'Calling through a function pointer stored in a struct, from inside an ISR. You would have thought hard ' +
        'about that in C. The C++ syntax hides it, which is the only difference.',
      ...nodeLoc(isr),
    });
  }

  // --- Recursion ------------------------------------------------------------
  for (const cycle of findCycles(graph)) {
    const head = node(cycle[0]);
    const selfCall = cycle.length === 2 && cycle[0] === cycle[1];
    out.push({
      construct: selfCall ? 'direct_recursion' : 'mutual_recursion',
      severity: 'trap',
      typeId: cycle[0],
      qualifiedName: head?.name ?? cycle[0],
      title: selfCall
        ? `${head?.name ?? cycle[0]} calls itself`
        : `Recursive cycle: ${cycle.map((c) => node(c)?.name ?? c).join(' -> ')}`,
      emits:
        'Stack usage that static analysis cannot bound. -fstack-usage reports per-frame cost but not total depth, ' +
        'so the worst case has to be reasoned about by hand.',
      cEquivalent:
        'Exactly the same hazard as in C, and just as unwelcome on a part with a few kilobytes of stack. Worth ' +
        'confirming the recursion is depth-bounded by something other than hope.',
      ...nodeLoc(head),
    });
  }

  // --- Depth ----------------------------------------------------------------
  const chain = deepestChain(graph);
  if (chain.length > depthWarning) {
    const tail = node(chain[chain.length - 1]);
    out.push({
      construct: 'deep_call_chain',
      severity: 'trap',
      typeId: chain[chain.length - 1],
      qualifiedName: tail?.name ?? '',
      title: `Call chain ${chain.length} frames deep`,
      emits:
        'Every frame costs stack. Where the chain passes through a virtual call the compiler cannot inline across ' +
        'it, so frames that would have collapsed in C survive here.',
      cEquivalent:
        `The same chain written in C would likely have been flattened by the inliner. Path: ` +
        chain.map((c) => node(c)?.name ?? c).join(' -> '),
      ...nodeLoc(tail),
    });
  }

  // --- Fan-out from a single polymorphic site -------------------------------
  const byFrom = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.resolution === 'cha' || e.resolution === 'rta') {
      byFrom.set(`${e.from}|${e.callSite?.line ?? 0}`, (byFrom.get(`${e.from}|${e.callSite?.line ?? 0}`) ?? 0) + 1);
    }
  }
  for (const [key, count] of byFrom) {
    if (count < 3) {
      continue;
    }
    const from = node(key.split('|')[0]);
    out.push({
      construct: 'wide_polymorphic_call',
      severity: 'new',
      typeId: key.split('|')[0],
      qualifiedName: from?.name ?? '',
      title: `One call site with ${count} possible targets`,
      emits:
        'A single indirect branch the branch predictor cannot learn, and a vtable slot that must exist in every ' +
        'implementation. Reading this code means holding all of the targets in mind at once.',
      cEquivalent:
        'A switch over a type tag, or a function-pointer table with several entries. In C the set of targets is ' +
        'written down in one place; here it is spread across the codebase and you need the tool to enumerate it.',
      ...nodeLoc(from),
    });
  }

  // --- Where analysis stops -------------------------------------------------
  const unresolved = graph.edges.filter((e) => e.resolution === 'unresolved' || e.resolution === 'fn_ptr');
  if (unresolved.length > 0) {
    const first = node(unresolved[0].from);
    out.push({
      construct: 'unresolved_dispatch',
      severity: 'new',
      typeId: unresolved[0].from,
      qualifiedName: first?.name ?? '',
      title: `${unresolved.length} call${unresolved.length === 1 ? '' : 's'} Lens could not follow`,
      emits:
        'Unknown. These go through a function pointer, a type-erased callable, or a type outside the analysed scope.',
      cEquivalent:
        'The parts of the program you still have to read rather than trust a diagram about. Marked so you know ' +
        'where the map ends rather than assuming the blank area is empty.',
      ...nodeLoc(first),
    });
  }

  return out;
}

function reachableFrom(graph: CallGraph, start: string): Set<string> {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length > 0) {
    for (const e of outgoing(graph, stack.pop()!)) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return seen;
}

export interface FlowSummary {
  nodes: number;
  edges: number;
  certain: number;
  bounded: number;
  unknown: number;
  maxDepth: number;
  isrCount: number;
}

export function summariseFlow(graph: CallGraph): FlowSummary {
  const d = depths(graph);
  let certain = 0;
  let bounded = 0;
  let unknown = 0;
  for (const e of graph.edges) {
    const c = CERTAINTY[e.resolution];
    if (c === 'certain') {
      certain += 1;
    } else if (c === 'bounded') {
      bounded += 1;
    } else {
      unknown += 1;
    }
  }
  return {
    nodes: graph.nodes.size,
    edges: graph.edges.length,
    certain,
    bounded,
    unknown,
    maxDepth: Math.max(0, ...d.values()),
    isrCount: [...graph.nodes.values()].filter((n) => n.isr).length,
  };
}
