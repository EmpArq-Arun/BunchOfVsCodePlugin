# ADR 0006 — clang predicts, pahole verifies, and pahole cannot see the interesting types

Status: accepted (P4) · reverses a design assumption

## Context

The design said to prefer pahole over clang's record layout dump for the shipped
build, on the reasoning that pahole reads the DWARF your real cross-compiler
emitted and is therefore target-correct by construction, with no sysroot guessing.

That reasoning is sound. The conclusion is wrong, and only testing it showed why.

## What testing found

pahole v1.25 reports `type 'X' not found` for **every polymorphic class**.
Confirmed against real output on this fixture: `PinConfig`, `StatusReg`,
`Tagged`, `RegisterView`, `Wasteful` and `Tight` all parse correctly, including
bitfields, bit holes, inherited subobjects and unions. `SpiDriver`, `DuplexPort`
and `Diamond` — the ones with a vptr — do not.

The types are present in the debug info: `readelf --debug-dump=info` finds five
references to `SpiDriver`. pahole simply will not parse them. Forcing the DWARF
backend with `-F dwarf` does not help; nor does namespace qualification.

So the tool that was going to be the primary source is blind to exactly the
classes whose layout surprises a C engineer. A struct's padding is the one thing
a C mental model already predicts correctly. The vptr is not.

## Decision

**clang `-fdump-record-layouts` is primary.** It gives, exactly: every field
offset, vptr positions, base subobject positions with their kind, bitfield bit
ranges, `sizeof`, `dsize`, and therefore tail padding. It works on every type.
Target correctness comes from taking flags out of `compile_commands.json` rather
than synthesising them, which the Rosetta lens already does for the same reason.

**pahole is optional enrichment.** It supplies the one thing clang's dump cannot:
per-member sizes, and therefore internal holes. It is queried per type rather
than dumped wholesale, and its failures are ordinary outcomes the parser reports
rather than errors.

**A type with no observation says so.** `observedGap` carries the reason —
"pahole cannot read polymorphic classes, so internal padding is not computed
here; offsets, sizeof and tail padding are exact." The byte-map draws inferred
extents with a dashed edge. A reader can always tell which numbers are measured
and which are inferred, which is the same principle as `unresolved` edges in the
Flow lens.

**Disagreement is a finding, not a bug to smooth away.** Where both sources see a
type and their offsets or sizes differ, that means the compilation database
records different flags from the build that produced the object. That is worth
knowing far more than a tidy diagram is, so it renders as a trap-severity
finding naming the field.

## Two smaller corrections from real output

`-F dwarf` is passed on every pahole invocation. A pahole built for kernel work
defaults to the BTF backend, which carries no C++ types at all — a silent empty
result rather than an error.

Empty base optimisation is detected from clang's own `(empty)` marker on the base
line, not inferred from a zero offset. Every primary base starts at offset zero,
so the offset heuristic cannot distinguish an empty base from an ordinary one and
was reporting EBO on classes that had none.

## Consequences

The Layout lens works with clang alone, which every other lens already needs.
pahole and an object file are configuration a user can add later for sharper
answers on their non-polymorphic types, and the panel says plainly what it is
missing without them.

If a later pahole gains polymorphic support the merge already handles it: the
observation path is the same, more types simply stop reporting a gap.
