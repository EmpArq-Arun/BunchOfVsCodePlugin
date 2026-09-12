# ADR 0010 — Snap to the symbol, and never report two failures as one

Status: accepted (1.0.2) · found by a real project

## What happened

A user put the cursor inside an inline virtual method in `MyClass.h` and the
Flow lens said:

> The language server did not recognise a function at the cursor. Put the cursor
> on a function name and try again.

Both halves were wrong. The advice was wrong because Lens should snap to the
name itself rather than ask the user to. And the diagnosis was wrong because the
real cause on a header is usually that the language server is not parsing the
file at all — VS Code assigns `.h` to C by default, and C++ parsed as C yields
no symbols whatsoever. Moving the cursor would never have helped.

## Decisions

**Snap to the enclosing symbol's name.** The cursor is almost never on the
function name; it is wherever you were reading. Language servers anchor call
hierarchy to the name, so Lens now tries the cursor, then the enclosing symbol's
`selectionRange.start`. Asking a user to reposition their cursor for the tool's
convenience is work the tool should do.

**Separate `no-symbols` from `no-hierarchy`.** They are indistinguishable to a
user and have unrelated fixes:

- *no symbols* — the file is not being parsed. On a header: wrong language
  assignment, or not reachable from any translation unit in the database. The
  message now names `files.associations` and explains why an unincluded header
  has no flags to infer from.
- *no hierarchy* — parsed fine, nothing to offer. Call hierarchy is a clangd
  feature; cpptools does not implement it. The message says so.

**Stage a renamed database into `.lens/cache/`.** clang-uml requires the exact
filename `compile_commands.json`. ADR 0009 declined to copy the file on the
grounds that materialising files behind the user's back is rude. That instinct
was right and the boundary was wrong: writing into a directory Lens already
creates and owns is not the same as writing into someone's build tree. Staging
is safe because every database entry carries its own absolute `directory`, so
relocating the file changes nothing about how any command resolves.

## The pattern, again

Both defects were the same mistake in different places: collapsing two causes
into one message and pointing the user at the wrong one. A tool whose whole
premise is that confident wrongness is the enemy should not be confidently wrong
about its own failures.
