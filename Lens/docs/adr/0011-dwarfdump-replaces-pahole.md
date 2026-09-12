# ADR 0011 — llvm-dwarfdump becomes the default observed-layout source

Status: accepted (1.0.3) · supersedes part of ADR 0006

## Context

ADR 0006 made clang the primary layout source because pahole cannot read
polymorphic classes, and kept pahole as optional enrichment for member sizes and
internal holes. A user on Windows then asked the obvious follow-up: pahole is
Linux-only, so is there an alternative?

There is, and it is better on both counts.

## Decision

`llvm-dwarfdump --debug-info` becomes the default observed-layout provider.

**It runs on Windows**, and ships with the same LLVM already required for
`lens.clang.path`, so it costs no new installation.

**It reads polymorphic classes.** Verified against real output: `SpiDriver`
comes back with byte_size 24, its base subobject at 0, `channel_` at 8 and
`base_` at 16 — the exact type pahole reports as "not found".

**Sizes and holes are computed here** rather than scraped from another tool's
formatting, because the raw DIE tree carries a type reference per member. That
is strictly more information than pahole's rendered output.

The output is normalised into the same `ObservedRecord` shape pahole produces,
so the merge, the findings and the byte-map renderer are all untouched. Two
providers, one observed plane. pahole stays selectable via
`lens.observedLayout.provider` for anyone who prefers it.

## Four bugs the real fixture caught

Each produced plausible, confident, wrong numbers, and none would have been
caught by a hand-written fixture.

**Typedef chains.** A member's `DW_AT_type` usually points at a typedef, and a
typedef DIE has no `DW_AT_byte_size`. Reading the size off the immediate
reference returned zero for every member on the fixture — which then reports a
struct with no padding anywhere.

**Pointer members.** A pointer DIE frequently omits its size because the address
size is a property of the compilation unit. Following its `DW_AT_type` instead
sizes the pointer as its pointee: four bytes for a `uint32_t*` on a 64-bit build.
The address size is now read from the CU header.

**Base subobjects.** Excluding them from the arithmetic — they are ancestors, not
members — made every polymorphic class report its own base as an internal hole.
`SpiDriver` claimed 15 bytes of waste against a true figure of 7.

**Empty bases.** An empty base has a DWARF `byte_size` of 1 while occupying
nothing, so it starts at the same offset as the member after it. Read literally
that is an overlap, which suppressed hole detection for the whole record.

## Where it declines to answer

With virtual inheritance the shared base is counted inside more than one
subobject, so extents genuinely overlap and gap arithmetic is meaningless. Rather
than emit a number, hole detection is skipped for those records. The same guard
fires on any unexpected overlap.

Note also that clang's default `-g` emits limited debug info: a type used only
through a pointer may appear as a declaration with no members. That is reported
as unreadable rather than as an empty struct, since claiming a type has no
members also claims it has no padding. `-fstandalone-debug` makes every type
complete; GCC-built firmware usually already is.
