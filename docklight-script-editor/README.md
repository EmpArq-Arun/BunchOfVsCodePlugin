# Docklight Script Editor (VS Code extension)

Opens `.ptp` Docklight project files in a visual, table-based editor instead of
raw text — edit Send Sequences (ASCII label, hex bytes, flag, delay) in a
spreadsheet-like UI, reorder/duplicate/delete rows, and it writes clean,
correctly-formatted text straight back into the file.

## Install / run it

1. Open this folder in VS Code.
2. `npm install`
3. Press `F5` (Run > Start Debugging) — this launches an **Extension
   Development Host** window with the extension loaded.
4. In that new window, open `samples/example.ptp` (or any `.ptp` file). It
   should open in the table editor automatically.

To use it in your everyday VS Code (not just the dev host), package it:
```
npm install -g @vscode/vsce
vsce package
```
This produces a `.vsix` you can install via
`code --install-extension docklight-script-editor-0.1.0.vsix`, or via the
Extensions view's "Install from VSIX..." command.

## Opening the visual editor

Two ways in:

1. **Automatic** — new `.ptp` files opened for the first time default to the
   visual editor (the extension is registered with `"priority": "default"`).
2. **Explicit button** — if a `.ptp` file is already open as plain text (e.g.
   it was open before you loaded the extension), there's now a preview icon
   (⧉, "Docklight: Open Visual Editor") in the editor title bar and in the
   Explorer right-click menu for any `.ptp` file. Click it to open the visual
   editor beside the text view, same as the Markdown preview button. This is
   the most reliable way to get the graphical view if the automatic default
   doesn't kick in for an already-open file.

While inside the visual editor, an "Open as Text" button in the title bar
goes back to plain text any time.

## What it does

- Parses the file into **blocks**: `VERSION`, `COMMSETTINGS`, `COMMDISPLAY`,
  `COMMCHANNELS`, `SEND`, `RECEIVE`, or anything else. A new block starts
  either after a blank line, or whenever a line exactly matches one of those
  known keywords — so it handles files with blank lines between sections
  *and* files that pack sections back-to-back.
- `SEND` blocks get a dedicated table. Instead of assuming a fixed number of
  lines, it locates the **hex-bytes line** by pattern (2+ space-separated
  hex byte pairs) within each block. Everything before it (after the index)
  is shown as "Name / label" field(s); everything after it is shown as
  generic "Other fields" (flag/delay-like values whose exact meaning isn't
  confirmed).
- The **"Command (ASCII)" column is the primary, directly-editable view** of
  the bytes — since real command sequences are almost always plain text,
  hex is treated as an implementation detail rather than something you need
  to look at. Control characters show as readable escapes rather than raw
  hex or dots:
  - `\r` `\n` `\t` `\0` for carriage return / line feed / tab / NUL
  - `\\` for a literal backslash
  - `\xNN` for anything else non-printable
  Type directly into this field — including typing `\r\n` yourself for a new
  command — and it's converted to hex automatically when saved. A small
  "▸ hex" toggle under each row reveals (and lets you directly edit) the raw
  hex bytes too, for the rare case you need to double-check or hand-tune
  exact byte values.
- Everything else (`VERSION`, `COMMSETTINGS`, etc.) shows up in a collapsible
  **"Project settings"** panel as raw editable lines, so nothing in the file
  is ever silently dropped even if this extension doesn't know what it means.
- A filter box searches by index / label / decoded ASCII.
- "Renumber" resets all `SEND` index fields to be sequential — useful after
  reordering by hand.
- Move up/down, duplicate, and delete buttons per row.

## Important accuracy note

Docklight's `.ptp` internal layout isn't published by Kickdrive/FuH, so this
was reverse-engineered structurally from two real sample files rather than
from an official spec, and the two samples didn't even agree on how many
lines a `SEND` block has — which is why the parser locates fields by pattern
(the hex-bytes line) instead of by fixed position:

- The **block structure** (blank-line or known-keyword delimited) is the
  load-bearing assumption, and it's what makes this lossless: any block type
  round-trips byte-for-byte even if we don't understand its fields (verified
  against both sample files in `samples/`).
- For `SEND` blocks, the hex-bytes line is reliably locatable by pattern, but
  the fields before it ("label") and after it ("other fields", e.g. a
  possible flag/delay) are shown generically because their exact meaning
  isn't confirmed from Docklight documentation.
- Saving through the editor always re-writes blocks separated by exactly one
  blank line — a formatting normalization, not a content change, but it will
  show up in a diff if your original file didn't use blank lines between
  every block.

**Recommendation before relying on this for real device testing:** make a
small edit through this UI, save, then open the same file in Docklight
itself and confirm it loads and behaves as expected — especially for
`RECEIVE` blocks or other section types not yet verified against a real
file.

## Project layout

```
src/
  extension.ts          — activation, command registration
  ptpModel.ts            — parsing/serialization (pure, no vscode dependency)
  ptpEditorProvider.ts    — CustomTextEditorProvider: webview <-> document glue
media/
  main.js                — webview UI logic
  style.css               — VS Code-themed styling
samples/
  example.ptp             — your sample file, used for manual testing
```

## Possible next steps

- If you have a real `.ptp` file that includes `RECEIVE` blocks (or other
  section types), send it over (or a redacted version) and the parser can
  get dedicated rich editing for those too, the same way `SEND` has now.
- Drag-and-drop row reordering (currently up/down buttons) if you want it.
- A "Send" button that actually opens the serial port and transmits, à la
  Docklight itself — bigger scope, but doable given `serialport` npm
  package, if useful for your ESP32-S3 bring-up workflow.
