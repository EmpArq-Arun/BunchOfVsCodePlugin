# ADR 0004 — Virtual calls are expanded, never resolved

Status: accepted (P2)

## Context

The LSP call hierarchy resolves `port->transfer()` to the declaration it can see
statically — `ISpi::transfer` — and stops. That is correct behaviour for a
language server and a dead end for a reader, because the declaration is a vtable
slot rather than a destination.

There are three things a tool can do at that point, and two of them are wrong.

**Guess.** Pick the most likely override and draw one clean edge. Produces a
readable diagram and teaches a false model of the program. This is the specific
failure the whole lens exists to prevent: a C engineer's dangerous failure mode
in C++ is confident wrongness, and a tool that manufactures confidence makes it
worse rather than better.

**Stop.** Leave the edge at the declaration. Honest, and useless — it is exactly
the wall the reader already hit unaided.

**Enumerate.** Show every override the hierarchy admits, ranked by evidence,
labelled as a set rather than a target.

## Decision

Enumerate, and make the difference visible without interaction.

Every edge carries a `Resolution` — `exact`, `devirtualised`, `cha`, `rta`,
`fn_ptr`, `observed`, `unresolved` — which collapses to a three-way `Certainty`
that drives rendering. Solid lines go exactly where they appear to. Dashed lines
are one of a known set. Dotted lines ending in a rendered `?` are calls Lens
could not follow at all.

Three consequences worth stating explicitly, because each is a place where the
easy implementation is the wrong one:

**The edge into the vtable slot is kept, not replaced.** The call really does go
through that slot, and deleting it to draw straight to the overrides would hide
the fact that dispatch happens here at all — which is the single most important
thing for a C reader to see.

**RTA ranks; it does not prune.** A candidate with no visible instantiation is
kept and labelled "may be created elsewhere", because the object may come from a
factory, a vendor SDK, or a translation unit outside the diagram. Dropping it
would be guessing with extra steps.

**A single candidate is reported as `devirtualised` with the caveat attached.**
"Exactly one target today" is genuinely useful and genuinely fragile: the
compiler may fold it under whole-program assumptions, separate compilation will
not, and a second implementer silently changes the cost of every call site.
Saying only the first half would be the confident-wrongness failure in miniature.

## Consequences

Diagrams are busier than a guessing tool's would be, and that is the point — the
busyness is real branching in the program. Where the graph is quiet, the program
is quiet.

`unresolved` becoming a rendered state also turns a limitation into a feature:
the dotted edges mark precisely the parts of the codebase that must be read
rather than trusted, which is information a reader cannot otherwise get.

## Note on the renderer

ADR 0003 deferred Cytoscape to "when the Flow lens needs call graphs". It turns
out not to, because the Flow lens shows a *rooted, depth-bounded* subgraph —
tens of nodes, same scale as a class diagram — rather than a whole-program graph.
Static SVG and testable layout therefore carry forward unchanged. Cytoscape is
deferred again, to the first view that genuinely needs whole-graph interaction.
Revisiting a decision because its premise turned out false is cheaper than
honouring a plan that no longer applies.
