import * as vscode from 'vscode';
import {
  classifyIsr,
  resolveVirtualCall,
  type CallEdge,
  type CallGraph,
  type CallNode,
} from '../core/flow.js';
import type { StructureModel } from '../core/structure.js';
import { symbolAt, symbolsFor } from '../symbols.js';

/**
 * Call graph construction.
 *
 * The LSP call hierarchy is the source of edges, for the same reason the journal
 * uses document symbols: it routes to whichever language server the user already
 * has, and needs no build of our own. What it will not do is follow a virtual
 * call — clangd resolves `port->transfer()` to the *declaration* it can see
 * statically and stops there, which is correct but is exactly the dead end a C
 * engineer hits when reading polymorphic code by hand.
 *
 * So the graph is built in two passes. The LSP pass produces edges that are
 * certain: this call really does reach that declaration. The CHA pass then
 * expands any declaration that is virtual into the honest set of overriders it
 * might actually dispatch to, tagged so the two kinds of edge can never be
 * mistaken for each other.
 *
 * When no structure model is available the second pass simply does not run, and
 * the caller is told — a graph with unexpanded virtual calls is useful, but only
 * if you know that is what you are looking at.
 */

export interface BuildOptions {
  symbolTimeoutMs: number;
  maxDepth: number;
  maxNodes: number;
  isrPatterns: string[];
  structure?: StructureModel;
}

export interface BuildResult {
  graph: CallGraph;
  /** True when the traversal stopped early; the graph is a subset, not the whole truth. */
  truncated: boolean;
  /** Virtual calls that could not be expanded because no structure model was loaded. */
  unexpandedVirtuals: number;
}

/**
 * Why no call graph could be built.
 *
 * `no-symbols` and `no-hierarchy` look identical to a user and have completely
 * different fixes, which is why they are separate: the first means the language
 * server is not parsing this file at all — usually wrong flags for a header —
 * and the second means it parsed fine but has no call hierarchy to offer.
 */
export type BuildFailure =
  | { kind: 'no-symbols' }
  | { kind: 'no-hierarchy'; symbol?: string };

function qualified(item: vscode.CallHierarchyItem): string {
  const detail = item.detail?.trim() ?? '';
  // clangd puts the enclosing scope in `detail`, e.g. "fw::hal::SpiDriver".
  return detail.length > 0 && /^[\w:]+$/.test(detail) ? `${detail}::${item.name}` : item.name;
}

function toNode(item: vscode.CallHierarchyItem, isrPatterns: string[]): CallNode {
  const id = qualified(item);
  const isr = classifyIsr(id, isrPatterns);
  return {
    id,
    name: id,
    file: vscode.workspace.asRelativePath(item.uri),
    line: item.selectionRange.start.line + 1,
    ...(isr ? { isr } : {}),
  };
}

async function prepare(uri: vscode.Uri, position: vscode.Position): Promise<vscode.CallHierarchyItem | undefined> {
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[] | undefined>(
    'vscode.prepareCallHierarchy',
    uri,
    position,
  );
  return items?.[0];
}

async function outgoingOf(item: vscode.CallHierarchyItem): Promise<vscode.CallHierarchyOutgoingCall[]> {
  const calls = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[] | undefined>(
    'vscode.provideOutgoingCalls',
    item,
  );
  return calls ?? [];
}

/**
 * Find a call hierarchy root.
 *
 * The cursor is rarely on the function *name* — it is usually somewhere in the
 * body, which is where you were reading. Language servers anchor call hierarchy
 * to the name, so the cursor position is tried and then the enclosing symbol's
 * name position, which is what the user meant.
 */
async function findRoot(
  doc: vscode.TextDocument,
  position: vscode.Position,
  timeoutMs: number,
): Promise<{ item: vscode.CallHierarchyItem } | BuildFailure> {
  const direct = await prepare(doc.uri, position);
  if (direct) {
    return { item: direct };
  }

  const symbols = await symbolsFor(doc, timeoutMs);
  if (symbols.length === 0) {
    return { kind: 'no-symbols' };
  }
  const enclosing = symbolAt(symbols, position);
  if (enclosing) {
    const snapped = await prepare(doc.uri, enclosing.selection.start);
    if (snapped) {
      return { item: snapped };
    }
  }
  return { kind: 'no-hierarchy', ...(enclosing ? { symbol: enclosing.sym.qualifiedName } : {}) };
}

export async function buildCallGraph(
  doc: vscode.TextDocument,
  position: vscode.Position,
  opts: BuildOptions,
): Promise<BuildResult | BuildFailure> {
  const root = await findRoot(doc, position, opts.symbolTimeoutMs);
  if (!('item' in root)) {
    return root;
  }
  const rootItem = root.item;

  const nodes = new Map<string, CallNode>();
  const edges: CallEdge[] = [];
  const rootNode = toNode(rootItem, opts.isrPatterns);
  nodes.set(rootNode.id, rootNode);

  let truncated = false;
  let frontier: { item: vscode.CallHierarchyItem; id: string }[] = [{ item: rootItem, id: rootNode.id }];
  const expanded = new Set<string>([rootNode.id]);

  for (let depth = 0; depth < opts.maxDepth && frontier.length > 0; depth++) {
    const next: { item: vscode.CallHierarchyItem; id: string }[] = [];
    for (const { item, id } of frontier) {
      if (nodes.size >= opts.maxNodes) {
        truncated = true;
        break;
      }
      for (const call of await outgoingOf(item)) {
        const callee = toNode(call.to, opts.isrPatterns);
        if (!nodes.has(callee.id)) {
          nodes.set(callee.id, callee);
        }
        const site = call.fromRanges[0];
        edges.push({
          from: id,
          to: callee.id,
          // The LSP edge is certain about reaching this declaration. Whether the
          // declaration is the final target is the next pass's question.
          resolution: 'exact',
          ...(site
            ? { callSite: { file: vscode.workspace.asRelativePath(item.uri), line: site.start.line + 1 } }
            : {}),
        });
        if (!expanded.has(callee.id)) {
          expanded.add(callee.id);
          next.push({ item: call.to, id: callee.id });
        }
      }
    }
    if (nodes.size >= opts.maxNodes) {
      truncated = true;
      break;
    }
    frontier = next;
  }
  if (frontier.length > 0) {
    truncated = true;
  }

  const graph: CallGraph = { root: rootNode.id, nodes, edges };
  const unexpandedVirtuals = expandVirtualCalls(graph, opts.structure);
  return { graph, truncated, unexpandedVirtuals };
}

/**
 * Second pass: replace every edge landing on a virtual declaration with the
 * candidate set from class hierarchy analysis.
 *
 * The edge into the declaration is kept and downgraded rather than deleted. The
 * call really does go through that vtable slot, and hiding the slot would lose
 * the thing a C engineer most needs to see — that dispatch happens here at all.
 */
function expandVirtualCalls(graph: CallGraph, structure?: StructureModel): number {
  if (!structure) {
    return countVirtualLooking(graph);
  }

  const methodIndex = new Map<string, { type: string; method: string; isVirtual: boolean }>();
  for (const t of structure.types) {
    for (const m of t.methods) {
      methodIndex.set(`${t.qualifiedName}::${m.name}`, {
        type: t.qualifiedName,
        method: m.name,
        isVirtual: m.isVirtual,
      });
    }
  }

  const added: CallEdge[] = [];
  for (const edge of graph.edges) {
    const target = methodIndex.get(edge.to);
    if (!target?.isVirtual) {
      continue;
    }
    const resolved = resolveVirtualCall(structure, { staticType: target.type, methodName: target.method });
    if (resolved.resolution === 'exact') {
      continue;
    }

    // The call into the vtable slot is real, but it is not where control ends up.
    edge.resolution = resolved.resolution === 'unresolved' ? 'unresolved' : 'cha';
    edge.evidence = resolved.note;

    for (const c of resolved.candidates) {
      if (c.qualifiedName === edge.to) {
        continue;
      }
      if (!graph.nodes.has(c.qualifiedName)) {
        graph.nodes.set(c.qualifiedName, {
          id: c.qualifiedName,
          name: c.qualifiedName,
          isVirtual: true,
          ...(c.file ? { file: c.file, line: c.line } : {}),
        });
      }
      added.push({
        from: edge.to,
        to: c.qualifiedName,
        resolution: resolved.resolution === 'devirtualised' ? 'devirtualised' : 'rta',
        evidence: c.evidence,
      });
    }
  }

  // Deduplicate: several call sites can reach the same slot.
  const seen = new Set(graph.edges.map((e) => `${e.from}>${e.to}`));
  for (const e of added) {
    const key = `${e.from}>${e.to}`;
    if (!seen.has(key)) {
      seen.add(key);
      graph.edges.push(e);
    }
  }
  return 0;
}

/**
 * Without a structure model there is no way to know which callees are virtual,
 * so the honest answer is a count of leaves that look like member functions — an
 * upper bound on what is going unexpanded, presented as such.
 */
function countVirtualLooking(graph: CallGraph): number {
  const hasOutgoing = new Set(graph.edges.map((e) => e.from));
  return [...graph.nodes.keys()].filter((id) => id.includes('::') && !hasOutgoing.has(id)).length;
}
