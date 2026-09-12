// Core data model shared between the extension host and the webview.

export interface SourceLocation {
  file: string;        // workspace-relative path
  line: number;         // 1-based
  column: number;        // 1-based
}

export type EdgeKind =
  | 'direct'          // ordinary call: foo()
  | 'pointer'         // call through a function pointer / std::function variable
  | 'virtualCandidate'; // possible target of a virtual dispatch call

export interface FunctionNode {
  id: string;
  name: string;
  qualifiedName?: string;
  location: SourceLocation;
  signature: string;
  isVirtual?: boolean;
  virtualConfirmed?: boolean;
  className?: string;
  active: boolean;
  source?: string;
  isStatic?: boolean;   // declared `static` — file-scoped, never linkable cross-file
  isIsr?: boolean;
  isrAttribute?: string;
  aliases?: string[];
}

export interface CallEdge {
  callerId: string;
  calleeId: string;
  kind: EdgeKind;
  callSite: SourceLocation;
  // For pointer edges: the variable/parameter the function was bound through,
  // shown in the UI as "via myCallback".
  via?: string;
  // true once a clang AST query has corroborated this specific edge (see
  // src/semantic). Heuristic-only edges leave this undefined/false — still
  // shown, just visually marked as unverified rather than dropped.
  confirmed?: boolean;
}

export interface CallGraphData {
  rootId: string;
  nodes: Record<string, FunctionNode>;
  edges: CallEdge[];
  mode: 'semantic' | 'heuristic';
  nodeDepths: Record<string, number>;
  computedDepth: number;
  truncated: boolean;
  semanticEnrichmentApplied?: boolean;
  // VS Code setting value at the time the graph was generated — used by the
  // webview to seed the slider on first load (overridden by persisted state
  // on subsequent opens of the same session).
  defaultDepth: number;
}

export type AccessLevel = 'public' | 'private' | 'protected';

export interface MemberVar {
  name: string;
  type: string;
  access: AccessLevel;
  isStatic: boolean;
  isConst: boolean;
  isPointer: boolean;
  isReference: boolean;
  isSmartPtr: boolean;
}

export type ClassRelKind = 'inheritance' | 'composition' | 'aggregation' | 'dependency';

export interface ClassRelationship {
  targetClassId: string;   // id of the target ClassInfo
  targetName: string;      // simple class name (for unresolved targets)
  kind: ClassRelKind;
  memberName?: string;
  access: AccessLevel;
}

export interface ClassInfo {
  id: string;
  name: string;
  qualifiedName: string;   // namespace::name (or just name when no namespace)
  namespace?: string;
  location: SourceLocation;
  bases: string[];
  methods: FunctionNode[];
  members: MemberVar[];
  relationships: ClassRelationship[];
  active: boolean;
  polymorphic?: boolean;
  basesConfirmed?: boolean;
  isStruct: boolean;
}

export interface ClassEdge {
  fromId: string;
  toId: string;
  kind: ClassRelKind;
  memberName?: string;
  access: AccessLevel;
}

export interface ClassGraphData {
  classes: Record<string, ClassInfo>;
  edges: ClassEdge[];
  mode: 'semantic' | 'heuristic';
  diagramType: 'uml' | 'hierarchy' | 'usage';
  rootClassId?: string;
  classNodeDepths?: Record<string, number>;
  /** All distinct source files that contain at least one class — for file-filter UI */
  availableFiles: string[];
}

export interface ClassHierarchyData {
  classes: Record<string, ClassInfo>;
  mode: 'semantic' | 'heuristic';
}

// ---- Webview <-> extension messages ----

export type ExtensionToWebviewMessage =
  | { type: 'graph'; data: CallGraphData }
  | { type: 'classHierarchy'; data: ClassHierarchyData }
  | { type: 'classUml'; data: ClassGraphData }
  | { type: 'sourceSnippet'; nodeId: string; source: string; startLine: number }
  | { type: 'enrichmentStatus'; status: 'checking' | 'idle' }
  | { type: 'uiConfig'; popup: { fontSize: number; width: number; height: number } }
  | { type: 'error'; message: string };

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'expandNode'; nodeId: string; depth: number }
  | { type: 'requestDepth'; depth: number } // slider moved past cached computedDepth
  | { type: 'requestSource'; nodeId: string }
  | { type: 'openLocation'; location: SourceLocation }
  | { type: 'exportGraph'; format: 'svg' | 'dot' | 'mermaid' };
