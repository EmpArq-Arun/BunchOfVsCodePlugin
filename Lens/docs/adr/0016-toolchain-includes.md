# ADR 0016 — Ask the cross compiler where its own headers are

Status: accepted (1.0.9) · found by a real project

## Context

A different repository, past every earlier obstacle, failed on:

    modbus_callbacks.cpp:10: 'limits' file not found

And Lens's own advice was wrong: it said a missing builtin header means clang-uml
could not find its resource directory. `<limits>` is not a builtin. `stdbool.h`,
`stdint.h` and `stddef.h` ship inside clang's resource directory; `<limits>`,
`<vector>` and `<cstdint>` belong to the standard library that came with the
cross compiler. One character separates `limits.h` from `limits`, and they have
entirely different fixes.

A compilation database written for `arm-none-eabi-g++` records the project's own
`-I` flags and nothing else. The toolchain's headers are found by the GCC driver
from paths compiled into it, so they appear nowhere in the database and clang
cannot guess them.

## Decision

**Ask the compiler named in the database.** `-x <lang> -E -Wp,-v -` makes any
GCC-derived driver print its search list, which is stable across versions and
vendors. Lens parses the angle-bracket block and passes those directories to
clang as `-isystem`, in the staged database and on the AST and layout commands.

Results are cached per compiler and language — a probe costs a subprocess, and
the C and C++ answers differ precisely in the libstdc++ paths that matter here.
Quoted-form directories are excluded: those are the project's own and the
database already has them. Harvested paths go after the compiler and before the
project's flags, so a project can still override them.

Failure is silent and yields nothing. On a machine without the cross compiler
installed the analysis still runs and fails later with a specific message, rather
than refusing up front.

**Classify the missing header.** Three causes, three messages: a builtin points
at `lens.clang.path`; a standard library header points at the cross compiler not
being runnable under the name the database records; anything else is a project
include path.

## The bug the tests could not have caught

The probe compiles from `-`, meaning stdin. Node's `spawn` leaves stdin open by
default, so the driver waited for input until the timeout killed it — a hang, not
an error, and invisible to every test because the tests mock the subprocess. It
surfaced only on an end-to-end run against real tooling, which then also hit the
harness timeout.

`child.stdin.end()` now follows every spawn in the extension. Harmless for the
other tools, essential for this one.

Worth stating plainly: a unit test that mocks the process boundary cannot test
the process boundary. The end-to-end run against real clang-uml was not a
formality here — it was the only thing that could have found this.

## Verification

Reproduced with a C++ translation unit including `<limits>`, compiled with
`-nostdinc++` to simulate a cross toolchain. Before: `'limits' file not found`.
After: seven `-isystem` paths harvested from the driver, clean run, diagram
generated.
