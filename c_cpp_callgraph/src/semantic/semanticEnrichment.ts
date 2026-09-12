import * as path from 'path';
import * as diag from '../diagnostics';
import { CompileCommandsDb } from './compileCommands';
import { queryClangAst, findCallSites, findNodes, AstNode } from './clangAstQuery';
import { CallGraphData, CallEdge, FunctionNode } from '../types';

export interface SemanticEngineConfig {
  clangBinary: string;
  compileCommandsDb: CompileCommandsDb;
  workspaceRoot: string;
  maxCallerConfirmations: number;
  timeoutMs?: number;
}

/** Minimal structural view of the heuristic class registry this module needs — avoids importing WorkspaceIndex (and its vscode dependency) directly. */
export interface ClassLookup {
  getAllClasses(): { name: string; bases: string[]; methods: FunctionNode[] }[];
}

function pickRootByLine(roots: AstNode[], line: number | undefined): AstNode {
  if (roots.length <= 1 || line === undefined) return roots[0];
  for (const r of roots) {
    const decl = [...findNodes(r, 'CXXMethodDecl'), ...findNodes(r, 'FunctionDecl')].find((d) => d.loc?.line === line);
    if (decl) return r;
  }
  return roots[0];
}

async function confirmCallees(
  fn: FunctionNode,
  absFilePath: string,
  cfg: SemanticEngineConfig,
): Promise<{ ok: boolean; calleeNames: Set<string> }> {
  const entry = cfg.compileCommandsDb.entryFor(absFilePath);
  if (!entry) return { ok: false, calleeNames: new Set() };

  const res = await queryClangAst({
    clangBinary: cfg.clangBinary,
    filePath: absFilePath,
    compilerArgs: entry.args,
    filterName: fn.qualifiedName ?? fn.name,
    cwd: entry.directory,
    timeoutMs: cfg.timeoutMs,
  });
  if (!res.ok || res.roots.length === 0) return { ok: false, calleeNames: new Set() };

  const root = pickRootByLine(res.roots, fn.location.line);
  const sites = findCallSites(root);
  return { ok: true, calleeNames: new Set(sites.map((s) => s.calleeName)) };
}

async function confirmCallerReferencesCallee(
  callerFn: FunctionNode,
  absCallerFile: string,
  calleeName: string,
  cfg: SemanticEngineConfig,
): Promise<boolean | undefined> {
  const entry = cfg.compileCommandsDb.entryFor(absCallerFile);
  if (!entry) return undefined;

  const res = await queryClangAst({
    clangBinary: cfg.clangBinary,
    filePath: absCallerFile,
    compilerArgs: entry.args,
    filterName: callerFn.qualifiedName ?? callerFn.name,
    cwd: entry.directory,
    timeoutMs: cfg.timeoutMs,
  });
  if (!res.ok || res.roots.length === 0) return undefined;

  const root = pickRootByLine(res.roots, callerFn.location.line);
  const sites = findCallSites(root);
  return sites.some((s) => s.calleeName === calleeName);
}

interface ClassConfirmation {
  ok: boolean;
  bases: string[];
  polymorphic: boolean;
}

async function confirmClassInfo(className: string, absFilePath: string, cfg: SemanticEngineConfig): Promise<ClassConfirmation> {
  const entry = cfg.compileCommandsDb.entryFor(absFilePath);
  if (!entry) return { ok: false, bases: [], polymorphic: false };

  const res = await queryClangAst({
    clangBinary: cfg.clangBinary,
    filePath: absFilePath,
    compilerArgs: entry.args,
    filterName: className,
    cwd: entry.directory,
    timeoutMs: cfg.timeoutMs,
  });
  if (!res.ok) return { ok: false, bases: [], polymorphic: false };

  for (const root of res.roots) {
    const record = findNodes(root, 'CXXRecordDecl').find((r) => r.name === className && (r.definitionData || r.bases));
    if (record) {
      const bases = (record.bases ?? []).map((b) => b.type?.qualType).filter((x): x is string => !!x);
      return { ok: true, bases, polymorphic: !!record.definitionData?.isPolymorphic };
    }
  }
  return { ok: true, bases: [], polymorphic: false };
}

/**
 * Confirms bases + polymorphism for up to `maxClasses` heuristically-found
 * classes (sequential, capped — this can be called for a whole workspace's
 * class diagram, unlike the call-graph enrichment above which is scoped to
 * one root's neighbors, so it needs its own bound on latency).
 */
export async function enrichClassHierarchy(
  classes: { id: string; name: string; location: { file: string }; bases: string[] }[],
  cfg: SemanticEngineConfig,
  maxClasses = 30,
): Promise<Map<string, ClassConfirmation>> {
  const results = new Map<string, ClassConfirmation>();
  for (const cls of classes.slice(0, maxClasses)) {
    const absFile = path.resolve(cfg.workspaceRoot, cls.location.file);
    const confirmation = await confirmClassInfo(cls.name, absFile, cfg);
    if (confirmation.ok) results.set(cls.id, confirmation);
  }
  return results;
}

/**
 * Enriches the edges directly touching `graph.rootId` (its own callees, and
 * its immediate callers, capped at `maxCallerConfirmations`) with clang
 * confirmation, and adds virtual-dispatch candidate edges when the root is
 * part of a confirmed-polymorphic class hierarchy. Edges further than one
 * hop from this particular root are left untouched (still shown — just not
 * yet checked) to keep per-interaction cost bounded; deeper nodes get
 * enriched in turn as the user expands into them.
 */
export async function enrichCallGraph(
  graph: CallGraphData,
  classLookup: ClassLookup,
  cfg: SemanticEngineConfig,
): Promise<CallGraphData> {
  const rootNode = graph.nodes[graph.rootId];
  if (!rootNode) return { ...graph, semanticEnrichmentApplied: true };

  diag.logSection(`Enriching graph for ${rootNode.qualifiedName ?? rootNode.name}`);

  const rootAbsFile = path.resolve(cfg.workspaceRoot, rootNode.location.file);
  const calleeResult = await confirmCallees(rootNode, rootAbsFile, cfg);

  const incomingToRoot = graph.edges.filter((e) => e.calleeId === graph.rootId && e.kind === 'direct');
  const distinctCallerIds = [...new Set(incomingToRoot.map((e) => e.callerId))].slice(0, cfg.maxCallerConfirmations);

  const callerConfirmations = new Map<string, boolean>();
  for (const callerId of distinctCallerIds) {
    const callerNode = graph.nodes[callerId];
    if (!callerNode) continue;
    const callerAbsFile = path.resolve(cfg.workspaceRoot, callerNode.location.file);
    const result = await confirmCallerReferencesCallee(callerNode, callerAbsFile, rootNode.name, cfg);
    if (result !== undefined) callerConfirmations.set(callerId, result);
  }

  const enrichedEdges: CallEdge[] = graph.edges.map((e) => {
    if (e.callerId === graph.rootId && e.kind === 'direct' && calleeResult.ok) {
      const calleeNode = graph.nodes[e.calleeId];
      return { ...e, confirmed: calleeNode ? calleeResult.calleeNames.has(calleeNode.name) : false };
    }
    if (e.calleeId === graph.rootId && e.kind === 'direct' && callerConfirmations.has(e.callerId)) {
      return { ...e, confirmed: callerConfirmations.get(e.callerId) };
    }
    return e;
  });

  const extraNodes: Record<string, FunctionNode> = {};
  const extraEdges: CallEdge[] = [];

  if (rootNode.className) {
    const classConfirmation = await confirmClassInfo(rootNode.className, rootAbsFile, cfg);
    if (classConfirmation.ok && classConfirmation.polymorphic) {
      const subclasses = classLookup.getAllClasses().filter((c) => c.bases.includes(rootNode.className!));
      for (const sub of subclasses) {
        const override = sub.methods.find((m) => m.name === rootNode.name && m.id !== rootNode.id);
        if (!override) continue;

        extraNodes[override.id] = { ...override, virtualConfirmed: true };
        for (const callerId of distinctCallerIds) {
          const originalCallSite = incomingToRoot.find((e) => e.callerId === callerId)?.callSite ?? rootNode.location;
          extraEdges.push({
            callerId,
            calleeId: override.id,
            kind: 'virtualCandidate',
            callSite: originalCallSite,
            confirmed: true,
          });
        }
      }
    }
  }

  return {
    ...graph,
    nodes: { ...graph.nodes, ...extraNodes },
    edges: [...enrichedEdges, ...extraEdges],
    semanticEnrichmentApplied: true,
  };
}
