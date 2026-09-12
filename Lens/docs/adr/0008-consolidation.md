# ADR 0008 — What the six projects became, and what turned out unnecessary

Status: accepted (P9)

## The consolidation

| Was | Now |
|---|---|
| **CppNav** | The Flow lens. Its CHA/RTA resolver is `core/flow.ts`; its call-hierarchy role is served by the LSP, which does it better. Cancelled as a separate product — it was always the substrate. |
| **Call Graph Visualizer** | The Flow lens surface. Freeze the published extension; do not develop it further. |
| **Complexity Cosmos** | The Quality lens, `core/complexity.ts`. |
| **Codex Intelligence** | The Narrative lens, `core/narrative.ts`, including the context manifest. |
| **LMV** | The Cost lens, `core/elf.ts` + `core/mangling.ts` + `core/cost.ts` — reimplemented rather than vendored, see below. |
| **Embedded Clang Config** | Stays published standalone. Lens reads `compile_commands.json` directly, so nothing needed extracting after all. |

Six maintained surfaces become two published extensions with no shared library
between them.

## The dependency audit, which went further than planned

The design named a Python orchestrator, libclang bindings, `lizard`, clang-uml,
pahole, uftrace, Orbuculum and a vendored `lmv-core`. What shipped needs
markedly less, and each removal came from finding that the dependency was
re-deriving something already in hand.

**No Python, no libclang bindings.** `clang -Xclang -ast-dump=json` emits
everything the detectors need as JSON, which TypeScript reads natively. This also
sidesteps libclang's known gaps — the absent `clang_isVirtualBase`, the
unmaterialised implicit destructors — rather than working around them. (ADR 0005)

**No lizard.** Once the AST is parsed for Rosetta, a Python runtime to re-derive
branch counts is a dependency with nothing to show for it. Worse, lizard counts
tokens, so it cannot see the exits C++ generates rather than spells.

**No binutils.** The ELF symbol table is a fixed structure; reading it directly
is a couple of hundred lines and works on a Windows machine with no toolchain
installed. (ADR 0007)

**No Cytoscape.** Deferred twice, on each occasion because the premise turned out
false: both the Structure and Flow lenses render rooted, bounded subgraphs of
tens of nodes, where a deterministic layout is adequate and — more importantly —
testable. A layout bug in a comprehension tool does not produce an ugly picture;
it produces one that teaches something false. (ADRs 0003, 0004)

**No SQLite.** The annotation plane is human-authored, small, and needs to merge
in git, which a binary database cannot do. The machine-generated planes are
recomputed on demand and cached as the JSON their producers already emit. (ADR
0001)

What remains external is genuinely external: clang for the AST and record
layouts, clang-uml for class diagrams, pahole for observed member sizes, a trace
file for the dynamic plane. Every one is a configured path with a typed failure
and a sentence naming the fix, and every one is optional. The journal — the
phase whose value most depends on starting early — needs none of them.

## The pattern worth keeping

Every phase's most valuable output was a documented limit.

Unresolved call edges, because a guessed edge is worse than an admitted gap.
Copy elision showing up as an *absent* AST node. pahole unable to read any
polymorphic class — the exact types a C engineer most needs explained. Four
fifths of an image landing outside the cost ledger until the reconciliation check
forced it to be named.

Three of those were found only because fixtures were generated from real tooling
rather than authored from a reading of the specification. In each case a
hand-written fixture would have agreed with the broken parser: the lambda capture
`FieldDecl`s that carry no name, the thunk whose inner symbol is not `_Z`-prefixed,
the `_ZZ` encoding that wraps a complete function signature. All three produced
plausible, confident, wrong output.

That is the whole thesis of the tool applied to the tool itself. The failure mode
this project exists to prevent is confident wrongness, and the only reliable
defence found was to check every assumption against something real.
