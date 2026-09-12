# ADR 0002 — Anchor on qualified name, not USR, in P0

Status: accepted (P0) · superseded by clangd USRs at P2

## Context

The design specifies USR as the anchor key, which is right. USRs come from
libclang or from clangd's index, and both mean P0 would carry a toolchain
dependency: a compilation database, a matching clang, correct include paths for
a cross target. That is the P2 problem, and making the journal wait for it would
cost the journal its most valuable months.

The requirement the anchor actually has to satisfy is narrower than USR
identity: a note must survive the code moving underneath it during normal work.
Reformatting, functions sliding down a file, files being moved between folders.

## Decision

Anchor on `sha1(qualifiedName | symbolKind | normalisedSignature)`, taking all
three from `vscode.executeDocumentSymbolProvider` — which routes to whichever
language server the user already has, clangd or cpptools, with no setup of our
own. If the codebase has working IntelliSense, Lens works.

Survives: line moves, reformatting, edits elsewhere in the file, moving the file
(the recorded path is a navigation hint, never part of identity).

Does not survive: renaming the symbol, or moving it to a different namespace or
class. This is defensible — a renamed symbol is arguably a different thing — and
the failure is loud: `revealAnchor` reports the entry as orphaned rather than
dropping the user at a stale line.

Positions the language server cannot name — macro bodies, `#ifdef` blocks, bare
statements — fall back to a content fingerprint over three lines. Weaker, and
labelled as such to the user at the moment of writing, but it is what makes the
tool usable in exactly the places unfamiliar firmware is most confusing.

## Overloads

Signature normalisation is best-effort, because `DocumentSymbol.detail` is not
standardised: clangd emits a return type and parameter list, cpptools frequently
emits nothing. The normaliser reduces whatever it gets to a parameter-type spine
and tolerates absence. The property under test is convergence — every spelling
of `const char *p` must hash the same — not any particular output.

Consequence: two overloads differing only by parameter type share an anchor when
the language server supplies no detail. Notes appear on both. Firmware rarely
overloads on type alone, and showing a note twice is a much smaller failure than
losing it.

## Migration

Every entry stores `detail` verbatim alongside `symbol` and `symbolKind`. When
P2 brings a real index, a re-anchoring pass can map each entry to its USR
without loss, and `anchorMode` grows a third value. No entry written today needs
rewriting by hand.
