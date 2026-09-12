"""
isr_parser.py — Interrupt Service Routine (ISR) health analysis.

Works at three data levels, each adding more detail:
  Level 0 (ELF only)       — ISR identification, code-size estimate, section
  Level 1 (+ .su files)    — Own stack frame per ISR + hardware context overhead
  Level 2 (+ .ci callgraph) — Full worst-case stack depth including call tree

Key concepts:
  • "ISR stack budget" = hardware_context_save + own_frame + call_chain_depth
  • Hardware context save is invisible in .su files — it's extra bytes the CPU
    (or OS) pushes BEFORE the ISR body even begins. Arch-specific constants below.
  • Re-entrancy: ISRs must not call functions that can block, allocate heap, or
    acquire non-ISR-safe mutexes. Hazard detection checks the call tree for these.
  • Nesting: on ARM Cortex-M with PRIMASK=0, a higher-priority ISR can preempt
    a lower-priority one — each active ISR consumes its full stack budget simultaneously.
"""
import re
from collections import defaultdict

# ── Hardware context-save overhead per architecture ───────────────────────────
# These bytes are pushed BEFORE the compiler-generated prologue runs, so they
# will NEVER appear in .su frame size output. Must be added on top.
HW_CONTEXT_OVERHEAD = {
    # ARM Cortex-M (EXC_ENTRY, no FPU)
    # CPU auto-saves: R0–R3, R12, LR, PC, xPSR = 8 regs × 4 bytes = 32 bytes
    'arm':          {'no_fpu': 32, 'fpu_lazy': 104, 'default': 32,
                     'note': 'ARM auto-saves R0–R3, R12, LR, PC, xPSR (32 B). '
                             'FPU lazy stacking adds up to 72 B more (S0–S15 + FPSCR).'},
    # ESP32 Xtensa
    # Xtensa window call ABI: saves a0–a15 (16 regs × 4 B = 64 B) plus
    # special registers (SAR, LCOUNT, LBEG, LEND, PS, PC) = ~96–176 B total.
    # Typical interrupt wrapper saves ~160 B including aligning the stack.
    'esp32-xtensa': {'no_fpu': 160, 'default': 160,
                     'note': 'Xtensa ISR wrapper saves a0–a15 + special regs (~160 B).'},
    # ESP32-C3/C6/H2/P4 (RISC-V)
    # RISC-V saves all 32 registers (x0–x31) on interrupt entry = 32 × 4 = 128 B
    # plus mstatus, mepc, mcause, mtval CSRs = 128 + 16 = 144 B typical.
    'esp32-riscv':  {'no_fpu': 144, 'default': 144,
                     'note': 'RISC-V saves all 32 GPRs + CSRs on interrupt entry (~144 B).'},
    # Native Linux x86-64 (signal handlers — different model)
    # The kernel saves the full sigcontext (ucontext_t) on the user stack:
    # ~580 bytes including general regs, FP state, signal mask.
    'x86-64':       {'no_fpu': 580, 'default': 580,
                     'note': 'Linux kernel saves full ucontext_t (~580 B) for signal handlers. '
                             'Hardware interrupt handlers run in kernel space — not visible here.'},
    'x86-32':       {'no_fpu': 320, 'default': 320,
                     'note': 'Linux 32-bit signal handler context save (~320 B).'},
}

# ── ISR naming conventions per architecture ──────────────────────────────────
# Order matters: more specific patterns first, generic last.
ISR_PATTERNS = {
    'arm': [
        # CMSIS standard handler names
        re.compile(r'^(NMI|HardFault|MemManage|BusFault|UsageFault|SVC|DebugMon|PendSV|SysTick)_Handler$'),
        # Peripheral IRQ handlers (any name ending in _IRQHandler)
        re.compile(r'^.+_IRQHandler$'),
        # FreeRTOS port ISRs
        re.compile(r'^vPort.+ISR$'),
        re.compile(r'^xPortSysTickHandler$'),
        # HAL IRQ handlers
        re.compile(r'^HAL_.+IRQHandler$'),
        # Generic ISR suffix patterns
        re.compile(r'^.+[_-](?:ISR|isr|irq|IRQ|interrupt|Interrupt)$'),
        re.compile(r'^(?:ISR|isr)_.+$'),
    ],
    'esp32-xtensa': [
        re.compile(r'^.+_isr(?:_handler)?$', re.IGNORECASE),
        re.compile(r'^.+_interrupt_handler$', re.IGNORECASE),
        re.compile(r'^esp_intr_.+$'),
        re.compile(r'^IRAM_ATTR$'),   # This is a section attr, matched by section instead
        re.compile(r'^.+[_-](?:ISR|isr|irq|IRQ)$'),
    ],
    'esp32-riscv': [
        re.compile(r'^.+_isr(?:_handler)?$', re.IGNORECASE),
        re.compile(r'^.+_interrupt_handler$', re.IGNORECASE),
        re.compile(r'^.+[_-](?:ISR|isr|irq|IRQ)$'),
    ],
    'x86-64': [
        # Linux signal handlers registered via sigaction
        re.compile(r'^.+(?:_sig(?:handler|action)|_signal_handler)$', re.IGNORECASE),
        re.compile(r'^(?:sig|signal)_.+(?:handler|action)$', re.IGNORECASE),
        # Generic
        re.compile(r'^.+[_-](?:ISR|isr|irq|IRQ)$'),
    ],
    'x86-32': [
        re.compile(r'^.+(?:_sig(?:handler|action)|_signal_handler)$', re.IGNORECASE),
        re.compile(r'^.+[_-](?:ISR|isr|irq|IRQ)$'),
    ],
}
# Fallback generic patterns used when no arch-specific match found
ISR_PATTERNS_GENERIC = [
    re.compile(r'^.+_IRQHandler$'),
    re.compile(r'^.+(?:_isr|_ISR|_irq|_IRQ)$'),
    re.compile(r'^(?:isr|ISR)_.+$'),
    re.compile(r'^(?:NMI|HardFault|SysTick|PendSV|SVC)_Handler$'),
]

# ── Functions dangerous to call from an ISR ──────────────────────────────────
HAZARDOUS_FUNCS = {
    # Dynamic memory allocation — heap operations use locks; not ISR-safe
    'malloc':       ('heap',    'error',  'Heap allocation from ISR can deadlock if ISR preempts malloc'),
    'free':         ('heap',    'error',  'Heap free from ISR can corrupt heap if ISR preempts malloc'),
    'calloc':       ('heap',    'error',  'Heap allocation from ISR not ISR-safe'),
    'realloc':      ('heap',    'error',  'Heap allocation from ISR not ISR-safe'),
    'pvPortMalloc': ('heap',    'error',  'FreeRTOS heap alloc — use pvPortMallocFromISR if it exists'),
    'vPortFree':    ('heap',    'error',  'FreeRTOS heap free — not ISR-safe'),
    # RTOS blocking calls
    'xSemaphoreTake':    ('rtos', 'error',  'Blocking semaphore take — use xSemaphoreTakeFromISR'),
    'xQueueReceive':     ('rtos', 'error',  'Blocking queue recv — use xQueueReceiveFromISR'),
    'xQueueSend':        ('rtos', 'warn',   'Blocking queue send — use xQueueSendFromISR'),
    'osMutexAcquire':    ('rtos', 'error',  'CMSIS-RTOS mutex acquire blocks — not ISR-safe'),
    'vTaskDelay':        ('rtos', 'error',  'vTaskDelay blocks — never call from ISR'),
    'vTaskDelayUntil':   ('rtos', 'error',  'vTaskDelayUntil blocks — never call from ISR'),
    'osDelay':           ('rtos', 'error',  'CMSIS-RTOS delay — never call from ISR'),
    'ulTaskNotifyTake':  ('rtos', 'warn',   'Blocking notify — use ulTaskNotifyTakeFromISR'),
    # Slow I/O — not strictly forbidden but degrade ISR latency severely
    'printf':       ('io',     'warn',   'printf holds locks internally and is extremely slow from ISR'),
    'fprintf':      ('io',     'warn',   'fprintf holds locks — avoid in ISR'),
    'sprintf':      ('io',     'warn',   'sprintf is usually safe but large; prefer snprintf'),
    'puts':         ('io',     'warn',   'stdout I/O from ISR degrades latency'),
    'fwrite':       ('io',     'warn',   'File I/O from ISR'),
    # HAL delays
    'HAL_Delay':    ('delay',  'error',  'HAL_Delay spins waiting for SysTick — deadlocks if called from SysTick ISR'),
    # __errno_location uses TLS — usually fine on bare-metal, risky with RTOS
    '__errno_location': ('tls', 'info', 'errno access uses thread-local storage — verify RTOS stack config'),
}


def _is_isr(func_name, arch):
    """Return True if func_name matches ISR naming conventions for arch."""
    patterns = ISR_PATTERNS.get(arch, []) + ISR_PATTERNS_GENERIC
    return any(p.match(func_name) for p in patterns)


def _priority_from_name(func_name):
    """
    Heuristically infer ISR priority class from name.
    Returns one of: 'fault', 'system', 'nmi', 'peripheral', 'user', 'unknown'.
    """
    n = func_name.lower()
    if 'hardfault' in n or 'busfault' in n or 'memmanage' in n or 'usagefault' in n:
        return 'fault'
    if 'nmi' in n:
        return 'nmi'
    if 'systick' in n or 'pendsv' in n or 'svc' in n:
        return 'system'
    if any(x in n for x in ('tim', 'uart', 'spi', 'i2c', 'can', 'adc', 'dma', 'eth', 'usb', 'exti', 'gpio', 'intr')):
        return 'peripheral'
    return 'unknown'


def _estimate_cycles(code_size_bytes, arch):
    """
    Rough cycle count estimate from code size.
    Assumes average instruction density — very approximate but useful for
    relative comparison between ISRs.
    """
    if not code_size_bytes:
        return None
    # Average bytes per instruction per ISA
    avg_bytes_per_insn = {'arm': 3.0, 'esp32-xtensa': 3.5, 'esp32-riscv': 3.5,
                          'x86-64': 4.5, 'x86-32': 4.0}.get(arch, 4.0)
    # Average cycles per instruction (pipeline, cache hit assumed)
    avg_cpi = {'arm': 1.5, 'esp32-xtensa': 2.0, 'esp32-riscv': 1.5,
               'x86-64': 1.3, 'x86-32': 1.5}.get(arch, 1.5)
    estimated_insns = code_size_bytes / avg_bytes_per_insn
    return round(estimated_insns * avg_cpi)


def detect_isrs(symbols, ld_sections=None, arch='arm'):
    """
    Identify ISR candidates from the symbol table and linker sections.

    Strategy:
      1. Function symbols matching ISR naming patterns (primary signal)
      2. Symbols in fast-memory sections that handle interrupts
         (.iram0.vectors, .isr_vector, .int_vector, ITCM sections, etc.)
      3. Symbols in exception-handler sections

    Parameters
    ----------
    symbols     : list of dicts from elf_parser.analyse_elf() + assign_symbols()
    ld_sections : list of LD section dicts (for fast-memory classification)
    arch        : architecture string ('arm', 'esp32-xtensa', etc.)

    Returns
    -------
    list of dicts:
        {func_name, section, addr, code_size, priority_class,
         in_fast_mem, detection_reason}
    """
    # Sections that strongly indicate ISR/vector content
    VECTOR_SECTIONS = {
        '.isr_vector', '.vectors', '.int_vector', '.interrupts',
        '.ARM.excep', '.exception_handlers', 'EXCEPTIONS',
        '.iram0.vectors',              # ESP32 Xtensa
        '.init_array',                 # constructor ISR wrappers (check carefully)
    }
    # Fast-memory sections (ISR code must live here for low latency)
    FAST_MEM_SECTIONS = {
        '.itcm', '.itcm_code', '.ramcode', '.fastcode',
        '.iram0.text', '.iram.text',   # ESP32 Xtensa/RISC-V
        '.iram0.bss',
    }
    all_fast = FAST_MEM_SECTIONS | VECTOR_SECTIONS

    # Build a set of fast/vector section names from LD data
    fast_sec_names = all_fast.copy()
    if ld_sections:
        for sec in ld_sections:
            n = sec.get('name', '')
            t = sec.get('type', '').lower()
            if any(k in n.lower() for k in ('isr', 'vector', 'interrupt', 'itcm', 'iram', 'ramcode', 'fastcode')):
                fast_sec_names.add(n)

    isrs = {}
    for sym in (symbols or []):
        if sym.get('type') != 'function':
            continue
        name    = sym.get('name', '')
        section = sym.get('section') or ''
        addr    = sym.get('addr', 0)
        size    = sym.get('size', 0)

        in_vector  = section in VECTOR_SECTIONS or any(k in section.lower() for k in ('vector', 'isr_vector'))
        in_fast    = section in fast_sec_names or any(k in section.lower() for k in ('iram', 'itcm', 'ramcode', 'fastcode'))
        by_name    = _is_isr(name, arch)

        if not (by_name or in_vector):
            continue

        reason = []
        if by_name:     reason.append('naming convention')
        if in_vector:   reason.append('vector section')
        if in_fast:     reason.append('fast memory')

        if name not in isrs:
            isrs[name] = {
                'func_name':        name,
                'demangled':        sym.get('demangled', name),
                'section':          section,
                'addr':             addr,
                'code_size':        size,
                'priority_class':   _priority_from_name(name),
                'in_fast_mem':      in_fast,
                'detection_reason': ' + '.join(reason),
            }

    return sorted(isrs.values(), key=lambda x: x['addr'])


def _build_call_tree(cg_result, func_name, max_depth=20):
    """
    Return ordered list of callee names in worst-case path, up to max_depth.
    Uses cgResult.paths if available, otherwise cgResult.worst_case dict.
    """
    if not cg_result:
        return []
    # cgResult from callgraph_parser: {worst_case:{name:int}, paths:{name:list}}
    paths = cg_result.get('paths') or {}
    if func_name in paths:
        return paths[func_name][:max_depth]
    # Fallback: no detailed path, just return empty
    return []


def analyse_isr_health(isrs, su_entries, cg_result, arch='arm'):
    """
    Enrich ISR list with stack, depth, hazard, and processing data.

    Parameters
    ----------
    isrs        : list from detect_isrs()
    su_entries  : SU_DATA.entries — [{func, size, type, file, line}]
    cg_result   : SU_DATA.cgResult — from /analyse_callgraph
    arch        : architecture string

    Returns
    -------
    List of enriched ISR health records, plus a summary dict.
    """
    hw = HW_CONTEXT_OVERHEAD.get(arch, HW_CONTEXT_OVERHEAD['arm'])
    hw_overhead = hw['default']
    hw_note     = hw['note']

    # Build lookup dicts
    su_by_func = {e['func']: e for e in (su_entries or [])}
    # cg_result['worst_case'] = {funcName: {worst_case:int, frame:int, path:list, ...}}
    # Extract the integer byte count from the nested dict.
    wc_by_func   = {}   # {name: int}  — worst-case bytes including call chain
    path_by_func = {}   # {name: list} — deepest callee path
    if cg_result and cg_result.get('worst_case'):
        for fname, entry in cg_result['worst_case'].items():
            if isinstance(entry, dict):
                wc_by_func[fname]   = entry.get('worst_case', 0)
                path_by_func[fname] = entry.get('path', [])
            else:
                wc_by_func[fname] = int(entry)   # handle plain-int fallback

    # All callee names reachable from each ISR (for hazard checking)
    # callgraph_parser stores paths inside worst_case entries, not a top-level 'paths' key.
    callees_by_func = path_by_func

    results = []
    for isr in isrs:
        name = isr['func_name']
        su   = su_by_func.get(name)

        # ── Stack budget ──────────────────────────────────────────────────
        own_frame      = su['size']  if su else None
        frame_type     = su['type']  if su else 'unknown'  # static/dynamic/bounded
        worst_case_wc  = wc_by_func.get(name)  # incl. call chain, excl. hw overhead

        # Total worst-case ISR stack consumption on ARM:
        #   hardware auto-save + ISR own frame + deepest call chain
        # (worst_case from callgraph already includes own_frame, so don't double-count)
        if worst_case_wc is not None:
            total_stack = hw_overhead + worst_case_wc
        elif own_frame is not None:
            total_stack = hw_overhead + own_frame
        else:
            total_stack = None

        # Depth = number of hops in the worst-case path (path includes the ISR itself,
        # so subtract 1).  path_by_func is built from worst_case[name]['path'].
        path = path_by_func.get(name, [])
        call_chain_depth = max(0, len(path) - 1) if path else None

        # ── Processing estimate ───────────────────────────────────────────
        est_cycles   = _estimate_cycles(isr['code_size'], arch)

        # ── Hazard detection ──────────────────────────────────────────────
        hazards = []
        # Check direct calls AND transitive calls through the call tree
        callees = set(callees_by_func.get(name, []))
        # Also walk the worst-case path for transitive hazard checking
        if name in path_by_func:
            callees.update(path_by_func[name])
        # Check if ISR itself or its callees include hazardous functions
        all_funcs_to_check = {name} | callees
        for func in sorted(all_funcs_to_check):
            # Exact match
            if func in HAZARDOUS_FUNCS:
                cat, severity, msg = HAZARDOUS_FUNCS[func]
                hazards.append({'func': func, 'category': cat, 'severity': severity,
                                'msg': msg, 'direct': func == name})
            # Prefix match for common patterns
            elif any(func.startswith(p) for p in ('pvPortMalloc', 'vPortFree', 'xQueue', 'xSemaphore',
                                                    'ulTask', 'xTask', 'vTask', 'osQueue', 'osMutex')):
                # Check if it's an ISR-safe variant
                if any(x in func for x in ('FromISR', '_ISR', 'ISR', 'FROMISR')):
                    pass  # ISR-safe variant — no hazard
                else:
                    hazards.append({'func': func, 'category': 'rtos', 'severity': 'warn',
                                    'msg': f'{func}() may not be ISR-safe; prefer the FromISR variant',
                                    'direct': func == name})

        # Check for dynamic/unbounded own frame
        if frame_type in ('dynamic', 'bounded'):
            hazards.append({'func': name, 'category': 'stack', 'severity': 'warn',
                            'msg': f'ISR has {frame_type} stack frame (VLAs or alloca) — stack depth unpredictable',
                            'direct': True})

        # Check call depth — deep chains from ISR are risky
        if call_chain_depth is not None and call_chain_depth > 5:
            hazards.append({'func': name, 'category': 'depth', 'severity': 'warn',
                            'msg': f'ISR has call depth of {call_chain_depth} — consider flattening',
                            'direct': True})

        results.append({
            **isr,
            'own_frame':         own_frame,
            'frame_type':        frame_type,
            'hw_overhead':       hw_overhead,
            'worst_case_chain':  worst_case_wc,
            'total_stack_budget': total_stack,
            'call_chain_depth':  call_chain_depth,
            'est_cycles':        est_cycles,
            'hazards':           hazards,
            'has_su_data':       su is not None,
            'has_cg_data':       cg_result is not None,
        })

    # ── Summary ──────────────────────────────────────────────────────────────
    with_su     = [r for r in results if r['has_su_data']]
    with_hazard = [r for r in results if r['hazards']]
    with_total  = [r for r in results if r['total_stack_budget'] is not None]
    max_stack   = max((r['total_stack_budget'] for r in with_total), default=0)
    n_errors    = sum(1 for r in results for h in r['hazards'] if h['severity'] == 'error')
    n_warns     = sum(1 for r in results for h in r['hazards'] if h['severity'] == 'warn')
    not_in_fast = [r for r in results if not r['in_fast_mem']]

    summary = {
        'total_isrs':       len(results),
        'with_su_data':     len(with_su),
        'with_hazards':     len(with_hazard),
        'max_total_stack':  max_stack,
        'hw_overhead':      hw_overhead,
        'hw_note':          hw_note,
        'n_errors':         n_errors,
        'n_warns':          n_warns,
        'not_in_fast_mem':  len(not_in_fast),
    }

    return {
        'isrs':    sorted(results, key=lambda x: -(x['total_stack_budget'] or 0)),
        'summary': summary,
        'arch':    arch,
    }
