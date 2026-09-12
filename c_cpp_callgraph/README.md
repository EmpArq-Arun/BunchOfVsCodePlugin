# C/C++ Call Graph Visualizer (VS Code extension) — v0.3

Interactive caller/callee call graphs, function-pointer/callback tracing,
active-vs-`#ifdef`'d-out code, class hierarchy (UML-style) diagrams, and now
**clang-verified edge confirmation + virtual-dispatch candidates** for C/C++.

## Status: heuristic engine + hybrid clang-verification layer, both tested against real clang

This works **with or without `compile_commands.json`**:

- **No `compile_commands.json` found** → pure heuristic mode (v0.1 behavior,
  unchanged): fast, in-memory, regex/brace-based, zero setup.
- **`compile_commands.json` found** (auto-detected, or via
  `callgraph.compileCommandsPath`) → the heuristic graph is additionally
  **corroborated by your own `clang` binary**, on demand, for whatever's
  currently on screen. Edges get marked confirmed (green), contradicted
  (red dashed — heuristic false positive, kept visible rather than silently
  dropped), or not-yet-checked (gray). Virtual-dispatch candidates appear as
  purple dotted edges when clang confirms a class hierarchy is polymorphic.

## Why this design, not clangd or a custom native AST tool

I tried three approaches and measured them before picking one — worth
recording since it's a real architectural fork:

1. **VS Code's built-in `vscode.prepareCallHierarchy` etc., delegating to
   clangd/cpptools.** Zero extra dependencies, but entirely dependent on the
   user having a working clangd/cpptools setup — if absent, "semantic mode"
   silently provides nothing extra over heuristic.
2. **A custom Clang LibTooling C++ tool**, compiled and shipped as a native
   binary. Technically the "proper" way real indexers do this — but means
   shipping/building a platform-specific native binary per OS/arch, which is
   a heavier, harder-to-verify dependency than what we're trying to avoid.
3. **Shelling out to `clang`/`clang++` directly** (no native binary, no
   bindings) — this is what's actually implemented.

Within option 3, the obvious first thing to try — `clang -Xclang
-ast-dump=json` for a whole translation unit — **does not work** for real
codebases. Measured directly: one file that just does `#include <vector>`
produced a **1.2 million line** JSON dump. Not viable.

The fix: `-Xclang -ast-dump-filter=<name>` scopes the dump to a single named
declaration's subtree. Same file, same `<vector>` include, filtered to one
function: **74 lines, ~130ms**, even though clang still has to fully parse
the headers internally (same cost as a normal incremental compile — just not
serialized back to us). This is what the whole semantic layer is built on.
All of these numbers came from real `clang++ -Xclang -ast-dump-filter=...`
invocations during development, not estimates — see `test/clangAstQuery.test.ts`
and `test/semanticEnrichment.test.ts`, which run against a real installed
clang and real fixture files, not mocks.

This also settles the caching question: since each query is already scoped
to one function/class and fast, there's no whole-workspace index to persist
— enrichment runs lazily, in-memory, only for whatever's currently visible
(the selected root + its immediate neighbors, capped at
`maxCallerConfirmations`). A persistent disk cache would add invalidation
complexity (mtimes, schema versions, stale branches) for little benefit at
this scope — worth revisiting only if real usage shows the per-load latency
is actually a problem.

## What clang verification does and doesn't buy you

- **Does**: confirm/contradict direct and member-call edges with real
  overload-aware type matching; confirm class inheritance + polymorphism;
  generate virtual-dispatch candidate edges; correctly exclude anything
  inside `#if 0`/unresolved `#ifdef` branches (clang's preprocessor already
  discarded them before parsing — confirmed in `test/clangAstQuery.test.ts`).
- **Doesn't**: resolve function-pointer/callback targets. A function
  pointer's runtime value isn't part of the AST — `f();` through a
  pointer variable shows up as a call through a `VarDecl`, not a
  `FunctionDecl`, regardless of engine. This stays entirely on the
  heuristic engine in both modes; clang verification doesn't change that
  (confirmed empirically too — see the `dispatch()` case in the tests).

## Function-pointer / callback tracing (heuristic, both modes)

Covers: `(*ptr)(args) = func;` declarations, `var = func;` assignments
(including `obj->field = func;`/`obj.field = func;`), dispatch-table array
initializers (`HandlerFn table[] = { OnA, OnB };`), and **lambda
assignments traced one level in** — `cb = [](){ helper(); }; cb();` shows
`cb()` as a pointer-edge to a synthetic `<lambda>` node, which itself has
a normal outgoing edge to `helper()`, so it's expandable rather than a dead
end. Resolution prefers the most recent same-file binding before the call
site; if none exists in that file, it falls back to **any other file's**
binding for that variable name — covers the common C pattern of a callback
field wired up in one translation unit and invoked in another (HAL/driver
vtables, observer registration, etc.), at the cost of being unable to
distinguish two same-named-but-distinct callback variables across
unrelated struct instances (documented over-approximation, not a bug).

Still not covered: pointer-to-member-function syntax (`void
(Class::*ptr)()`) is rare enough in modern C++ (lambdas/`std::function`
cover the same need) that it's left as a gap rather than built blind.

## Getting it running

```bash
npm install
npm run build
```

Then in VS Code: open this folder, press **F5** (Extension Development
Host), open a C/C++ project there.

- **Call Graph: Show for Function at Cursor**
- **Call Graph: Show Class Hierarchy (UML)**
- **Call Graph: Rebuild Workspace Index**

To produce an installable `.vsix`: `npm install -g @vscode/vsce && vsce package`.

## Running the test suite

```bash
npm test
```

94 checks across 7 files. Notably, three of them exercise **real clang**
(installed locally, not mocked) against fixture `.cpp` files in
`test/fixtures/` with a real `compile_commands.json`:

- `test/clangAstQuery.test.ts` — direct calls, recursion, member calls
  (`.`/`->`), confirms pointer calls are correctly *not* reported as direct,
  class bases/polymorphism, `#if 0` exclusion, and the `<vector>`
  dump-size sanity check above.
- `test/semanticEnrichment.test.ts` — confirms a genuine edge, flags a
  deliberately-fabricated edge as unconfirmed (not dropped), confirms the
  caller-side direction too, and validates virtual-candidate generation.
- `test/fullPipeline.test.ts` — the real `WorkspaceIndex` (heuristic) →
  `buildCallGraph` → `enrichCallGraph` sequence end to end, exactly mirroring
  what `webviewPanel.ts` runs at use time.

`test/functionPointers.test.ts` validates the cross-file pointer-binding
fallback and lambda-body tracing above (no clang needed — pure heuristic
engine), against the mock vscode workspace.

The remaining three (`sanity.ts`, `graphBuilder.test.ts`,
`workspaceIndex.test.ts`) are the rest of the pure heuristic-engine tests,
no clang/vscode needed (`test/mocks/vscode/` stands in where a real host
would be).

If you don't have `clang`/`clang++` installed, the three clang-dependent
test files will fail (the extension itself degrades gracefully — see above
— but the tests for that layer need the real binary to mean anything).

## Settings

```jsonc
{
  "callgraph.compileCommandsPath": "",       // optional — auto-detects at root/build/out/cmake-build-*
  "callgraph.clangBinaryPath": "",            // optional — defaults to 'clang++' on PATH
  "callgraph.maxCallerConfirmations": 15,      // caps clang queries per load (perf bound)
  "callgraph.graphvizDotPath": "",             // optional, SVG export only
  "callgraph.defaultDepth": 5,
  "callgraph.maxDepth": 20,                     // slider range is always 1-20
  "callgraph.maxVisibleNodes": 500,
  "callgraph.showSourceByDefault": false
}
```

(`clangdPath`, `clangUmlPath`, `cscopePath`, `ctagsPath` from the original
plan were dropped — they don't fit the architecture that actually got built
and tested. cscope/ctags in particular turned out unnecessary: the
heuristic engine doesn't need them, and clang itself replaced clang-uml for
class diagrams.)

## How heuristic mode works (unchanged from v0.1, no setup required)

See the v0.1 notes inline in `src/parser/` — regex/brace-matching pass:
strip comments/literals, find function/class spans via brace-depth
matching, track `#if`/`#ifdef` nesting (only resolves what's locally
`#define`d; everything else stays active+unflagged rather than guessed at),
resolve call sites (qualified name → pointer-binding tracker → bare name),
two-pass workspace-wide resolution for cross-file calls.

## Known limitations

- Heuristic name resolution still can't fully disambiguate overloads on its
  own — clang verification corrects this for whatever's currently visible,
  but unconfirmed/unexpanded parts of the graph keep the heuristic's
  over-approximation.
- Function-pointer/callback tracing is approximate in both modes (see
  above) — by design, not a gap either engine closes.
- Class-hierarchy enrichment is capped at 30 classes per load
  (sequential clang queries) to bound latency on large diagrams.
- `entryFor()`'s fallback for headers (using a same-directory `.cpp`'s
  compile flags as a proxy) is a heuristic itself — works for typical
  per-directory layouts, may misfire on unusual ones.

## What's next

Real-world validation: every number and behavior above came from fixture
files and a fresh clang install in a sandbox, not your actual codebase.
Things likely to need adjustment once you try it on something real:
include-path edge cases in `compile_commands.json` parsing, latency on
heavily-templated files at `maxCallerConfirmations`'s default of 15, and
whatever heuristic-parser misses turn up on code styles I haven't seen.
