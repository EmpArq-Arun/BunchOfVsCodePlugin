# Complexity Cosmos

Per-function code complexity for C/C++, tracked over time, surfaced three ways:

- **Status bar** — the function under your cursor, as a celestial body + value + trend arrow.
- **Problems panel** — diagnostics when a function approaches, crosses, or doubles its threshold.
- **Panel** (`Complexity Cosmos: Open Panel`) — every function in the file as a sorted card grid, each with a sparkline of its history and the threshold drawn in.

The visual metaphor is gravity ≈ complexity. A trivial function is a drifting asteroid; an untestable one is a black hole that understanding can't escape.

| Tier | Body | Meaning |
|------|------|---------|
| 0 | 🪨 Asteroid | Trivial |
| 1 | 🌑 Moon | Simple |
| 2 | 🪐 Planet | Modest |
| 3 | 🟠 Gas giant | Notable |
| 4 | ⭐ Star | Heavy |
| 5 | 🔴 Red giant | Severe |
| 6 | ✦ Neutron star | Critical |
| 7 | 🕳️ Black hole | Untestable |

## Metrics

Switch the active metric from the status bar, the command palette (`Complexity Cosmos: Select Metric`), or settings. Each has its own threshold.

| Key | Label | Default threshold |
|--------|-----------------|-------------------|
| `ccn` | Cyclomatic (CCN) | 10 |
| `nloc` | Lines (NLOC) | 60 |
| `tokens` | Tokens | 400 |
| `params` | Parameters | 5 |
| `length` | Span (lines) | 80 |

## Requirements

The backend uses [`lizard`](https://github.com/terryyin/lizard) (a small, zero-config multi-language complexity analyser):

```bash
pip install lizard
```

If your `python` isn't on `PATH` or lizard lives in another interpreter, set `complexityCosmos.pythonPath`.

## Run it (from source)

```bash
npm install
npm run build      # or: npm run watch
```

Then press <kbd>F5</kbd> to launch the Extension Development Host, open a C/C++ file, and move the cursor through a function. Save the file to record a history snapshot, or run `Complexity Cosmos: Snapshot Current File`.

History is stored per workspace in `.vscode/complexity-history.json`, keyed by relative path + function signature, capped at `complexityCosmos.historyLimit` snapshots each.

## How it's wired

```
C/C++ file ──► python/analyze.py (lizard) ──► JSON per-function metrics
                                                   │
              src/analyzer.ts  ── spawn ───────────┘
                    │  tierOf(value, bands) → 0..7
                    ├─► status bar      (function under cursor)
                    ├─► diagnostics     (0.75× / 1× / 2× threshold)
                    ├─► history.ts      (.vscode/complexity-history.json)
                    └─► panel.ts ──► media/main.js + style.css (webview)
```

The backend is intentionally swappable: it takes file paths in and returns metrics out. A cognitive-complexity backend built on clang-tidy and your existing `compile_commands.json` would drop in behind the same interface.

## Settings

| Setting | Default | Notes |
|---------|---------|-------|
| `complexityCosmos.metric` | `ccn` | Active metric. |
| `complexityCosmos.thresholds` | see table | Per-metric flag level. |
| `complexityCosmos.snapshotOnSave` | `true` | Record history on every save. |
| `complexityCosmos.historyLimit` | `50` | Snapshots retained per function. |
| `complexityCosmos.pythonPath` | `python` | Interpreter running lizard. |
