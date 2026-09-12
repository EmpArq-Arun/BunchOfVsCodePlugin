#!/usr/bin/env python3
"""
Linker MemMap Viewer
====================
Run:   python app.py
Opens: http://localhost:5000  (auto-scans for free port)

Usage:
  1. Drop .ld file — memory map, regions, sections
  2. Drop .elf/.axf — symbols, sizes, DMA warnings, addr→line
  3. Drop .map file — per-.o breakdown, GC'd sections
  4. Set toolchain prefix, e.g.:
       D:\\NXP\\S32DS\\build_tools\\gcc_v11.4\\gcc-11.4-arm32-eabi\\bin\\arm-none-eabi-

Requires:  pip install bottle
"""

import os, sys, json, socket, webbrowser, threading, tempfile, shutil
from pathlib import Path

# ── PyInstaller compatibility ─────────────────────────────────────────────
# When frozen as .exe, files are in sys._MEIPASS (temp extraction folder).
# When running as a script, use the directory of this file.
if getattr(sys, 'frozen', False):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))

try:
    from bottle import Bottle, request, response, run, static_file, BaseRequest
except ImportError:
    print('\n[ERROR] Missing dependency.  Run:  pip install bottle\n')
    sys.exit(1)

# Allow large map/elf uploads (up to 256 MB)
BaseRequest.MEMFILE_MAX = 10 * 1024 * 1024

def _parse_target():
    """
    Extract target profile JSON from the current request.
    Returns a dict with keys: id, isa, memmap, dma_safe_sections,
    cacheable_sections, periph_note, isa_note.
    Defaults to ARM Cortex-M if not provided.
    """
    raw = request.forms.get('target', '').strip()
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            pass
    # Default: ARM Cortex-M (backward compatibility with old clients)
    return {
        "id":  "arm",
        "isa": "thumb2",
        "memmap": {
            "null_window":   0x100,
            "flash_ranges":  [[0x00000000, 0x10000000]],
            "sram_ranges":   [[0x20000000, 0x40000000]],
            "periph_ranges": [[0x40000000, 0xE0000000]],
        },
        "dma_safe_sections": [
            ".non_cacheable_data", ".non_cacheable_bss",
            ".mcal_data_no_cacheable", ".mcal_bss_no_cacheable",
        ],
        "cacheable_sections": [
            ".data", ".bss", ".sram_data", ".sram_bss",
            ".dtcm_data", ".dtcm_bss", ".ramcode",
        ],
        "periph_note": "On S32K3: check PCC_<PERIPH>_CGC bit.",
        "isa_note": "",
    }  # 10 MB for text form fields

from parsers.ld_parser  import parse_linker_script
from parsers.map_parser import parse_map
from parsers.callgraph_parser import analyse_callgraph
from parsers.disasm_parser   import disassemble
from parsers.elf_parser import (
    resolve_tools, save_elf, analyse_elf,
    assign_symbols, make_warnings, startup_cost, run_tool,
    detect_elf_arch, detect_elf_bitness,
)
try:
    from parsers.cpp_parser import analyse_cpp
    _HAS_CPP = True
except ImportError:
    _HAS_CPP = False

try:
    from parsers.isr_parser import detect_isrs, analyse_isr_health
    _HAS_ISR = True
except ImportError:
    _HAS_ISR = False

app = Bottle()

# ── Static files ──────────────────────────────────────────────────────────

@app.route('/static/<filename:path>')
def serve_static(filename):
    resp = static_file(filename, root=os.path.join(BASE_DIR, 'static'))
    # Prevent browser caching during development
    resp.set_header('Cache-Control', 'no-cache, no-store, must-revalidate')
    resp.set_header('Pragma', 'no-cache')
    resp.set_header('Expires', '0')
    return resp

# ── Pages ─────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    tmpl = os.path.join(BASE_DIR, 'templates', 'index.html')
    with open(tmpl, 'r', encoding='utf-8') as f:
        return f.read()

# ── API routes ────────────────────────────────────────────────────────────

@app.route('/parse_ld', method='POST')
def route_parse_ld():
    """
    Parse one or more GCC linker scripts.
    Accepts content, content_2 … content_5 for multiple .ld files.
    Files are auto-ordered: MEMORY block first, SECTIONS block second.
    This handles ESP-IDF's split memory.ld + sections.ld pattern.
    Returns: parse_linker_script() result with doc comment fields.
    """
    response.content_type = 'application/json'
    try:
        parts = []
        for field in ['content','content_2','content_3','content_4','content_5']:
            val = request.forms.get(field, '')
            if not val:
                fup = request.files.get(field)
                if fup:
                    try: val = fup.file.read().decode('utf-8', errors='replace')
                    except Exception: val = ''
            if val and val.strip():
                parts.append(val)
        if not parts:
            return json.dumps({"error": "Empty file"})
        import re as _re2
        def _has_mem(c): return bool(_re2.search(r'\bMEMORY\s*\{', c))
        def _has_sec(c): return bool(_re2.search(r'\bSECTIONS\s*\{', c))
        mem_  = [p for p in parts if _has_mem(p)]
        sec_  = [p for p in parts if _has_sec(p) and not _has_mem(p)]
        rest_ = [p for p in parts if not _has_mem(p) and not _has_sec(p)]
        combined = '\n'.join(mem_ + sec_ + rest_)
        return json.dumps(parse_linker_script(combined))
    except Exception as ex:
        import traceback
        return json.dumps({"error": str(ex), "trace": traceback.format_exc()})


@app.route('/parse_map', method='POST')
def route_parse_map():
    response.content_type = 'application/json'
    try:
        # Large map files may exceed MEMFILE_MAX — bottle moves them to request.files
        content = request.forms.get('content', '')
        if not content.strip():
            up = request.files.get('content')
            if up:
                up.file.seek(0)
                content = up.file.read().decode('utf-8', errors='replace')
        if not content.strip():
            return json.dumps({"error": "Empty map file — file may be too large or wrong format"})
        # Architecture selection strategy:
        # 1. Always auto-detect from the file content first (most reliable)
        # 2. Use the user's chip-selector choice only as a tiebreaker when
        #    auto-detection is ambiguous (equal hits on both sets)
        # This means an ESP32 .map dropped while ARM is selected still parses
        # correctly, and a mismatch warning appears in the UI.
        target = _parse_target()
        target_arch_map = {'esp32-xtensa': 'esp32', 'esp32-riscv': 'esp32', 'arm': 'arm'}
        hint_arch = target_arch_map.get(target.get('id', 'arm'), 'arm')
        result = parse_map(content, arch=None)   # auto-detect from content
        # If auto-detect was ambiguous (no ESP32 or ARM sections found), use hint
        if result.get('arch') == 'arm' and result['summary']['total_flash'] == 0 and hint_arch == 'esp32':
            result = parse_map(content, arch='esp32')
        return json.dumps(result)
    except Exception as ex:
        return json.dumps({"error": str(ex)})


@app.route('/analyse_elf', method='POST')
def route_analyse_elf():
    response.content_type = 'application/json'
    tmp = None
    try:
        up = request.files.get('elf')
        if not up:
            return json.dumps({"error": "No ELF file received"})

        raw_tools = json.loads(request.forms.get('tools', '{}'))
        ld_data   = json.loads(request.forms.get('ld_data', '{}'))

        # Save ELF — closed before subprocess opens it (Windows file-lock fix)
        tmp   = save_elf(up)
        tools = resolve_tools(raw_tools)

        try:
            symbols, elf_secs, debug = analyse_elf(tmp, tools)
        except ValueError as _ve:
            # Clean user-facing error (wrong file type, empty file, etc.)
            return json.dumps({
                "error": str(_ve),
                "symbols": [], "warnings": [], "elf_sections": {},
                "debug": {"nm_ok": False, "re_ok": False, "sz_ok": False,
                          "nm_stderr": str(_ve), "nm_sample": ""},
            })

        ld_secs = ld_data.get('sections', [])
        assign_symbols(symbols, elf_secs, ld_secs)

        for reg in ld_data.get('regions', []):
            reg['used_bytes'] = sum(
                elf_secs.get(s['name'], {}).get('size', 0)
                for s in reg.get('sections', []))

        return json.dumps({
            "symbols":      symbols,
            "elf_sections": elf_secs,
            "warnings":     make_warnings(ld_data, elf_secs, symbols, _parse_target()),
            "startup":      startup_cost(ld_secs, elf_secs),
            "debug":        debug,
        })

    except Exception as ex:
        import traceback
        return json.dumps({"error": str(ex), "trace": traceback.format_exc()})
    finally:
        if tmp and os.path.exists(tmp):
            try: os.unlink(tmp)
            except Exception: pass


@app.route('/debug_elf', method='POST')
def route_debug_elf():
    response.content_type = 'application/json'
    tmp = None
    try:
        up = request.files.get('elf')
        if not up:
            return json.dumps({"error": "No ELF file"})

        raw_tools = json.loads(request.forms.get('tools', '{}'))
        tmp   = save_elf(up)
        tools = resolve_tools(raw_tools)
        fsize = os.path.getsize(tmp)
        results = {
            "file_size":  fsize,
            "prefix_in":  tools['prefix_in'],
            "prefix_out": tools['prefix_out'],
            "tools": {}
        }

        for name, t, extra in [
            ('nm',   tools['nm'],   ['--print-size', '--radix=x']),
            ('re',   tools['re'],   ['-S', '--wide']),
            ('size', tools['size'], ['-A', '-x']),
        ]:
            stdout, stderr, rc = run_tool([t] + extra + [tmp])
            results["tools"][name] = {
                "path":   t,
                "found":  bool(shutil.which(t)) or os.path.isfile(t) or os.path.isfile(t+'.exe'),
                "rc":     rc,
                "lines":  len([l for l in stdout.splitlines() if l.strip()]),
                "stdout": stdout[:3000] if stdout else "",
                "stderr": stderr[:800]  if stderr else "",
            }
        return json.dumps(results)

    except Exception as ex:
        import traceback
        return json.dumps({"error": str(ex), "trace": traceback.format_exc()})
    finally:
        if tmp and os.path.exists(tmp):
            try: os.unlink(tmp)
            except Exception: pass


@app.route('/addr2line', method='POST')
def route_addr2line():
    response.content_type = 'application/json'
    tmp = None
    try:
        addr   = request.forms.get('addr', '').strip()
        raw    = {'prefix': request.forms.get('prefix', ''),
                  'a2l':    request.forms.get('a2l_tool', '')}
        up     = request.files.get('elf')

        if not addr:  return json.dumps({"error": "No address"})
        if not up:    return json.dumps({"error": "No ELF file"})

        try:    addr_int = int(addr, 0)
        except: return json.dumps({"error": f"Bad address: {addr}"})

        tmp  = save_elf(up)
        tool = resolve_tools(raw)['a2l']
        out, err, _ = run_tool([tool, '-e', tmp, '-f', '-C', '-p', hex(addr_int)])
        return json.dumps({"result": out.strip() or err.strip() or "No result"})

    except Exception as ex:
        return json.dumps({"error": str(ex)})
    finally:
        if tmp and os.path.exists(tmp):
            try: os.unlink(tmp)
            except Exception: pass


# ── Server startup ────────────────────────────────────────────────────────

@app.route('/scan_su', method='POST')
def route_scan_su():
    """
    Walk a directory tree and catalogue ALL analysis-relevant GCC output files.

    Searches recursively for:
        .su  → per-function stack frame sizes (needs -fstack-usage)
        .ci  → call graph with stack costs (needs -fcallgraph-info=su,da)
        .d   → header dependency lists (generated automatically)
        .o   → object files (exist in every build)

    Returns:
        {
          "su_files":  [...],   list of .su files found
          "ci_files":  [...],   list of .ci files found
          "d_files":   [...],   list of .d  files found
          "o_files":   [...],   count of .o files (not listed individually)
          "has_su":    bool,
          "has_ci":    bool,
          "has_d":     bool,
          "summary":   str      human-readable description of what was found
        }

    EMBEDDED ENGINEER NOTE:
        If has_su=True and has_ci=True  → full worst-case call-chain analysis available
        If has_su=True and has_ci=False → per-function frame sizes only (add -fcallgraph-info=su,da)
        If has_su=False                 → no stack data (add -fstack-usage and rebuild)
    """
    response.content_type = 'application/json'
    try:
        path = request.forms.get('path', '').strip()
        if not path:
            return json.dumps({"error": "No path provided"})

        # Support environment variables and ~ in path (useful for CI/CD paths)
        path = os.path.expandvars(os.path.expanduser(path))

        if not os.path.isdir(path):
            return json.dumps({
                "error": f"Directory not found: {path}",
                "hint":  "Check the path is a build output directory (e.g. Debug/ or Release/)"
            })

        su_files, ci_files, d_files = [], [], []
        o_count = 0

        # os.walk recurses into ALL subdirectories automatically.
        # We only skip hidden dirs (.git, .svn) and non-build dirs.
        # NOTE: dirs[:] modifies the list IN PLACE — this is the correct
        # way to prune os.walk subdirectory traversal.
        for root, dirs, fnames in os.walk(path):
            dirs[:] = sorted(
                d for d in dirs
                if not d.startswith('.')
                and d not in ('node_modules', '.git', '.svn', '__pycache__', '.vs')
            )

            rel = os.path.relpath(root, path)
            rel = '' if rel == '.' else rel

            for fname in sorted(fnames):
                full = os.path.join(root, fname)
                size = os.path.getsize(full)

                if fname.endswith('.su'):
                    su_files.append({
                        "path": full,
                        "name": fname,
                        "stem": fname[:-3],    # filename without .su, matches .ci stem
                        "dir":  rel or '(root)',
                        "size": size,
                    })
                elif fname.endswith('.ci'):
                    ci_files.append({
                        "path": full,
                        "name": fname,
                        "stem": fname[:-3],
                        "dir":  rel or '(root)',
                        "size": size,
                    })
                elif fname.endswith('.d'):
                    d_files.append({
                        "path": full,
                        "name": fname,
                        "dir":  rel or '(root)',
                        "size": size,
                    })
                elif fname.endswith('.o') or fname.endswith('.obj'):
                    o_count += 1

        # Sort all lists: shallowest first then alphabetical
        key = lambda f: (f['dir'].count(os.sep), f['name'])
        su_files.sort(key=key)
        ci_files.sort(key=key)
        d_files.sort(key=key)

        # Match .ci files to .su files by stem (same base filename)
        su_stems = {f['stem'] for f in su_files}
        ci_stems = {f['stem'] for f in ci_files}
        matched  = su_stems & ci_stems    # files that have both .su and .ci

        # Build human-readable summary for the UI
        has_su = len(su_files) > 0
        has_ci = len(ci_files) > 0
        has_d  = len(d_files)  > 0

        if has_su and has_ci:
            summary = (
                f"Found {len(su_files)} .su and {len(ci_files)} .ci files "
                f"({len(matched)} matched pairs). "
                f"Full worst-case call-chain analysis available."
            )
            level = "full"
        elif has_su:
            summary = (
                f"Found {len(su_files)} .su files but no .ci files. "
                f"Per-function stack frames available. "
                f"Add -fcallgraph-info=su,da for worst-case call-chain analysis."
            )
            level = "partial"
        else:
            summary = (
                f"No .su files found in {path}. "
                f"Add -fstack-usage to GCC flags and rebuild."
            )
            level = "none"

        return json.dumps({
            "su_files":  su_files,
            "ci_files":  ci_files,
            "d_files":   d_files,   # not used by UI yet, but available
            "o_count":   o_count,
            "has_su":    has_su,
            "has_ci":    has_ci,
            "has_d":     has_d,
            "matched":   len(matched),
            "level":     level,      # "full" | "partial" | "none"
            "summary":   summary,
        })

    except PermissionError as ex:
        return json.dumps({"error": f"Permission denied: {ex.filename}"})
    except Exception as ex:
        import traceback
        return json.dumps({"error": str(ex), "trace": traceback.format_exc()})


@app.route('/load_su_files', method='POST')
def route_load_su_files():
    """
    Read the contents of selected .su and .ci files and return them.

    Accepts .su files (stack frame data) AND .ci files (call graph data).
    Both are plain text — same read logic, different consumer on the JS side.
    """
    response.content_type = 'application/json'
    try:
        paths = json.loads(request.forms.get('paths', '[]'))
        if not paths:
            return json.dumps({"error": "No paths provided"})

        files  = []
        errors = []
        for path in paths:
            path = os.path.expandvars(os.path.expanduser(path))
            if not os.path.isfile(path):
                errors.append(f"Not found: {path}")
                continue
            # Accept .su (stack usage) and .ci (call graph info) — both plain text
            if not (path.endswith('.su') or path.endswith('.ci')):
                errors.append(f"Unsupported file type (expected .su or .ci): {path}")
                continue
            try:
                with open(path, 'r', errors='replace') as fh:
                    content = fh.read()
                files.append({
                    "name":    os.path.basename(path),
                    "path":    path,
                    "content": content,
                    "type":    "ci" if path.endswith('.ci') else "su",
                })
            except Exception as e:
                errors.append(f"{path}: {e}")

        return json.dumps({"files": files, "errors": errors})

    except Exception as ex:
        return json.dumps({"error": str(ex)})



@app.route('/disassemble', method='POST')
def route_disassemble():
    """
    Disassemble the function containing a given address.

    Accepts:
        addr           hex string  e.g. "0x00401234"
        context_lines  int         lines before/after target (default 10)
        func_start     hex string  optional — if caller knows from nm
        func_end       hex string  optional
        prefix         str         toolchain prefix
        tools_json     JSON str    full tools dict (nm, re, size, a2l, objdump)

    Returns:
        Full disassembly result from disasm_parser.disassemble()

    EMBEDDED ENGINEER NOTE:
        The disassembly is most useful when the ELF was built with -g.
        Without debug info, C source lines won't appear — but ARM Thumb-2
        instruction analysis still works.

    ESP32 COMPILER FLAGS NEEDED:
        In menuconfig → Compiler Options:
          Optimization level: Debug (-Og) or Size (-Os with -g)
          Generate debug information: CONFIG_COMPILER_OPTIMIZATION_ASSERTIONS_ENABLE
        Or add to CMakeLists.txt:
          idf_build_set_property(COMPILE_OPTIONS "-g3" APPEND)
        Without -g, objdump produces code-only output (no C source lines).
    """
    response.content_type = 'application/json'
    tmp = None
    try:
        up = request.files.get('elf')
        if not up:
            return json.dumps({"error": "No ELF file — load ELF and click Analyse ELF first"})

        addr_str = request.forms.get('addr', '').strip()
        if not addr_str:
            return json.dumps({"error": "No address provided"})

        try:
            target_addr = int(addr_str, 0)
        except ValueError:
            return json.dumps({"error": f"Invalid address: {addr_str}"})

        context_lines = int(request.forms.get('context_lines', '10'))
        context_lines = max(1, min(context_lines, 100))   # clamp 1–100

        raw_tools = json.loads(request.forms.get('tools_json', '{}'))
        tools     = resolve_tools(raw_tools)

        # Auto-detect ELF architecture from header if objdump might be wrong
        # This catches the case where ARM is selected but an ESP32 ELF was dropped
        try:
            with open(tmp, 'rb') as ef:
                hdr = ef.read(18)
            if len(hdr) >= 18:
                e_machine = int.from_bytes(hdr[16:18], 'little')
                # 40=ARM, 94=Xtensa, 243=RISC-V
                if e_machine == 94 and 'xtensa' not in (tools.get('objdump','') or ''):
                    # Try xtensa-esp-elf-objdump
                    from parsers.elf_parser import find_tool
                    xt = find_tool(['xtensa-esp-elf-objdump', 'xtensa-esp32-elf-objdump'])
                    if xt: tools['objdump'] = xt
                elif e_machine == 243 and 'riscv' not in (tools.get('objdump','') or ''):
                    from parsers.elf_parser import find_tool
                    rv = find_tool(['riscv32-esp-elf-objdump'])
                    if rv: tools['objdump'] = rv
        except Exception:
            pass  # best-effort; fall through to whatever was configured

        # Optional known function bounds (avoids a second objdump pass)
        func_start_str = request.forms.get('func_start', '').strip()
        func_end_str   = request.forms.get('func_end',   '').strip()
        func_start = int(func_start_str, 0) if func_start_str else None
        func_end   = int(func_end_str,   0) if func_end_str   else None

        tmp = save_elf(up)

        source_dir = request.forms.get('source_dir', '').strip() or None
        if source_dir:
            source_dir = os.path.expandvars(os.path.expanduser(source_dir))

        result = disassemble(
            tmp_path      = tmp,
            tools         = tools,
            target_addr   = target_addr,
            context_lines = context_lines,
            func_start    = func_start,
            func_end      = func_end,
            source_dir    = source_dir,
            target        = _parse_target(),
        )
        return json.dumps(result)

    except Exception as ex:
        import traceback
        return json.dumps({"error": str(ex), "trace": traceback.format_exc()})
    finally:
        if tmp and os.path.exists(tmp):
            try: os.unlink(tmp)
            except Exception: pass


@app.route('/debug_ci', method='POST')
def route_debug_ci():
    """
    Debug route: returns the first 60 lines of an uploaded .ci file
    so we can see the actual GCC format and fix the parser accordingly.
    """
    response.content_type = 'application/json'
    try:
        content = request.forms.get('content', '')
        if not content:
            up = request.files.get('file')
            if up:
                up.file.seek(0)
                content = up.file.read().decode('utf-8', errors='replace')
        lines   = content.splitlines()
        return json.dumps({
            "total_lines": len(lines),
            "sample":      lines[:60],
            "raw60":       content[:3000],
        })
    except Exception as ex:
        return json.dumps({"error": str(ex)})


@app.route('/analyse_callgraph', method='POST')
def route_analyse_callgraph():
    """
    Parse uploaded .ci files and compute worst-case stack depths.

    Accepts:
        ci_contents  JSON array of {name, content} objects
        su_entries   JSON array of already-parsed .su entries (for frame-size fallback)

    Returns callgraph analysis from callgraph_parser.analyse_callgraph().

    SOFTWARE ENGINEER NOTE:
        This route does the heavy computation server-side so the browser
        doesn't need to implement a graph algorithm. The result is a simple
        dict that the frontend renders as a table + call-chain visualisation.
    """
    response.content_type = 'application/json'
    try:
        ci_list   = json.loads(request.forms.get('ci_contents', '[]'))
        su_list   = json.loads(request.forms.get('su_entries',  '[]'))

        if not ci_list:
            return json.dumps({"error": "No .ci file contents provided"})

        contents = [item['content'] for item in ci_list if 'content' in item]
        result   = analyse_callgraph(contents, su_list or None)

        if result is None:
            return json.dumps({"error": "Callgraph analysis produced no results"})

        # top_worst path lists can be large — truncate to 10 steps for the UI
        for item in result.get('top_worst', []):
            if len(item.get('path', [])) > 10:
                item['path'] = item['path'][:10] + ['...']

        return json.dumps(result)

    except Exception as ex:
        import traceback
        return json.dumps({"error": str(ex), "trace": traceback.format_exc()})


@app.route('/scan_source', method='POST')
def route_scan_source():
    """
    Walk a directory tree and return all source files found.

    Searches recursively for: .c .cpp .cxx .cc .h .hpp .s .asm .inc
    Returns list of {path, name, ext, dir, size} sorted shallowest-first.

    The browser cannot access the filesystem directly — this route lets the
    user type a path and see what source files the server finds, then pick
    which ones to load (same pattern as /scan_su for .su/.ci files).
    """
    response.content_type = 'application/json'
    try:
        path = (request.forms.get('path', '') or '').strip()
        if not path:
            return json.dumps({"error": "No path provided"})

        path = os.path.expandvars(os.path.expanduser(path))
        if not os.path.isdir(path):
            return json.dumps({"error": f"Directory not found: {path}"})

        SOURCE_EXTS = {'.c', '.cpp', '.cxx', '.cc', '.h', '.hpp',
                       '.s', '.asm', '.inc', '.c++', '.hxx', '.h++'}

        files = []
        for root, dirs, fnames in os.walk(path):
            # Skip common non-source directories
            dirs[:] = sorted(d for d in dirs
                             if not d.startswith('.')
                             and d not in ('node_modules', '.git', '.svn',
                                           '__pycache__', 'Debug', 'Release',
                                           'build', 'dist', '.vs', 'obj'))
            rel = os.path.relpath(root, path)
            rel = '' if rel == '.' else rel
            for fname in sorted(fnames):
                ext = os.path.splitext(fname)[1].lower()
                if ext in SOURCE_EXTS:
                    full = os.path.join(root, fname)
                    files.append({
                        "path": full,
                        "name": fname,
                        "ext":  ext,
                        "dir":  rel or '(root)',
                        "size": os.path.getsize(full),
                    })

        # Sort: shallowest first, then alphabetical
        files.sort(key=lambda f: (f['dir'].count(os.sep), f['name']))

        return json.dumps({"files": files, "total": len(files), "root": path})

    except PermissionError as ex:
        return json.dumps({"error": f"Permission denied: {ex.filename}"})
    except Exception as ex:
        return json.dumps({"error": str(ex)})


@app.route('/load_source_files', method='POST')
def route_load_source_files():
    """
    Read selected source files and return their contents.
    Used when the user picks files from the /scan_source picker.
    """
    response.content_type = 'application/json'
    try:
        paths = json.loads(request.forms.get('paths', '[]'))
        if not paths:
            return json.dumps({"error": "No paths provided"})

        files  = []
        errors = []
        SOURCE_EXTS = {'.c', '.cpp', '.cxx', '.cc', '.h', '.hpp',
                       '.s', '.asm', '.inc', '.c++', '.hxx', '.h++'}

        for path in paths:
            path = os.path.expandvars(os.path.expanduser(path))
            ext  = os.path.splitext(path)[1].lower()
            if not os.path.isfile(path):
                errors.append(f"Not found: {path}"); continue
            if ext not in SOURCE_EXTS:
                errors.append(f"Not a source file: {path}"); continue
            try:
                with open(path, 'r', errors='replace') as fh:
                    content = fh.read()
                files.append({"name": os.path.basename(path),
                              "path": path, "content": content})
            except Exception as e:
                errors.append(f"{path}: {e}")

        return json.dumps({"files": files, "errors": errors})

    except Exception as ex:
        return json.dumps({"error": str(ex)})


@app.route('/scan_ld', method='POST')
def route_scan_ld():
    """Walk a directory and return all .ld/.lds/.x files."""
    response.content_type = 'application/json'
    try:
        path = os.path.expandvars(os.path.expanduser((request.forms.get('path') or '').strip()))
        if not path:
            return json.dumps({"error": "No path provided"})
        if not os.path.isdir(path):
            return json.dumps({"error": f"Directory not found: {path}"})
        LD_EXTS = {'.ld', '.lds', '.x'}
        skip = {'node_modules', '.git', '.svn', '__pycache__', '.vs'}
        files = []
        for root, dirs, fnames in os.walk(path):
            dirs[:] = sorted(d for d in dirs if d not in skip and not d.startswith('.'))
            for fname in sorted(fnames):
                if os.path.splitext(fname)[1].lower() in LD_EXTS:
                    full = os.path.join(root, fname)
                    files.append({
                        "path": full, "name": fname,
                        "dir":  os.path.relpath(root, path) or '(root)',
                        "size": os.path.getsize(full),
                    })
        files.sort(key=lambda f: (f['dir'].count(os.sep), f['name']))
        return json.dumps({"files": files, "root": path})
    except PermissionError as ex:
        return json.dumps({"error": f"Permission denied: {ex.filename}"})
    except Exception as ex:
        return json.dumps({"error": str(ex)})


@app.route('/load_ld_files', method='POST')
def route_load_ld_files():
    """Read selected .ld files from disk and return their contents."""
    response.content_type = 'application/json'
    try:
        paths = json.loads(request.forms.get('paths', '[]'))
        if not paths:
            return json.dumps({"error": "No paths provided"})
        LD_EXTS = {'.ld', '.lds', '.x'}
        files, errors = [], []
        for p in paths:
            p = os.path.expandvars(os.path.expanduser(p))
            if not os.path.isfile(p):
                errors.append(f"Not found: {p}"); continue
            if os.path.splitext(p)[1].lower() not in LD_EXTS:
                errors.append(f"Not a linker script: {p}"); continue
            try:
                with open(p, 'r', errors='replace') as fh:
                    files.append({"name": os.path.basename(p), "path": p,
                                  "content": fh.read()})
            except Exception as e:
                errors.append(f"{p}: {e}")
        return json.dumps({"files": files, "errors": errors})
    except Exception as ex:
        return json.dumps({"error": str(ex)})


@app.route('/resource_stats', method='GET')
def route_resource_stats():
    """Return live process RSS, CPU%, thread count and GC stats."""
    response.content_type = 'application/json'
    response.set_header('Cache-Control', 'no-store')
    try:
        import gc, threading as _threading
        proc = _resource_proc()
        mem  = proc.memory_info()
        cpu  = proc.cpu_percent(interval=None)   # non-blocking; first call returns 0
        fds  = 0
        try: fds = proc.num_fds()
        except Exception: pass
        gc_counts = list(gc.get_count())
        return json.dumps({
            "rss_bytes":    mem.rss,
            "vms_bytes":    mem.vms,
            "cpu_pct":      cpu,
            "threads":      proc.num_threads(),
            "fds":          fds,
            "gc_counts":    gc_counts,
            "gc_threshold": list(gc.get_threshold()),
            "uptime_s":     _resource_start_s(),
        })
    except Exception as ex:
        return json.dumps({"error": str(ex)})


# ── Resource monitoring helpers ──────────────────────────────────────────────
try:
    import psutil as _psutil
    _resource_proc_obj = _psutil.Process()
    _resource_proc_obj.cpu_percent(interval=None)   # initialise CPU counter
    _resource_start_t = __import__('time').time()

    def _resource_proc(): return _resource_proc_obj
    def _resource_start_s(): return round(__import__('time').time() - _resource_start_t, 1)
except ImportError:
    # psutil not installed.
    # 'resource' module is Unix-only and does NOT exist on Windows — do not
    # import it unconditionally.  Use os / ctypes for a cross-platform fallback.
    import time as _time, os as _os, sys as _sys
    _resource_start_t = _time.time()

    def _win_rss_bytes():
        """Read RSS on Windows via ctypes PROCESS_MEMORY_COUNTERS."""
        try:
            import ctypes, ctypes.wintypes
            class _PMC(ctypes.Structure):
                _fields_ = [
                    ('cb',                          ctypes.wintypes.DWORD),
                    ('PageFaultCount',               ctypes.wintypes.DWORD),
                    ('PeakWorkingSetSize',            ctypes.c_size_t),
                    ('WorkingSetSize',                ctypes.c_size_t),
                    ('QuotaPeakPagedPoolUsage',       ctypes.c_size_t),
                    ('QuotaPagedPoolUsage',           ctypes.c_size_t),
                    ('QuotaPeakNonPagedPoolUsage',    ctypes.c_size_t),
                    ('QuotaNonPagedPoolUsage',        ctypes.c_size_t),
                    ('PagefileUsage',                 ctypes.c_size_t),
                    ('PeakPagefileUsage',             ctypes.c_size_t),
                ]
            pmc = _PMC()
            pmc.cb = ctypes.sizeof(pmc)
            ctypes.windll.psapi.GetProcessMemoryInfo(
                ctypes.windll.kernel32.GetCurrentProcess(),
                ctypes.byref(pmc), pmc.cb)
            return pmc.WorkingSetSize
        except Exception:
            return 0

    def _unix_rss_bytes():
        """Read RSS on Linux/macOS via /proc or resource module."""
        try:
            # Linux: /proc/self/status is always available
            with open('/proc/self/status') as fh:
                for line in fh:
                    if line.startswith('VmRSS:'):
                        return int(line.split()[1]) * 1024
        except Exception:
            pass
        try:
            import resource as _res
            ru = _res.getrusage(_res.RUSAGE_SELF)
            return ru.ru_maxrss * (1 if _sys.platform == 'darwin' else 1024)
        except Exception:
            return 0

    class _FallbackProc:
        def memory_info(self):
            rss = _win_rss_bytes() if _sys.platform == 'win32' else _unix_rss_bytes()
            class _M: pass
            m = _M(); m.rss = rss; m.vms = rss
            return m
        def cpu_percent(self, interval=None): return 0.0
        def num_threads(self):
            try:
                if _sys.platform == 'win32':
                    return 1   # not easily available without psutil
                import threading
                return threading.active_count()
            except Exception:
                return 1
        def num_fds(self):
            try:
                return len(_os.listdir(f'/proc/{_os.getpid()}/fd'))
            except Exception:
                raise OSError('fd count not available (install psutil)')

    def _resource_proc(): return _FallbackProc()
    def _resource_start_s(): return round(_time.time() - _resource_start_t, 1)


@app.route('/parse_cpp', method='POST')
def route_parse_cpp():
    """
    C++ ELF artifact analysis — vtables, RTTI, exceptions, PLT/GOT, templates.

    IMPORTANT: exception-table and PLT/GOT analysis need the REAL ELF section
    list (.eh_frame, .plt, .dynamic, etc.) from readelf -S — NOT the linker
    script's MEMORY/SECTIONS layout. Native Linux x86/x86-64 builds typically
    have no .ld file loaded at all, so we always re-derive sections from the
    ELF itself via analyse_elf() rather than relying solely on client-supplied
    LD section data (which would silently return empty exception/PLT results
    for any native build).
    """
    response.content_type = 'application/json'
    tmp = None
    try:
        if not _HAS_CPP:
            return json.dumps({"error": "cpp_parser not available", "is_cpp": False})
        up = request.files.get('elf')
        if not up:
            return json.dumps({"error": "No ELF file"})
        tmp = save_elf(up)

        raw_tools = json.loads(request.forms.get('tools_json', '{}'))
        prefix  = raw_tools.get('prefix', '')
        cxxfilt = raw_tools.get('cxxfilt', '') or (prefix + 'c++filt' if prefix else 'c++filt')

        # Client may pass already-parsed symbols to avoid a second nm run —
        # but ELF section data is always re-derived here (see docstring above).
        symbols_in = json.loads(request.forms.get('symbols_json', '[]'))

        tools = resolve_tools(raw_tools)
        symbols_fresh, elf_secs_dict, debug = analyse_elf(tmp, tools)

        symbols = symbols_in if symbols_in else symbols_fresh

        # Convert elf_secs dict {name: {addr,size,...}} -> list of {name,size}
        # as expected by cpp_parser's exception/dynamic-section analysers.
        real_sections = [
            {"name": name, "size": info.get("size", 0)}
            for name, info in elf_secs_dict.items()
        ]

        return json.dumps(analyse_cpp(symbols, real_sections, cxxfilt_path=cxxfilt))
    except Exception as ex:
        import traceback
        return json.dumps({"error": str(ex), "trace": traceback.format_exc()[:800]})
    finally:
        if tmp:
            try: os.remove(tmp)
            except Exception: pass


@app.route('/analyse_isr', method='POST')
def route_analyse_isr():
    """
    Interrupt Subroutine health analysis.

    Accepts (all optional except target_json):
        symbols_json   JSON — symbols list from /analyse_elf (provides ISR identification)
        su_entries     JSON — SU_DATA.entries from client (stack frame data)
        cg_result      JSON — SU_DATA.cgResult from /analyse_callgraph
        ld_sections    JSON — LD section list for fast-memory classification
        target_json    JSON — target profile (provides 'isa' for arch detection)

    Returns: {isrs: [...], summary: {...}, arch: str}
    """
    response.content_type = 'application/json'
    try:
        if not _HAS_ISR:
            return json.dumps({'error': 'isr_parser module not available'})

        tgt     = json.loads(request.forms.get('target_json', '{}'))
        arch    = tgt.get('isa', tgt.get('id', 'arm'))
        # Normalise ISA string to arch key used in isr_parser
        _ARCH_MAP = {
            'thumb2':     'arm',       'arm':      'arm',
            'xtensa':     'esp32-xtensa', 'esp32-xtensa': 'esp32-xtensa',
            'riscv32':    'esp32-riscv', 'esp32-riscv':  'esp32-riscv',
            'x86-64':     'x86-64',    'x86-32':  'x86-32',
        }
        arch = _ARCH_MAP.get(arch, 'arm')

        symbols     = json.loads(request.forms.get('symbols_json',  '[]'))
        su_entries  = json.loads(request.forms.get('su_entries',    '[]'))
        cg_result   = json.loads(request.forms.get('cg_result',     'null'))
        ld_sections = json.loads(request.forms.get('ld_sections',   '[]'))

        isrs = detect_isrs(symbols, ld_sections=ld_sections, arch=arch)
        result = analyse_isr_health(isrs, su_entries, cg_result, arch=arch)
        return json.dumps(result)

    except Exception as ex:
        import traceback
        return json.dumps({'error': str(ex), 'trace': traceback.format_exc()[:800]})



def find_free_port(candidates):
    for port in candidates:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                s.bind(('localhost', port))
                return port
        except OSError:
            pass
    return None


def open_browser(port):
    import time
    time.sleep(0.8)
    webbrowser.open(f'http://localhost:{port}')


if __name__ == '__main__':
    candidates = [5000, 5500, 7000, 7777, 8000, 8080, 8888, 9000, 3000,
                   5001, 5002, 5003, 6000, 6500, 10000, 12000, 15000]
    if len(sys.argv) > 1:
        try: candidates = [int(sys.argv[1])] + candidates
        except ValueError: pass

    PORT = find_free_port(candidates)
    if not PORT:
        print('\n[ERROR] No free port found. Try:  python app.py 12345\n')
        sys.exit(1)

    print(f"""
  ╔══════════════════════════════════════════════════════╗
  ║  Linker MemMap Viewer  →  http://localhost:{PORT:<5}    ║
  ║                                                      ║
  ║  Files:  lmv/                                        ║
  ║    app.py          ← this file (server + routes)     ║
  ║    parsers/        ← ld_parser, elf_parser, map      ║
  ║    static/         ← CSS + JS modules                ║
  ║    templates/      ← index.html                      ║
  ║                                                      ║
  ║  Toolchain prefix examples:                          ║
  ║    arm-none-eabi-                                    ║
  ║    D:/NXP/S32DS/bin/arm-none-eabi-                   ║
  ║                                                      ║
  ║  Ctrl+C to stop                                      ║
  ╚══════════════════════════════════════════════════════╝
""")
    # ISSUE 7: Add a shutdown endpoint so the browser page can stop the server.
    # When the browser sends POST /shutdown, the server exits cleanly.
    @app.route('/shutdown', method='POST')
    def route_shutdown():
        """
        Gracefully stop the server from the browser.
        Called by the page's beforeunload handler and the ✕ button.
        Only accepts requests from localhost for security.
        """
        if request.environ.get('REMOTE_ADDR') not in ('127.0.0.1', '::1'):
            abort(403, 'Shutdown only allowed from localhost')
        def _stop():
            import time; time.sleep(0.3)   # let the HTTP response finish
            os._exit(0)
        threading.Thread(target=_stop, daemon=True).start()
        return json.dumps({"ok": True})

    # Pre-import wsgiref dependencies so PyInstaller bundles them correctly.
    # Without this, frozen EXEs crash with "No module named 'http.server'"
    # because PyInstaller's static analysis misses wsgiref's dynamic imports.
    try:
        import wsgiref.simple_server   # noqa: F401  — needed by Bottle/wsgiref
        import http.server             # noqa: F401  — needed by wsgiref
        import http.client             # noqa: F401
        import socketserver            # noqa: F401
    except ImportError:
        pass  # Already imported or running in a non-frozen environment

    threading.Thread(target=open_browser, args=(PORT,), daemon=True).start()
    run(app, host='localhost', port=PORT, server='wsgiref', quiet=True,
        max_request_size=256 * 1024 * 1024)
