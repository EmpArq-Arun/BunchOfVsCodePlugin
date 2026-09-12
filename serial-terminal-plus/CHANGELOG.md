# Change Log

## 0.2.0

- Added buffered file logging in `text`, `csv` and `jsonl` formats.
- Records are batched in memory (default 64 KiB) and written in a single write to avoid
  per-line disk activity and unnecessary flash wear.
- Safety-net flush interval, manual flush, size-based rotation with generation pruning,
  optional auto-start on connect and per-kind filters (rx / tx / info / parsed samples).
- Toolbar controls with a live readout of bytes written, bytes buffered and write count.

## 0.1.0

- Initial release.
- Terminal window with port configuration, colourised TX/RX log, hex view, filter and manual send.
- Scheduled commands with per-command repeat timer, encoding, line ending, channels and colour.
- Response window with in-place value replacement, min/max/count/rate statistics.
- Plotter with up to 16 windows, shared or separate charts, auto-scale and rolling buffer.
- Template and regex response patterns with a built-in pattern tester.
- Built-in SIMULATOR port for hardware-free use.
