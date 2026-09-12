export type CFGNodeKind = 'entry' | 'exit' | 'process' | 'decision' | 'loop' | 'switch' | 'label' | 'preproc';

export interface SourcePosition { row: number; column: number; }
export interface SourceRange { start: SourcePosition; end: SourcePosition; }

export interface CFGNode {
  id: string;
  kind: CFGNodeKind;
  /** Raw code text for each statement (joined with \n for multi-line process nodes) */
  rawText: string;
  /** Individual statement lines — used for Code and Both display modes */
  rawLines: string[];
  /** Final label: annotation > heuristic > rawText */
  label: string;
  /** True when label came from a parsed comment, not code */
  labelFromAnnotation: boolean;
  /** The annotation text itself (null when label is heuristic or raw code) */
  annotation: string | null;
  isISR?: boolean;
  anchorRange: SourceRange;
}

export type CFGEdgeKind =
  | 'flow' | 'true' | 'false' | 'case' | 'fallthrough'
  | 'break' | 'continue' | 'goto' | 'loop-back';

export interface CFGEdge {
  from: string;
  to: string;
  kind: CFGEdgeKind;
  label?: string;
}

export interface ControlFlowGraph {
  functionName: string;
  entryId: string;
  exitId: string;
  nodes: Map<string, CFGNode>;
  edges: CFGEdge[];
}

export interface ExitPoint { id: string; kind: CFGEdgeKind; label?: string; }
