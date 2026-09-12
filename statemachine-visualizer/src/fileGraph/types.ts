export type SymbolKind = 'function' | 'class' | 'variable' | 'typedef';
export type CrossRefKind = 'include' | 'call' | 'extern' | 'inherit' | 'typedef';

export interface SymbolDef { name: string; file: string; line: number; kind: SymbolKind }

export interface CrossRef {
  fromFile: string; toFile: string; kind: CrossRefKind;
  symbol: string;
  detail?: string;
  fromLine: number;
}

export interface ComponentPort {
  name: string; kind: SymbolKind; direction: 'export' | 'import';
  defLine?: number;  // source line of the definition (for exports)
  connections: Array<{ file: string; mechanism: CrossRefKind; line: number; detail?: string }>;
}

export interface FileDetail {
  file: string; label: string;
  components: ComponentPort[];
  includes: string[]; includedBy: string[];
}

export interface FolderNode {
  id: string; label: string; path: string;
  fileCount: number; crossFolderEdges: number;
}

export interface FileNode {
  id: string; label: string; file: string;
  folderId: string;
  ext: string; degree: number; hasSM: boolean; smNames: string[];
  pairedFile?: string;    // the matched header/impl partner path
  displayLabel?: string;  // short label without extension (e.g. "motor" for motor.c + motor.h)
}

export interface FileEdge {
  from: string; to: string;
  kind: CrossRefKind;
  symbols: string[]; details: string[]; count: number;
}

export interface SerializedGraph {
  folders: FolderNode[];
  files: FileNode[];
  edges: FileEdge[];
  details: Record<string, FileDetail>;
}
