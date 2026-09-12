/**
 * Core data model. Deliberately free of any `vscode` import so it can be unit
 * tested with plain node and reused by a headless CLI later.
 */

/** The five entry kinds. Order matters for display grouping. */
export const ENTRY_KINDS = ['wtf', 'quirk', 'idiom', 'learned', 'todo'] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const KIND_LABEL: Record<EntryKind, string> = {
  wtf: 'Open question',
  quirk: 'Quirk',
  idiom: 'Idiom',
  learned: 'Learned',
  todo: 'To do',
};

export const KIND_BLURB: Record<EntryKind, string> = {
  wtf: "I don't understand this yet",
  quirk: 'This code does something surprising',
  idiom: 'This is a named C++ pattern',
  learned: 'I worked something out',
  todo: 'Something to come back and do',
};

/**
 * How an entry was pinned to the source.
 *
 * `symbol` survives line moves, reformatting and file moves, because identity is
 * derived from the qualified name rather than a location. `fingerprint` is the
 * fallback for positions the language server cannot name (macro bodies,
 * preprocessor blocks, raw statements) and survives edits elsewhere in the file
 * but not edits to the anchored lines themselves.
 */
export type AnchorMode = 'symbol' | 'fingerprint';

export interface SymbolPath {
  /** Fully qualified, e.g. `motor::Controller::step`. */
  qualifiedName: string;
  /** VS Code SymbolKind name, e.g. `Method`, `Class`, `Function`. */
  symbolKind: string;
  /**
   * Raw `detail` string from the language server, if any. Stored verbatim so a
   * future re-anchoring pass (P2, once clangd USRs are available) can migrate
   * entries without losing information.
   */
  detail?: string;
}

export interface JournalEntry {
  /** Stable content-derived id, `lens:` + 16 hex chars. Also the join key. */
  anchor: string;
  anchorMode: AnchorMode;
  kind: EntryKind;
  /** Qualified symbol name, or a short descriptor for fingerprint anchors. */
  symbol: string;
  symbolKind: string;
  detail?: string;
  /**
   * Workspace-relative path where the symbol was last seen. A *hint* for
   * navigation only — never part of identity, so moving a file does not orphan
   * its notes.
   */
  file: string;
  /** 1-based line where the symbol was last seen. Hint only. */
  line: number;
  created: string;
  updated: string;
  /**
   * ISO date when this should resurface, or null once retired. Absent for kinds
   * that are not on the review schedule.
   */
  revisitAt: string | null;
  /** 0 = just noted, incremented each time review confirms understanding. */
  confidence: number;
  tags: string[];
  /** Markdown body. */
  body: string;
  /** Absolute path of the file backing this entry. Runtime only, not serialised. */
  path?: string;
}

export function isEntryKind(v: string): v is EntryKind {
  return (ENTRY_KINDS as readonly string[]).includes(v);
}
