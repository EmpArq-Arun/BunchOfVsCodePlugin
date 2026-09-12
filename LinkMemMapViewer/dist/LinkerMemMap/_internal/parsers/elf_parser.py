"""ELF binary analysis — nm, readelf, size, addr2line."""
import re, os, subprocess, shutil, tempfile
from pathlib import Path

# C++ analysis — imported lazily
try:
    from parsers.cpp_parser import analyse_cpp
    _HAS_CPP = True
except ImportError:
    try:
        from cpp_parser import analyse_cpp
        _HAS_CPP = True
    except ImportError:
        _HAS_CPP = False

# ── Toolchain resolution ───────────────────────────────────────────────────

def normalize_prefix(raw):
    """Accept any prefix format; returns string to prepend to bare tool names.
    Never injects arm-none-eabi- unless the input explicitly contains it.
    Valid inputs: empty, bare triplet (xtensa-esp-elf), triplet with dash,
    full path to prefix (D:\\NXP\\bin\\arm-none-eabi-), directory path.
    """
    p = (raw or "").strip()
    if not p:
        return ""
    # Already ends with "-": correct prefix form
    if p.endswith("-"):
        return p
    # Ends with path separator: directory, tool basenames appended directly
    if p.endswith("/") or p.endswith("\\"):
        return p
    # Basename contains "-": looks like a toolchain triplet without trailing dash
    last = os.path.basename(p)
    if "-" in last:
        return p + "-"
    # Pure directory without trailing separator
    return p + os.sep



# ── ELF architecture constants ───────────────────────────────────────────────
EM_386    = 3    # x86 IA-32
EM_ARM    = 40   # ARM 32-bit
EM_X86_64 = 62   # AMD64 / Intel 64
EM_XTENSA = 94   # Xtensa (ESP32)
EM_RISCV  = 243  # RISC-V

_EMACHINE_ARCH = {
    EM_386:    'x86-32',
    EM_ARM:    'arm',
    EM_X86_64: 'x86-64',
    EM_XTENSA: 'esp32-xtensa',
    EM_RISCV:  'esp32-riscv',
}

def detect_elf_arch(elf_path):
    """Return architecture string from ELF e_machine header field."""
    try:
        with open(elf_path, 'rb') as fh:
            hdr = fh.read(20)
        if len(hdr) < 20 or hdr[:4] != b'\x7fELF':
            return None
        e_machine = int.from_bytes(hdr[18:20], 'little')
        return _EMACHINE_ARCH.get(e_machine)
    except Exception:
        return None

def detect_elf_bitness(elf_path):
    """Return 32 or 64 based on ELF EI_CLASS field."""
    try:
        with open(elf_path, 'rb') as fh:
            ei_class = fh.read(6)[4]
        return 64 if ei_class == 2 else 32
    except Exception:
        return 32


def find_tool(candidates):
    """
    Return first candidate that exists AND is executable on the current OS.

    On Windows, bare tool names (e.g. "nm") may accidentally resolve to a
    Linux/Cygwin/POSIX binary installed by Git-for-Windows or WSL that lives
    on PATH but cannot be executed by the Windows kernel.  We detect this by
    reading the first two bytes of the resolved binary: if they are b'\x7fE'
    (Linux ELF magic) we skip that candidate and keep looking.  The ARM or
    Xtensa toolchain nm.exe (from S32DS, Keil, etc.) will have MZ magic and
    be accepted immediately.

    Preference order:
      1. Exact path as given if it exists (user set it explicitly)
      2. shutil.which() resolution — already handles PATH + .exe on Windows
      3. Add .exe suffix (Windows: full path D:\\toolchain\\nm becomes nm.exe)
    """
    import sys as _sys

    def _is_native(path):
        """Return True if the binary at path is runnable on the current OS."""
        if not path: return False
        if _sys.platform != 'win32': return True  # on Linux/macOS everything is fine
        try:
            with open(path, 'rb') as fh:
                magic = fh.read(2)
            # MZ = Windows PE/EXE  (b'MZ')
            # ELF = Linux/POSIX    (b'\x7fE')
            # Mach-O 64-bit        (b'\xcf\xfa')
            if magic == b'\x7fE':
                return False   # Linux ELF on Windows — won't run without WSL
            return True        # MZ, batch scripts, etc.
        except Exception:
            return True        # assume fine if we can't read it

    first = ''
    for raw in candidates:
        t = (raw or '').strip()
        if not t: continue

        # Try exact path
        if os.path.isfile(t) and _is_native(t):
            if not first: first = t
            return t
        if os.path.isfile(t + '.exe') and _is_native(t + '.exe'):
            if not first: first = t + '.exe'
            return t + '.exe'

        # Try PATH resolution
        resolved = shutil.which(t)
        if resolved and _is_native(resolved):
            if not first: first = resolved
            return resolved

        # On Windows, also try with explicit .exe suffix via which
        if _sys.platform == 'win32':
            resolved_exe = shutil.which(t + '.exe')
            if resolved_exe and _is_native(resolved_exe):
                if not first: first = resolved_exe
                return resolved_exe

        if not first:
            first = t   # remember first candidate even if not yet runnable

    return first


def resolve_tools(raw):
    """
    Build resolved absolute paths for nm/readelf/size/addr2line/objdump.

    Priority order for each tool:
      1. Explicit value from raw (e.g. raw['nm'] = 'xtensa-esp-elf-nm')
      2. prefix + basename (derived from raw['prefix'])
      3. Bare basename (last resort, works if tool is on PATH)

    The old 'arm-none-eabi-' hardcoded fallback is REMOVED — it was
    the root cause of ESP32 / custom-prefix tools not working.
    """
    prefix = normalize_prefix(raw.get('prefix', ''))

    def candidates(field, basename):
        c = []
        explicit = (raw.get(field) or '').strip()

        # 1. Explicit value always wins if provided
        if explicit:
            c.append(explicit)

        # 2. prefix + basename (if prefix was given and explicit didn't already include it)
        if prefix and not explicit:
            c.append(prefix + basename)

        # 3. Bare basename — works when tools are on PATH
        c.append(basename)
        return c

    return {
        'nm':      find_tool(candidates('nm',      'nm')),
        're':      find_tool(candidates('re',      'readelf')),
        'size':    find_tool(candidates('size',    'size')),
        'a2l':     find_tool(candidates('a2l',     'addr2line')),
        'objdump': find_tool(candidates('objdump', 'objdump')),
        'prefix_in':  raw.get('prefix', ''),
        'prefix_out': prefix,
    }


# ── Subprocess helper ──────────────────────────────────────────────────────

def run_tool(args, timeout=30):
    try:
        r = subprocess.run(args, capture_output=True, text=True,
                           timeout=timeout, errors='replace')
        return r.stdout, r.stderr, r.returncode
    except FileNotFoundError:
        return '', 'Tool not found: ' + args[0], 1
    except subprocess.TimeoutExpired:
        return '', 'Timeout: ' + ' '.join(args), 1
    except Exception as e:
        return '', str(e), 1


def save_elf(upload):
    """Write uploaded ELF to temp file and CLOSE it before returning.
    Critical on Windows — open handles block subprocess access."""
    suffix = Path(upload.filename).suffix or '.elf'
    fd, path = tempfile.mkstemp(suffix=suffix)
    try:
        upload.file.seek(0)
        with os.fdopen(fd, 'wb') as f:
            while True:
                chunk = upload.file.read(65536)
                if not chunk: break
                f.write(chunk)
    except Exception:
        try: os.unlink(path)
        except Exception: pass
        raise
    return path


# ── nm parsing ────────────────────────────────────────────────────────────

NM_TYPES = {
    'T':'function','t':'function','W':'weak','w':'weak',
    'D':'variable','d':'variable','B':'variable','b':'variable',
    'R':'constant','r':'constant','C':'common','c':'common',
    'U':'undefined','A':'absolute','a':'absolute',
    'V':'weak_obj','v':'weak_obj','G':'small_data','g':'small_data',
    'S':'small_bss','s':'small_bss','I':'indirect','i':'indirect',
}
SYM_COLORS = {
    'function':'#3b82f6','variable':'#f97316','constant':'#10b981',
    'weak':'#6366f1','undefined':'#6e7681','absolute':'#f59e0b',
    'common':'#8b5cf6','other':'#374151',
}


def parse_nm_line(parts):
    def is_hex(s): return bool(re.match(r'^[0-9a-fA-F]{6,}$', s))
    def is_type(s): return len(s) == 1 and s in 'TtDdBbRrWwUuAaCcVvGgSsIi'

    source = ''
    clean = []
    for p in parts:
        if '\t' in p: source = p.strip('\t'); break
        clean.append(p)
    parts = clean

    try:
        if len(parts) >= 3 and is_hex(parts[0]):
            if len(parts) >= 4 and is_hex(parts[1]) and is_type(parts[2]):
                addr, size, ntype_raw, name = int(parts[0],16), int(parts[1],16), parts[2], ' '.join(parts[3:])
            elif is_type(parts[1]):
                addr, size, ntype_raw, name = int(parts[0],16), 0, parts[1], ' '.join(parts[2:])
            else: return None
        elif len(parts) >= 2 and is_type(parts[0]):
            addr, size, ntype_raw, name = 0, 0, parts[0], ' '.join(parts[1:])
        elif len(parts) >= 3:
            name = parts[0]
            ntype_raw = parts[1]
            addr = int(parts[2],16) if is_hex(parts[2]) else 0
            size = int(parts[3],16) if len(parts)>3 and is_hex(parts[3]) else 0
        else: return None

        ntype = NM_TYPES.get(ntype_raw, 'other')
        return {"name": name, "addr": addr, "size": size, "type": ntype,
                "type_raw": ntype_raw, "global": ntype_raw.isupper(),
                "color": SYM_COLORS.get(ntype, SYM_COLORS['other']),
                "source": source, "section": None, "file": ""}
    except (ValueError, IndexError):
        return None


def parse_nm_output(stdout):
    seen, syms = set(), []
    for line in stdout.splitlines():
        line = line.strip()
        if not line or line.endswith(':'): continue
        parts = line.split()
        if len(parts) < 2: continue
        sym = parse_nm_line(parts)
        if not sym: continue
        name = sym['name']
        if not name or name.startswith('$'): continue
        key = (name, sym['addr'])
        if key in seen: continue
        seen.add(key)
        syms.append(sym)
    return sorted(syms, key=lambda s: s['addr'])


def parse_readelf_output(stdout):
    secs = {}
    for line in stdout.splitlines():
        m = re.match(
            r'\s*\[\s*\d+\]\s+(\S+)\s+(\S+)\s+([0-9a-fA-F]+)\s+'
            r'([0-9a-fA-F]+)\s+([0-9a-fA-F]+)', line)
        if m:
            secs[m.group(1)] = {"addr": int(m.group(3),16),
                                 "size": int(m.group(5),16),
                                 "type": m.group(2), "flags": ""}
    return secs


def parse_size_output(stdout):
    sizes = {}
    for line in stdout.splitlines():
        m = re.match(r'^(\S+)\s+(0x[0-9a-fA-F]+|\d+)\s+(0x[0-9a-fA-F]+|\d+)', line)
        if m:
            try: sizes[m.group(1)] = {'size': int(m.group(2),0), 'addr': int(m.group(3),0)}
            except Exception: pass
    return sizes


def analyse_elf(tmp_path, tools):
    """
    Run nm/readelf/size on tmp_path. Return (symbols, elf_secs, debug_info).

    Pre-validation: checks the file magic bytes before invoking any subprocess.
    This catches common Windows issues where:
      - A .libdep.so (Linux dynamic library generated by the linker as a side
        effect of some IDEs) is accidentally passed instead of the .elf
      - An incomplete upload created an empty or truncated temp file
    Raises ValueError with a clear message so the route can surface it to the UI.
    """
    nm_t, re_t, sz_t = tools['nm'], tools['re'], tools['size']

    # ── Validate file before calling tools ───────────────────────────────────
    try:
        file_size = os.path.getsize(tmp_path)
        with open(tmp_path, 'rb') as _fh:
            _magic = _fh.read(4)
    except Exception as _e:
        raise ValueError(f"Cannot read uploaded file: {_e}")

    if file_size == 0:
        raise ValueError("Uploaded file is empty. Try re-uploading the ELF.")

    # ELF magic = 0x7f 'E' 'L' 'F'
    if _magic[:4] != b'\x7fELF':
        # Diagnose common confusions
        _hex = _magic.hex()
        if _magic[:2] == b'MZ':
            _hint = "This looks like a Windows PE/EXE — only Linux/ARM/ESP32 ELF files are supported."
        elif _magic[:2] == b'\xcf\xfa' or _magic[:2] == b'\xce\xfa':
            _hint = "This looks like a macOS Mach-O binary — only ELF format is supported."
        elif b'libdep' in tmp_path.encode() or tmp_path.endswith('.so'):
            _hint = ("This looks like a shared library stub (.so/.libdep) generated by your IDE. "
                     "Drop the .elf file, not the .so dependency file.")
        else:
            _hint = f"First bytes: {_hex!r}. Expected an ELF file (first bytes 7f 45 4c 46)."
        raise ValueError(f"Not an ELF file — {_hint}")

    nm_out, nm_err, nm_rc = run_tool([nm_t, '--print-size', '--radix=x', tmp_path])
    if not nm_out.strip():
        nm_out, nm_err, nm_rc = run_tool([nm_t, '--print-size', '--radix=x',
                                            '--line-numbers', tmp_path])
    if not nm_out.strip():
        nm_out, nm_err, nm_rc = run_tool([nm_t, tmp_path])

    re_out, re_err, re_rc = run_tool([re_t, '-S', '--wide', tmp_path])
    sz_out, sz_err, sz_rc = run_tool([sz_t, '-A', '-x', tmp_path])

    def exists(t):
        return bool(shutil.which(t)) or os.path.isfile(t) or os.path.isfile(t+'.exe')

    debug = {
        "file_size":    os.path.getsize(tmp_path) if os.path.exists(tmp_path) else 0,
        "prefix_in":    tools['prefix_in'],
        "prefix_out":   tools['prefix_out'],
        "nm_tool":      nm_t,   "nm_ok":  exists(nm_t),
        "nm_rc":        nm_rc,  "nm_lines": len([l for l in nm_out.splitlines() if l.strip()]),
        "nm_stderr":    nm_err[:800]   if nm_err else "",
        "nm_sample":    nm_out[:1200]  if nm_out else "(empty)",
        "re_tool":      re_t,   "re_ok":  exists(re_t),
        "re_rc":        re_rc,
        "re_stderr":    re_err[:400]   if re_err else "",
        "re_sample":    re_out[:600]   if re_out else "(empty)",
        "sz_tool":      sz_t,   "sz_ok":  exists(sz_t),
        "sz_rc":        sz_rc,
        "sz_stderr":    sz_err[:300]   if sz_err else "",
    }

    symbols  = parse_nm_output(nm_out)
    elf_secs = parse_readelf_output(re_out)
    sz_data  = parse_size_output(sz_out)

    for name, s in sz_data.items():
        if name in elf_secs:
            if elf_secs[name]['size'] == 0: elf_secs[name]['size'] = s['size']
        else:
            elf_secs[name] = {'addr': s['addr'], 'size': s['size'],
                              'type': 'PROGBITS', 'flags': ''}

    return symbols, elf_secs, debug


def assign_symbols(symbols, elf_secs, ld_sections):
    ranges = sorted(
        [(s['addr'], s['addr']+s['size'], n)
         for n, s in elf_secs.items() if s['size'] > 0])
    sec_map = {s['name']: s for s in ld_sections}
    for sym in symbols:
        if sym['addr'] == 0 or sym['type'] == 'undefined': continue
        sym['section'] = next(
            (name for start,end,name in ranges if start <= sym['addr'] < end), None)
        if sym['section'] and sym['section'] in sec_map:
            sec_map[sym['section']].setdefault('symbols', []).append(sym)


def make_warnings(ld_data, elf_secs, symbols, target=None):
    warns = []
    for reg in ld_data.get('regions', []):
        used = sum(elf_secs.get(s['name'], {}).get('size', 0) for s in reg['sections'])
        if reg['length'] > 0:
            pct = used / reg['length']
            if pct > 0.95:
                warns.append({"level":"error","category":"Memory Overflow",
                    "message":f"{reg['name']} is {pct*100:.1f}% full ({used:,}/{reg['length']:,} bytes)",
                    "detail":"Region nearly full — linker will error on next build."})
            elif pct > 0.80:
                warns.append({"level":"warn","category":"Memory Pressure",
                    "message":f"{reg['name']} is {pct*100:.1f}% full ({used:,}/{reg['length']:,} bytes)",
                    "detail":"Consider LTO, const to flash, or increasing region size."})

    # Target-specific DMA-safe and cacheable section names
    # The client sends these via the target JSON so they match the selected platform.
    if target:
        dma_safe_secs  = set(target.get('dma_safe_sections',  []))
        cacheable_secs = set(target.get('cacheable_sections',  []))
        target_id      = target.get('id', 'arm')
    else:
        dma_safe_secs  = {".non_cacheable_data", ".non_cacheable_bss",
                          ".mcal_data_no_cacheable", ".mcal_bss_no_cacheable"}
        cacheable_secs = {".data", ".bss", ".sram_data", ".sram_bss",
                          ".dtcm_data", ".dtcm_bss", ".ramcode"}
        target_id      = 'arm'

    cacheable_ranges = []
    for sec in ld_data.get('sections', []):
        # Use the target-specific cacheable set; fall back to the LD section flag
        is_cacheable = sec['name'] in cacheable_secs or sec.get('cacheable', False)
        is_dma_safe  = sec['name'] in dma_safe_secs  or sec.get('dma_safe',  False)
        # Update the section dict so the UI shows the right badges
        sec['cacheable'] = is_cacheable and not is_dma_safe
        sec['dma_safe']  = is_dma_safe
        if is_cacheable and not is_dma_safe:
            es = elf_secs.get(sec['name'], {})
            if es.get('size', 0) > 0:
                cacheable_ranges.append((es['addr'], es['addr']+es['size'], sec['name']))

    # DMA safety warning: DMA-ish symbol names in cacheable sections
    dma_kw = ['buf','buffer','frame','ipc','spi','dma','rx','tx',
               'fifo','packet','msg','transfer']

    # ESP32-specific: also flag symbols in .dram0.data/.dram0.bss if they look like DMA buffers
    # (ESP32 cache can cause coherency issues with DMA to cached DRAM)
    if target_id.startswith('esp32'):
        esp_dma_note = " Move to DRAM_ATTR / WORD_ALIGNED_ATTR with MALLOC_CAP_DMA."
    else:
        esp_dma_note = " Move to .non_cacheable_bss."

    for sym in symbols:
        if sym['size'] < 4 or sym['type'] not in ('variable','common'): continue
        if not any(k in sym['name'].lower() for k in dma_kw): continue
        for start,end,sec_name in cacheable_ranges:
            if start <= sym['addr'] < end:
                warns.append({"level":"warn","category":"DMA Safety",
                    "message":f"'{sym['name']}' ({sym['size']} B) in cacheable '{sec_name}'",
                    "detail":f"0x{sym['addr']:08X} — DMA access here causes cache incoherency."
                             + esp_dma_note,
                    "symbols":[sym]})
                break

    for sym in sorted([s for s in symbols if s['size']>1024
                       and s['type'] in ('variable','common')],
                      key=lambda s: -s['size'])[:5]:
        warns.append({"level":"info","category":"Large RAM Symbol",
            "message":f"'{sym['name']}' uses {sym['size']:,} bytes",
            "detail":f"0x{sym['addr']:08X} in {sym.get('section','?')}. "
                     f"If constant, consider placing in flash.",
            "symbols":[sym]})

    for sym in sorted([s for s in symbols if s['size']>4096 and s['type']=='function'],
                      key=lambda s: -s['size'])[:5]:
        warns.append({"level":"info","category":"Large Function",
            "message":f"'{sym['name']}' is {sym['size']:,} bytes",
            "detail":f"0x{sym['addr']:08X}. Large functions increase I-cache pressure.",
            "symbols":[sym]})

    return warns


def startup_cost(ld_sections, elf_secs):
    items, total_copy, total_zero = [], 0, 0
    for sec in ld_sections:
        sz = elf_secs.get(sec['name'], {}).get('size', 0)
        if not sz: continue
        if sec['noload']:
            total_zero += sz
            items.append({"section":sec['name'],"type":"zeroed","size":sz,
                          "vma":sec['vma'],"lma":sec['lma']})
        elif sec['lma']:
            total_copy += sz
            items.append({"section":sec['name'],"type":"copied","size":sz,
                          "vma":sec['vma'],"lma":sec['lma']})
    return {"items":items,"total_copy":total_copy,"total_zero":total_zero}
