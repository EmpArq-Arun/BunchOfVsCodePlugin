# C/C++ State Machine Visualizer (VS Code extension)

Scans your workspace for C/C++ state machines, lists them in a sidebar, and
renders each one as:

1. **Black-box I/O view** — the module as a single box, with its inputs
   (functions other code calls into it), outputs (functions/calls it makes
   out), shared globals, and `#include`/class-inheritance dependencies drawn
   as edges around it.
2. **State diagram view** (click the box) — actual states rendered using
   their real enum identifiers, with transition edges labeled with the
   guard condition or action that was detected.

Click any state, transition, or I/O node to jump straight to that line in
the source.

## Status

This is a working v0.1 scaffold, parser-tested against sample C and C++
files included in `sample/`. It has **not** been run inside a live VS Code
Extension Development Host yet — do that as your first step (see below)
before pointing it at a large real codebase, and expect to file/fix issues
against unusual code styles.

## Getting it running

```bash
npm install
npm run build
```

Then in VS Code: open this folder, press **F5** (Run → Start Debugging).
That launches an "Extension Development Host" window with the extension
active. Open a C/C++ project in that window and check the **State Machines**
icon in the activity bar.

To produce an installable `.vsix` instead:

```bash
npm install -g @vscode/vsce
vsce package
```

## How detection works (heuristic mode — no setup required)

No compiler, no `compile_commands.json`, nothing to install. It's a
regex/brace-matching pass over each file looking for:

- `enum` / `enum class` / `typedef enum` declarations → the states.
- A dispatcher driving that enum, tried in this order:
  1. `switch (stateVar) { case STATE_X: ... }`
  2. `if (stateVar == STATE_X) { ... }` / `else if` chains
  3. Function-pointer dispatch tables (`HandlerFn table[] = { OnIdle, OnRun, ... }`)
     indexed by enum order, with transitions inferred from state-variable
     assignments inside each handler.
- Assignments back to the state variable inside each branch → transitions,
  annotated with the nearest guard condition or preceding action call as a
  best-effort label.
- Non-static function definitions → input hooks (further split into
  `getter`/`setter` by name pattern); calls to anything not defined in the
  file → outputs; `extern` globals → shared state; `#include`s and C++
  `class X : public Y` → dependencies; assignments to `*callback`/`*handler`
  fields → callback registration.

Each detected machine reports a confidence score and which pattern matched,
shown in the sidebar tooltip — heuristics will occasionally miss unusual
styles (heavy macro use, multi-variable composite state, state stored in a
bitfield, etc.). Enums with no recognized dispatcher still show up (so you
can see what wasn't picked up) at low confidence with an empty diagram.

## Optional external tools

Everything above works standalone. These settings exist so you can opt in
to better tooling **if you have it installed** — none are required:

| Setting | What it's for | Used by default? |
|---|---|---|
| `statemachineVisualizer.tools.graphvizPath` | Path to Graphviz `dot`. When set, the "Export Diagram via Graphviz" context-menu command renders a `.svg` next to the source file instead of just leaving a `.dot` file. | No — implemented and ready, just point it at `dot`. |
| `statemachineVisualizer.tools.ctagsPath` | Path to universal-ctags. Intended to improve the I/O black-box view with real cross-file caller resolution (who *actually* calls this function from elsewhere in the workspace), instead of this file's local guess. | **Reserved** — setting exists, not yet wired into the parser. |
| `statemachineVisualizer.tools.cscopePath` | Path to cscope, same cross-file goal as ctags above (call-graph queries). | **Reserved**, not yet wired in. |
| `statemachineVisualizer.tools.clangPath` | Path to clang/libclang, for a future full-AST parsing mode instead of regex heuristics (handles macros/templates correctly). | **Reserved**, not yet wired in. |
| `statemachineVisualizer.parsing.mode` | `heuristic` (default) or `ctags-enhanced`. | `heuristic` |
| `statemachineVisualizer.scan.include` / `.exclude` | Glob patterns for the workspace scan. | Common C/C++ extensions; excludes `node_modules`, `build`, `out`, `.git`. |

If you want the ctags/cscope/clang modes actually built out, that's a
follow-up — the settings are there so it's a config change, not a breaking
one, when that lands.

## Project layout

```
src/extension.ts          activation, command registration
src/scanner.ts             workspace scan + file-watch cache
src/parser/cParser.ts      the heuristic parser (the core logic)
src/sidebar/               tree view listing detected machines
src/webview/panelManager.ts webview lifecycle + graphviz export
media/webview/main.ts      diagram rendering (cytoscape + dagre layout)
sample/                    two test fixtures (plain C switch-case, C++ if-else)
```

## Known limitations (v0.1)

- Single-file analysis: a state machine whose handler logic is split across
  multiple `.c`/`.cpp` files won't be fully connected (this is exactly what
  the ctags/cscope modes above are meant to fix later).
- Composite/orthogonal state (multiple state variables interacting) isn't
  modeled — each enum is treated independently.
- Transition guard/action labels are best-effort text snippets, not a
  verified condition graph.
