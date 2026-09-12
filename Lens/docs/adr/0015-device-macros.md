# ADR 0015 — Name the one missing macro, not the hundred symptoms

Status: accepted (1.0.8) · found by a real project

## Context

With the database repaired and clang-uml parsing, the Structure lens failed with
a wall of diagnostics:

    stm32g4xx.h:137: "Please select first the target STM32G4xx device used in your application"
    Buzzer.h:35: unknown type name 'TIM_HandleTypeDef'
    stm32g4xx_hal_gpio.h:285: unknown type name 'GPIO_TypeDef'; did you mean 'GPIO_InitTypeDef'?
    ... hundreds more

Inspecting the user's database settled it: **fifty entries, zero `-D` flags.**
No `STM32G474xx`, no `USE_HAL_DRIVER`. Every silicon vendor's CMSIS header opens
with a guard listing the supported parts and an `#error` telling you to pick one.
Without the macro that `#error` fires on the first include, no peripheral types
are ever declared, and every subsequent type is unknown.

So one missing macro, presented as hundreds of independent failures, with the
actual cause on the first line and buried by the time the user reads it.

## Decisions

**`lens.extraCompileFlags`.** A user-supplied flag list injected after the
compiler and before the project's own flags, in every command Lens builds and in
the database it stages for clang-uml. The escape hatch for a database missing
something its project needs, whatever that turns out to be.

**Read the candidate list out of the header.** The valid macros are written down
in the header the error came from, so Lens finds that header, extracts every
identifier the guard tests, and offers them in a picker. The answer is saved to
workspace settings rather than applied for one run, because which part a project
targets is a property of the project.

Detection keys on the shape — an `#error` inside a conditional testing three or
more `defined()` macros — rather than on ST's wording, so it works for any vendor
following the same convention. Two macros is an ordinary guard; a long list is a
part selector.

**Diagnose before dumping.** On a device-selection failure the panel now explains
that every "unknown type name" below is a consequence of one missing macro, names
the header, and offers the picker.

## Verification

Reproduced against real clang-uml 0.6.3 with a faithful copy of ST's guard.
Without the macro: the `#error` fires and nothing is generated. With
`-DSTM32G474xx -DUSE_HAL_DRIVER` injected through the staging path: clean run.

The header parser is tested against the same guard, including ST's backslash line
continuations — the four physical lines matter, since stopping at the first would
find three macros and silently omit seven.

## The part Lens cannot fix

The database is generated without `-D` flags, and clangd reads the same file.
Every LSP-backed lens — Flow especially — is very likely failing for exactly this
reason, and no amount of repair inside Lens fixes IntelliSense. The diagnosis now
says so explicitly, because pointing at the generator is more useful than another
workaround.
