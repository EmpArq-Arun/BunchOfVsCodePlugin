import { isControlKeyword } from './textUtils';
import { namespaceAt, NamespaceRange } from './namespaceTracker';

export interface RawFunctionSpan {
  name: string;
  className?: string;
  namespace?: string;    // enclosing C++ namespace, e.g. "MyApp::UI"
  signature: string;
  headerStart: number;
  bodyStart: number;
  bodyEnd: number;
  isVirtualLike: boolean;
  isStatic: boolean;    // declared with `static` — file-scoped, cannot be called cross-file in C
  isIsr: boolean;
  isrAttribute: string;
}

// ── ISR detection ────────────────────────────────────────────────────────────
// Patterns checked in the ~300 characters of cleaned source preceding the
// function header (attributes, pragma lines, keyword qualifiers, etc.)
const ISR_PRECEDE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // GCC / Clang __attribute__
  { re: /__attribute__\s*\(\s*\(\s*interrupt/i,            label: '__attribute__((interrupt))' },
  { re: /__attribute__\s*\(\s*\(\s*isr\b/i,                label: '__attribute__((isr))' },
  { re: /__attribute__\s*\(\s*\(\s*vector/i,               label: '__attribute__((vector(...)))' },
  { re: /__attribute__\s*\(\s*\(\s*naked/i,                label: '__attribute__((naked))' },
  // Keil / MDK / IAR / CC-RX / Green Hills
  { re: /\b__irq\b/,                                       label: '__irq' },
  { re: /\b__interrupt\b/,                                  label: '__interrupt' },
  { re: /\b_Interrupt\b/,                                   label: '_Interrupt (Microchip XC)' },
  { re: /\b__near\s+__interrupt\b/i,                       label: '__near __interrupt' },
  { re: /\binterrupt\s+void\b/,                            label: 'interrupt void' },
  // CCS (Code Composer Studio) / TI
  { re: /#pragma\s+vector\s*=/,                             label: '#pragma vector=' },
  { re: /#pragma\s+interrupt/i,                             label: '#pragma interrupt' },
  // ESP-IDF / ESP8266
  { re: /\bIRAM_ATTR\b/,                                   label: 'IRAM_ATTR' },
  { re: /\bICACHE_FLASH_ATTR\b/,                           label: 'ICACHE_FLASH_ATTR' },
  { re: /\bICACHE_RAM_ATTR\b/,                             label: 'ICACHE_RAM_ATTR' },
  // Nordic nRF5 SDK / nRFx
  { re: /\bnrf_nvic_irq_enable\b/,                         label: 'Nordic NVIC' },
  // FreeRTOS (any function with FromISR suffix handled by name below)
  // OSEK / AUTOSAR
  { re: /\bISR\s*\(/,                                       label: 'ISR() macro (AVR/AUTOSAR)' },
];

// Naming convention patterns checked against the bare function name
const ISR_NAME_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /_IRQHandler$/,            label: 'ARM CMSIS IRQHandler' },
  { re: /_IRQ$/,                   label: '_IRQ suffix' },
  { re: /_Interrupt$/i,            label: '_Interrupt suffix' },
  { re: /^ISR_/i,                  label: 'ISR_ prefix' },
  { re: /_isr$/i,                  label: '_isr suffix' },
  { re: /FromISR$/,                label: 'FreeRTOS FromISR' },
  { re: /^NMI_Handler$/,           label: 'ARM NMI_Handler' },
  { re: /^HardFault_Handler$/,     label: 'ARM HardFault_Handler' },
  { re: /^MemManage_Handler$/,     label: 'ARM MemManage_Handler' },
  { re: /^BusFault_Handler$/,      label: 'ARM BusFault_Handler' },
  { re: /^UsageFault_Handler$/,    label: 'ARM UsageFault_Handler' },
  { re: /^SVC_Handler$/,           label: 'ARM SVC_Handler' },
  { re: /^DebugMon_Handler$/,      label: 'ARM DebugMon_Handler' },
  { re: /^PendSV_Handler$/,        label: 'ARM PendSV_Handler' },
  { re: /^SysTick_Handler$/,       label: 'ARM SysTick_Handler' },
];

/**
 * Detects whether a function is an ISR by:
 * 1. Checking the text in the window immediately before the header for known ISR attributes.
 * 2. Checking the function name against naming convention patterns.
 * Returns null if not an ISR; otherwise returns the label string identifying it.
 */
export function detectIsrAttribute(
  name: string,
  cleanedSrc: string,
  headerStart: number,
  extraPatterns: RegExp[],
): string | null {
  // Anchor at the end of the previous function/statement to avoid bleeding
  // into preceding code. Then extend to include the full function header
  // (return type qualifiers like `__irq`, `__interrupt` sit there).
  const lastEnd = Math.max(
    cleanedSrc.lastIndexOf('}', headerStart - 1),
    cleanedSrc.lastIndexOf(';', headerStart - 1),
  );
  const searchFrom = lastEnd >= 0 ? lastEnd + 1 : Math.max(0, headerStart - 300);
  // Include up to the opening '(' of the parameter list
  const parenPos = cleanedSrc.indexOf('(', headerStart);
  const searchTo = parenPos >= 0 ? parenPos : headerStart + 120;
  const window = cleanedSrc.slice(searchFrom, searchTo);

  for (const { re, label } of ISR_PRECEDE_PATTERNS) {
    if (re.test(window)) return label;
  }
  for (const ep of extraPatterns) {
    if (ep.test(window)) return 'custom pattern';
  }
  for (const { re, label } of ISR_NAME_PATTERNS) {
    if (re.test(name)) return label;
  }
  return null;
}

// ── Function span extraction ─────────────────────────────────────────────────

// The trailing `(\s*:[^{]*)?` group consumes constructor/destructor initializer
// lists like `Circle(int r) : radius_(r), count_(0) {` so the brace can still
// be matched.  It also handles `try { ... }` function-try-blocks by stopping
// at the first `{`.
const FUNC_HEADER_RE =
  /(^|[\n;}])[ \t]*(virtual\s+|explicit\s+|inline\s+|static\s+)*((?:[A-Za-z_][\w:<>,\*&\s]*?)\s+)?(~?[A-Za-z_]\w*(?:::~?[A-Za-z_]\w*)*)\s*\(([^;{}()]*)\)\s*(const\s*)?(override\s*)?(final\s*)?(noexcept(\([^)]*\))?\s*)?(\s*:\s*[^{]*)?\s*\{/g;

export function extractFunctionSpans(
  cleanedSrc: string,
  extraIsrPatterns: RegExp[] = [],
  rawSrc?: string,
  nsRanges: NamespaceRange[] = [],
): RawFunctionSpan[] {
  const isrSrc = rawSrc ?? cleanedSrc;
  const spans: RawFunctionSpan[] = [];
  FUNC_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = FUNC_HEADER_RE.exec(cleanedSrc))) {
    const qualifiers = m[2] ?? '';
    const isVirtual = /\bvirtual\b/.test(qualifiers);
    const isStatic  = /\bstatic\b/.test(qualifiers);
    const returnType = (m[3] || '').trim();
    const rawName = m[4];
    const params = m[5];
    const braceOffset = m.index + m[0].length - 1;

    let name = rawName;
    let className: string | undefined;
    const qualified = rawName.split('::');
    if (qualified.length >= 2) {
      // e.g. Sentinel::Apex::GetT1 → className = "Sentinel::Apex", name = "GetT1"
      className = qualified.slice(0, -1).join('::');
      name = qualified[qualified.length - 1];
    }

    if (isControlKeyword(name) || isControlKeyword(returnType)) {
      FUNC_HEADER_RE.lastIndex = m.index + 1;
      continue;
    }

    const bodyEnd = findMatchingBrace(cleanedSrc, braceOffset);
    if (bodyEnd === -1) continue;

    const headerStart = findHeaderStart(cleanedSrc, m.index);
    const isrAttr = detectIsrAttribute(name, isrSrc, headerStart, extraIsrPatterns);

    // Determine enclosing namespace
    const ns = nsRanges.length > 0 ? namespaceAt(headerStart, nsRanges) : undefined;

    spans.push({
      name,
      className,
      namespace: ns,
      signature: `${returnType ? returnType + ' ' : ''}${rawName}(${params.trim()})`.trim(),
      headerStart,
      bodyStart: braceOffset,
      bodyEnd,
      isVirtualLike: isVirtual,
      isStatic,
      isIsr: isrAttr !== null,
      isrAttribute: isrAttr ?? '',
    });

    FUNC_HEADER_RE.lastIndex = braceOffset + 1;
  }

  return spans;
}

function findHeaderStart(src: string, matchIndex: number): number {
  let i = matchIndex;
  while (i < src.length && (src[i] === '\n' || src[i] === ';' || src[i] === '}')) i++;
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function findMatchingBrace(src: string, openOffset: number): number {
  let depth = 0;
  for (let i = openOffset; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}
