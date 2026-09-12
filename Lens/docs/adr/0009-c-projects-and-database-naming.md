# ADR 0009 — Driver mode comes from the database, and the database may be named anything

Status: accepted (1.0.1) · found by a real project

## What happened

A user pointed Lens at a real STM32G4 firmware project: 50 translation units,
all C, `arm-none-eabi-gcc --target=arm-none-eabi -std=c11 -mcpu=cortex-m4`, with
the database saved as `compile_commands_fixed.json`. Nothing worked, and nothing
said why clearly.

Three defects, in order of severity.

**Driver mode was hardcoded by configuration, not derived from the entry.**
`lens.clang.path` defaults to `clang++`, and `clang++` given `-std=c11` does not
degrade — it refuses:

    error: invalid argument '-std=c11' not allowed with 'C++'

That is fatal for every AST-based lens on any C project. The assumption baked in
was that a C++ comprehension tool is only ever pointed at C++, which is exactly
backwards: the users this tool is for work in mixed codebases and spend most of
their time in the C half.

**The database filename was hardcoded.** `lens.compilationDatabase` was
documented and implemented as a *directory*, with `compile_commands.json`
appended. A differently named file could not be reached at all, and the failure
presented as "no compilation database found" in a workspace that plainly had one.

**The failure message did not name the cause.** `clang exited with 1` with the
driver error buried in stderr.

## Decisions

**Derive the language from the entry, and force it with `--driver-mode`.**
`-x` wins, then `-std=`, then the file extension — the order the compiler itself
resolves them in. `--driver-mode=gcc` or `=g++` is then prepended, so one
configured binary serves both languages and the user does not maintain two paths.
Verified end to end against the real flags: the generated command line produces a
correct AST for a Cortex-M4 C file.

**`lens.compilationDatabase` accepts a file path or a directory.** A value ending
in `.json` is the file; anything else is a directory to look inside. Absolute
Windows paths are detected rather than joined to the workspace root.

**The clang failure message recognises the driver error** and says the language
was likely wrong, rather than leaving the user to read compiler stderr.

## One thing deliberately not fixed

clang-uml takes `compilation_database_dir` and requires the standard filename, so
the Structure lens alone still cannot use a renamed database. Rather than copy
the file behind the user's back, the failure now says so and suggests a symlink.
Silently materialising files in someone's build directory is a worse trade than
one clear sentence.

## Note

A pure C project is a legitimate and common answer, not a degraded one. Rosetta
and Layout now say plainly that a translation unit compiled as C has nothing for
them to translate, instead of presenting an empty result that reads like
breakage.

The real database is now a test fixture, so this class of regression is caught
rather than rediscovered.
