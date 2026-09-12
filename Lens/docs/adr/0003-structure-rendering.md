# ADR 0003 — Static SVG for the Structure lens, Cytoscape deferred to P2

Status: accepted (P1)

## Context

The design says to reuse the Cytoscape renderer from Call Graph Visualizer as
the shared graph surface for every lens. That is right eventually. It is wrong
for P1, for a reason specific to what P1 draws.

Class diagrams for a firmware module are tens of nodes. Call graphs are
thousands. Those are different rendering problems: the first is a small layered
DAG where a deterministic layout is both adequate and *verifiable*; the second
needs incremental layout, viewport culling and interactive expansion, which is
what a graph library is for.

The verifiability matters more than it sounds. A rendering bug in a
comprehension tool does not produce an ugly picture — it produces a picture that
teaches you something false about the code. Unit-testable layout is therefore
worth more here than in a normal visualisation.

## Decision

P1 renders SVG built in the extension host, with a longest-path layering pass
and two barycentre sweeps for crossing reduction. No dependency, deterministic
output, and layout properties are asserted in tests: every base outranks every
class deriving from it, no two boxes on a rank overlap, the same model produces
the same coordinates.

Edges are straight lines between anchor points. Orthogonal routing looks tidier
and piles up badly on shared paths in dense graphs.

Colours are CSS custom properties bound to VS Code theme variables in the
webview, so the renderer knows nothing about themes and stays pure.

## Consequences

Good: no dependency in P1; layout is tested rather than eyeballed; the SVG is
exportable as-is into documentation.

Bad: no pan/zoom beyond browser scroll, no incremental expansion, no drag. All
acceptable for tens of nodes; none acceptable for a call graph.

## When this gets revisited

At P2, when the Flow lens needs to render call graphs. That is the point where
Cytoscape earns its place, and the migration is contained: `renderSvg` is the
only thing that has to change, because `layout` and the normalised model are
already renderer-agnostic. The known Cytoscape traps from the existing extension
carry over — `cy.batch()` with synchronous layout calls to avoid the
`requestAnimationFrame` click-unresponsiveness, and explicit `nodeWidth`/
`nodeHeight` fields because `width: 'label'` auto-sizing is broken.
