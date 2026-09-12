"""GCC linker .map file parser — supports both ARM Cortex-M and ESP32 (Xtensa/RISC-V)."""
import re


# ── Architecture-specific section classification tables ──────────────────────
# KEPT SEPARATE per-architecture so users can modify one without affecting the other.
# Each entry: section name prefix -> ('flash'|'ram'|'both'|'ignore')
# 'both' = copied from flash to RAM at boot (e.g. .data)

_ARM_SECTION_CLASS = {
    # Flash-resident (never copied to RAM)
    '.text':           'flash',
    '.rodata':         'flash',
    '.init':           'flash',
    '.fini':           'flash',
    '.itcm_text':      'flash',
    '.pflash':         'flash',
    '.ARM':            'flash',
    '.preinit_array':  'flash',
    '.init_array':     'flash',
    '.fini_array':     'flash',
    # RAM-resident initialised (loaded from flash, counted in both)
    '.data':           'both',
    '.mcal_data':      'both',
    '.ramcode':        'both',
    '.sram_data':      'both',
    '.dtcm_data':      'both',
    # RAM-resident uninitialised
    '.bss':            'ram',
    '.mcal_bss':       'ram',
    '.dtcm_bss':       'ram',
    '.sram_bss':       'ram',
    '.non_cacheable':  'ram',
    '.heap':           'ram',
    '.stack':          'ram',
    # NXP RTD AUTOSAR specific
    '.mcal_const':     'flash',
    '.mcal_const_cfg': 'flash',
    '.mcal_shared':    'ram',
    '.shareable':      'ram',
    '.standby':        'ram',
    '.int_vector':     'ram',
    '.int_results':    'ram',
}

_ESP32_SECTION_CLASS = {
    # XIP flash (instruction + read-only data, never physically in RAM)
    '.flash.text':          'flash',
    '.flash.rodata':        'flash',
    '.flash.appdesc':       'flash',
    '.flash_rodata_dummy':  'flash',
    '.flash.rodata_noload': 'flash',
    # IRAM code — loaded from flash into IRAM at boot (counted as both)
    '.iram0.text':          'both',
    '.iram0.vectors':       'both',
    # DRAM data — initialised at boot from flash image (counted as both)
    '.dram0.data':          'both',
    # DRAM BSS / noinit — RAM only
    '.dram0.bss':           'ram',
    '.dram0.dummy':         'ignore',   # alignment spacer
    '.noinit':              'ram',
    # RTC fast memory
    '.rtc.text':            'both',
    '.rtc.force_fast':      'both',
    '.rtc.data':            'both',
    '.rtc.bss':             'ram',
    '.rtc_noinit':          'ram',
    '.rtc_reserved':        'ram',
    # RTC slow memory
    '.rtc.force_slow':      'both',
    # PSRAM / external RAM
    '.ext_ram.dummy':       'ignore',   # PSRAM alignment spacer, not real RAM
    '.ext_ram':             'ram',
    # IRAM tail sections
    '.iram0.data':          'both',
    '.iram0.bss':           'ram',
    '.iram0.text_end':      'ignore',
    '.dram0.heap_start':    'ignore',
    # Debug sections — ignore
    '.debug':               'ignore',
    '.xtensa':              'ignore',
    '.xt.':                 'ignore',
    '.comment':             'ignore',
}

# Fallback for unknown sections
_IGNORE_PREFIXES = ('.debug', '.comment', '.xtensa', '.xt.', '.zdebug')


def _classify(sec_name, section_map):
    """Return 'flash'|'ram'|'both'|'ignore' for a section name."""
    for prefix, cls in section_map.items():
        if sec_name.startswith(prefix):
            return cls
    for prefix in _IGNORE_PREFIXES:
        if sec_name.startswith(prefix):
            return 'ignore'
    return None   # unknown


# ── x86-64 Linux section classification ──────────────────────────────────────
# Covers native Linux binaries (PIE/PIC or static), C++ binaries, and
# cross-compiled x86 test images. Separate from ARM/ESP32 tables.
# Note: "flash" = in binary file on disk; "ram" = only in process memory at runtime.
_X86_64_SECTION_CLASS = {
    '.text':              'flash',
    '.init':              'flash',
    '.fini':              'flash',
    '.plt':               'flash',
    '.plt.got':           'flash',
    '.plt.sec':           'flash',
    '.rodata':            'flash',
    '.rodata.str':        'flash',
    '.eh_frame':          'flash',
    '.eh_frame_hdr':      'flash',
    '.gcc_except_table':  'flash',
    '.init_array':        'flash',
    '.fini_array':        'flash',
    '.preinit_array':     'flash',
    '.data':              'both',
    '.data.rel.ro':       'both',
    '.got':               'both',
    '.got.plt':           'both',
    '.tdata':             'both',
    '.bss':               'ram',
    '.tbss':              'ram',
    '.note.ABI-tag':      'ignore',
    '.note.gnu.build-id': 'ignore',
    '.gnu.version':       'ignore',
    '.gnu.version_r':     'ignore',
    '.gnu.hash':          'ignore',
    '.dynsym':            'ignore',
    '.dynstr':            'ignore',
    '.rela.dyn':          'ignore',
    '.rela.plt':          'ignore',
    '.dynamic':           'ignore',
    '.interp':            'ignore',
    '.comment':           'ignore',
}
_X86_32_SECTION_CLASS = _X86_64_SECTION_CLASS


def _detect_arch(sections):
    """
    Auto-detect architecture from section names.
    Returns 'esp32' if ESP32-style sections dominate, else 'arm'.
    Called once after sections are parsed.
    """
    esp32_secs = {'.flash.text', '.flash.rodata', '.iram0.text', '.dram0.data',
                  '.dram0.bss', '.iram0.vectors', '.rtc.text', '.dram0.dummy'}
    arm_secs   = {'.non_cacheable_data', '.non_cacheable_bss',
                  '.dtcm_data', '.mcal_data', '.int_vector', '.int_results'}
    x86_secs   = {'.plt', '.got', '.got.plt', '.dynamic', '.interp',
                  '.rela.dyn', '.rela.plt', '.dynsym', '.eh_frame_hdr',
                  '.gcc_except_table', '.data.rel.ro'}
    names = {s['name'] for s in sections}
    esp32_hits = len(names & esp32_secs)
    arm_hits   = len(names & arm_secs)
    x86_hits   = len(names & x86_secs)
    if esp32_hits > arm_hits and esp32_hits > x86_hits: return 'esp32'
    if x86_hits >= 2:                                   return 'x86-64'
    if arm_hits > 0:                                    return 'arm'
    return 'arm'


def parse_map(content, arch=None):
    """
    Parse a GCC .map file.

    Parameters
    ----------
    content : str  — raw text of the .map file
    arch    : str  — 'arm', 'esp32', or None (auto-detect from section names)

    Returns dict with: sections, symbols, discarded, summary
    """
    content = content.replace('\r\n', '\n').replace('\r', '\n')
    sections  = _parse_sections(content)
    discarded = _parse_discarded(content)

    # Detect architecture if not specified
    if arch is None:
        arch = _detect_arch(sections)

    section_map = (_ESP32_SECTION_CLASS  if arch == 'esp32'
                  else _X86_64_SECTION_CLASS if arch in ('x86-64','x86-32')
                  else _ARM_SECTION_CLASS)

    symbols = _extract_symbols(sections)
    summary = _make_summary(sections, section_map, arch)

    return {
        'sections':  sections,
        'symbols':   symbols,
        'discarded': discarded,
        'summary':   summary,
        'arch':      arch,
    }


# ── Internal parsers ─────────────────────────────────────────────────────────

def _parse_sections(content):
    sections, current = [], None
    start = 0
    map_start = re.search(r'^Linker script and memory map', content, re.MULTILINE)
    if map_start:
        start = map_start.start()
    else:
        fb = re.search(r'^\.(text|data|bss|rodata|iram|dram|flash)', content, re.MULTILINE)
        if fb:
            start = fb.start()

    for line in content[start:].splitlines():
        # Top-level section line: ".name  0xADDR  0xSIZE"
        m = re.match(r'^(\.\S+)\s+(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)\s*$', line)
        if m:
            current = {
                'name':    m.group(1),
                'addr':    int(m.group(2), 16),
                'size':    int(m.group(3), 16),
                'units':   [],
                'symbols': [],
            }
            sections.append(current)
            continue

        # Unit line: "  .sub.section  0xADDR  0xSIZE  path/to/file.obj"
        m = re.match(r'^\s+(\.\S+)\s+(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)\s+(\S+)', line)
        if m and current:
            sz = int(m.group(3), 16)
            if sz > 0:
                current['units'].append({
                    'subsection': m.group(1),
                    'addr':       int(m.group(2), 16),
                    'size':       sz,
                    'file':       _short(m.group(4)),
                    'file_full':  m.group(4),
                })
            continue

        # Symbol line: "  0xADDR  symbol_name"
        m = re.match(r'^\s+(0x[0-9a-fA-F]{4,})\s+(\S+)\s*$', line)
        if m and current:
            name = m.group(2)
            if not name.startswith('0x') and not name.startswith('.'):
                current['symbols'].append({
                    'name': name,
                    'addr': int(m.group(1), 16),
                })

    return [s for s in sections if s['size'] > 0]


def _parse_discarded(content):
    disc, in_disc = [], False
    for line in content.splitlines():
        if 'Discarded input sections' in line:
            in_disc = True
            continue
        if not in_disc:
            continue
        if not line.strip():
            continue
        m = re.match(r'\s+(\.\S+)\s+0x\S+\s+0x\S+\s+(\S+)', line)
        if m:
            disc.append({
                'name':      m.group(1),
                'file':      _short(m.group(2)),
                'file_full': m.group(2),
            })
        elif line and line[0] not in ' \t':
            in_disc = False
    return disc


def _extract_symbols(sections):
    syms = []
    for sec in sections:
        for s in sec.get('symbols', []):
            syms.append({
                'name':    s['name'],
                'addr':    s['addr'],
                'size':    0,
                'section': sec['name'],
                'file':    '',
            })
        for u in sec.get('units', []):
            syms.append({
                'name':    u['subsection'],
                'addr':    u['addr'],
                'size':    u['size'],
                'section': sec['name'],
                'file':    u['file'],
            })
    return syms


def _make_summary(sections, section_map, arch):
    by_file = {}
    total_flash = total_ram = 0

    for sec in sections:
        cls = _classify(sec['name'], section_map)
        if cls == 'ignore':
            continue
        is_flash = cls in ('flash', 'both')
        is_ram   = cls in ('ram',   'both')

        for u in sec.get('units', []):
            f = u['file']
            if f not in by_file:
                by_file[f] = {'file': f, 'flash': 0, 'ram': 0, 'total': 0}
            if is_flash:
                by_file[f]['flash'] += u['size']
                total_flash          += u['size']
            if is_ram:
                by_file[f]['ram']   += u['size']
                total_ram            += u['size']
            # Only count flash+ram in total (not debug/comment/ignore sections)
            if is_flash or is_ram:
                by_file[f]['total'] += u['size']

    # Sort by flash first, then RAM — most flash-heavy files appear first
    ranked = sorted(by_file.values(), key=lambda x: -(x['flash'] + x['ram']))
    # Remove entries with zero contribution (came from ignored sections only)
    ranked = [r for r in ranked if r['flash'] > 0 or r['ram'] > 0]
    return {
        'total_flash': total_flash,
        'total_ram':   total_ram,
        'by_file':     ranked[:500],   # raised from 80; large projects need more
        'arch':        arch,
    }


def _short(p):
    p = p.replace('\\', '/')
    parts = [x for x in p.split('/') if x]
    return '/'.join(parts[-2:]) if len(parts) > 2 else p
