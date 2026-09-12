# Lens — C++ Comprehension & Migration Workbench

*Supersedes `cpp-cost-lens-design.md`. Cost was one lens; this is the whole instrument.*

A VS Code extension that helps a long-time C engineer read, understand and safely contribute to a
large modern C++ codebase — by rendering structure, flow, sequence, lifetime, layout and cost through
a consistent set of "lenses", each of which explains itself in terms the C engineer already owns, and
by accumulating a personal, durable record of the quirks discovered along the way.

Two jobs, in order of importance:

1. **Ramp-up** — get productive in unfamiliar C++ fast, without pretending to understand things you don't.
2. **Retention** — turn every "oh, *that's* what that does" moment into a permanent, searchable, symbol-anchored note, so the second encounter costs nothing.

Cost analysis serves both. It is not the point.

---

## Part I — Open source landscape and salvage verdicts

Verdict key: **DEPEND** (ship it, wrap it) · **PORT** (steal the idea, write your own) ·
**STUDY** (read the algorithm) · **RETIRE** (do not carry forward)

### Indexing and cross-reference

| Tool | What it gives | Verdict |
|---|---|---|
| **clangd** | LSP semantic index, incremental, already in your stack via Embedded Clang Config | **DEPEND** — the default index source. Consume via LSP; never write another indexer. |
| **ccls** | Origin cquery. Global cross-reference view, parallel indexing that serves requests before completion, incremental update on save, indexes LLVM at ~1.8 GB RSS | **DEPEND (optional backend)** — better whole-project xref than clangd on very large trees. Offer as a switchable index provider. |
| **RTags** | Clang-based tagger with a daemon model | **STUDY** — its README is the canonical statement of why C-era taggers fail on C++. Architecture largely superseded by clangd. |
| **cscope** | C cross-reference, function call relationships | **RETIRE** — no C++ semantics. Templates, namespaces and overloading all break it. |
| **universal-ctags** | Lexical tag generation, improved C++ parser over exuberant-ctags | **RETIRE for C++** — no references, no call hierarchy, and the C++ typeref field is unreliable because struct/class keywords are optional in C++. Fine to keep for the C portions of a mixed codebase; useless as a comprehension backbone. |
| **GNU GLOBAL (gtags)** | Tagging with multiple backends and output formats | **RETIRE** — its own author deprecated the built-in C++ parser at 6.6.5. Still excellent for C-only trees (kernel-scale), which is exactly why it feels like it should work and then doesn't. |

**The lesson to put in the tool's own onboarding text:** every navigation tool a C engineer reaches
for by reflex is one that degrades silently on C++. Not loudly — *silently*. It returns plausible,
incomplete answers. Half your early confusion is tooling, not language.

### Diagrams and visualisation

| Tool | What it gives | Verdict |
|---|---|---|
| **clang-uml** | LibTooling-based class / sequence / package / include diagram generator, YAML-configured, emits PlantUML + MermaidJS + **JSON**, driven by compile_commands.json. C++17 with partial C++20. Include/exclude filters by namespace, subclass, specialisation, dependants, context, relationship type. Generates sequence diagrams for plain C too. | **DEPEND — highest-value dependency in the project.** JSON output is a first-class ingest format. Its C support means the same renderer draws your C mental model and the C++ code, which *is* the Rosetta pedagogy. |
| **Sourcetrail** (archived 2021, Clang 11) | Tri-pane comprehension UI: graph + code + symbol list, kept in sync | **PORT** — do not revive a dead Clang-11 codebase. The interaction model is the best ever built for C++ comprehension; reimplement it in the webview. |
| **CodeCompass** (Ericsson + ELTE, LLVM/Clang) | Exact handling of overloading, inheritance, variable/type usage, **function pointers and virtual function targets** where other tools are partial; Steensgaard's and Andersen's pointer analysis for pointer-use visualisation; architecture/component/interface diagrams beyond class+call; integrates build and VCS information; runs on 10 MLOC systems | **STUDY, hard.** Their function-pointer and virtual-target resolution is precisely the problem your ISR/HAL tracking already fights. Read the pointer-analysis implementation before writing your own. |
| **Woboq Code Browser** | Static HTML generation with semantic highlighting and tooltips | **PORT (the output model)** — "generate a shareable static artifact of the codebase" is a good export target for onboarding docs. |
| **Doxygen + Graphviz** | Doc extraction, caller/callee graphs | **DEPEND (optional)** — only if the codebase already has doc comments. Otherwise its graphs are inferior to clang-based ones. |
| **PlantUML / MermaidJS** | Diagram rendering | **DEPEND** — clang-uml already targets both; render Mermaid inline in webview, PlantUML for export. |
| **Graphviz / Cytoscape.js** | Layout + interactive graph | **DEPEND** — already your stack. |

### Language pedagogy

| Tool | What it gives | Verdict |
|---|---|---|
| **C++ Insights** | Clang-based source-to-source transform: range-for → internal form, lambda → closure class, structured bindings expanded, `auto`/`decltype` resolved, implicit conversions and operator calls made visible. Has a VS Code extension that can diff against the original and use a compilation database. | **DEPEND** — shell out to the binary, own the presentation. Never reimplement desugaring. This is the single best "show me what the compiler actually sees" tool that exists. |
| **Compiler Explorer** (local instance) / `cxx-compiler-explorer` | Source↔assembly correspondence | **DEPEND (optional)** — for the "prove it" pane. A local CE instance avoids sending proprietary firmware to godbolt.org. Non-negotiable for employer code. |
| **cppreference / DevDocs offline** | Reference material | **DEPEND** — link out from construct hovers rather than writing your own reference prose. |

### Layout, size and binary

| Tool | What it gives | Verdict |
|---|---|---|
| **pahole** (dwarves) | Struct/class layout from **DWARF/CTF/BTF**, hole and end-padding detection, `--reorganize` with step-by-step display, filters like "show only structs with ≥N holes", explicitly aimed at understanding an unfamiliar codebase | **DEPEND** — and prefer it over clang layout dumps for the *shipped* build, because DWARF from your real cross-compiler is target-correct with no sysroot guessing. Verify C++ `DW_TAG_class_type` handling on your version; it was a historic gap. |
| **clang `-cc1 -fdump-record-layouts -fdump-vtable-layouts`** | *Predicted* layout, including vtable slot tables | **DEPEND** — the prediction plane. Diff against pahole's observed plane; disagreement is a finding, not noise. |
| **Bloaty McBloatface** | Fast whole-binary size overview, ELF diff between builds | **DEPEND** — the A/B build comparison engine. |
| **puncover** | Per-file/per-symbol code, stack and static sizes with disassembly, web UI | **STUDY / partially RETIRE** — LMV already covers this ground. Read its stack-analysis approach; don't run both. |
| **binsize** | bloaty+nm wrapper with tree and compare subcommands | **STUDY** — useful CLI ergonomics reference. |
| **ELFInsight** | VS Code ELF symbol table, section memory distribution, call graph | **STUDY** — direct prior art for the VS Code surface; LMV is more capable. |
| **pyelftools** | ELF/DWARF parsing in Python | **DEPEND** — already in LMV. |
| **llvm-cxxfilt / llvm demangler** | Itanium demangling | **DEPEND** — never hand-roll a demangler. |

### Runtime and dynamic behaviour

| Tool | What it gives | Verdict |
|---|---|---|
| **uftrace** | Function graph tracer for C/C++ with entry/exit timestamps, arguments and return values; filters; Chrome trace, flame graph, **Graphviz and Mermaid call-graph output**. Needs `-pg`, `-finstrument-functions` or `-fpatchable-function-entry=N`; dynamic patching on x86_64/AArch64. Linux userspace only. | **DEPEND (host builds only)** — use on unit-test and host-simulation builds of firmware modules. It will not run on bare-metal Cortex-M. Its Mermaid output ingests straight into the Sequence lens. |
| **Orbuculum / ORBTrace** | Open-source Cortex-M SWO/SWV and 1/2/4-bit parallel trace decode; multiplexes to network clients; documented recipe for piping `-finstrument-functions` entry/exit hooks out an ITM channel | **DEPEND (on-target)** — this is how you get *real* execution sequences from firmware rather than static approximations. ~12.5 MB/s demonstrated on parallel trace; SWO is slower but needs no special hardware. |
| **gcov / lcov** | Executed-line coverage | **DEPEND (optional)** — "which code actually runs" is a superb ramp-up filter. Grey out never-executed branches in the Flow lens. |
| **Percepio Tracealyzer / SEGGER SystemView** | RTOS-aware trace | **NOTE ONLY** — commercial. Relevant because you're on FreeRTOS; if the team already licenses one, ingest its export rather than duplicating. |

### Quality
`lizard` (**DEPEND**, already yours), `clang-tidy` (**DEPEND** — but as an *explainer*, see below),
`cppcheck` (**STUDY**), `include-what-you-use` (**DEPEND (optional)** — header hygiene is a real
ramp-up obstacle in template-heavy code).

Note on clang-tidy: for a learner its value is inverted. Don't run it as a linter over code you don't
own. Run its `modernize-*` and `cppcoreguidelines-*` checks in **read-only explain mode** over code
someone else wrote, as a "here is the idiom being used and its named rationale" annotation source.

### The explicit do-not-build list

Never write: an indexer, a demangler, a UML renderer, a graph layout engine, a DWARF parser, a
desugaring transform, a trace decoder, a coverage instrumenter. Every one is solved. The project's
entire value is in the **join**, the **pedagogy** and the **retention**.

---

## Part II — Consolidation of existing projects

Six overlapping tools, each re-solving indexing, rendering and configuration. Collapse to **one
extension plus two shared libraries**.

| Existing project | Fate | Detail |
|---|---|---|
| **CppNav** | **Absorbed — becomes the Index core** | libclang indexing, CHA/RTA resolver, JSON-RPC backend and `CallHierarchyProvider` become Lens's spine. Cancel as a separate product; it was always the substrate, not the deliverable. |
| **Call Graph Visualizer** | **Absorbed — becomes the Flow lens** | The Cytoscape renderer, sidebar/filter UI, 7 layouts, path-trace mode, group/cluster mode, ISR detection and HAL vtable-struct linking become the shared graph surface for *all* lenses. Freeze the published extension at current version; don't delete it, don't develop it. |
| **Complexity Cosmos** | **Absorbed — becomes the Quality lens** | lizard backend, CodeLens, hover table and snapshot history fold in as one lens. Small, self-contained, low migration cost. Retire standalone. |
| **Codex Intelligence** | **Absorbed — becomes the Narrative lens + knowledge store** | Its compressed markdown knowledge DB is *already* the right storage model for the Quirk Journal. The 13-provider LLM registry and Context Manifest transparency carry over intact. Multi-agent orchestration deferred — it is a distraction from ramp-up. |
| **LMV** | **Stays a standalone Python package, consumed by Lens** | ELF/map/stack/callgraph/vtable/RTTI analysis is genuinely useful headless and in CI. Keep the CLI, drop the Bottle web UI as the primary surface (Lens replaces it). This also sidesteps the Windows packaging problem: it ships *inside* the extension as a vendored wheel, and standalone packaging becomes optional rather than blocking. |
| **Embedded Clang Config** | **Stays published standalone, shared as a library** | Different audience, real standalone value. Extract the S32DS/MPLAB X/CubeIDE/Keil/Generic detection into a package that both it and Lens import. Zero duplication, two products. |
| **Job Intel** | **Unaffected** | Different domain entirely. |

**Net result:** 6 maintained surfaces → 2 published extensions (Lens, Embedded Clang Config) + 2
shared libraries (`lmv-core`, `toolchain-profiles`). Roughly a 60% reduction in maintenance surface,
and every lens inherits configuration, indexing and rendering for free instead of reimplementing it.

---

## Part III — Architecture

### The Lens Index — one store, many views

A single project-local SQLite database at `.lens/index.db`. Every lens is a read-only view over it.
This is the entire reason six tools become one.

```
symbols       usr, mangled, kind, file, line, signature, is_virtual, is_template, std_version
relations     from_usr, to_usr, kind (calls|inherits|overrides|includes|reads|writes|instantiates), confidence
layouts       usr, source (predicted|observed), size, align, members[offset,size,name,padding_before]
abi_artifacts usr, artifact_kind (vtable|vtt|typeinfo|thunk|guard|init_array|eh_table), mangled, section, bytes
costs         usr, rom, ram, stack, source (modelled|measured), build_id
traces        run_id, seq, usr, depth, timestamp_us, source (uftrace|itm|coverage)
constructs    usr, construct_id, span, severity, c_equivalent_ref
annotations   usr, kind (quirk|idiom|learned|todo|wtf), body_md, created, revisit_at, confidence
builds        build_id, flags, triple, elf_hash, timestamp
```

Join keys: **USR** for source identity (survives line moves — critical for annotation durability),
**mangled name** for binary identity. Everything else hangs off those two.

### Confidence is a first-class column

A C engineer's worst failure mode in C++ is confident wrongness — believing a call goes somewhere it
doesn't. Every relation carries a confidence value and a resolution method:

- `exact` — direct call, statically resolved
- `cha` / `rta` — virtual call narrowed by class hierarchy / rapid type analysis
- `fn_ptr` — through a function pointer, targets inferred
- `observed` — seen in an actual trace
- `unresolved` — Lens does not know, and says so

The UI renders these differently and **never draws an unresolved edge as though it were exact**. A
tool that admits ignorance is more useful to a learner than one that guesses smoothly.

### Layered backends

```
VS Code extension (TypeScript)
├── Lens shell — lens switcher, symbol context, shared Cytoscape/Mermaid surface
├── Providers — hover, CodeLens, CallHierarchy, TreeView, annotation gutter
└── JSON-RPC ──► Python orchestrator
                 ├── index/       clangd LSP client │ ccls (optional) │ libclang for what LSP omits
                 ├── diagram/     clang-uml wrapper → JSON → renderer
                 ├── layout/      pahole (observed) + clang -cc1 (predicted) + diff
                 ├── binary/      lmv-core: ELF, map, .su, gc-sections, bloaty diff
                 ├── construct/   AST matcher pass → construct catalogue hits
                 ├── desugar/     C++ Insights wrapper
                 ├── trace/       uftrace (host) │ orbuculum ITM (target) │ gcov
                 ├── narrate/     LLM registry, Context Manifest
                 └── journal/     annotations, review scheduling, markdown export
```

Every backend is optional and degrades independently. No pahole? The layout lens shows predicted-only
and says so. No trace probe? Sequence lens is static-only. Nothing crashes the pipeline — your
existing principle, enforced by making each backend a separate process returning typed JSON or an
error object.

---

## Part IV — The lenses

Each lens answers one question a newcomer actually asks.

**1. Structure — "what are the pieces and how do they relate?"**
clang-uml class, package and include diagrams, scoped by folder or namespace. Sourcetrail-style
tri-pane: graph, source, symbol list, kept in sync. Include-graph view answers "why does touching
this header rebuild everything", which is a genuine early frustration.

**2. Flow — "if I call this, where does control actually go?"**
Call graph with virtual dispatch expanded to candidate targets via CHA/RTA, function pointers
resolved where possible, ISRs marked, confidence rendered honestly. Path-trace mode from your
existing extension. Overlay coverage to grey out code that never runs.

**3. Sequence — "what is the order of things at runtime?"**
Static first: clang-uml sequence diagrams between two code locations, with free functions as
standalone participants (works identically on the C parts). Dynamic second: uftrace on host test
builds, ITM/`-finstrument-functions` on target via Orbuculum. Render both, and diff them — the gap
between what the static analysis predicts and what the hardware does is where the real learning is.

**4. Lifetime — "who owns this, and when does it die?"**
The single most alien concept coming from C. Visualise: construction and destruction points, RAII
scopes as bracketed regions in the gutter, smart-pointer ownership edges, static init order,
`__cxa_atexit` registrations, temporaries and their lifetime extension. A C engineer knows
malloc/free discipline; this lens shows that C++ is doing the same discipline invisibly, and where.

**5. Layout — "what does this object look like in memory?"**
pahole-observed and clang-predicted byte maps side by side, vptr slots marked, padding in red,
hole/padding waste ranked project-wide, `--reorganize` suggestions. Target-correct by construction.

**6. Cost — "what does this construct cost in ROM/RAM/stack?"**
The mangled-name join from v1: `_ZTV`/`_ZTT`/`_ZTI`/`_ZTS`/`_ZTh`/`_ZGV` prefixes attributed back to
the class that caused them; unattributable bytes bucketed into named runtime-support categories;
A/B build diff via bloaty with `-fno-rtti -fno-exceptions -fno-threadsafe-statics`. Every number
tagged `modelled` or `measured`, never blurred.

**7. Rosetta — "what would I have written in C?"**
The pedagogical core. For every detected construct: the C++ as written, the C you'd hand-roll for
the same machine behaviour, and the C++ Insights desugaring showing what the compiler actually built.
Three columns: *your mental model → the source → the truth*. Virtual dispatch renders as the
function-pointer-table struct you already write in HAL layers — which your Call Graph Visualizer
already detects and links, so the tool can point at a real example from the actual codebase rather
than a toy.

**8. Journal — "what did I learn, and what will I forget?"**
See below. The lens that makes this a tool you keep using after you've ramped up.

---

## Part V — The Quirk Journal

The retention half of the brief, and the genuinely novel part. No existing tool does this.

- **Anchored to USR, not line numbers.** Notes survive refactors, reformatting and file moves. A note on `Motor::step` stays on `Motor::step`.
- **Typed entries.** `quirk` (this code does something surprising), `idiom` (this is a named C++ pattern, here's what it's called), `learned` (I understood something), `wtf` (I don't understand this yet — flagged for follow-up), `todo`.
- **Auto-seeded.** When a lens surfaces something notable — a virtual base, a `std::function` in an ISR path, a static with a guard variable, a template instantiated 14 ways — it offers a pre-filled draft entry. You edit and keep, or dismiss.
- **Open questions are first-class.** A `wtf` entry is a tracked debt with the symbol attached. The list of things you don't yet understand *is the ramp-up plan*, and it shrinks visibly. That visible shrinkage matters more for morale than it sounds.
- **Revisit scheduling.** Entries surface again on a decaying schedule (7 / 30 / 90 days) in a review panel. Not gamified, not a streak — just "you noted this a month ago, does it still surprise you?" Confidence field goes up, entry retires itself.
- **Rendered inline.** Gutter marker plus hover on any annotated symbol, so past-you briefs present-you automatically while reading.
- **Markdown export.** `.lens/journal/` as flat markdown, git-committable. Becomes team onboarding documentation almost for free — the notes a newcomer writes are exactly what the *next* newcomer needs.
- **Ramp-up dashboard.** Symbols visited, constructs encountered vs. catalogue coverage, open `wtf` count, journal entries by module. Not a productivity metric — a map of where your understanding is thin.

---

## Part VI — Phase plan

Sequenced so that **every phase is useful standing alone**, and the earliest phases require no
infrastructure beyond what a normal build already produces. You are ramping up while contributing,
so nothing may block on a full pipeline.

### P0 — Skeleton + Journal (1–2 weeks)
Extension shell, `.lens/index.db`, clangd LSP client for symbol resolution, USR-anchored annotations,
gutter + hover rendering, `wtf` list view, markdown export.
*Exit:* you can annotate any symbol in the real codebase and the note survives a refactor.
*Value on day one, zero heavy tooling.* Start using it on the actual project immediately — the
journal is worth more the earlier it starts.

### P1 — Structure lens (1–2 weeks)
clang-uml wrapper, JSON ingest, class/include/package diagrams scoped by folder or namespace,
tri-pane sync. Migrate the Cytoscape renderer from Call Graph Visualizer as the shared surface.
*Exit:* generate a readable class diagram for one real module without hand-editing YAML.

### P2 — Flow lens + CppNav migration (2–3 weeks)
Absorb CppNav's index and CHA/RTA resolver. Call graph with virtual targets expanded, function
pointers resolved, ISRs marked, confidence rendered distinctly. Optional gcov overlay.
*Exit:* pick any virtual call site and see the honest candidate set, with unresolved edges marked as
unresolved rather than omitted or guessed.

### P3 — Rosetta lens (3–4 weeks) — **the teaching core**
Construct catalogue as a versioned JSON manifest keyed by standard. AST matcher pass per construct.
C++ Insights integration. Three-column C↔source↔desugared pane. Hover and CodeLens.
*Exit:* every construct in the pilot fixture is detected, explained, and shown with a C equivalent
drawn from real code in the codebase where one exists.

### P4 — Layout lens (1–2 weeks)
pahole + clang `-cc1` dumps, byte-map SVG renderer, predicted-vs-observed diff, padding waste ranking.
*Exit:* the two sources agree on every type in the fixture, or the disagreement is explained.

### P5 — Cost lens + LMV migration (2–3 weeks)
`lmv-core` extraction and vendoring, demangler, ABI artifact census, attribution join, bloaty A/B
build diff, cost ledger and treemap.
*Exit:* total attributed bytes plus named runtime buckets reconciles with `arm-none-eabi-size` to
within a stated tolerance. If it doesn't reconcile, the attribution is wrong and you'd never know.

### P6 — Sequence lens (2–4 weeks)
Static: clang-uml sequence diagrams with location constraints. Dynamic: uftrace ingest for host test
builds; `-finstrument-functions` → ITM → Orbuculum ingest for target. Static/dynamic diff view.
*Exit:* one real firmware use case traced end-to-end on hardware and rendered as a sequence diagram
next to its static prediction.

### P7 — Lifetime lens (2–3 weeks)
Ctor/dtor points, RAII scope brackets in the gutter, ownership edges, static init order, atexit
registrations.
*Exit:* a C reader can see, for one module, exactly where every object is born and dies.

### P8 — Narrative + Quality (2–3 weeks)
Codex Intelligence migration: per-module primers generated from the actual code with Context
Manifest transparency. Complexity Cosmos migration as the Quality lens. clang-tidy in explain mode.
*Exit:* `.lens/primers/` contains a readable "the C++ in this module, explained" doc per folder.

### P9 — Consolidation and release
Freeze Call Graph Visualizer, Complexity Cosmos and CppNav as standalone products. Extract
`toolchain-profiles` shared with Embedded Clang Config. Package, document, publish.

**Sequencing note:** P0–P2 give you working comprehension in about a month. P3 is where the learning
compounds. P4–P7 are depth you'll want by month three but would slow you down at week two. If time
runs short, P0/P2/P3/P8 alone is a complete, coherent product; the binary lenses are the part you can
already do by hand with LMV.

---

## Part VII — Risks

- **clang-uml sequence diagrams don't do templates.** Fine for firmware control flow, painful if the codebase is template-heavy. Verify against the real project before committing P6 scope.
- **pahole and C++ classes.** Historic `DW_TAG_class_type` handling gap. Test on your actual DWARF early; fall back to clang-predicted-only if it bites.
- **Predicted vs observed layout divergence.** Treat as a finding, not an error to suppress. It's often the most educational output the tool produces.
- **Inlining at -O2** destroys source↔symbol attribution. Mitigate with `-ffunction-sections -fdata-sections` (already yours), a `-fno-inline` teaching build, and DWARF `DW_TAG_inlined_subroutine` ranges for the real build.
- **Trace overhead.** `-finstrument-functions` on every function will change real-time behaviour on a motor controller. Support selective instrumentation by file or symbol pattern from the outset, not as an afterthought.
- **Proprietary code and cloud LLMs.** Employer firmware must not leave the machine. Default the narrate backend to LM Studio local; make any cloud provider an explicit opt-in with a visible indicator. Same for Compiler Explorer — local instance only.
- **Scope creep into a static analyser.** Lens explains; it does not judge. The moment it starts telling you code is bad, it becomes a linter you'll stop opening. Explanation and prescription must stay separated, and P8's clang-tidy integration is the place that boundary is most likely to erode.
- **Vendor SDK noise.** Switchable exclusion profiles from day one, per your existing pattern.

---

## Part VIII — Pilot fixture

Two projects, not one.

**A. Synthetic torture fixture (~2 kLOC).** Every construct in the catalogue exactly once, with
known expected costs: virtual HAL, one multiple-inheritance class, one virtual base, a
`dynamic_cast`, exceptions both on and off, three instantiations of one template, a `std::function`
callback, a function-local static, two globals with constructors, one coroutine, one ISR path
through a virtual call. Regression suite and demo in one.

**B. The real codebase you're ramping on.** Every phase's exit criterion must be demonstrated against
it, not just the fixture. A comprehension tool that only works on toy code is a comprehension tool
you will not use — and the journal entries you generate while validating each phase are real work,
not test data.
