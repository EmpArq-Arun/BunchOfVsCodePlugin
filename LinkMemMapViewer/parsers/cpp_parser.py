"""
C++ ELF artifact analysis — vtables, RTTI, exceptions, templates, PLT/GOT.

Handles BOTH:
  - Native Linux x86/x86_64 binaries (built with gcc/g++/clang++)
  - Cross-compiled C++ (ARM/ESP32 built with arm-none-eabi-g++ etc.)

Key differences between native and cross-compiled artefacts:
  - Native: PIE base address (usually 0x0 or 0x400000), dynamic sections present
  - Native: PLT/GOT for shared library calls (cross-compiled usually has none)
  - Cross: fixed flash/RAM addresses; no dynamic linker needed
  - Both: same ABI name mangling (_ZTV*, _ZTI*, _ZTS*, etc.)
  - Both: same .eh_frame / .gcc_except_table exception format
"""
import re, subprocess, shutil
from collections import defaultdict


# ── Symbol demangling ─────────────────────────────────────────────────────────

def demangle_batch(mangled_names, cxxfilt_path='c++filt'):
    """
    Demangle a list of C++ mangled names using c++filt.
    Returns a dict {mangled -> demangled}.
    Falls back gracefully if c++filt is not available.
    """
    if not mangled_names:
        return {}

    tool = cxxfilt_path or 'c++filt'
    if not shutil.which(tool):
        # Try common alternatives
        for alt in ['c++filt', 'arm-none-eabi-c++filt', 'xtensa-esp-elf-c++filt']:
            if shutil.which(alt):
                tool = alt
                break
        else:
            # No demangler available — return identity mapping
            return {n: n for n in mangled_names}

    try:
        inp = '\n'.join(mangled_names)
        r = subprocess.run(
            [tool], input=inp, capture_output=True, text=True, timeout=10
        )
        demangled = r.stdout.strip().split('\n')
        if len(demangled) == len(mangled_names):
            return dict(zip(mangled_names, demangled))
    except Exception:
        pass
    return {n: n for n in mangled_names}


def _is_mangled(name):
    """Return True if the name looks like a C++ mangled symbol."""
    return bool(name) and (
        name.startswith('_Z') or name.startswith('__Z')
    )


# ── Vtable extraction ────────────────────────────────────────────────────────

# _ZTV<name>  = vtable for <class>
# _ZTI<name>  = typeinfo for <class>
# _ZTS<name>  = typeinfo name (string) for <class>
# _ZTT<name>  = VTT for <class> (virtual base construction)
# _ZTC<name>  = construction vtable
# _ZTc        = covariant return thunk
# _ZTh/_ZTv   = virtual/non-virtual thunk

_VTABLE_RE     = re.compile(r'^_ZTV(.+)$')
_TYPEINFO_RE   = re.compile(r'^_ZTI(.+)$')
_TYPEINFONAME_RE = re.compile(r'^_ZTS(.+)$')
_VTT_RE        = re.compile(r'^_ZTT(.+)$')


def extract_vtable_info(symbols, demangle_map):
    """
    Extract vtable layout and class hierarchy from ELF symbols.

    Returns:
        {
          'classes': [
            {
              'mangled':   '_ZTV6MyClass',
              'name':      'MyClass',
              'demangled': 'vtable for MyClass',
              'vtable_size': 128,
              'addr':      0x804abc0,
              'has_typeinfo': True,
              'typeinfo_name': 'MyClass',
              'parent_typeinfo': ['_ZTI9BaseClass'],  # from typeinfo struct
              'is_polymorphic': True,
            }
          ],
          'rtti_tree': [...],  # parent → [children] adjacency
        }
    """
    classes = {}
    typeinfo_names = {}
    vtts = {}

    for sym in symbols:
        name = sym.get('name', '')
        addr = sym.get('addr', 0)
        size = sym.get('size', 0)

        m = _VTABLE_RE.match(name)
        if m:
            mangled_class = m.group(1)
            dm = demangle_map.get(name, name)
            # dm is like "vtable for MyClass"
            class_name = dm.replace('vtable for ', '').strip() if 'vtable for' in dm else mangled_class
            classes[mangled_class] = {
                'vtable_sym':    name,
                'name':          class_name,
                'demangled_vtable': dm,
                'vtable_size':   size,
                'vtable_addr':   addr,
                'has_typeinfo':  False,
                'typeinfo_name': None,
                'virt_func_count': max(0, (size - 16) // 8) if size >= 16 else 0,
                # 16 bytes overhead: 8 byte offset-to-top + 8 byte typeinfo ptr
                # Each virtual function entry is 8 bytes (64-bit) or 4 bytes (32-bit)
                # We use 8 as a safe default for x86-64; ARM Cortex-M uses 4
                'is_polymorphic': True,
                'parents': [],
            }
            continue

        m = _TYPEINFO_RE.match(name)
        if m:
            mangled_class = m.group(1)
            dm = demangle_map.get(name, name)
            class_name = dm.replace('typeinfo for ', '').strip() if 'typeinfo for' in dm else mangled_class
            if mangled_class in classes:
                classes[mangled_class]['has_typeinfo'] = True
                classes[mangled_class]['typeinfo_name'] = class_name
            else:
                classes[mangled_class] = {
                    'vtable_sym':    None,
                    'name':          class_name,
                    'demangled_vtable': None,
                    'vtable_size':   0,
                    'vtable_addr':   0,
                    'has_typeinfo':  True,
                    'typeinfo_name': class_name,
                    'virt_func_count': 0,
                    'is_polymorphic': False,
                    'parents': [],
                }
            continue

        m = _TYPEINFONAME_RE.match(name)
        if m:
            mangled_class = m.group(1)
            dm = demangle_map.get(name, name)
            type_name = dm.replace('typeinfo name for ', '').strip() if 'typeinfo name for' in dm else mangled_class
            typeinfo_names[mangled_class] = type_name

    # Enrich with typeinfo names
    for mc, info in classes.items():
        if mc in typeinfo_names:
            info['typeinfo_name'] = typeinfo_names[mc]

    return {
        'classes': sorted(classes.values(), key=lambda c: c['name']),
        'class_count': len(classes),
    }


# ── Template instantiation analysis ─────────────────────────────────────────

def extract_template_info(symbols, demangle_map):
    """
    Group symbols by template family to show instantiation counts and sizes.

    Returns:
        [{'template': 'std::vector<T>', 'instantiations': [...], 'total_size': N}]
    """
    # Template instantiations have '<' in their demangled name
    templates = defaultdict(list)

    for sym in symbols:
        name = sym.get('name', '')
        if not _is_mangled(name):
            continue
        dm = demangle_map.get(name, name)
        if '<' not in dm:
            continue

        # Extract base template name (before first '<')
        base = dm.split('<')[0].strip()
        # Remove leading return type if any (strip trailing space-word)
        if ' ' in base:
            parts = base.rsplit(' ', 1)
            # Keep if looks like a qualified name
            if '::' in parts[-1] or parts[-1][0].isupper():
                base = parts[-1]
            else:
                base = base

        templates[base].append({
            'demangled':  dm,
            'mangled':    name,
            'size':       sym.get('size', 0),
            'type':       sym.get('type', ''),
            'section':    sym.get('section') or '',
        })

    result = []
    for tmpl, insts in sorted(templates.items(), key=lambda x: -sum(i['size'] for i in x[1])):
        total = sum(i['size'] for i in insts)
        result.append({
            'template':       tmpl,
            'count':          len(insts),
            'total_size':     total,
            'instantiations': sorted(insts, key=lambda x: -x['size'])[:20],
        })

    return result[:50]  # Top 50 template families by total size


# ── C++ symbol classification ────────────────────────────────────────────────

# Regex patterns for C++ ABI symbol prefixes
_CPP_CATEGORIES = [
    ('vtable',         re.compile(r'^_ZTV')),            # vtable for class
    ('vtt',            re.compile(r'^_ZTT')),            # VTT (virtual table table)
    ('typeinfo',       re.compile(r'^_ZTI')),            # typeinfo object
    ('typeinfo_name',  re.compile(r'^_ZTS')),            # typeinfo name string
    ('thunk',          re.compile(r'^_ZT[chv]')),        # thunks (covariant/virtual)
    ('guard',          re.compile(r'^_ZGV')),            # static variable guard
    ('cxa_runtime',    re.compile(r'^__cxa_')),          # C++ ABI runtime calls
    ('operator_new',   re.compile(r'^_Znw|^_Zna')),     # operator new
    ('operator_del',   re.compile(r'^_Zdl|^_Zda')),     # operator delete
    ('ctor',           re.compile(r'^_ZN.*C[12]E')),     # constructors
    ('dtor',           re.compile(r'^_ZN.*D[012]E')),    # destructors
    ('member_fn',      re.compile(r'^_ZN')),             # class member functions
    ('namespace_fn',   re.compile(r'^_ZL')),             # anonymous namespace functions
    ('global_fn',      re.compile(r'^_Z[^TNLG]')),      # other mangled globals
]

_CATEGORY_LABELS = {
    'vtable':        ('🗂',  'V-Table',        '#3b82f6'),
    'vtt':           ('🗂',  'VTT',            '#6366f1'),
    'typeinfo':      ('🔖',  'RTTI typeinfo',  '#8b5cf6'),
    'typeinfo_name': ('🏷',  'RTTI name',      '#a78bfa'),
    'thunk':         ('⤵',  'Thunk',          '#ec4899'),
    'guard':         ('🔒',  'Static guard',   '#f59e0b'),
    'cxa_runtime':   ('⚙',  'CXA runtime',    '#ef4444'),
    'operator_new':  ('➕',  'operator new',   '#10b981'),
    'operator_del':  ('➖',  'operator delete','#6ee7b7'),
    'ctor':          ('🔨',  'Constructor',    '#34d399'),
    'dtor':          ('🗑',  'Destructor',     '#f87171'),
    'member_fn':     ('📐',  'Member fn',      '#60a5fa'),
    'namespace_fn':  ('📎',  'Anon-NS fn',     '#94a3b8'),
    'global_fn':     ('🌐',  'Global fn',      '#cbd5e1'),
}

def classify_cpp_symbol(mangled):
    """Return category key for a C++ mangled symbol, or None if not C++."""
    if not _is_mangled(mangled):
        return None
    for cat, pat in _CPP_CATEGORIES:
        if pat.match(mangled):
            return cat
    return 'global_fn'


# ── Exception handler table analysis ────────────────────────────────────────

def analyse_exception_sections(sections):
    """
    Summarise C++ exception handling overhead from section info.

    .eh_frame        — DWARF CFI records for stack unwinding (all functions)
    .eh_frame_hdr    — binary search index into .eh_frame
    .gcc_except_table — LSDA (Language Specific Data Area) for try/catch/finally
    .ARM.exidx        — ARM EHABI index table (ARM only)
    .ARM.extab        — ARM EHABI exception unwind data (ARM only)

    Returns:
        {
          'total_bytes': N,
          'sections': [{'name':..., 'size':..., 'note':...}],
          'note': 'Exception handling adds N KB to the binary.'
        }
    """
    EH_SECTIONS = {
        '.eh_frame':          'DWARF CFI — stack unwind records for all functions with -g',
        '.eh_frame_hdr':      'Binary search index into .eh_frame (runtime lookup speedup)',
        '.gcc_except_table':  'LSDA — try/catch landing pad addresses and type filters',
        '.ARM.exidx':         'ARM EHABI compact unwind index (replaces .eh_frame on ARM)',
        '.ARM.extab':         'ARM EHABI extended unwind data for complex frames',
        '.except_table':      'Exception table (alternative name, some toolchains)',
    }

    found = []
    total = 0
    for sec in (sections or []):
        n = sec.get('name', '')
        for eh_name, note in EH_SECTIONS.items():
            if n == eh_name or n.startswith(eh_name):
                size = sec.get('size', 0)
                found.append({'name': n, 'size': size, 'note': note})
                total += size
                break

    return {
        'total_bytes': total,
        'sections':    sorted(found, key=lambda x: -x['size']),
        'note': f'Exception handling overhead: {total:,} bytes ({total/1024:.1f} KB)' if total else 'No exception sections found (binary may use -fno-exceptions)',
    }


# ── PLT / GOT analysis (native Linux only) ───────────────────────────────────

def analyse_dynamic_sections(sections, symbols):
    """
    Analyse PLT/GOT and dynamic linking overhead.

    Relevant for native Linux binaries that link shared libraries.
    Cross-compiled firmware typically has no PLT/GOT.

    .plt      — Procedure Linkage Table: thunks for dynamically-linked functions
    .got      — Global Offset Table: relocated pointers patched by ld.so
    .got.plt  — GOT entries for PLT (initially points to PLT resolver)
    .plt.got  — PLT entries for GOT-referenced symbols
    .plt.sec  — PLT stubs for IBT (Indirect Branch Tracking, CET)
    .rela.plt — Relocation entries for PLT slots
    .rela.dyn — Relocation entries for dynamic data symbols
    .dynamic  — Dynamic section (ld.so metadata)
    .dynsym   — Dynamic symbol table (exported + imported symbols)
    .dynstr   — String table for dynamic symbols
    .gnu.version — Symbol versioning
    .interp   — Path to the dynamic linker (ld-linux.so.2)
    """
    DYNAMIC_SECTIONS = {
        '.plt':       ('PLT', 'Procedure Linkage Table — one 16-byte stub per imported function'),
        '.got':       ('GOT', 'Global Offset Table — relocated data pointers'),
        '.got.plt':   ('GOT.PLT', 'GOT entries for PLT; 8 bytes each (lazy binding)'),
        '.plt.got':   ('PLT.GOT', 'PLT entries for GOT-indirect calls'),
        '.plt.sec':   ('PLT.SEC', 'IBT-enabled PLT stubs (CET security)'),
        '.rela.plt':  ('RELA.PLT', 'PLT relocation entries — one per imported symbol'),
        '.rela.dyn':  ('RELA.DYN', 'Data relocation entries (global variables, vtable ptrs)'),
        '.dynamic':   ('DYNAMIC', 'Dynamic section — metadata for ld.so'),
        '.dynsym':    ('DYNSYM', 'Dynamic symbol table (exported + undefined symbols)'),
        '.dynstr':    ('DYNSTR', 'String table for dynamic symbol names'),
        '.interp':    ('INTERP', 'Dynamic linker path (e.g. /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2)'),
        '.gnu.version': ('VERSYM', 'Symbol version requirements'),
    }

    found = []
    total = 0
    is_dynamic = any(sec.get('name', '') == '.plt' or sec.get('name', '') == '.dynamic'
                     for sec in (sections or []))

    for sec in (sections or []):
        n = sec.get('name', '')
        if n in DYNAMIC_SECTIONS:
            tag, note = DYNAMIC_SECTIONS[n]
            size = sec.get('size', 0)
            found.append({'name': n, 'tag': tag, 'size': size, 'note': note})
            total += size

    # Count imported functions from PLT (each PLT entry = 16 bytes on x86-64)
    plt_sec = next((s for s in found if s['name'] == '.plt'), None)
    plt_count = max(0, (plt_sec['size'] - 16) // 16) if plt_sec else 0
    # First 16 bytes of PLT is the PLT0 resolver stub

    return {
        'is_dynamic': is_dynamic,
        'total_bytes': total,
        'sections': sorted(found, key=lambda x: -x['size']),
        'plt_entry_count': plt_count,
        'note': f'Dynamic linking: {plt_count} imported functions via PLT ({total/1024:.1f} KB overhead)' if is_dynamic else 'Static binary — no PLT/GOT (self-contained)',
    }


# ── Constructor/destructor ordering ─────────────────────────────────────────

def extract_init_order(symbols, sections, demangle_map):
    """
    Extract the order of global constructors and destructors.

    .init_array — array of pointers to __attribute__((constructor)) functions
                  and global C++ object constructors, in link order
    .fini_array — array of pointers to __attribute__((destructor)) functions
                  and global C++ object destructors (reverse of .init_array)
    .ctors/.dtors — older GCC format (still used by some toolchains)

    Returns:
        {
          'init_syms': [{'name': ..., 'demangled': ..., 'section': ...}],
          'fini_syms': [...],
          'note': '...'
        }
    """
    init_syms = []
    fini_syms = []

    # Collect all constructor/destructor symbols
    for sym in (symbols or []):
        sec = sym.get('section') or ''
        name = sym.get('name', '')
        dm = demangle_map.get(name, name)

        if sec in ('.init_array', '.ctors') or '__init_array' in sec:
            init_syms.append({'name': name, 'demangled': dm,
                              'size': sym.get('size', 0), 'addr': sym.get('addr', 0),
                              'section': sec})
        elif sec in ('.fini_array', '.dtors') or '__fini_array' in sec:
            fini_syms.append({'name': name, 'demangled': dm,
                              'size': sym.get('size', 0), 'addr': sym.get('addr', 0),
                              'section': sec})

    # Also find global constructors by naming convention
    for sym in (symbols or []):
        name = sym.get('name', '')
        dm = demangle_map.get(name, name)
        t = sym.get('type', '')
        if t == 'function' and ('_GLOBAL__I_' in name or '_GLOBAL__sub_I_' in name):
            init_syms.append({'name': name, 'demangled': dm,
                              'size': sym.get('size', 0), 'addr': sym.get('addr', 0),
                              'section': sym.get('section') or '.init_array',
                              'note': 'Module-level constructor (file initialiser)'})
        elif t == 'function' and '_GLOBAL__D_' in name:
            fini_syms.append({'name': name, 'demangled': dm,
                              'size': sym.get('size', 0), 'addr': sym.get('addr', 0),
                              'section': sym.get('section') or '.fini_array',
                              'note': 'Module-level destructor'})

    return {
        'init_syms': sorted(init_syms, key=lambda x: x['addr']),
        'fini_syms': sorted(fini_syms, key=lambda x: x['addr']),
        'note': f'{len(init_syms)} global constructors, {len(fini_syms)} global destructors run before/after main().'
    }


# ── Top-level analysis entry point ───────────────────────────────────────────

def analyse_cpp(symbols, sections, cxxfilt_path='c++filt'):
    """
    Run the full C++ artifact analysis pipeline.

    Parameters
    ----------
    symbols  : list of dicts from elf_parser.analyse_elf() — name/addr/size/type/section
    sections : list of dicts from ld_parser.parse_linker_script() or from readelf
    cxxfilt_path : path to the c++filt demangler

    Returns
    -------
    {
      'is_cpp':        bool,
      'demangled':     {mangled -> demangled},
      'vtables':       {...},
      'templates':     [...],
      'exceptions':    {...},
      'dynamic':       {...},
      'init_order':    {...},
      'sym_categories': {category -> [symbols]},
      'summary':       {...},
    }
    """
    # Step 1: find all mangled names
    mangled = [s['name'] for s in (symbols or []) if _is_mangled(s.get('name', ''))]
    is_cpp = len(mangled) > 0

    if not is_cpp:
        return {
            'is_cpp': False,
            'note': 'No C++ mangled symbols found. Binary appears to be pure C.',
        }

    # Step 2: demangle in one batch call
    dm_map = demangle_batch(mangled, cxxfilt_path)

    # Step 3: classify all C++ symbols
    categories = defaultdict(list)
    for sym in (symbols or []):
        name = sym.get('name', '')
        cat = classify_cpp_symbol(name)
        if cat:
            entry = {**sym, 'demangled': dm_map.get(name, name), 'category': cat}
            categories[cat].append(entry)
        # Inject demangled name into every symbol for the symbol table
        if name in dm_map:
            sym['demangled'] = dm_map[name]

    # Step 4: run sub-analyses
    vtable_info   = extract_vtable_info(symbols, dm_map)
    template_info = extract_template_info(symbols, dm_map)
    exc_info      = analyse_exception_sections(sections)
    dyn_info      = analyse_dynamic_sections(sections, symbols)
    init_info     = extract_init_order(symbols, sections, dm_map)

    # Step 5: build summary
    vtable_size = sum(c.get('vtable_size', 0) for c in vtable_info['classes'])
    exc_size    = exc_info['total_bytes']
    dyn_size    = dyn_info['total_bytes']
    n_ctors     = sum(1 for s in symbols if classify_cpp_symbol(s.get('name','')) == 'ctor')
    n_dtors     = sum(1 for s in symbols if classify_cpp_symbol(s.get('name','')) == 'dtor')
    n_vtables   = vtable_info['class_count']
    n_templates = sum(t['count'] for t in template_info)

    summary = {
        'mangled_count':   len(mangled),
        'class_count':     n_vtables,
        'vtable_bytes':    vtable_size,
        'exception_bytes': exc_size,
        'dynamic_bytes':   dyn_size,
        'ctor_count':      n_ctors,
        'dtor_count':      n_dtors,
        'template_instantiations': n_templates,
        'plt_imports':     dyn_info['plt_entry_count'],
    }

    return {
        'is_cpp':          True,
        'demangled':       dm_map,
        'vtables':         vtable_info,
        'templates':       template_info,
        'exceptions':      exc_info,
        'dynamic':         dyn_info,
        'init_order':      init_info,
        'sym_categories':  dict(categories),
        'category_meta':   _CATEGORY_LABELS,
        'summary':         summary,
    }
