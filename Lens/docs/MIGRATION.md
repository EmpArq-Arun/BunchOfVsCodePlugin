# Migrating from the existing tools

## What to do with each

**CppNav** — stop. Its index and CHA/RTA resolver live in Lens as `core/flow.ts`,
and clangd handles call hierarchy better than a hand-rolled index will.

**Call Graph Visualizer** — freeze at its current published version. It still
works; it simply will not gain features. The Flow lens supersedes it and adds
honest virtual-call expansion, which the standalone extension never had.

**Complexity Cosmos** — retire. `Lens: Show Complexity` covers it, counts
short-circuit operators and explicit throws that a token-based counter misses,
and needs no Python.

**Codex Intelligence** — retire the analysis half. `Lens: Write Module Primer`
generates the same kind of document with a stricter rule: every claim traces to
something a lens measured in this codebase, and the manifest names what did not
run. The multi-agent orchestration work does not carry over and was always a
distraction from ramping up.

**LMV** — keep it. It does map files, linker scripts and stack analysis, none of
which Lens does. The overlapping part is ELF symbol attribution, which Lens now
does natively; use whichever is in front of you.

**Embedded Clang Config** — keep it, unchanged. It generates the
`compile_commands.json` that four Lens lenses depend on, so it is upstream of
Lens rather than replaced by it.

## Order to adopt

1. **Install Lens and start the journal today.** It needs nothing but working IntelliSense, and the journal is the one component whose value decays if you start it late.
2. **Run the Structure lens once** so the class hierarchy is cached. Flow and Rosetta both sharpen when it exists and say so when it does not.
3. **Add the ELF and trace paths when you have them.** Neither blocks anything.

## What you lose

Nothing that was load-bearing. The one real gap is LMV's map-file and
linker-script analysis, which is why LMV stays.
