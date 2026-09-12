# Lens

A C++ comprehension workbench for engineers fluent in C.

Reading unfamiliar modern C++ with a C model in mind produces confident, wrong
conclusions — a destructor that runs at a closing brace, a call that dispatches
somewhere the source does not name, a `sizeof` larger than the members you can
see. Lens makes those things visible, explains each one in terms of the C you
would have written, and keeps a durable record of what you worked out.

Every finding has the same shape: **what the compiler emits**, and **what you
would have written in C for the same machine behaviour**. Severity is distance
from a C mental model, not code quality — Lens explains, it does not judge.

## The lenses

| Lens | Answers | Needs |
|---|---|---|
| **Journal** | What did I not understand, and what did I work out? | nothing |
| **Structure** | What are the pieces, and what is alien about each class? | clang-uml |
| **Flow** | If I call this, where does control actually go? | LSP; sharper with Structure |
| **Rosetta** | What is this *line* doing that it does not look like? | clang |
| **Layout** | What does this object look like in memory? | clang; sharper with pahole |
| **Cost** | What do these features cost in my image? | the linked ELF |
| **Sequence** | What order do things happen in, and what really ran? | clang; sharper with a trace |
| **Lifetime** | Who owns this, and when does it die? | clang |
| **Quality** | Where is this hard to hold in your head? | clang |
| **Primer** | Write all of it down for the next person. | whatever has run |

Every external tool is a configured path with a typed failure that names the fix,
and every one is optional. Start with the journal, which needs none of them.

## Three principles the code enforces

**Certainty is visible.** A resolved call and a bounded guess never look alike. A
call Lens could not follow renders as a dotted edge with a `?`, because knowing
where analysis stops tells you which code you must read rather than trust.

**Nothing is silently dropped.** The cost ledger reconciles against the ELF's own
section totals. Layouts that could not be cross-checked say so. Trace lines that
did not parse are counted. A tool that quietly omits is worse than one that
admits a gap.

**Human notes outrank generated ones.** The journal leads every primer, because it
carries the thing no analysis can: what actually confused a person.

---

# Lens — P0

The first phase of the C++ comprehension workbench: a symbol-anchored journal
for everything you don't understand yet.

P0 does one thing. While reading unfamiliar C++, you put the cursor on a symbol
and record a note — most often "I have no idea what this is doing". The note is
anchored to the symbol rather than to a line, so it survives the code moving
underneath it, and it comes back to you on hover the next time you read that
function. The list of things you don't yet understand becomes your ramp-up plan,
and you can watch it shrink.

No compilation database. No clang. No build. If the codebase already has working
IntelliSense, this works.

## Why this is phase zero

Every other lens can be built later at no cost. The journal is the only
component whose value depends on starting early — one begun in month three has
lost its two best months of material, and those are the months when everything
is confusing enough to be worth writing down.

## Using it

| | |
|---|---|
| `Ctrl+Alt+/` | Flag an open question on the symbol at the cursor |
| `Ctrl+Alt+.` | Add a note of any kind |
| Hover | Read whatever you recorded here before |
| Lens sidebar | Open questions, review queue, whole journal |
| `Lens: Start Review Session` | Walk what's due |
| `Lens: Export Journal to Single Markdown` | One document for the next person who joins |
| `Lens: Show Ramp-up Status` | Where your understanding is thin |

### Entry kinds

- **Open question** — I don't understand this yet. The most important kind, and the one on the hotkey.
- **Quirk** — this code does something surprising.
- **Idiom** — this is a named C++ pattern; here's what it's called.
- **Learned** — I worked something out.
- **To do** — something to come back and do. Never scheduled for review.

### Review

Entries resurface after 7, then 30, then 90 days, asking only whether they still
surprise you. Three confirmations and an entry retires itself. Answering "still
unclear" resets the schedule and costs nothing — an entry that keeps returning
is information about where your model of the codebase is actually weak, which is
the point.

No streaks, no scores, no daily target.

## Storage

```
.lens/journal/          markdown, one file per entry — commit this
.lens/cache/            SQLite for the machine-generated planes (P2) — gitignore this
```

Journal entries are plain markdown with YAML frontmatter. They diff, they merge,
they review in a pull request, and they are readable on a machine that has never
installed this extension. Reasoning in `docs/adr/0001-journal-storage.md`.

## Anchoring, and where it breaks

An entry is keyed on the qualified symbol name, its kind, and a normalised
signature. It survives reformatting, the function moving down the file, and the
file itself being moved.

It does **not** survive renaming the symbol. When that happens the entry is
reported as orphaned rather than quietly pointing at a stale line. Positions the
language server can't name — macro bodies, `#ifdef` blocks — fall back to a
weaker content fingerprint, and you're told so at the moment you write the note.

P2 replaces this with real clangd USRs. Every entry stores enough to migrate
without being rewritten. Reasoning in `docs/adr/0002-anchoring.md`.

## Not in P0

No parsing, no diagrams, no cost analysis, no call graphs. Those are P1 onward.
The one thing P0 deliberately includes from later phases is `detail` capture on
every entry, so that nothing written now has to be redone.

## Development

```bash
npm install
npm run typecheck
npm test        # 51 unit tests, no VS Code required
npm run build
npm run package # requires @vscode/vsce
```

`src/core/` carries no `vscode` import, which is what makes it testable with
plain node and reusable from a headless CLI later. Keep it that way.

---

# P1 — Structure lens

`Lens: Show Structure Diagram` runs clang-uml over a scope you choose (the
current folder by default), renders the class hierarchy, and — the part that
matters — names what is unfamiliar about each class.

Every finding comes in two halves: what the compiler emits, and what you would
have written in C for the same machine behaviour. One click turns any finding
into a draft journal entry, which you edit before keeping.

## What it detects

Traps, where a correct C instinct gives a wrong answer in C++:

- polymorphic class with a non-virtual destructor — including the harder case where no destructor is declared at all
- virtual inheritance (VTT, runtime base offsets)
- coroutines (heap-allocated frame unless elided)

Unfamiliar but ordinary:

- virtual dispatch, abstract interfaces, multiple inheritance
- deleted and defaulted special members, move assignment, operator overloads
- class templates, static data members and their pre-main construction
- private and protected inheritance

Already familiar from C, and marked as such so you don't waste attention on them:

- unions, plain structs with no bases and no methods

## Requirements

clang-uml on PATH (or `lens.clangUml.path`) and a `compile_commands.json` in the
workspace, `build/`, or `out/` (or `lens.compilationDatabase`). Both missing
cases produce a specific, actionable message rather than an error.

The journal works without any of this. Structure is enrichment, not a
prerequisite.

## Configuration

| Setting | Purpose |
|---|---|
| `lens.clangUml.path` | clang-uml binary |
| `lens.clangUml.timeoutSeconds` | give up after this long |
| `lens.compilationDatabase` | directory holding compile_commands.json |
| `lens.structure.namespaces` | restrict diagrams to these namespaces |
| `lens.structure.excludeNamespaces` | exclude vendor SDK namespaces |

---

# P2 — Flow lens

`Lens: Show Call Flow` builds the call tree from the function at the cursor and,
crucially, expands virtual calls into the honest set of targets the class
hierarchy admits.

## Reading the diagram

| Line | Means |
|---|---|
| solid | goes exactly here — direct call, or the only possible target |
| dashed | one of a known set — virtual call, all candidates enumerated |
| dotted, marked `?` | Lens could not follow this — read the code |

The dotted edges are not an apology. On a codebase dispatching through function
pointers and type-erased callables, knowing exactly where analysis stops tells
you which parts of the program you must read rather than trust a diagram about.

Press Enter on any function to see its candidate list with the evidence for each
one: why Lens believes that type is ever instantiated, or that it has not seen
one being made.

## What it flags

- indirect dispatch reachable from an interrupt handler — vtable load, flash read, no inlining, in interrupt context
- direct and mutual recursion — stack depth static analysis cannot bound
- call chains deeper than `lens.flow.depthWarning`, with the path spelled out
- single call sites with three or more possible targets
- every call it could not follow, counted and located

Interrupt handlers are detected by CMSIS core names (certain) and by
`*_IRQHandler`-style conventions (likely, and labelled as such). Add project
conventions with `lens.flow.isrPatterns`.

## Virtual expansion needs the Structure lens

Run `Lens: Show Structure Diagram` once. It caches the class hierarchy to
`.lens/cache/`, and the Flow lens reuses it. Without it the call tree still
builds, and the panel says plainly that virtual calls are not being expanded
rather than quietly showing a shallower truth.

| Setting | Purpose |
|---|---|
| `lens.flow.maxDepth` | call levels to follow |
| `lens.flow.maxNodes` | stop expanding at this many functions |
| `lens.flow.depthWarning` | warn beyond this many frames |
| `lens.flow.isrPatterns` | extra interrupt-handler patterns |

---

# P3 — Rosetta lens

`Lens: Explain This Function` (`Ctrl+Alt+E`) parses the function at the cursor
and annotates every line that does something it does not look like it is doing.

This is the teaching core. P1 tells you what is unfamiliar about a class; this
tells you what is invisible in a statement — a destructor that runs at a closing
brace, a temporary built and torn down inside one expression, a guard variable
behind a `static`, an index operator that is a function call.

Annotations appear at the end of the line, marked `!` for worth care, `~` for
unfamiliar, `=` for already familiar from C. Hover for the full explanation:
what the compiler emits, and what you would have written in C for the same
machine behaviour.

## What it finds

Worth care:

- statements where a temporary's destructor runs at the semicolon, and what dangles if you kept a reference
- function-local statics, their guard variable, and the `_ZZ…E` mangled name that locates it in the ELF
- lambdas capturing by reference, named, with the lifetime consequence
- `throw`, and the unwind tables enabling exceptions at all costs you
- `dynamic_cast` and `typeid`, and what they drag out of libsupc++
- heap allocation, naming the allocator actually selected
- coroutine suspension points and the frame allocation behind them
- implicit conversions — where unintended copies hide

Unfamiliar but ordinary: object construction and RAII scope, materialised
temporaries, operator calls, `delete`, try blocks, virtual call sites.

Already familiar from C, and marked so you don't spend attention on them:
range-based for, structured bindings.

## Requirements

A clang binary at `lens.clang.path` and a `compile_commands.json`. The clang need
not be your build compiler, but it must understand your build flags — which are
taken from the compilation database, not synthesised, so a cross build is
analysed for its real target rather than the host.

Run the Structure lens once first. Without it, virtual call sites cannot be
identified and destructor claims are hedged; the panel says so rather than
quietly showing less.

| Setting | Purpose |
|---|---|
| `lens.clang.path` | clang or clang++ binary for AST analysis |
| `lens.clang.timeoutSeconds` | give up after this long |
| `lens.compilationDatabase` | path to the database **file** or its directory |

### Mixed C and C++ projects

The driver language is taken from each compilation database entry — `-x` first,
then `-std=`, then the file extension — and forced with `--driver-mode`. One
configured binary therefore serves both languages, and a `.c` file compiled with
`-std=c11` works even though `lens.clang.path` points at `clang++`.

A translation unit that compiles as C is not a failure case. Rosetta will say so
and find nothing, which is the correct answer.

### If your database is not called `compile_commands.json`

Point `lens.compilationDatabase` at the file itself — it takes a `.json` path as
well as a directory. clang-uml requires the standard filename, so the Structure
lens stages a copy under `.lens/cache/`; nothing is written outside `.lens/`.

### If clang-uml fails with "not a git repository"

Some clang-uml versions query git at startup and treat its failure as fatal.
Lens works around it by running from a scratch repository inside `.lens/cache`
— created with one empty commit, because `git init` alone leaves `HEAD`
unresolvable and produces a different fatal error. Disable with
`lens.clangUml.gitWorkaround`. The real fix is to upgrade: 0.6.3 does not require
a repository at all.

If it still fails, delete `.lens/cache/gitscratch` and retry; git must be on PATH.

### If every SDK type is "unknown type name"

Your compilation database is missing the vendor device macro. CMSIS headers open
with a guard listing the supported parts and an `#error` telling you to pick one;
without it nothing is declared and every type below fails. Run **Lens: Select
Target Device Macro** — it reads the valid macros out of your own device header
and saves your choice — or set it by hand:

```json
"lens.extraCompileFlags": ["-DSTM32G474xx", "-DUSE_HAL_DRIVER"]
```

These flags are added to every command Lens builds. Note that clangd reads the
same database, so IntelliSense is probably broken for the same reason — the real
fix belongs in whatever generates `compile_commands.json`.

### If a standard library header is "file not found"

`<limits>`, `<vector>` and friends belong to the standard library that shipped
with your cross compiler, not to clang, and a compilation database does not
record where they live. Lens asks the compiler named in the database — with
`-E -Wp,-v` — and passes its search paths on. If this still fails, that compiler
could not be run under the exact name the database records; put it on PATH, or
add its include directories to `lens.extraCompileFlags` as `-isystem` entries.

Note the distinction: `limits.h` is a clang builtin and points at
`lens.clang.path`; `limits` is the standard library and points at the toolchain.

### Lens repairs the database it hands to clang-uml

clang-uml reads your compilation database directly, so Lens rewrites a corrected
copy into `.lens/cache` rather than copying it. Two repairs are applied: comment
lines that some generators carry over from `compile_flags.txt` are dropped (a
compiler reports those as missing input files), and clang's resource directory is
added with `-isystem` so builtin headers like `stdbool.h` resolve. Your own
database is never modified.

### Diagram scope comes from the database, not from globs

The Structure lens asks which folder to cover and then selects those translation
units from your compilation database by path. If nothing matches it says how many
entries it looked at and shows one of their paths — which is usually enough to
spot a database generated under a different root or drive letter.

### Headers, and why the Flow lens may say it sees no symbols

VS Code assigns `.h` to **C** by default. C++ in a file being parsed as C yields
no symbols at all, and every LSP-backed lens goes quiet. If your C++ lives in
`.h` files:

```json
"files.associations": { "*.h": "cpp" }
```

A header also needs to be included by some `.cpp` in your compilation database —
clangd infers a header's flags from a translation unit that uses it, and has
nothing to work from otherwise.

Call hierarchy is a clangd feature. The Microsoft C/C++ extension does not
implement it, so the Flow lens needs clangd.

Inline annotations clear themselves as soon as you edit the file, because the
line numbers they are pinned to have moved.

---

# P4 — Layout lens

`Lens: Show Object Layouts` draws every class in the current translation unit as
a byte map, with hidden storage in the same space as the members you declared.

The point is that `sizeof` in C++ is not the sum of what you can see. A vptr
appears where nothing in the declaration mentions one; a second appears under
multiple inheritance; virtual bases move at runtime. All of it is invisible in
the source and all of it is in the byte map.

## Reading the map

| Cell | Means |
|---|---|
| solid, labelled | a member you declared |
| highlighted | hidden vtable pointer — nothing in the source mentions it |
| shaded | padding inserted for alignment |
| dashed edge | extent inferred, not measured |

## What it flags

- hidden vptrs, counted and located, with the per-object cost
- virtual bases, and the fact that the offset to them is not a compile-time constant
- tail padding, escalated to a trap past a quarter of the object
- internal holes between members, where they could be computed
- empty base optimisation — one of the few cases where the C++ form is strictly smaller than the C one
- **predicted and built layouts disagreeing**, which means your compilation database and your build used different flags

## Two sources, and why clang leads

clang `-fdump-record-layouts` predicts the layout for the target your build flags
describe, taken from `compile_commands.json` rather than synthesised. It sees
every type.

pahole reads the DWARF your compiler actually emitted, and supplies per-member
sizes and internal holes. It cannot read polymorphic classes — v1.25 reports
"type not found" for anything with a vptr, even though the types are in the
DWARF. So it is optional enrichment, not the primary source, and any type it
could not see says so rather than implying it has no internal padding.

| Setting | Purpose |
|---|---|
| `lens.pahole.objectFile` | a `.o` or `.elf` built with `-g` to cross-check against |
| `lens.dwarfdump.path` | llvm-dwarfdump binary (default provider) |
| `lens.observedLayout.provider` | `auto`, `dwarfdump`, `pahole` or `none` |
| `lens.pahole.path` | pahole binary, if you select that provider |

Without the object file you get predicted layouts only — still exact for offsets,
`sizeof` and tail padding.

### On Windows, use llvm-dwarfdump (the default)

pahole is Linux-only. `llvm-dwarfdump` is the portable replacement and is what
`auto` selects: it ships with the LLVM you already installed for
`lens.clang.path`, and it reads polymorphic classes, which pahole refuses. If a
type comes back as unreadable, build with `-fstandalone-debug` (clang) or
`-fno-eliminate-unused-debug-types` (gcc) — the default `-g` can emit a type used
only through a pointer as a declaration with no members.

---

# P5 — Cost lens

`Lens: Show Image Cost` reads your linked ELF and attributes its bytes back to
the language features that caused them.

The join is the Itanium mangled name. `_ZTVN2fw4ISpiE` is not an opaque 40-byte
blob in `.rodata` — it is the vtable for `fw::ISpi`, which exists because
somebody wrote `virtual`. Turning the first statement into the second is the
whole lens.

## What it separates

- **Virtual dispatch** — vtables and this-adjusting thunks
- **Virtual inheritance** — VTTs and construction vtables, which are pure overhead if the diamond is avoidable
- **RTTI** — typeinfo records and the type-name strings they compare
- **Exceptions** — unwind tables and the runtime that walks them, paid whether or not anything throws
- **Static initialisation** — guard variables, `.init_array`, `__cxa_atexit`
- **Templates** — one copy per instantiation, the classic bloat source
- **Your C++ code**, **C code and startup**, **runtime support**, **dynamic linking**

Plus a per-class rollup: what one class costs across every artifact it caused.

## The ledger reconciles

Group totals are checked against the ELF's own allocated section sizes, and any
shortfall is reported rather than smoothed away. If coverage drops below 90% the
panel says so and tells you every figure is a lower bound — usually fixed by
building with `-ffunction-sections -fdata-sections`.

This matters more than it sounds. On the first run against the test fixture the
check reported 22% coverage, which turned out to be PIE dynamic-linking machinery
the ledger had no category for. Without reconciliation it would have shown seven
confident categories and silently omitted four fifths of the image.

## Requirements

None beyond the ELF. The reader is native — no nm, no readelf, no binutils.

| Setting | Purpose |
|---|---|
| `lens.cost.elfFile` | path to the linked image; empty searches for `*.elf`, `*.axf`, `*.out` |

Point it at the **unstripped** image, before any strip step. A stripped image
falls back to `.dynsym`, which holds only exported symbols, and the panel says so.
