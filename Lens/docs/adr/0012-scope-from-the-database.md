# ADR 0012 — Select translation units from the database, and name all four symbol outcomes

Status: accepted (1.0.4) · found by a real project

## Two failures, one shape

Both were the same mistake made again: a message that states a conclusion about
the project when the truth was about timing or about path semantics.

### clang-uml: "reported success but wrote no JSON"

Lens generated glob patterns like `Application/*.cpp` relative to the workspace
root. clang-uml resolves relative globs against **its config file's own
directory**, and Lens writes that config into `.lens/cache`. So the pattern
became `.lens/cache/Application/*.cpp`, matched nothing, and clang-uml exited
zero having produced no output. The error message then blamed the glob, which was
right in substance and useless in practice.

**Decision: stop writing patterns.** The scope is now a directory, and the
translation units are selected from the compilation database by prefix match —
absolute paths, case- and separator-insensitive, straight into the config. No
pattern semantics are involved at any point.

The second benefit matters more than the first: Lens now knows *before* running
clang-uml whether anything matched, so a miss reports how many entries were
examined and shows a sample path. If the database was generated on a different
machine or a different drive letter — an easy state to reach with a hand-edited
database — the sample makes it obvious instantly.

`relative_to` is also emitted, anchoring any remaining relative path to the
workspace rather than to wherever the generated config lives.

### "The language server returned no symbols"

A single request loses to two different races. The language server may not have
registered its provider yet, in which case `executeDocumentSymbolProvider`
resolves to `undefined` immediately; or it may be mid-parse and answer with an
empty array. Neither means the file is unparseable, and both were reported as
"it is not parsing this file" — a conclusion about the project drawn from a fact
about timing.

**Decision: poll, and distinguish four outcomes.**

- `ok` — symbols arrived.
- `timeout` — nothing answered within the window. Normal on a first parse.
- `no-provider` — the command kept resolving to `undefined`, so no extension has
  registered for this language. Points at clangd or cpptools not being installed,
  enabled, or finished activating.
- `empty` — a provider answered and the file genuinely has no symbols.

The request now retries every 400ms until the timeout, which absorbs both races,
and each outcome gets its own message naming its own fix.

## The recurring lesson

This is the fourth diagnosis in this project that was wrong the same way, after
ADRs 0009 and 0010. A tool built on the premise that confident wrongness is the
enemy keeps being confidently wrong about its own failures, and the fix is always
the same: find the two causes hiding behind one message and separate them.

Worth treating as a review rule rather than a series of accidents — when writing
an error message, ask what else could produce this state, and whether the user
could tell the difference from what is being said.
