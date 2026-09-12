# Serial Terminal Plus

An enhanced serial terminal for Visual Studio Code: define reusable commands with their own
**repeat timers**, send them over a configurable serial port, and watch the replies in three
dedicated windows — a **terminal log**, an **in-place response window** and a **16-window plotter**.

## Features

- **Terminal window** — port picker (baud / data bits / parity / stop bits / RTS-CTS), colourised
  TX/RX log with timestamps, hex view, substring filter, scrollback limit, manual send box with
  command history.
- **Scheduled commands** — every command carries its own payload, encoding (ascii/hex), line ending,
  repeat interval, colour, channel selection, target graph window and response pattern.
  Start/stop individually or all at once. `repeat = 0` means one-shot.
- **Response window** — one row per series, value replaced **in place** (textbox style) with a change
  flash, plus min / max / count / update rate / last raw line. Freeze, filter and decimal control.
- **Graph window** — up to **16 plot windows** in an auto or fixed grid. Several commands can share a
  window (overlaid traces) or use separate windows. Rolling buffer, auto-scale or manual Y range,
  time or sample-index X axis, pause, and a "combine all into #1" toggle.
- **Simulator port** — a built-in `SIMULATOR` device replies in the default response format so the
  whole workbench can be used without hardware.
- **Buffered file logging** — write the session to disk in `text`, `csv` or `jsonl` format with
  **wear-friendly batched writes**, size-based rotation and a live buffer readout.
- **Import / export** command sets as JSON.

## Getting started

```bash
npm install
npm run compile
```

Press <kbd>F5</kbd> in VS Code to launch the Extension Development Host, then run
**Serial Terminal+: Open Workbench (all windows)** from the Command Palette.

Select the `SIMULATOR` port and press **Connect** → **Start all** to see live data flowing through
all three windows immediately.

## Response patterns

Each command declares how its reply is decoded. Two modes are available.

### Template mode (default)

```
or <COMMAND> ch1:<data> ch2:<data> ch3:<data> ch4:<data>
```

| Placeholder | Meaning |
| --- | --- |
| `<command>` / `<cmd>` | The echoed command name. The line is only accepted if it matches this command. |
| `<data>` / `<value>` | A numeric value bound to the next free channel (1, 2, 3 …). |
| `<ch3>` / `<channel3>` | A numeric value bound explicitly to channel 3. |
| `<hex>` / `<hex5>` | A hexadecimal value (`0x` prefix optional). |
| `<any>` / `<*>` | Ignored filler text. |

Everything else is matched literally, whitespace runs are flexible, and the pattern may appear
anywhere inside the received line (prefixes such as log timestamps are tolerated).

Only the channels ticked for the command are extracted, so `ch1:… ch2:… ch3:… ch4:…` with channels
`2, 4` selected yields two series.

### Regex mode

Provide a raw JavaScript regular expression. Use named groups `(?<cmd>…)`, `(?<d1>…)`, `(?<d2>…)`
to bind channels explicitly, or plain positional groups (group *n* → channel *n*):

```
or\s+(?<cmd>\w+)\s+ch1:(?<d1>[-\d.]+)\s+ch2:(?<d2>[-\d.]+)
TEMP=([-\d.]+) HUM=([-\d.]+)
```

Flags `i`, `m`, `s`, `u` are supported. The **Test** button in the command editor validates a pattern
against a sample line and shows the extracted channel values.

## Multiple commands and plot windows

- Each command has a **graph window** index (`#1` … `#16`).
- Commands sharing an index are drawn as multiple traces on the **same** chart.
- Different indexes produce **separate** charts in the grid (max 16, enforced by
  `serialTerminalPlus.maxGraphWindows`).
- A single received line can satisfy several commands at once; each one contributes its own series.

Series are keyed as `<command>.ch<n>` and coloured from the command colour, so the terminal,
response and graph windows all agree on naming and colour.

## File logging

Press **⏺ Log to file** in the terminal toolbar (or run *Serial Terminal+: Start / Stop File
Logging*). The neighbouring buttons let you choose a specific file (📁), force a flush (⤓) and open
the active log (↗). The status text shows the file name, bytes written, bytes still buffered and the
number of physical writes.

### Flash-friendly batched writes

Records are **never written per received line**. They accumulate in memory and are handed to the OS
as a single write only when one of these happens:

1. the buffer reaches `logging.flushKiB` (default **64 KiB**);
2. the `logging.flushIntervalMs` safety net expires (default **10 s**) and the buffer is non-empty;
3. you press the flush button, stop logging, disconnect, or the extension deactivates.

With a 64 KiB buffer a typical 100-byte response line produces roughly **one write per 650 lines**
instead of one write per line. Set `logging.flushIntervalMs` to `0` to flush *only* on a full buffer
or on stop — the fewest possible writes, at the cost of keeping more data in RAM.

The file descriptor is opened once in append mode and all writes are synchronous, so buffered data
is still written correctly when VS Code shuts the extension down.

### Formats

| Format | Example line |
| --- | --- |
| `text` | `2026-01-02 03:04:05.000 << or READ ch1:1.5 ch2:-2 ch3:300 ch4:0.5` |
| `csv` | `2026-01-02 03:04:05.000,1767322445000,sample,READ,1,READ.ch1,1.5,` |
| `jsonl` | `{"t":1767322445000,"kind":"rx","text":"or READ ch1:1.5 …"}` |

Enable `logging.includeSamples` to append one record per **parsed channel value** in addition to the
raw lines — combine it with `csv` to get a spreadsheet-ready capture of every plotted point.

### Rotation

When the active file passes `logging.maxFileMiB` (default 16 MiB) it is renamed to `name.1.log`,
existing generations shift up, and anything beyond `logging.maxFiles` (default 5) is deleted. Set
`logging.maxFileMiB` to `0` to disable rotation.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `serialTerminalPlus.defaultPortConfig` | `{ baudRate: 115200, … }` | Pre-filled port configuration. |
| `serialTerminalPlus.lineEnding` | `\r\n` | Default line ending for manual sends. |
| `serialTerminalPlus.maxGraphWindows` | `16` | Number of plot windows (hard limit 16). |
| `serialTerminalPlus.maxPointsPerSeries` | `600` | Rolling buffer length per series. |
| `serialTerminalPlus.terminalScrollback` | `2000` | Lines retained in the terminal log. |
| `serialTerminalPlus.logging.autoStart` | `false` | Start logging automatically on connect. |
| `serialTerminalPlus.logging.directory` | `""` | Folder for auto-named logs (default `<workspace>/serial-logs`). |
| `serialTerminalPlus.logging.format` | `text` | `text`, `csv` or `jsonl`. |
| `serialTerminalPlus.logging.flushKiB` | `64` | Buffer size before a single write is issued. |
| `serialTerminalPlus.logging.flushIntervalMs` | `10000` | Safety-net flush; `0` = only on full buffer/stop. |
| `serialTerminalPlus.logging.maxFileMiB` | `16` | Rotation threshold; `0` disables rotation. |
| `serialTerminalPlus.logging.maxFiles` | `5` | Rotated generations to keep. |
| `serialTerminalPlus.logging.includeRx` / `includeTx` / `includeInfo` | `true` | Which record kinds to log. |
| `serialTerminalPlus.logging.includeSamples` | `false` | Also log each parsed channel value. |
| `serialTerminalPlus.logging.timestamps` | `true` | Timestamp prefix for `text` records. |

## Commands

`Serial Terminal+: Open Workbench (all windows)`, `Open Terminal / Response / Graph Window`,
`Connect`, `Disconnect`, `Start All Scheduled Commands`, `Stop All Scheduled Commands`,
`Export Command Set`, `Import Command Set`, `Start / Stop File Logging`, `Start File Logging As…`,
`Stop File Logging`, `Flush Log Buffer To Disk`, `Open Current Log File`.

## Native module note

Real ports use the native [`serialport`](https://serialport.io) module. If the prebuilt binary does
not match the Electron ABI of your VS Code build, the terminal shows a warning banner and only the
`SIMULATOR` port is offered. Rebuild it with:

```bash
npx @electron/rebuild -v <electron-version-of-your-vscode> -f -w serialport
```

## Development

| Script | Purpose |
| --- | --- |
| `npm run compile` | Type-check and bundle to `dist/`. |
| `npm run watch` | esbuild watch mode (used by <kbd>F5</kbd>). |
| `npm test` | Unit tests for the response-parsing engine. |
| `npm run package` | Produce a `.vsix`. |

## License

MIT
