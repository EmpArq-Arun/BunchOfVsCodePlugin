#!/usr/bin/env python3
"""
Complexity analyzer backend for the Complexity Cosmos VS Code extension.

Runs lizard (https://github.com/terryyin/lizard) over the given source files
and emits one JSON array of per-function metrics on stdout. The extension owns
all UI, thresholding and history; this script's only job is "files in, metrics
out" so the backend stays swappable.

Usage:
    python analyze.py file1.c file2.cpp ...

On stderr it emits a single machine-readable token on failure:
    lizard-not-installed   -> lizard is missing from this interpreter
    analyze-error:<path>:<msg>  -> one file failed (others still emitted)
"""
import sys
import json

try:
    import lizard
except ImportError:
    sys.stderr.write("lizard-not-installed")
    sys.exit(2)


def main(paths):
    out = []
    for path in paths:
        try:
            info = lizard.analyze_file(path)
        except Exception as exc:  # noqa: BLE001 - report and keep going
            sys.stderr.write(f"analyze-error:{path}:{exc}\n")
            continue
        for fn in info.function_list:
            out.append(
                {
                    "file": path,
                    "name": fn.name,
                    "longName": fn.long_name,
                    # The five switchable metrics. All are always present so the
                    # extension can change the active metric without re-running.
                    "ccn": fn.cyclomatic_complexity,   # McCabe cyclomatic
                    "nloc": fn.nloc,                   # non-comment lines
                    "tokens": fn.token_count,          # raw token count
                    "params": fn.parameter_count,      # parameter count
                    "length": fn.length,               # physical line span
                    "start": fn.start_line,
                    "end": fn.end_line,
                }
            )
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1:])
