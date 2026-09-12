# Linker MemMap Viewer

---

## Licence & Disclaimer

**For development and debugging use only.**

This tool is provided as-is, without warranty of any kind, express or implied,
including but not limited to warranties of merchantability, fitness for a
particular purpose, or non-infringement.

The individual or organisation deploying this tool accepts full responsibility
for its use. The author(s) and any associated individual or organisation shall
not be held liable for any direct, indirect, incidental, special, or
consequential damages arising from the use of, or inability to use, this tool —
including but not limited to data loss, incorrect memory analysis, or decisions
made on the basis of output produced by this tool.

This tool is **not validated for use in safety-critical, production, or
certification contexts**. Output must be independently verified before being
relied upon in any engineering decision.

Use of this tool implies acceptance of these terms.

---

## Quick Start

```bash
pip install bottle          # one-time
python app.py               # browser opens automatically
```

Override port if needed:
```bash
python app.py 8080
```

## Usage

Drop any combination of files — each is optional:

| File | What it unlocks |
|------|----------------|
| `.ld` | Memory map, regions, sections, startup cost |
| `.elf` / `.axf` | Symbols, sizes, DMA warnings, addr→line |
| `.map` | Per-.o flash/RAM breakdown, GC'd sections |

## Toolchain

In the sidebar **Prefix** field, paste your toolchain path:

```
arm-none-eabi-
D:\NXP\S32DS.3.6.4\S32DS\build_tools\gcc_v11.4\gcc-11.4-arm32-eabi\bin\arm-none-eabi-
D:\NXP\S32DS.3.6.4\S32DS\build_tools\gcc_v11.4\gcc-11.4-arm32-eabi\bin\
```

Trailing dash, backslash, or forward slash all work — auto-detected.

## Project Structure

```
lmv/
├── app.py              ← entry point, server, all routes
├── parsers/
│   ├── ld_parser.py    ← GCC linker script parser
│   ├── elf_parser.py   ← nm/readelf/size/addr2line + warnings
│   └── map_parser.py   ← .map file parser
├── static/
│   ├── app.css         ← all styles
│   ├── state.js        ← app state + feature registry
│   ├── drops.js        ← file drop/upload (isolated — the fix lives here)
│   ├── render.js       ← memory map SVG + sections + symbols + warnings
│   ├── tabs.js         ← bloat/startup/mapfile/dead code/addr2line/debug
│   ├── popups.js       ← modal popup system
│   └── utils.js        ← helpers, tooltip, init
└── templates/
    └── index.html      ← HTML shell, loads static files
```

## Why File Selection Was Broken (and how it's fixed)

The monolithic version embedded `JSON.stringify(obj)` inside
`onclick="..."` HTML attributes. The browser's HTML parser sees the first
`"` in the JSON as the closing quote of the attribute — everything after
that point was broken HTML. Since `getElementById()` returned `null` for
all elements, no event listeners ever registered.

**Fix**: `drops.js` is the only file that touches file input. File inputs
are `display:none` siblings of the drop area divs (not overlaid inside
them). The div's `click` handler calls `input.click()` explicitly.
All wiring runs in `DOMContentLoaded` so the DOM is guaranteed ready.
No data is ever placed inside HTML attribute strings.
