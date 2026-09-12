# C/C++ Dependency Visualizer — Requirements

## Overview

A VS Code extension that statically analyses C/C++ workspaces and renders an
interactive dependency graph.  No compiler, build system, or external tooling
is required for the default mode.  Optional tools (ctags, cscope, Graphviz,
clang) can be configured to enhance analysis quality.

---

## 1. Workspace Scanning

- **REQ-S1** Automatically scan the workspace for C/C++ source files on activation and on demand (⟳ Refresh button). Never disable the refresh button even if parsing error occurs.
- **REQ-S2** Files scanned by default: `*.c`, `*.cpp`, `*.cc`, `*.cxx`, `*.h`, `*.hpp`, `*.hxx`.
- **REQ-S3** Include and exclude glob patterns are user-configurable in VS Code settings (`statemachineVisualizer.scan.include/exclude`).
- **REQ-S4** Re-scan any file automatically when it is saved; update the graph without a full workspace rescan.
- **REQ-S5** Scan results are cached per-file and invalidated on file change, creation, or deletion via a `FileSystemWatcher`.
- **REQ-S6** Maximum 10,000 files per scan; report files scanned and errors in the output channel.

---

## 2. Heuristic Parser

All analysis is regex / brace-matching based.  No compiler or external tool is required.

### 2.1 Preprocessing
- **REQ-P1** Strip C/C++ block comments, line comments, string literals, and character literals before applying structural regexes, preserving original character offsets and line numbers.
- **REQ-P2** Handle nested `{}` and `()` using brace/paren-matching helpers.

### 2.2 Symbol Extraction
- **REQ-P3** Extract non-static function definitions (return type, name, parameter list, definition line).
- **REQ-P4** Detect getter/setter naming patterns (`Module_GetX`, `Module_SetX`, `getX`, `setX`).
- **REQ-P5** Extract class and struct definitions (name, line, base classes).
- **REQ-P6** Extract `enum` and `enum class` declarations, including `typedef enum` aliases, stripping inline comments from enum bodies.
- **REQ-P7** Extract `typedef` aliases.
- **REQ-P8** Extract non-`extern`, non-`static` global variable definitions at file scope.
- **REQ-P9** Extract local `#include "..."` directives (not `<system>` includes).
- **REQ-P10** Extract `extern type varName` declarations.
- **REQ-P11** Extract C++ class inheritance chains (`class A : public B, protected C`).
- **REQ-P12** Detect callback/handler field registrations (`foo->onEvent = myHandler`).

### 2.3 Cross-File Reference Detection
- **REQ-P13** Build a workspace-wide symbol table (Pass 1) then resolve cross-file references (Pass 2).
- **REQ-P14** Detect function call edges: a call in file A to a non-static function defined in file B.
- **REQ-P15** Detect include edges: `#include "header.h"` resolved to the matching workspace file by basename or path suffix.
- **REQ-P16** Detect extern variable edges: `extern` declaration in file A matched to a variable definition in file B.
- **REQ-P17** Detect inheritance edges: base class defined in another file.
- **REQ-P18** Detect typedef/type-usage edges: a type name used in file A that is defined (class/struct/enum/typedef) in file B.
- **REQ-P19** Skip function call edges from a header to its paired implementation file (forward-declaration false positives).
- **REQ-P20** Suppress macro-like ALL_CAPS identifiers and identifiers shorter than two characters from call-edge matching.
- **REQ-P21** Capture rich detail strings for each reference: `#include "x.h"`, `extern volatile int g_flag`, `class Door : IDevice`, `Motor_Start()`.
- **REQ-P22** Store the source-line number of every cross-reference.

### 2.4 Header/Source Pairing
- **REQ-P23** Automatically detect `X.h` / `X.c` / `X_*.h` / `X_*.c` pairs (and `.hpp`/`.cpp`, etc.) pairs by matching basenames.
- **REQ-P24** Represent a paired header+implementation as a single graph node labelled with the base name (e.g. `motor` instead of `motor.c` and `motor.h`).
- **REQ-P25** Remap all cross-references that target a header to the paired implementation file; suppress the internal header↔implementation edge.
- **REQ-P26** If `X.h` includes `Y.h`, the merged `X` node shows a link to the merged `Y` node.

---

## 3. State Machine Detection

- **REQ-SM1** Detect state machines from `enum`/`enum class` types whose values are used as the discriminant of a `switch`, `if`/`else if` chain, or function-pointer dispatch table.
- **REQ-SM2** Support `switch (stateVar) { case STATE_X: ... }` dispatch.
- **REQ-SM3** Support `if (state == STATE_X) { ... } else if (...)` dispatch.
- **REQ-SM4** Support function-pointer dispatch tables whose element count matches the enum's state count and whose elements are known local functions.
- **REQ-SM5** Support scoped `enum class` values in comparisons and assignments (`state == LinkState::Connected`, `state = LinkState::Connected`).
- **REQ-SM6** Extract state-to-state transitions and label each edge with the guard condition that caused the transition, regardless of how many lines before the assignment that condition appeared.
- **REQ-SM7** Find the innermost `if` / `else if` block that structurally encloses the state-variable assignment and use its condition as the transition label.
- **REQ-SM8** Report confidence score (0–1) and detection kind (`switch-case`, `if-else`, `dispatch-table`, `unknown`) per state machine.
- **REQ-SM9** List detected state machines in the activity-bar sidebar, grouped by file, with confidence icon and tooltip.
- **REQ-SM10** Clicking a sidebar entry opens the state-machine diagram panel.

---

## 4. Dependency Graph — File-Level View

### 4.1 Node Hierarchy
- **REQ-G1** Three-level hierarchy: **Folder → File → Function**.
- **REQ-G2** On first open, show folder nodes only. If opened from a file's context menu, auto-expand that file's folder.
- **REQ-G3** Clicking a folder node expands it (showing its file nodes) and double clicking it collapses the folder.
- **REQ-G4** Clicking a file node expands it (showing its cross-boundary function/variable components) and double clicking it collapses the file.
- **REQ-G5** Expansion happens in-place: the expanded node stays at its current graph position. Other around the expanded node will shift accordingly to accommodate the expanded node components without overlapping.
- **REQ-G6** Expansion happens with single click and collapse with double click on the node. Expansion ensures that file node components are visible and none of the components are overlapping each other, so that all the components are visible to the user.
- **REQ-G7** A file with a detected state machine shows a `⊡` badge.
- **REQ-G8** A paired header+source module shows a `(.c+.h)` suffix.

### 4.2 Component Nodes (inside expanded files)
- **REQ-G9** Export components (symbols defined here and used by others) are shown as green `▶` nodes.
- **REQ-G10** Import components (symbols this file calls from other files) are shown as orange `◀` nodes.
- **REQ-G11** In LR/Radial layout: exports in a left column, imports in a right column relative to the file node centre.
- **REQ-G12** In TB layout: exports in a top row, imports in a bottom row.
- **REQ-G13** Component nodes are positioned programmatically (not by the layout algorithm) so they always appear adjacent to their parent file node.

### 4.3 Edges
- **REQ-G14** One edge per (fromFile, toFile, edgeKind) triple; no aggregation across kinds.
- **REQ-G15** Edge kinds and colours:
  - **call** — blue `#4f8cff`, solid
  - **include** — grey `#6c7280`, dashed
  - **extern** — red `#ff6b6b`, solid
  - **inherit** — purple `#a855f7`, solid
  - **typedef** — amber `#f59e0b`, dashed
- **REQ-G16** Edge thickness scales with the number of distinct symbols mediating the connection (min 1 px, max 4 px).
- **REQ-G17** When a file is expanded, edges are redistributed: edges from import components to target file nodes; edges from source file nodes to export components.
- **REQ-G18** Edges between files in the same collapsed folder are suppressed in the folder-level view.

---

## 5. Layout Options

- **REQ-L1** Three layout modes selectable via toolbar buttons:
  - **⊙ Radial** — force-directed (`cose`), randomised starting positions.
  - **⇆ LR** — left-to-right hierarchical (`dagre`, default).
  - **⇅ TB** — top-to-bottom hierarchical (`dagre`).
- **REQ-L2** The layout runs on file and folder nodes only; component nodes are placed programmatically afterwards.
- **REQ-L3** Node positions are saved before every rebuild and restored when the same node reappears after expand/collapse.
- **REQ-L4** A **⤢ Fit** button fits all visible elements to the viewport.
- **REQ-L5** A **⊟ Collapse** button collapses all expanded folders/files.
- **REQ-L6** A `ResizeObserver` calls `cy.resize()` whenever the graph container changes size.

---

## 6. Interaction Model

- **REQ-I1** **Left-click** a folder → expand/collapse.
- **REQ-I2** **Left-click** a file → expand/collapse its function components AND update the sidebar info panel.
- **REQ-I3** **Left-click** a component node → jump to its definition or call site in the source editor (same editor column, no split).
- **REQ-I4** **Left-click** an edge → open the source file at the first reference line.
- **REQ-I5** **Ctrl/Cmd + click** a node → enter focus mode: the selected node and all directly connected neighbours stay at full opacity; all other elements fade to 10%.  Clicking background or Ctrl-clicking again exits focus mode.
- **REQ-I6** **Ctrl+Shift + click** one or more nodes → add to / remove from a multi-selection (purple border).
- **REQ-I7** When one or more nodes are multi-selected, a **⊞ View N selected** toolbar button appears.  Clicking it enters **Selection View**: only the selected files and edges between them are shown.
- **REQ-I8** Clicking empty canvas clears focus mode and hides the info panel. It also clears the selection and goes back to the previous view.
- **REQ-I9** The **↩** back button navigates through a history stack of previous expansion / selection states.
- **REQ-I10** In selection mode, clicking on a file node shows functions of the file, but they must not overlayed on top of each other and cannot be selected. Also, the connection edges should go from function node to file node instead of file node to file node.
- **REQ-I11** In selection mode, all the nodes should be able to expand and collapse, and the functions should be shown as components of the file node. The functions should also be connected to the file/function node with edges.

**Note:**  No files found. Open a workspace and click ⟳ 
---

## 7. Hover Tooltips

- **REQ-T1** Hovering a **folder** node shows: folder path, file count, cross-folder link count, usage hint.
- **REQ-T2** Hovering a **file** node shows: relative path, paired-file info, export/import counts, SM badge if applicable, expand hint.
- **REQ-T3** Hovering a **component** node shows: direction (export/import), symbol name, definition line (for exports), connected peer files, click hint.
- **REQ-T4** Hovering an **edge** shows a structured popup grouped by edge kind, each section listing the actual symbol names and rich detail strings   (e.g. `#include "motor.h"`, `extern volatile int g_flag`, `Motor_Start()`).
- **REQ-T5** Tooltips appear at mouse position clamped to the viewport; they are shown for the node only if the node is focused.
- **REQ-T6** Up to 16 symbols are listed per edge kind; the rest are omitted.
- **REQ-T7** Hovering should produce a tool tip for the edges , example function edges should only show function calls, include edges should only show include, typedef edges should only show typedefs,extern edges should only show extern declarations and inherit edges should only show inheritance. This is relevant to selection view when 2 or more files are selected.

**Note:**  In selection mode, clicking on a file node shows functions of the file, but they are overlayed on top of each other and cannot be selected. 
---

## 8. Sidebar Panel

- **REQ-SB1** A right-hand sidebar shows the **Legend** and, when a node is clicked, a **File Info** panel.
- **REQ-SB2** The sidebar is resizable horizontally by dragging a handle between the graph and the sidebar (100 px – 500 px range).
- **REQ-SB3** The sidebar can be collapsed/expanded via a **◀ Panel** /  **▶ Panel** toolbar button.
- **REQ-SB4** The Legend lists all five edge kinds as checkboxes, all checked by default.  Unchecking a kind immediately hides all edges of that kind via `display: none` (no rebuild required).  Re-checking restores them.
- **REQ-SB5** The File Info panel shows: file path, paired header path (if any), SM badge and names (if any), a list of exported symbols (green), a list of imported symbols (orange).
- **REQ-SB6** Symbol lists show the first 8 items and offer **▼ Show N more** / **▲ Show less** toggles.
- **REQ-SB7** **Ctrl+click** on a symbol chip in the info panel opens the source editor at that symbol's definition line.
- **REQ-SB8** A **📄 Open file** button opens the file in the active editor column (no split).
- **REQ-SB9** A **⊡ State diagram** button opens the state-machine diagram panel (appears only when a state machine is detected in the file).
- **REQ-SB10** A vertical drag handle between the Legend and the File Info panel allows resizing the info panel height (80 px – 600 px). On resize the bottom portion of info panel should be padded to bring the menu up and hold its position until changed again. The padding should be applied to the bottom of the last element in the panel (the last symbol in the list).
- **REQ-SB11** The user-set info-panel height persists across file selections.
- **REQ-SB12** **Connections** Should dynamically update the information based on the selected files or workspace. If unclicked, all links are generated but hidden. If clicked, only the links between the selected files are displayed.

---

## 9. State Machine Diagram Panel

- **REQ-D1** Displays the state diagram for a single detected state machine.
- **REQ-D2** Each state is a rounded-rectangle node labelled with the enum identifier and its explicit value (if any).
- **REQ-D3** The initial state (first enum value) is highlighted with a green border.
- **REQ-D4** Transition edges are labelled with the guard condition (`on event == X`) or preceding action (`after Motor_Stop()`).
- **REQ-D5** Two layout options: **⇆ LR** (left-to-right) and **⇅ TB** (top-to-bottom), selectable via toolbar buttons.
- **REQ-D6** Clicking a state node or transition edge opens the source editor at the relevant line. This works only on active part of the graph.
- **REQ-D7** Hovering a state or edge shows a tooltip with the symbol name and source location. This works only on active part of the graph.
- **REQ-D8** The legend reports detection kind, confidence percentage, state count, transition count, and the name of the state variable.
- **REQ-D9** If no transitions were resolved, a diagnostic message is shown.

---

## 10. Source Navigation

- **REQ-N1** All "open source" actions open the file in `vscode.ViewColumn.Active` (the currently active editor column); no split is created.
- **REQ-N2** The cursor is moved to the target line and the editor scrolls to reveal it (`InCenter`).
- **REQ-N3** Clicking an **export** component navigates to the function's definition line (populated by the scanner from the symbol-definition table).
- **REQ-N4** Clicking an **import** component navigates to the function's definition in the target file (looked up from the target file's detail record).
- **REQ-N5** Ctrl+clicking a symbol chip in the sidebar navigates to the definition (exports) or to the call site in the target file (imports).

---

## 11. Optional External Tools

All external tools are opt-in.  The extension works fully without them.

| Setting | Tool | Purpose |
|---|---|---|
| `tools.graphvizPath` | Graphviz `dot` | Export state diagram as `.dot` / `.svg` |
| `tools.ctagsPath` | universal-ctags | Reserved — cross-file caller resolution |
| `tools.cscopePath` | cscope | Reserved — cross-file call-graph queries |
| `tools.clangPath` | clang / libclang | Reserved — full AST parsing mode |
| `parsing.mode` | — | `heuristic` (default) or `ctags-enhanced` |

- **REQ-E1** If `graphvizPath` is set, the **Export Diagram via Graphviz** context-menu command generates a `.dot` file and renders it to `.svg`.
- **REQ-E2** If `graphvizPath` is not set, only the `.dot` file is written and the user is prompted to configure the path.

---

## 12. Right-Click Context Menus

- **REQ-C1** Right-clicking a `.c/.cpp/.h/.hpp` file in the VS Code Explorer shows **C/C++ Dependency Graph: Open Workspace Map**.
- **REQ-C2** Right-clicking in the editor title shows the same command for C/C++ files.
- **REQ-C3** Opening the graph from a specific file auto-expands that file's folder and highlights that file.
- **REQ-C4** The state-machine sidebar item context menu offers **Go to Definition** (reveals the enum in source) and **Export Diagram via Graphviz**.

**Note**: Right ckick is not working anywhere
---

## 13. Non-Functional Requirements

- **REQ-NF1** No compilation or `compile_commands.json` required.
- **REQ-NF2** Works on Windows, macOS, and Linux.
- **REQ-NF3** All external tool paths are configurable; missing tools produce a user-facing prompt, never a silent failure.
- **REQ-NF4** The webview script sends a `{type:'ready'}` message before any data is posted to it, preventing dropped messages on slow machines.
- **REQ-NF5** A `ResizeObserver` keeps the cytoscape canvas sized correctly when the VS Code panel is resized.
- **REQ-NF6** The extension activates on `workspaceContains:**/*.c` (and equivalent C++ globs) to avoid unnecessary activation.
- **REQ-NF7** All output is routed to a dedicated **C/C++ Dependency Visualizer** output channel.
- **REQ-NF8** The webview enforces a strict Content Security Policy with a per-session nonce.

---

## 14. Settings Reference

| Setting | Type | Default | Description |
|---|---|---|---|
| `scan.include` | `string[]` | `["**/*.c", ...]` | Glob patterns to scan |
| `scan.exclude` | `string[]` | `["**/build/**", ...]` | Glob patterns to exclude |
| `parsing.mode` | enum | `heuristic` | Parser mode |
| `tools.ctagsPath` | string | `""` | Path to ctags executable |
| `tools.cscopePath` | string | `""` | Path to cscope executable |
| `tools.clangPath` | string | `""` | Path to clang executable |
| `tools.graphvizPath` | string | `""` | Path to Graphviz `dot` executable |
