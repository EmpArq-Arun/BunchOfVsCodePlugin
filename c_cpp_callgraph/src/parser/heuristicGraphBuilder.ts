import { WorkspaceIndex } from './workspaceIndex';
import { CallGraphData, CallEdge, FunctionNode } from '../types';

function edgeKey(e: CallEdge): string {
  return `${e.callerId}|${e.calleeId}|${e.callSite.line}|${e.callSite.column}`;
}

export function buildCallGraph(
  index: WorkspaceIndex,
  rootId: string,
  maxDepth: number,
  maxVisibleNodes: number,
): CallGraphData {
  const root = index.getFunction(rootId);
  if (!root) {
    throw new Error(`Unknown function id: ${rootId}`);
  }

  const nodes: Record<string, FunctionNode> = { [rootId]: root };
  const nodeDepths: Record<string, number> = { [rootId]: 0 };
  const edgeMap = new Map<string, CallEdge>();
  let truncated = false;

  const addNode = (id: string): boolean => {
    if (nodes[id]) return true;
    if (Object.keys(nodes).length >= maxVisibleNodes) {
      truncated = true;
      return false;
    }
    const fn = index.getFunction(id);
    if (!fn) return false;
    nodes[id] = fn;
    return true;
  };

  const recordDepth = (id: string, depth: number) => {
    if (nodeDepths[id] === undefined || depth < nodeDepths[id]) {
      nodeDepths[id] = depth;
    }
  };

  const bfs = (direction: 'in' | 'out'): number => {
    const visited = new Set<string>([rootId]);
    let frontier: { id: string; depth: number }[] = [{ id: rootId, depth: 0 }];
    let depthReached = 0;

    for (let d = 1; d <= maxDepth; d++) {
      if (frontier.length === 0) break;
      const nextFrontier: { id: string; depth: number }[] = [];

      for (const { id } of frontier) {
        const edges = direction === 'out' ? index.getOutgoing(id) : index.getIncoming(id);
        for (const e of edges) {
          const neighborId = direction === 'out' ? e.calleeId : e.callerId;
          if (!addNode(neighborId)) continue;

          recordDepth(neighborId, d);

          const key = edgeKey(e);
          if (!edgeMap.has(key)) edgeMap.set(key, e);

          if (!visited.has(neighborId)) {
            visited.add(neighborId);
            nextFrontier.push({ id: neighborId, depth: d });
          }
        }
      }

      if (nextFrontier.length > 0) depthReached = d;
      frontier = nextFrontier;
    }

    return depthReached;
  };

  const calleeDepth = bfs('out');
  const callerDepth = bfs('in');

  return {
    rootId,
    nodes,
    edges: [...edgeMap.values()],
    nodeDepths,
    mode: 'heuristic',
    computedDepth: Math.max(calleeDepth, callerDepth),
    truncated,
    defaultDepth: 5, // placeholder — overwritten by webviewPanel.postGraph() with the real setting value
  };
}
