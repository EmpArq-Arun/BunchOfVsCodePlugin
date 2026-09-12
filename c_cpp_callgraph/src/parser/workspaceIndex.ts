import * as vscode from 'vscode';
import { stripCommentsAndLiterals, stripCompilerAnnotations, LineIndex } from './textUtils';
import { extractFunctionSpans, RawFunctionSpan } from './functionExtractor';
import { extractClassSpans, RawClassSpan } from './classExtractor';
import { extractNamespaceRanges, NamespaceRange } from './namespaceTracker';
import { extractCallSites } from './callSiteExtractor';
import { trackConditionals, isOffsetInactive, ConditionalInfo } from './conditionalTracker';
import {
  findPointerBindings,
  FileScopedPointerBinding,
  LambdaBinding,
} from './functionPointerTracker';
import { extractMacroAliases, buildMergedAliasMap, resolveAlias, MacroAliasMap } from './macroAliasTracker';
import * as diag from '../diagnostics';
import { FunctionNode, CallEdge, EdgeKind, ClassInfo, ClassEdge, ClassGraphData, MemberVar, ClassRelationship } from '../types';

interface FileParseResult {
  relPath: string;
  cleanedSrc: string;
  rawCleaned: string;   // comment-stripped but NOT attribute-stripped; used for macro alias extraction
  lineIndex: LineIndex;
  functionSpans: RawFunctionSpan[];
  classSpans: RawClassSpan[];
  nsRanges: NamespaceRange[];
  conditionalInfo: ConditionalInfo;
}

interface FunctionRange {
  startLine: number;
  endLine: number;
  relPath: string;
}

function pushIndex(map: Map<string, string[]>, key: string, id: string) {
  const arr = map.get(key);
  if (arr) arr.push(id);
  else map.set(key, [id]);
}

function pushEdge(map: Map<string, CallEdge[]>, key: string, edge: CallEdge) {
  const arr = map.get(key);
  if (arr) arr.push(edge);
  else map.set(key, [edge]);
}

function lambdaNodeId(relPath: string, offset: number): string {
  return `${relPath}:lambda:${offset}`;
}

const FILE_GLOB = '**/*.{c,cc,cpp,cxx,h,hh,hpp,hxx}';
const EXCLUDE_GLOB = '**/{node_modules,build,out,dist,.git,bin}/**';

// Maximum number of cross-file same-name matches treated as virtual candidates.
// Beyond this threshold the bare-name call is skipped rather than creating
// hundreds of false-positive edges (e.g. 'init' defined in every module).
const MAX_AMBIGUOUS_BARE_LINKS = 12;

export class WorkspaceIndex {
  private functions = new Map<string, FunctionNode>();
  private nameIndex = new Map<string, string[]>();
  private qualifiedIndex = new Map<string, string[]>();
  private edgesByCaller = new Map<string, CallEdge[]>();
  private edgesByCallee = new Map<string, CallEdge[]>();
  private classes = new Map<string, ClassInfo>();
  private functionRanges = new Map<string, FunctionRange>();
  private macroAliases: MacroAliasMap = new Map();
  private dirty = true;

  markDirty(): void {
    this.dirty = true;
  }

  getMacroAliases(): Map<string, string> {
    return this.macroAliases;
  }

  async ensureFresh(): Promise<void> {
    if (!this.dirty) return;
    await this.fullRescan();
    this.dirty = false;
  }

  getFunction(id: string): FunctionNode | undefined {
    return this.functions.get(id);
  }

  getOutgoing(id: string): CallEdge[] {
    return this.edgesByCaller.get(id) ?? [];
  }

  getIncoming(id: string): CallEdge[] {
    return this.edgesByCallee.get(id) ?? [];
  }

  getAllClasses(): ClassInfo[] {
    return [...this.classes.values()];
  }

  getAllFunctions(): FunctionNode[] {
    return [...this.functions.values()];
  }

  /** Body line range (1-based, inclusive) for a function node. */
  getFunctionRange(id: string): { startLine: number; endLine: number } | undefined {
    const r = this.functionRanges.get(id);
    return r ? { startLine: r.startLine, endLine: r.endLine } : undefined;
  }

  /** Find the function whose body range contains `line` (1-based). */
  findFunctionAtLine(relPath: string, line: number): FunctionNode | undefined {
    let best: FunctionNode | undefined;
    let bestDist = Infinity;
    for (const [id, range] of this.functionRanges) {
      if (range.relPath !== relPath) continue;
      if (line >= range.startLine && line <= range.endLine) {
        const dist = line - range.startLine;
        if (dist < bestDist) { bestDist = dist; best = this.functions.get(id); }
      }
    }
    return best;
  }

  /**
   * When the cursor is on a function DECLARATION (ending with `;`) or a
   * forward declaration, extract the function name from the source line and
   * look it up in the index.  Returns the best match.
   *
   * @param lineText Raw text of the cursor line, e.g.
   *   `  static Zirconia::LocalModule&  GetHeartbeatLocalModule();`
   * @param relPath Source file (used for same-file preference)
   */
  findFunctionByNameOnLine(lineText: string, relPath: string): FunctionNode | undefined {
    // Extract identifiers that look like function names: optionally qualified, followed by `(`
    const DECL_NAME_RE = /\b(~?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/g;
    const candidates: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = DECL_NAME_RE.exec(lineText))) {
      const raw = m[1];
      // Skip control keywords and type names (heuristic: if it's all lowercase it's likely a type/keyword)
      if (!/\b(if|for|while|switch|do|return|sizeof|catch)\b/.test(raw)) {
        candidates.push(raw);
      }
    }

    for (const raw of candidates) {
      const parts = raw.split('::');
      const bareName = parts[parts.length - 1];

      // Try qualified lookup first
      const qualIds = this.qualifiedIndex.get(raw);
      if (qualIds && qualIds.length > 0) return this.functions.get(qualIds[0]);

      // Try bare name — prefer same file
      const allIds = this.nameIndex.get(bareName);
      if (!allIds || allIds.length === 0) continue;
      const sameFile = allIds.filter(id => this.functions.get(id)?.location.file === relPath);
      const preferred = sameFile.length > 0 ? sameFile : allIds;
      const fn = this.functions.get(preferred[0]);
      if (fn) return fn;
    }
    return undefined;
  }

  /** Find the class whose definition is closest to `line` (1-based) in `relPath`. */
  findClassAtLine(relPath: string, line: number): ClassInfo | undefined {
    let best: ClassInfo | undefined;
    for (const cls of this.classes.values()) {
      if (cls.location.file !== relPath) continue;
      if (cls.location.line <= line) {
        if (!best || cls.location.line > best.location.line) best = cls;
      }
    }
    return best;
  }

  /**
   * Builds a ClassGraphData suitable for UML/hierarchy/usage diagrams.
   * `rootClassId` sets the depth-0 node for depth-slider filtering.
   */
  buildClassGraph(
    diagramType: 'uml' | 'hierarchy' | 'usage',
    rootClassId?: string,
  ): ClassGraphData {
    const classes: Record<string, ClassInfo> = {};
    for (const [id, cls] of this.classes) classes[id] = cls;

    const edgeSet = new Map<string, ClassEdge>();

    const addEdge = (fromId: string, toId: string, kind: ClassEdge['kind'], memberName?: string, access: ClassEdge['access'] = 'public') => {
      if (fromId === toId) return;
      if (!this.classes.has(fromId) || !this.classes.has(toId)) return;
      const key = `${fromId}→${toId}:${kind}`;
      if (!edgeSet.has(key)) edgeSet.set(key, { fromId, toId, kind, memberName, access });
    };

    for (const cls of this.classes.values()) {
      for (const rel of cls.relationships) {
        if (diagramType === 'hierarchy' && rel.kind !== 'inheritance') continue;
        if (rel.targetClassId.startsWith('unresolved:')) continue;
        addEdge(cls.id, rel.targetClassId, rel.kind, rel.memberName, rel.access);
      }

      // Method-signature dependency detection:
      // if a method of cls takes or returns a known class, that's a dependency.
      if (diagramType !== 'hierarchy') {
        for (const method of cls.methods) {
          const sigWords = (method.signature ?? '').matchAll(/\b([A-Z][A-Za-z_]\w*)\b/g);
          for (const [, name] of sigWords) {
            const targetIds = [...this.classes.values()].filter(c => c.name === name).map(c => c.id);
            for (const tid of targetIds) {
              if (tid !== cls.id) addEdge(cls.id, tid, 'dependency');
            }
          }
        }
      }
    }

    // BFS from root to build per-node depths
    let classNodeDepths: Record<string, number> | undefined;
    if (rootClassId && classes[rootClassId]) {
      const depths: Record<string, number> = { [rootClassId]: 0 };
      const queue = [rootClassId];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const d = depths[cur];
        for (const e of edgeSet.values()) {
          for (const neighbor of [e.fromId === cur ? e.toId : null, e.toId === cur ? e.fromId : null]) {
            if (neighbor && depths[neighbor] === undefined) {
              depths[neighbor] = d + 1;
              queue.push(neighbor);
            }
          }
        }
      }
      classNodeDepths = depths;
    }

    const availableFiles = [...new Set(
      [...this.classes.values()].map(c => c.location.file)
    )].sort();

    return {
      classes,
      edges: [...edgeSet.values()],
      mode: 'heuristic',
      diagramType,
      rootClassId,
      classNodeDepths,
      availableFiles,
    };
  }

  /** Finds the innermost indexed function whose body spans the given 1-based line, in the given relative path. */
  private async fullRescan(): Promise<void> {
    this.functions.clear();
    this.nameIndex.clear();
    this.qualifiedIndex.clear();
    this.edgesByCaller.clear();
    this.edgesByCallee.clear();
    this.classes.clear();
    this.functionRanges.clear();
    this.macroAliases.clear();

    const uris = await vscode.workspace.findFiles(FILE_GLOB, EXCLUDE_GLOB, 5000);
    const parsed: FileParseResult[] = [];

    // Read user-configured extra ISR patterns from settings
    const cfg = vscode.workspace.getConfiguration('callgraph');
    const MAX_AMBIGUOUS_BARE_LINKS = cfg.get<number>('maxAmbiguousLinks', 12);
    const extraIsrRawPatterns: string[] = cfg.get<string[]>('isrPatterns', []);
    const extraIsrPatterns: RegExp[] = extraIsrRawPatterns.flatMap((p) => {
      try { return [new RegExp(p, 'i')]; } catch { return []; }
    });

    // --- file parsing pass (first scan to collect all class names for relationship detection) ---
    const allClassNames = new Set<string>();

    for (const uri of uris) {
      let text: string;
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        text = Buffer.from(bytes).toString('utf8');
      } catch { continue; }

      const rawCleaned = stripCommentsAndLiterals(text);
      const cleaned = stripCompilerAnnotations(rawCleaned);
      const lineIndex = new LineIndex(cleaned);
      const nsRanges = extractNamespaceRanges(cleaned);
      const conditionalInfo = trackConditionals(cleaned);
      const relPath = vscode.workspace.asRelativePath(uri, false);

      // First-pass class extraction (without relationship detection — we need all class names first)
      const classSpansFirstPass = extractClassSpans(cleaned, nsRanges);
      for (const c of classSpansFirstPass) allClassNames.add(c.name);

      // Function extraction with namespace info
      const functionSpans = extractFunctionSpans(cleaned, extraIsrPatterns, rawCleaned, nsRanges);
      // Class extraction (second pass with full class name set for relationship detection)
      const classSpans = extractClassSpans(cleaned, nsRanges, allClassNames);

      parsed.push({ relPath, cleanedSrc: cleaned, rawCleaned, lineIndex, functionSpans, classSpans, nsRanges, conditionalInfo });
    }

    // Build the global macro alias map from rawCleaned of every file.
    // rawCleaned still has #define lines visible (only comments/literals were stripped).
    const perFileMaps = parsed.map(f => extractMacroAliases(f.rawCleaned));
    const filePaths   = parsed.map(f => f.relPath);
    this.macroAliases = buildMergedAliasMap(perFileMaps, filePaths);

    // Diagnostics: count headers vs source files
    const headerCount = filePaths.filter(p => /\.(h|hh|hpp|hxx)$/i.test(p)).length;
    const sourceCount = filePaths.length - headerCount;
    diag.logInfo(`Index: ${filePaths.length} files scanned (${sourceCount} source, ${headerCount} header)`);
    // Detailed macro alias logging happens later (after the function index is built)
    // so we can filter to only aliases that resolve to actual indexed functions.

    // Re-do class spans with full allClassNames (some were added by later files in the first pass)
    // For simplicity we do a second extraction pass on each file using the complete allClassNames set.
    const parsedWithRelationships: FileParseResult[] = [];
    for (const f of parsed) {
      const text2 = f.cleanedSrc; // already cleaned
      const classSpans2 = extractClassSpans(text2, f.nsRanges, allClassNames);
      parsedWithRelationships.push({ ...f, classSpans: classSpans2 });
    }

    // Register classes with full member/relationship info
    for (const f of parsedWithRelationships) {
      for (const c of f.classSpans) {
        const loc = f.lineIndex.toLineCol(c.headerStart);
        const id = `${f.relPath}:class:${c.headerStart}`;
        const members: MemberVar[] = c.members.map(m => ({
          name: m.name, type: m.type, access: m.access,
          isStatic: m.isStatic, isConst: m.isConst,
          isPointer: m.isPointer, isReference: m.isReference, isSmartPtr: m.isSmartPtr,
        }));
        this.classes.set(id, {
          id,
          name: c.name,
          qualifiedName: c.qualifiedName,
          namespace: c.namespace,
          location: { file: f.relPath, line: loc.line, column: loc.column },
          bases: c.bases,
          methods: [],
          members,
          relationships: [], // resolved in a later pass once all class ids are known
          active: !isOffsetInactive(c.headerStart, f.conditionalInfo),
          isStruct: c.isStruct,
        });
      }
    }

    // Build name → class id index and resolve relationships
    const classNameToIds = new Map<string, string[]>();
    for (const cls of this.classes.values()) {
      const arr = classNameToIds.get(cls.name) ?? [];
      arr.push(cls.id);
      classNameToIds.set(cls.name, arr);
      if (cls.qualifiedName !== cls.name) {
        const arr2 = classNameToIds.get(cls.qualifiedName) ?? [];
        arr2.push(cls.id);
        classNameToIds.set(cls.qualifiedName, arr2);
      }
    }

    for (const [fileIdx, f] of parsedWithRelationships.entries()) {
      for (const c of f.classSpans) {
        const clsId = `${f.relPath}:class:${c.headerStart}`;
        const cls = this.classes.get(clsId);
        if (!cls) continue;
        const resolvedRels: ClassRelationship[] = [];
        for (const rel of c.relationships) {
          const targetIds = classNameToIds.get(rel.targetClass) ?? [];
          const targetId = targetIds[0] ?? `unresolved:${rel.targetClass}`;
          resolvedRels.push({
            targetClassId: targetId,
            targetName: rel.targetClass,
            kind: rel.kind,
            memberName: rel.memberName,
            access: rel.access,
          });
        }
        cls.relationships = resolvedRels;
      }
    }

    // Use parsedWithRelationships as the final parsed array
    parsed.length = 0;
    for (const f of parsedWithRelationships) parsed.push(f);

    // Pass 1: register every named function so cross-file calls/pointers can resolve by name.
    for (const f of parsed) {
      for (const span of f.functionSpans) {
        const loc = f.lineIndex.toLineCol(span.headerStart);
        const endLoc = f.lineIndex.toLineCol(span.bodyEnd);
        const id = `${f.relPath}:${span.headerStart}`;

        const node: FunctionNode = {
          id,
          name: span.name,
          qualifiedName: (() => {
            const parts: string[] = [];
            if (span.namespace) parts.push(span.namespace);
            if (span.className) parts.push(span.className);
            parts.push(span.name);
            return parts.length > 1 ? parts.join('::') : undefined;
          })(),
          location: { file: f.relPath, line: loc.line, column: loc.column },
          signature: span.signature,
          isVirtual: span.isVirtualLike,
          isStatic: span.isStatic || undefined,
          className: span.className,
          active: !isOffsetInactive(span.headerStart, f.conditionalInfo),
          isIsr: span.isIsr || undefined,
          isrAttribute: span.isrAttribute || undefined,
        };

        this.functions.set(id, node);
        this.functionRanges.set(id, { startLine: loc.line, endLine: endLoc.line, relPath: f.relPath });
        pushIndex(this.nameIndex, span.name, id);
        if (span.className) pushIndex(this.qualifiedIndex, `${span.className}::${span.name}`, id);
      }
    }

    // Attach methods to classes by name (definitions are often out-of-line, so
    // this is a name match across the whole workspace, not just same-file).
    for (const node of this.functions.values()) {
      if (!node.className) continue;
      for (const cls of this.classes.values()) {
        if (cls.name === node.className) cls.methods.push(node);
      }
    }

    // Attach macro aliases to function nodes via reverse lookup of macroAliases.
    // ── Important: first filter the alias map to only keep aliases whose RESOLVED
    //    target is an actual indexed function.  This eliminates false positives from:
    //    • C keywords  (#define VALIDATE_PACKET(x) if (x) ... → "if")
    //    • NULL / NAN constants (#define DEFAULT_VALUE(...) NAN → "NAN")
    //    • Hardware pin/register constants (#define MX_ADCx_IN3_Pin(...) PA3 → "PA3")
    //    All of those had targets that are NOT in the nameIndex, so they're purged here.
    if (this.macroAliases.size > 0) {
      const validAliases = new Map<string, string>();
      for (const [alias, resolved] of this.macroAliases) {
        if (this.nameIndex.has(resolved)) validAliases.set(alias, resolved);
      }

      // Log what survived the filter — this is the genuinely useful alias info
      const rawCount = this.macroAliases.size;
      this.macroAliases = validAliases;
      diag.logInfo(`Macro function-aliases: ${validAliases.size} resolve to indexed functions (${rawCount - validAliases.size} filtered — C keywords, constants, HAL defines)`);

      // Reverse-lookup: attach alias names to their target function nodes
      const reverseAliasMap = new Map<string, string[]>();
      for (const [macro, realName] of this.macroAliases) {
        const arr = reverseAliasMap.get(realName) ?? [];
        arr.push(macro);
        reverseAliasMap.set(realName, arr);
      }
      for (const fn of this.functions.values()) {
        const fnAliases = reverseAliasMap.get(fn.name);
        if (fnAliases && fnAliases.length > 0) {
          fn.aliases = fnAliases;
          diag.logInfo(`  alias: ${fnAliases.join(', ')} → ${fn.name} (${fn.location.file}:${fn.location.line})`);
        }
      }
    }

    const knownNames = new Set(this.nameIndex.keys());

    // Pass 1.5: pointer bindings + lambda registrations
    const allFunctionBindings: FileScopedPointerBinding[] = [];
    const lambdasByFile = new Map<string, LambdaBinding[]>();

    for (const f of parsed) {
      const { bindings, lambdas } = findPointerBindings(f.cleanedSrc, knownNames);
      for (const b of bindings) {
        allFunctionBindings.push({ ...b, file: f.relPath });

        // For anonymous binding kinds (no named variable to call through later),
        // create a direct incoming pointer edge from the file's scope to the
        // function right now, so the graph shows "referenced as function pointer" even
        // when we can't trace the exact call chain all the way through.
        if (b.variable.startsWith('<') && b.variable !== '<dispatch-table>') {
          const calleeIds = this.nameIndex.get(b.functionName);
          if (calleeIds) {
            const loc = f.lineIndex.toLineCol(b.offset);
            // We create a sentinel "file-scope" node ID as the caller when there
            // is no better function body to attribute the reference to.  It is
            // better than losing the edge entirely.
            const callSiteLoc = { file: f.relPath, line: loc.line, column: loc.column };
            // Try to find the enclosing function for a better callerId
            const enclosing = [...this.functionRanges.entries()].find(([, r]) =>
              r.relPath === f.relPath && loc.line >= r.startLine && loc.line <= r.endLine,
            );
            const callerId = enclosing ? enclosing[0] : `${f.relPath}:scope`;
            for (const calleeId of calleeIds) {
              const edge: CallEdge = { callerId, calleeId, kind: 'pointer', callSite: callSiteLoc, via: b.variable };
              pushEdge(this.edgesByCaller, callerId, edge);
              pushEdge(this.edgesByCallee, calleeId, edge);
            }
          }
        }
      }
      lambdasByFile.set(f.relPath, lambdas);

      for (const lambda of lambdas) {
        const loc = f.lineIndex.toLineCol(lambda.offset);
        const id = lambdaNodeId(f.relPath, lambda.offset);
        this.functions.set(id, {
          id,
          name: '<lambda>',
          qualifiedName: `<lambda assigned to ${lambda.variable}>`,
          location: { file: f.relPath, line: loc.line, column: loc.column },
          signature: `[](...) { /* assigned to ${lambda.variable} */ }`,
          active: !isOffsetInactive(lambda.offset, f.conditionalInfo),
        });
      }
    }  // end for (const f of parsed) — Pass 1.5

    // Dedup sets for diagnostic warnings — only emit each unique message once per build.
    // Without these, "skipping 'GetValue': 42 matches" fires once per call site (hundreds of lines).
    const warnedSkipped = new Set<string>();   // "${filePath}:${bareName}"
    const warnedBadAlias = new Set<string>();  // alias name

    // Pass 2: resolve call sites (direct + pointer-bound + lambda-bound) into
    // edges, for every regular function body AND every lambda body (so a
    // lambda assigned to a callback shows what it itself calls, instead of
    // being a dead end once you've followed the pointer to it).
    for (const f of parsed) {
      const lambdasThisFile = lambdasByFile.get(f.relPath) ?? [];

      const resolveBody = (callerId: string, bodyStart: number, bodyEnd: number) => {
        const body = f.cleanedSrc.slice(bodyStart, bodyEnd);
        const callSites = extractCallSites(body);

        for (const site of callSites) {
          const absOffset = bodyStart + site.offset;
          const lastSegment = site.name.includes('::') ? site.name.split('::').pop()! : site.name;

          let calleeIds: string[] | undefined = this.qualifiedIndex.get(site.name);
          let kind: EdgeKind = 'direct';
          let via: string | undefined;

          if (!calleeIds) {
            // ── All-bindings resolution for named function pointer variables ──
            // For state machine dispatch (e.g. `current_state()`) we need ALL
            // functions ever assigned to the variable, not just the most recent.
            // A named variable that has multiple bindings in the workspace is
            // very likely a dispatching function pointer (state machine, plugin
            // registry, HAL ops table) — treat it as a fan-out to all targets.
            const ANON_VARS = new Set(['<dispatch-table>', '<designated-init>', '<addr-of>', '<passed-as-arg>']);

            // Collect all non-anonymous bindings for this exact variable name
            const varBindings = allFunctionBindings.filter(
              (b) => b.variable === site.name && !ANON_VARS.has(b.variable),
            );

            // Lambda bindings for this variable (same file only — lambdas are rarely cross-TU)
            const lambdaTargets: string[] = [];
            for (const l of lambdasThisFile) {
              if (l.variable === site.name) lambdaTargets.push(lambdaNodeId(f.relPath, l.offset));
            }

            if (varBindings.length > 0 || lambdaTargets.length > 0) {
              // Fan-out: emit an edge to EVERY function ever bound to this variable.
              const allTargets = new Set<string>(lambdaTargets);
              for (const b of varBindings) {
                for (const id of this.nameIndex.get(b.functionName) ?? []) allTargets.add(id);
              }
              if (allTargets.size > 0) {
                calleeIds = [...allTargets];
                kind = 'pointer';
                via = site.name;
              }
            }

            // Last resort: bare name match — but apply scoping rules to avoid
            // linking every function with the same name across unrelated files.
            if (!calleeIds) {
              const bare = site.name.includes('::') ? site.name.split('::').pop()! : site.name;
              const allWithName = this.nameIndex.get(bare);

              if (allWithName && allWithName.length > 0) {
                // Rule 1 — same-file preference: if ANY match is in this file, use only those.
                // This handles the common case where a module calls its own helper functions.
                const sameFileIds = allWithName.filter(id => {
                  const fn = this.functions.get(id);
                  return fn?.location.file === f.relPath;
                });
                if (sameFileIds.length > 0) {
                  calleeIds = sameFileIds;
                  // kind stays 'direct' — confident same-file call
                } else {
                  // Rule 2 — static scope: exclude static functions from other files
                  // (static in C means file-scoped; they cannot be called cross-file).
                  const visibleIds = allWithName.filter(id => {
                    const fn = this.functions.get(id);
                    return fn && !fn.isStatic;  // only non-static are externally visible
                  });

                  if (visibleIds.length === 0) {
                    // All candidates are static and from other files → no valid link
                  } else if (visibleIds.length === 1) {
                    // Exactly one non-static match → confident direct call
                    calleeIds = visibleIds;
                  } else if (visibleIds.length <= MAX_AMBIGUOUS_BARE_LINKS) {
                    // A small number of matches — likely a virtual method family.
                    // Mark as virtualCandidate so the user can filter them.
                    calleeIds = visibleIds;
                    if (kind === 'direct') kind = 'virtualCandidate';
                  } else {
                    // Too many matches (common helper name like `init` or `reset`) —
                    // skip rather than polluting the graph with hundreds of false edges.
                    const skipKey = `${f.relPath}:${bare}`;
                    if (!warnedSkipped.has(skipKey)) {
                      warnedSkipped.add(skipKey);
                      diag.logInfo(`  skipping '${bare}' in ${f.relPath}: ${visibleIds.length} non-static matches — use qualified name or set callgraph.maxAmbiguousLinks to include them as virtual candidates`);
                    }
                  }
                }
              }
            }

            // Macro alias resolution: if the callee name is a #define alias for a real function
            // (e.g. `#define MOT_IF_emulatedCommStart(x) COM_emulatedCommStart(x)`), follow the chain.
            if (!calleeIds && this.macroAliases.size > 0) {
              const bare = site.name.includes('::') ? site.name.split('::').pop()! : site.name;
              const resolved = resolveAlias(bare, this.macroAliases);
              if (resolved !== bare) {
                calleeIds = this.nameIndex.get(resolved);
                if (calleeIds && calleeIds.length > 0) {
                  kind = 'direct';
                  via = undefined;
                  diag.logInfo(`  macro-alias: ${bare} → ${resolved} (in ${f.relPath})`);
                } else {
                  if (!warnedBadAlias.has(bare)) {
                    warnedBadAlias.add(bare);
                    diag.logWarn(`  macro-alias: ${bare} → ${resolved} but "${resolved}" is not in the function index (compiler intrinsic or external library?)`);
                  }
                }
              }
            }
          }

          if (!calleeIds || calleeIds.length === 0) continue;

          const callSiteLoc = f.lineIndex.toLineCol(absOffset);
          const edge: Omit<CallEdge, 'calleeId'> = {
            callerId,
            kind,
            via,
            callSite: { file: f.relPath, line: callSiteLoc.line, column: callSiteLoc.column },
          };

          for (const calleeId of calleeIds) {
            const fullEdge: CallEdge = { ...edge, calleeId };
            pushEdge(this.edgesByCaller, callerId, fullEdge);
            pushEdge(this.edgesByCallee, calleeId, fullEdge);
          }
        }
      };

      for (const span of f.functionSpans) {
        resolveBody(`${f.relPath}:${span.headerStart}`, span.bodyStart, span.bodyEnd);
      }
      for (const lambda of lambdasThisFile) {
        resolveBody(lambdaNodeId(f.relPath, lambda.offset), lambda.bodyStart, lambda.bodyEnd);
      }
    }
  }
}
