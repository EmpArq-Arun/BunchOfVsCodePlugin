import re as _re

def _extract_doc_comments(content):
    """
    Generic algorithm — works for any GCC linker script, including ESP-IDF generated files.

    For each block comment /* ... */ or /** ... */, find the character position of
    the NEXT non-whitespace token.  If only whitespace (≤ 4 newlines) separates the
    comment from that token, the comment is the documentation for that token.

    Returns: dict { char_position_of_next_token → cleaned_comment_text }

    Cleaned text:
        - Leading /* and trailing */ stripped
        - Per-line leading * stripped (Doxygen / JavaDoc style)
        - Empty lines removed, trailing spaces trimmed
        - Inline refs like "See esp_attr.h" preserved as-is
    """
    c = content.replace('\r\n', '\n').replace('\r', '\n')
    out = {}
    for m in _re.finditer(r'/\*.*?\*/', c, _re.DOTALL):
        raw, end = m.group(0), m.end()
        gap = _re.match(r'^[ \t\n]*', c[end:]).end()
        if c[end:end+gap].count('\n') > 4:
            continue   # too far away — unrelated header comment
        token_pos = end + gap
        # Clean: strip comment delimiters and leading asterisks
        text = _re.sub(r'^/\*+\s*', '', raw)
        text = _re.sub(r'\s*\*+/$', '', text)
        lines = []
        for ln in text.split('\n'):
            ln = _re.sub(r'^\s*\*\s?', '', ln.rstrip())
            if ln.strip():
                lines.append(ln.strip())
        cleaned = ' '.join(lines)  # join as single paragraph for tooltip
        if cleaned and len(cleaned) > 3:
            out[token_pos] = cleaned
    return out


def _attach_docs(entities, positions, doc_map, content):
    """
    Attach the nearest preceding doc comment to each entity.

    entities  : list of dicts (regions or sections), modified in-place
    positions : list of char positions matching entities
    doc_map   : { token_pos → comment_text } from _extract_doc_comments
    content   : the full linker script text (after CRLF normalisation)
    """
    for entity, pos in zip(entities, positions):
        # Find the doc comment whose token_pos is closest to (and ≤) entity's position
        candidates = [(k, v) for k, v in doc_map.items() if k <= pos]
        if not candidates:
            continue
        best_k, best_v = max(candidates, key=lambda x: x[0])
        # Sanity check: the gap between comment end and entity must be pure whitespace
        gap = content[best_k:pos]
        if gap.count('\n') <= 5 and not _re.search(r'\S', gap):
            entity['doc'] = best_v
        else:
            entity['doc'] = ''

"""Linker script (.ld) parser — GCC/arm-none-eabi format."""
import re

SECTION_HINTS = {
    ".text":                    ("Code",       "Compiled C/C++ functions"),
    ".startup":                 ("Code",       "Reset handler and startup assembly"),
    ".systeminit":              ("Code",       "Clock and core init before main()"),
    ".intc_vector":             ("Vectors",    "Interrupt vector table"),
    ".isr_vector":              ("Vectors",    "STM32 interrupt vector table"),
    ".core_loop":               ("Code",       "Core idle loop"),
    ".init":                    ("Code",       "C runtime .init functions"),
    ".fini":                    ("Code",       "C runtime .fini functions"),
    ".itcm_text":               ("ITCM Code",  "Code in ITCM — zero wait-state"),
    ".acfls_code_rom":          ("Flash Acc",  "Flash driver ROM copy"),
    ".acfls_code_ram":          ("Flash Acc",  "Flash driver running from RAM"),
    ".acmem_43_infls_code_rom": ("Flash Acc",  "Internal flash driver ROM"),
    ".acmem_43_infls_code_ram": ("Flash Acc",  "Internal flash driver RAM"),
    ".rodata":                  ("RO Data",    "Read-only data — const globals, literals"),
    ".mcal_const":              ("RO Data",    "MCAL driver constant configuration"),
    ".mcal_const_cfg":          ("RO Data",    "MCAL generated configuration structures"),
    ".mcal_const_no_cacheable": ("RO Data NC", "MCAL constants in non-cacheable SRAM"),
    ".boot_header":             ("Boot",       "Boot header for ROM bootloader / HSE"),
    ".pflash":                  ("Flash",      "Primary flash — code and read-only data"),
    ".data":                    ("Init Data",  "Initialised globals — copied flash→RAM at boot"),
    ".mcal_data":               ("Init Data",  "MCAL driver initialised state"),
    ".ramcode":                 ("Init Data",  "Code that must execute from RAM"),
    ".dtcm_data":               ("DTCM Data",  "Initialised data in Data TCM"),
    ".mcal_data_no_cacheable":  ("NC Data",    "Driver data in non-cacheable SRAM for DMA"),
    ".non_cacheable_data":      ("NC Data",    "Non-cacheable SRAM — DMA buffers, IPC frames"),
    ".mcal_shared_data":        ("Shared",     "Initialised data shared between cores"),
    ".shareable_data":          ("Shared",     "Shareable memory for multiple cores"),
    ".bss":                     ("BSS",        "Uninitialised globals — zeroed at boot"),
    ".mcal_bss":                ("BSS",        "Uninitialised MCAL driver state"),
    ".dtcm_bss":                ("DTCM BSS",   "Uninitialised data in Data TCM"),
    ".mcal_bss_no_cacheable":   ("NC BSS",     "Uninitialised non-cacheable SRAM"),
    ".non_cacheable_bss":       ("NC BSS",     "Uninitialised non-cacheable SRAM"),
    ".mcal_shared_bss":         ("Shared BSS", "Uninitialised shared memory between cores"),
    ".shareable_bss":           ("Shared BSS", "Uninitialised shareable memory"),
    ".standby_data":            ("Standby",    "Preserved across low-power standby"),
    ".heap":                    ("Heap",       "malloc/free arena"),
    "_user_heap_stack":         ("Heap+Stack", "STM32 CubeMX combined heap+stack"),
    ".stack":                   ("Stack",      "Main stack — overflow causes HardFault"),
    ".int_vector":              ("Vect RAM",   "Vector table in RAM — runtime IRQ remap"),
    ".int_results":             ("Results",    "BIST / test results storage"),
    ".ARM":                     ("ARM Init",   "ARM runtime init/fini arrays"),
    ".preinit_array":           ("Init Array", "Pre-init constructor pointers"),
    ".init_array":              ("Init Array", "Global constructor pointers"),
    ".fini_array":              ("Fini Array", "Global destructor pointers"),
    ".sram_data":               ("Init Data",  "Initialised data placed in SRAM"),
    ".sram_bss":                ("BSS",        "Uninitialised SRAM"),
    ".data_tcm_data":           ("DTCM Data",  "Initialised data in Data TCM"),
    ".bss_tcm_data":            ("DTCM BSS",   "Uninitialised data in Data TCM"),
    # ── ESP-IDF (Xtensa ESP32/S2/S3 and RISC-V C3/C6/H2/P4) ──
    ".flash.text":              ("XIP Code",   "Code executed from flash via cache (XIP)"),
    ".flash.rodata":            ("XIP RO",     "Read-only data in flash (XIP)"),
    ".dram0.data":              ("Init Data",  "Initialised globals in DRAM (ESP32)"),
    ".dram0.bss":               ("BSS",        "Uninitialised globals in DRAM (ESP32)"),
    ".dram0.dma_reserved":      ("DMA",        "DRAM reserved for DMA — bypasses cache"),
    ".iram0.text":              ("IRAM Code",  "Code copied to IRAM — fast, interrupt-safe"),
    ".iram0.vectors":           ("Vectors",    "Interrupt vector table in IRAM"),
    ".iram0.data":              ("IRAM Data",  "Read-only data in IRAM"),
    ".iram0.bss":               ("IRAM BSS",   "Uninitialised data in IRAM"),
    ".rtc.text":                ("RTC Code",   "Code in RTC fast memory"),
    ".rtc.data":                ("RTC Data",   "Data in RTC slow memory — survives deep sleep"),
    ".rtc.bss":                 ("RTC BSS",    "Uninitialised RTC slow memory"),
    ".rtc_noinit":              ("RTC No Init","RTC memory not zeroed at boot"),
    ".noinit":                  ("No Init",    "Not zeroed at boot — intentionally uninitialised"),
    ".sram.text":               ("SRAM Code",  "Code in SRAM — RISC-V targets"),
    ".sram.data":               ("Init Data",  "Initialised data in SRAM — RISC-V"),
    ".sram.bss":                ("BSS",        "Uninitialised SRAM — RISC-V"),
}

TYPE_COLORS = {
    "Code":"#3b82f6","ITCM Code":"#06b6d4","Flash Acc":"#8b5cf6",
    "Vectors":"#f59e0b","Vect RAM":"#f59e0b","RO Data":"#10b981",
    "RO Data NC":"#059669","Boot":"#6366f1","Flash":"#2563eb",
    "Init Data":"#f97316","DTCM Data":"#fb923c","NC Data":"#ef4444",
    "Shared":"#ec4899","Shared BSS":"#a855f7","BSS":"#64748b",
    "DTCM BSS":"#475569","NC BSS":"#94a3b8","Standby":"#14b8a6",
    "Heap":"#84cc16","Heap+Stack":"#65a30d","Stack":"#a3e635",
    "Results":"#6b7280","ARM Init":"#8b5cf6","Init Array":"#7c3aed",
    "Fini Array":"#6d28d9","Unknown":"#374151",
    # ESP32-specific section types
    "XIP Code":"#06b6d4","XIP RO":"#0891b2",
    "IRAM Code":"#8b5cf6","IRAM Data":"#7c3aed","IRAM BSS":"#6d28d9",
    "RTC Code":"#ec4899","RTC Data":"#db2777","RTC BSS":"#be185d",
    "RTC No Init":"#9d174d","DMA":"#ef4444","No Init":"#6b7280",
    "SRAM Code":"#3b82f6",
}

REGION_COLORS = {
    "flash":"#0d2140","sram":"#0d2818","itcm":"#0d1e33",
    "dtcm":"#1a0d33","dflash":"#1e1e0d","default":"#141420",
}

DMA_SAFE  = {".non_cacheable_data",".non_cacheable_bss",
             ".mcal_data_no_cacheable",".mcal_bss_no_cacheable"}
CACHEABLE = {".data",".bss",".sram_data",".sram_bss",
             ".dtcm_data",".dtcm_bss",".ramcode"}


def _pv(s):
    s = s.strip()
    try:
        s2 = re.sub(r'(?i)0x([0-9a-f]+)', lambda m: str(int(m.group(1), 16)), s)
        s2 = re.sub(r'(?i)(\d+)[kK]', lambda m: str(int(m.group(1)) * 1024), s2)
        s2 = re.sub(r'(?i)(\d+)[mM]', lambda m: str(int(m.group(1)) * 1048576), s2)
        return int(eval(s2))
    except Exception:
        return 0


def _strip_comments(text):
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.DOTALL)
    text = re.sub(r'//[^\n]*', '', text)
    return text


def _classify_region(name, attrs):
    n, a = name.lower(), attrs.lower()
    if 'itcm' in n:                                return 'itcm'
    if 'dtcm' in n or 'stack' in n:               return 'dtcm'
    if 'dflash' in n or 'data_flash' in n:        return 'dflash'
    if 'flash' in n or 'rom' in n or ('r' in a and 'x' in a): return 'flash'
    if 'sram' in n or 'ram' in n:                 return 'sram'
    return 'default'


def parse_linker_script(content):
    _original_content = content   # preserve for doc comment extraction
    content = _strip_comments(content)
    regions, reg_map = [], {}

    mb = re.search(r'MEMORY\s*\{([^}]+)\}', content, re.DOTALL)
    if mb:
        # Accept both ORIGIN/LENGTH (GNU ld standard) and org/len (ESP-IDF abbreviated)
        for m in re.finditer(
            r'(\w+)\s*(?:\(([^)]*)\))?\s*:\s*(?:org|ORIGIN)\s*=\s*([^,]+),\s*(?:len|LENGTH)\s*=\s*([^\n]+)',
            mb.group(1), re.IGNORECASE
        ):
            name  = m.group(1)
            attrs = (m.group(2) or '').strip()
            origin, length = _pv(m.group(3)), _pv(m.group(4))
            rtype = _classify_region(name, attrs)
            reg = {"name": name, "attrs": attrs, "origin": origin,
                   "length": length, "end": origin + length, "type": rtype,
                   "color": REGION_COLORS.get(rtype, REGION_COLORS["default"]),
                   "sections": [], "used_bytes": 0}
            regions.append(reg)
            reg_map[name] = reg

    sections = []
    sb = re.search(r'SECTIONS\s*\{(.+)', content, re.DOTALL)
    if sb:
        for m in re.finditer(
            r'(\.[\w.]+)\s*(?:\([^)]*\))?\s*(?::\s*(?:AT\s*\([^)]+\)\s*)?)?'
            r'\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}[^>]*>\s*(\w+)?(?:\s*AT\s*>\s*(\w+))?',
            sb.group(1), re.DOTALL
        ):
            sname  = m.group(1)
            noload = bool(re.search(r'\bNOLOAD\b', m.group(0)))
            vma, lma = m.group(3), m.group(4)
            hint  = next((k for k in SECTION_HINTS if sname.startswith(k)), None)
            stype, sdesc = SECTION_HINTS.get(hint or sname, ("Unknown", "Unknown section"))
            sec = {"name": sname, "vma": vma, "lma": lma, "noload": noload,
                   "type": stype, "desc": sdesc,
                   "dma_safe": sname in DMA_SAFE, "cacheable": sname in CACHEABLE,
                   "color": TYPE_COLORS.get(stype, TYPE_COLORS["Unknown"]),
                   "size": 0, "symbols": []}
            sections.append(sec)
            if vma and vma in reg_map:
                reg_map[vma]["sections"].append(sec)

    entry = ""
    em = re.search(r'ENTRY\s*\((\w+)\)', content)
    if em:
        entry = em.group(1)

    # ── Attach doc comments ──────────────────────────────────────────────────
    # Generic: works for any .ld file that uses block comments before declarations.
    # Particularly rich for ESP-IDF generated files (memory.ld + sections.ld).
    # Use the ORIGINAL content (with comments) for doc extraction;
    # 'content' has already been stripped by _strip_comments() above.
    _content_norm = _original_content.replace('\r\n', '\n').replace('\r', '\n')
    _doc_map = _extract_doc_comments(_content_norm)

    # Region positions: find each region name in the MEMORY block
    _mb = _re.search(r'MEMORY\s*\{', _content_norm)
    if _mb:
        _body = _content_norm[_mb.end():]
        _body_start = _mb.end()
        _reg_positions = []
        _reg_re = _re.compile(
            r'(\w+)\s*(?:\([^)]*\))?\s*:\s*(?:org|ORIGIN)\s*=',
            _re.IGNORECASE
        )
        for _rm in _reg_re.finditer(_body):
            _reg_positions.append(_body_start + _rm.start(1))
        _attach_docs(regions, _reg_positions, _doc_map, _content_norm)

    # Section positions: find each section name in the SECTIONS block
    _sb = _re.search(r'SECTIONS\s*\{', _content_norm)
    if _sb:
        _sbody = _content_norm[_sb.end():]
        _sbody_start = _sb.end()
        _sec_positions = []
        _sec_re = _re.compile(
            r'^\s*(\.\S+)\s*(?:\([^)]*\))?\s*(?::\s*(?:ALIGN\([^)]+\)\s*)?)?$',
            _re.MULTILINE
        )
        _seen_secs = {}
        for _sm in _sec_re.finditer(_sbody):
            _name = _sm.group(1)
            if _name not in _seen_secs:
                _seen_secs[_name] = _sbody_start + _sm.start(1)  # start(1)=section name, not leading spaces
        # Map section name → position
        for _sec in sections:
            if _sec['name'] in _seen_secs:
                _sec_positions.append(_seen_secs[_sec['name']])
            else:
                _sec_positions.append(None)
        # Attach only for sections where we found a position
        for _sec, _pos in zip(sections, _sec_positions):
            if _pos is None:
                _sec['doc'] = ''
                continue
            _candidates = [(k, v) for k, v in _doc_map.items() if k <= _pos]
            if not _candidates:
                _sec['doc'] = ''
                continue
            _bk, _bv = max(_candidates, key=lambda x: x[0])
            _gap = _content_norm[_bk:_pos]
            _sec['doc'] = _bv if (_gap.count('\n') <= 5 and not _re.search(r'\S', _gap)) else ''

        # ── Inline-body fallback ───────────────────────────────────────────────
        # For sections with no preceding comment, check the FIRST block comment
        # inside the section body (e.g. .iram0.text has "/* Code marked as
        # running out of IRAM */" as its first statement inside the braces).
        # Only use it if the comment appears before any real linker directives
        # so we don't pick up a comment buried deep in a long section body.
        _body_sec_re = _re.compile(
            r'(\.' + r'\S+)\s*(?:\([^)]*\))?\s*:\s*(?:ALIGN\([^)]+\)\s*)?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)',
            _re.DOTALL
        )
        _inner_cm_re = _re.compile(r'/\*(.*?)\*/', _re.DOTALL)
        # Map section name → first body comment
        _body_docs = {}
        if _sb:
            for _bm in _body_sec_re.finditer(_sbody):
                _bname = _bm.group(1)
                _bbody = _bm.group(2)
                _icm   = _inner_cm_re.search(_bbody)
                if _icm:
                    # Only use if comment appears in first ~200 chars of body
                    if _icm.start() < 200:
                        _itext = _icm.group(1)
                        _ilines = [_re.sub(r'^\s*\*\s?','',ln.strip())
                                   for ln in _itext.split('\n') if ln.strip()]
                        _icleaned = ' '.join(l for l in _ilines if l).strip()
                        if _icleaned and len(_icleaned) > 5:
                            _body_docs[_bname] = _icleaned
        for _sec in sections:
            if not _sec.get('doc') and _sec['name'] in _body_docs:
                _sec['doc'] = _body_docs[_sec['name']]

    return {"regions": regions, "sections": sections, "entry": entry}
