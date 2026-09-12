# ADR 0007 — Read ELF natively, and reconcile the ledger against it

Status: accepted (P5)

## Context

The Cost lens turns linker output back into statements about source: this many
bytes exist because you wrote `virtual`. That requires a symbol table, a
demangler, and a defensible claim that the numbers add up.

## Decisions

**Read ELF directly rather than shelling out to nm or readelf.** Neither is
reliably present on a Windows development machine, and every external tool is one
more install standing between a user and their first answer. The symbol table is
a fixed, well-specified structure; reading it is a couple of hundred lines. Both
classes and both byte orders are handled because the image under analysis is
cross-compiled and the host is not.

One detail worth recording: the field order inside a symbol entry *differs*
between ELF32 and ELF64 — `st_value` and `st_size` precede `st_info` on 32-bit
and follow it on 64-bit. Treating it as a width change produces plausible
nonsense rather than an error.

**Demangle names, not signatures.** Attribution needs the entity name. Parameter
types are where the genuinely hard machinery lives — substitutions, template
argument packs, expression encodings — and none of it is needed to say that
`_ZTVN2fw4ISpiE` is the vtable for `fw::ISpi`. Template arguments collapse to
`<...>` rather than being half-decoded. Where a name cannot be parsed the symbol
reports `partial: true` and falls back to the raw string, instead of guessing a
prettier one.

Two encodings were implemented wrong against a plausible reading of the ABI and
corrected by running against a real binary. A thunk's inner name is a bare
`<encoding>`, not `_Z`-prefixed, so it must be restored before recursing. And
`_ZZ<function encoding>E<name>` wraps a *complete* function encoding including
its parameter types, so walking forward stops at the wrong `E`; the split has to
be made from the right.

**Reconcile, and report the shortfall.** Every defined sized symbol lands in
exactly one bucket, weak and COMDAT duplicates are collapsed by address, and the
group totals are asserted to equal the ELF's own allocated section sizes. An
attribution that does not add up is wrong in a way that is otherwise completely
invisible: it looks like a tidy report.

## What reconciliation caught immediately

The first run against the fixture reported 22% coverage — 5910 bytes in allocated
sections that no symbol claimed. That is not noise. It is the dynamic-linking
machinery of a PIE executable: relocation tables, GOT, PLT, dynamic symbol
tables. A statically linked firmware ELF has almost none of it.

The fix was not to suppress the gap but to name it. `linking` is now its own
category with its own explanation, the shortfall is computed per section rather
than as one lump, and coverage measures what the ledger *explains* rather than
only what symbols claim. Coverage went from 22% to 76% without a single number
changing — only the honesty of the labelling.

That is the argument for building the reconciliation check first. Without it the
ledger would have shown seven confident categories and quietly omitted four
fifths of the image.

## Framing

Findings state what a feature costs and never whether to remove it. Whether
exceptions are worth their bytes is a judgement about the product. Where a
measurement is available the finding points at it — "rebuild with
`-fno-exceptions` and compare" — rather than quoting a rule of thumb, because
the number for this project is the only one that matters.
