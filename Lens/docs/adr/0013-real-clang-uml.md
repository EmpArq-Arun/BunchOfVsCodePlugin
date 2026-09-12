# ADR 0013 — Running the real clang-uml, and the false positive it found

Status: accepted (1.0.5) · found by a real project

## Context

A user's Structure lens failed with `clang-uml exited with 1. fatal: not a git
repository`. Every earlier clang-uml behaviour in this project had been inferred
from documentation, so this time clang-uml itself was installed and the failure
reproduced.

Three things came out of that, and the third matters most.

## The git failure

Some clang-uml versions query git at startup to populate the `git` Jinja context
and treat its failure as fatal. Verified: **0.6.3 does not** — it runs happily in
a directory with no repository anywhere above it. So this is version-specific,
and upgrading is the real fix.

For versions that do need it, Lens now initialises a scratch repository under
`.lens/cache` and runs clang-uml from there. Verified against 0.6.3 that
this changes nothing about the output: every path Lens writes into the config is
absolute and `relative_to` is set, so the working directory does not participate
in path resolution. Nothing is written outside `.lens/`, and the project is never
touched. Disable with `lens.clangUml.gitWorkaround`.

### The workaround needed a second attempt

The first version ran `git init` and stopped, which produced a *different* fatal
git error: `ambiguous argument 'HEAD': unknown revision`. A freshly initialised
repository has no commits, so `HEAD` points at an unborn branch and any version
that resolves it fails. One fatal git error had been traded for another.

The scratch repository now gets an empty commit, and identity and signing are
passed on the command line rather than read from configuration:

    git -c user.email=... -c user.name=... -c commit.gpgsign=false commit --allow-empty

Both flags are load-bearing, and that was verified rather than assumed: with no
global git config — the state of any fresh machine — the commit fails outright
with "Author identity unknown", and `commit.gpgsign=true` with no key available
fails the same way. Neither has anything to do with C++, and both would have
surfaced as another opaque clang-uml error.

Reuse is keyed on `git rev-parse --verify HEAD` succeeding, not on the directory
existing, so a half-created repository from an interrupted run is finished rather
than trusted.

If git is absent entirely there is nothing to work around with, and the message
now says so and names the remedies.

### Why this is now tested

Twice wrong in two attempts, both times because the environment differed from the
one imagined. The logic is exported and covered against real git: HEAD resolves,
the repository is reused rather than reinitialised, nothing is written outside
`.lens/`, and an existing project repository is used in place.

## Path semantics, confirmed

The documentation states outright that `glob`, `output_directory`,
`compilation_database_dir` and the `paths` filter are all relative to the config
file's parent directory unless `relative_to` is set. That is exactly the ADR 0012
bug, now confirmed rather than deduced.

## The false positive

This is the important one. Real clang-uml output run through the detectors
produced **five** `implicit_non_virtual_destructor` findings on a source file
that has no destructor bug at all.

The cause: a derived class's destructor is implicitly virtual whenever a base's
is. `SpiDriver` declares no destructor, but inherits `ISpi`'s virtual one, so it
is perfectly well-formed. The detector checked only the class in front of it.

That is a false positive on the most alarming detector Lens has — one whose
finding text says the standard calls this undefined behaviour and that it leaks
silently. Firing it on correct code is worse than not having it: it would teach a
C engineer to distrust a hierarchy that is fine, and the noise would bury the one
real case when it appeared.

Fixed by walking the base chain. A base outside the diagram is assumed to have a
virtual destructor, because a missed warning costs far less than a confident
wrong one. After the fix the same file produces zero destructor findings, and a
constructed genuinely-broken hierarchy still produces one.

The real output is now a fixture, so this cannot regress.

## The lesson, stated plainly

Every detector in this project written against documentation rather than real
output has had a bug. The lambda captures, the thunk prefix, the `_ZZ` encoding,
the typedef chain, the pointer size, the base subobjects — and now this one,
which is the first that produced a *confidently wrong warning* rather than a
missing or malformed value. A tool for teaching people what code really does
cannot afford detectors validated against a reading of a spec.
