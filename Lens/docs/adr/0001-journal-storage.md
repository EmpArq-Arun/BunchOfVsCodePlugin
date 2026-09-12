# ADR 0001 — Journal entries are markdown files, not rows in `index.db`

Status: accepted (P0)

## Context

The design put every plane, annotations included, in a single SQLite database at
`.lens/index.db`. Implementing P0 made the annotation plane's requirements
concrete, and they turn out to be the opposite of every other plane's.

| | Annotations | Symbols, relations, layouts, costs, traces |
|---|---|---|
| Author | Human | Machine |
| Volume | Hundreds | Hundreds of thousands |
| Rebuildable | No — losing one is losing thought | Yes, from source and ELF |
| Wants to be in git | Yes | Emphatically not |
| Merged between engineers | Yes | Never |
| Edited by hand | Occasionally, and usefully | Never |

The requirement that decides it is git. The journal is meant to become team
onboarding documentation — the notes a newcomer writes are what the next
newcomer needs. That only works if entries diff, merge and review like text.
A SQLite file in version control produces binary conflicts that resolve to
"pick one side and lose the other", which for hand-written notes is data loss.

A second, smaller consideration: shipping SQLite in a VS Code extension means
either a native module with per-platform, per-Electron-ABI prebuilds, or a WASM
build carrying the whole database in memory. Both are real costs to pay in P0
for a few hundred rows.

## Decision

Split the storage by authorship.

- `.lens/journal/*.md` — one markdown file per entry, YAML frontmatter for
  metadata, body as prose. **Committed.** Source of truth.
- `.lens/cache/index.db` — SQLite for the machine-generated planes, arriving
  in P2. **Gitignored.** Rebuildable at any time.

The in-memory `Journal` map is a derived index rebuilt on load and on any
external change to the folder, which is watched because branch switches and
merges write to it behind the editor's back.

## Consequences

Good: entries are reviewable in a pull request; conflicts resolve as text;
an entry is readable and editable with no tooling at all, including on a
machine that has never installed Lens; export is nearly free; P0 ships with
zero runtime dependencies.

Bad: no queries across entries beyond a linear scan. Acceptable — the journal
is bounded by human writing speed and will not reach a size where this matters.
If it ever does, the fix is a derived cache in `index.db`, which does not
disturb the source of truth.

Also bad: two storage mechanisms rather than one. Accepted deliberately. They
have different owners and different lifetimes, and pretending otherwise is what
produced the original single-database design.

## Note on the schema

The `annotations` table in the design document survives as the frontmatter
field set, unchanged in meaning. If a derived cache is later wanted, the
markdown parses into exactly that table with no migration.
