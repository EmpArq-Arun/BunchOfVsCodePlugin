# Vistacode

Live flowchart visualization for C/C++ functions, directly in VS Code.

## Status: Phases 0–8 implemented

What works:
- **Live, cursor-based flowcharts.** `Vistacode: Show Flowchart for Current Function` opens a panel that tracks whichever function your cursor is in, updating on selection change (instant, cache-first) and on edits (debounced ~200ms).
- **Full construct coverage**: `if`/`else if`/`else`, `for`, `while`, `do`-`while`, `switch` (including empty-label grouping like `case 0: case 1:` and fallthrough), `goto`/labels (forward and backward), `break`, `continue`, `return`. Represented as a true graph, not a tree, so `goto` and fallthrough are ordinary edges.
- **Doxygen-style annotations**: a `/** ... */` comment directly above or trailing a statement overrides that node's label. Leading comments above a group of plain statements label the whole group.
- **Heuristic fallback labels** (bounds/null/error checks) for decision nodes with no comment.
- **Per-function disk cache** mirroring the source tree under `.vistacode/cache/`, written only on save (never during live typing). Unchanged functions are skipped entirely — no rebuild, no relayout. Stale entries (renamed/removed functions) are pruned automatically via a per-file manifest.
- **Click-to-rename**: clicking a node in the diagram prompts for a new label and writes it back into the source as a wrapped Doxygen comment (word-wrapped to `vistacode.annotationMaxLineWidth`), replacing an existing leading comment in place if there is one.
- **Export**: `Vistacode: Export Current Diagram` writes `.dot`, `.svg`, and `.png` for the currently displayed function, defaulting to the mirrored cache folder (overridable via `vistacode.exportPath` or a one-off save-location prompt).
- **Debugger overlay (Phase 7, best-effort)**: a DAP tracker listens for `stopped` events and highlights the matching node. This is the one piece that genuinely needs a live debug session to validate — see Known Limitations below.

## Tested

The parser, CFG builder, dot generator, and annotation/doxygen logic are pure functions with no VS Code dependency, so they're covered by real tests that parse actual C source with `web-tree-sitter` and render through the real WASM Graphviz engine (not mocked):

```bash
npm test
```

Covers: if/else-if/else branching + reachability, for/while continue-vs-break routing (including the for-loop continue-targets-the-update-step rule), switch fallthrough/empty-case-grouping/default, forward and backward goto resolution, do-while loop-back targeting, the Doxygen wrap/parse round-trip, and an actual dot→SVG render through Graphviz confirming the generated dot syntax is valid.

The VS Code-API-dependent glue (extension.ts, webview messaging, the debugger tracker) type-checks cleanly (`npm run compile-check`) and the bundles build cleanly, but can only be fully exercised in a real Extension Development Host — there's no VS Code GUI in an automated test run to drive that.

## Setup

```bash
npm install
npm run build
```

Then press `F5` in VS Code (with this folder open) to launch an Extension Development Host. Open a `.c`/`.cpp` file and run:

```
Vistacode: Show Flowchart for Current Function
```

Move your cursor between functions to see it update live. Save the file to populate `.vistacode/cache/`. Click any node in the diagram to rename it. Run `Vistacode: Export Current Diagram` to write `.dot`/`.svg`/`.png`.

## Architecture notes

- **Parsing**: `web-tree-sitter` (WASM) + `tree-sitter-wasms`' prebuilt C/C++ grammars — chosen over native `node-tree-sitter` bindings specifically to avoid per-platform native binary packaging headaches in the final `.vsix`. Pinned to `web-tree-sitter@0.22.6`: newer 0.26.x failed to load these grammar files in this environment (ABI mismatch) — if you upgrade either package, re-run `npm test` to confirm they still load together.
- **Rendering**: `@hpcc-js/wasm-graphviz` — its WASM binary is base64-inlined in the JS, so it bundles cleanly for both the extension host (export) and the webview (live display) with no separate asset file.
- **PNG export**: `@resvg/resvg-wasm`, the one asset that does need an explicit copy into `dist/wasm/` (see `scripts/copyAssets.js`) since its wasm-bindgen-style API requires manually supplying the wasm bytes.
- **Node identity gotcha**: tree-sitter `SyntaxNode` wrapper objects are not referentially stable across separate accessor calls — comparing two nodes with `===` will silently fail even when they represent the same underlying syntax node. Always compare `.id` instead. (This bit us once during development — see the `.id` comparisons in `cfgBuilder.ts`'s switch/labeled-statement handling.)

## Known limitations

- Switch statements assume every value either matches a case or `default`; the implicit "no case matches and there's no default" exit isn't drawn as a separate edge.
- The click-to-rename "find existing comment to replace" logic is a best-effort textual scan upward from the anchor line, not a re-parse — correct for the common case, but a hand-edited comment in an unusual shape could be missed (worst case: a duplicate comment gets inserted rather than replaced).
- The debugger overlay's `stackTrace` handling is written to the standard DAP shape but hasn't been exercised against a real debug adapter (cppdbg, lldb, etc.) — treat it as a verified-by-code-review skeleton, not a tested feature.
