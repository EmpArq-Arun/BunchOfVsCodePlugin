# ADR 0005 — Filtered clang JSON AST, parsed in TypeScript

Status: accepted (P3)

## Context

P3 is the first phase needing a real parse rather than someone else's. The
design assumed a Python backend around libclang, following CppNav. Three things
argued against it once the work was in front of me.

libclang's Python bindings have known holes — `clang_isVirtualBase` is absent and
needs a direct C call, compiler-generated destructors are not materialised — all
of which have to be worked around. A Python backend also means a second runtime
to install, configure and version-match on a Windows machine, for a feature whose
entire value is being available while reading. And `clang -Xclang -ast-dump=json`
already emits everything the detectors need, as JSON, which TypeScript reads
natively.

## Decision

Shell out to a configured clang binary, dump one declaration's AST as JSON, parse
it in the extension host. No Python, no native bindings, no second runtime.

`-ast-dump-filter` is load-bearing rather than an optimisation. An unfiltered
dump of a real translation unit is hundreds of megabytes of header declarations;
filtered to one function the fixture is 150 KB. That constraint also shapes the
feature: Rosetta analyses the function you are reading, on demand, which is how
it would want to work anyway.

Flags come from the project's `compile_commands.json`, sanitised rather than
synthesised. Unrecognised flags are kept. A silently dropped `-mcpu` or vendor
`-D` changes the AST without changing anything visible, and the lens would then
explain a program that does not exist.

## Two format properties that bite

**Locations are differential.** A node's `loc.file` is emitted only when it
differs from the previous location, and `line` only when it changes. Reading a
node in isolation yields a location that is *wrong* rather than absent — the
worst failure mode available. Correct resolution requires replaying clang's
pre-order walk, carrying file and line forward. This is implemented and tested
against real output; over twenty nodes in the fixture omit their line.

**Multiple matches are concatenated, not arrayed.** When the filter matches
several declarations clang emits several top-level JSON objects back to back.
`JSON.parse` on the whole text fails, so the reader splits on brace balance while
tracking string literals and escapes.

## What real output corrected

Two detectors were written wrong against a plausible reading of the schema and
fixed by running actual clang.

`MemberExpr` carries **no virtual flag** — only a `referencedMemberDecl` pointer
id. Virtual call sites therefore cannot be identified from the AST alone; the
answer comes from cross-referencing the P1 structure model by receiver type and
method name. This turned out well: it is the three planes joining, and the lens
degrades honestly to "no structure model loaded" rather than guessing.

Lambda capture `FieldDecl`s are **unnamed**. Names live on the sibling
`DeclRefExpr` capture initialisers. Reading names off the fields returns nothing,
which renders as "captureless lambda" — the opposite of the truth about lifetime,
on precisely the construct where lifetime is the hazard.

Both are why the fixture is generated from real clang rather than hand-authored.
A guessed fixture would have agreed with the guessed parser.

## Consequences

Rosetta needs a clang binary, configured at `lens.clang.path`, and a compilation
database. Both failures are typed and produce a sentence naming the fix. Neither
blocks the journal, the Structure lens, or the Flow lens.

clang's exit status is ignored when it produced a usable AST: a codebase mid-edit
is the normal state for a reading tool, and diagnostics are not a reason to
refuse to explain the parts that did parse.

## Known gap

Guaranteed copy elision shows up as an *absent* `CXXConstructExpr` — in the
fixture, `Buffer scratch = make_buffer()` generates no constructor call at all.
That absence is one of the better things to teach a C engineer, since it is a
case where C++ is cheaper than the C they would have written, and it currently
goes unreported because detecting a missing node needs the declaration-side view
rather than the expression-side one. Worth adding.
