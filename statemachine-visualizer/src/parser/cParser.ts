import {
  IODirection,
  IOMechanism,
  IOPort,
  StateMachine,
  StateNode,
  Transition,
  TransitionKind,
} from './types';
import {
  findMatchingBrace,
  findMatchingParen,
  lineAt,
  splitTopLevel,
  stripCommentsAndLiterals,
} from './textUtils';

const C_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'return',
  'sizeof', 'typedef', 'struct', 'union', 'enum', 'class', 'public', 'private',
  'protected', 'new', 'delete', 'throw', 'catch', 'try', 'namespace', 'using',
  'template', 'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
  'defined', 'goto', 'break', 'continue', 'static', 'const', 'volatile',
  'inline', 'extern', 'virtual', 'override', 'explicit', 'friend', 'operator',
  'void', 'int', 'char', 'short', 'long', 'float', 'double', 'bool', 'unsigned',
  'signed', 'auto', 'register', 'typename', 'this', 'nullptr', 'true', 'false',
  '__attribute__', 'NULL',
]);

interface EnumInfo {
  /** canonical name used for display */
  name: string;
  /** all spellings (tag name and/or typedef alias) that may appear as a type */
  aliases: string[];
  states: StateNode[];
  stateNameSet: Set<string>;
  line: number;
}

interface FunctionInfo {
  name: string;
  isStatic: boolean;
  isVirtual: boolean;
  returnType: string;
  bodyStart: number;
  bodyEnd: number;
  line: number;
}

/**
 * Parse a header + implementation pair as ONE translation unit.
 *
 * Real-world state machines almost always declare the enum in `X.h` and put the
 * `switch` dispatch in `X.c`.  Parsing the files separately finds the enum but
 * no transitions.  This concatenates them, runs the normal single-file parser
 * over the combined text, then remaps every reported line number back to the
 * file it actually came from.
 */
export function parseFilePair(
  headerPath: string, headerSrc: string,
  implPath: string, implSrc: string,
): StateMachine[] {
  const headerLines = headerSrc.split('\n').length;
  const combined = headerSrc + '\n' + implSrc;

  // Remap a combined-text line number back to its original file + line.
  const remap = (line: number): { file: string; line: number } =>
    line <= headerLines
      ? { file: headerPath, line }
      : { file: implPath, line: line - headerLines };

  // Parse the combined text; the reported "file" is a placeholder we rewrite below.
  const machines = parseFile(implPath, combined);

  for (const m of machines) {
    // The machine belongs to whichever file declared its enum.
    const enumLoc = m.states[0]?.location;
    if (enumLoc) {
      const r = remap(enumLoc.line);
      m.file = r.file;
      m.id = `${r.file}::${m.enumName}`;
    }
    for (const s of m.states) {
      const r = remap(s.location.line);
      s.location = r;
    }
    for (const t of m.transitions) {
      const r = remap(t.location.line);
      t.location = r;
    }
    for (const p of m.io) {
      const r = remap(p.location.line);
      p.location = r;
    }
  }
  return machines;
}

export function parseFile(file: string, source: string): StateMachine[] {
  const stripped = stripCommentsAndLiterals(source);

  const enums = findEnums(file, source, stripped);
  if (enums.length === 0) return [];

  const functions = findFunctions(stripped);
  const io = extractIO(file, source, stripped, functions);

  const machines: StateMachine[] = [];
  for (const en of enums) {
    const result = findDispatchLogic(file, source, stripped, en, functions);
    machines.push({
      id: `${file}::${en.name}`,
      name: en.name,
      file,
      enumName: en.name,
      stateVariable: result.stateVariable,
      states: en.states,
      transitions: result.transitions,
      io,
      confidence: result.confidence,
      detectionKind: result.kind,
    });
  }
  return machines;
}

// ---------------------------------------------------------------------------
// Enum discovery
// ---------------------------------------------------------------------------

function findEnums(file: string, source: string, stripped: string): EnumInfo[] {
  const enums: EnumInfo[] = [];
  const re = /\benum\b(\s+class)?\s*([A-Za-z_]\w*)?\s*(:\s*[A-Za-z_][\w:<>\s]*)?\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = findMatchingBrace(stripped, braceOpen);
    if (braceClose === -1) continue;

    const tagName = m[2];
    // Use the stripped text (comments blanked) so inline comments like
    //   STATE_IDLE,  /* the idle state */
    // don't break the entry regex below.
    const bodyText = stripped.slice(braceOpen + 1, braceClose - 1);

    // Look for a trailing typedef alias: `} Alias;`
    const afterBrace = stripped.slice(braceClose);
    const aliasMatch = afterBrace.match(/^\s*([A-Za-z_]\w*)\s*;/);
    const aliasName = aliasMatch ? aliasMatch[1] : undefined;

    // Was this preceded by `typedef`? (not required, just informative)
    const before = stripped.slice(Math.max(0, m.index - 20), m.index);
    const isTypedef = /typedef\s*$/.test(before);

    const canonicalName = tagName || aliasName || `AnonEnum_L${lineAt(stripped, m.index)}`;
    const aliases = Array.from(new Set([tagName, aliasName, canonicalName].filter(Boolean))) as string[];

    const states: StateNode[] = [];
    const entries = splitTopLevel(bodyText, ',');
    for (const entry of entries) {
      const em = entry.match(/^([A-Za-z_]\w*)\s*(=\s*([\s\S]+))?$/);
      if (!em) continue;
      states.push({
        name: em[1],
        value: em[3]?.trim(),
        isInitial: states.length === 0,
        location: { file, line: lineAt(stripped, braceOpen) },
      });
    }
    if (states.length === 0) continue;

    enums.push({
      name: canonicalName,
      aliases,
      states,
      stateNameSet: new Set(states.map((s) => s.name)),
      line: lineAt(stripped, m.index),
    });

    void isTypedef; // retained for potential future use / debugging
  }
  return enums;
}

// ---------------------------------------------------------------------------
// Function discovery (used both for I/O and as transition search scope)
// ---------------------------------------------------------------------------

function findFunctions(stripped: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];
  // Approximate top-level function definition signature, e.g.:
  //   static void Foo::bar(int x, Ctx *c) const {
  const re = /(^|[};])\s*((?:static|inline|extern|virtual|explicit)\s+)*[A-Za-z_][\w:<>,\*&\s]*?[\s\*&]([A-Za-z_~]\w*(?:::[A-Za-z_~]\w*)?)\s*\(([^;{}]*)\)\s*(const\s*)?(override\s*)?\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const boundaryLen = m[1] ? m[1].length : 0;
    const depth = braceDepthAt(stripped, m.index + boundaryLen);
    if (depth < 0 || depth > 2) continue; // top-level, or a member function inside a class/struct (and optionally a namespace)
    const name = m[3];
    if (!name || C_KEYWORDS.has(name)) continue;
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = findMatchingBrace(stripped, braceOpen);
    if (braceClose === -1) continue;
    const qualifiers = m[2] || '';
    functions.push({
      name,
      isStatic: /\bstatic\b/.test(qualifiers),
      isVirtual: /\bvirtual\b/.test(qualifiers) || !!m[6],
      returnType: '',
      bodyStart: braceOpen + 1,
      bodyEnd: braceClose - 1,
      line: lineAt(stripped, m.index),
    });
    re.lastIndex = braceClose - 1; // skip past body but keep the closing '}' available as the next match's boundary char
  }
  return functions;
}

/** Counts unmatched '{' minus '}' from the start of the string up to (not including) `index`. */
function braceDepthAt(stripped: string, index: number): number {
  let depth = 0;
  for (let i = 0; i < index; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') depth--;
  }
  return depth;
}

// ---------------------------------------------------------------------------
// Transition discovery: switch/case, if/else, dispatch-table (in that priority)
// ---------------------------------------------------------------------------

interface DispatchResult {
  transitions: Transition[];
  stateVariable?: string;
  kind: TransitionKind;
  confidence: number;
}

function findDispatchLogic(
  file: string,
  source: string,
  stripped: string,
  en: EnumInfo,
  functions: FunctionInfo[],
): DispatchResult {
  const viaSwitch = findSwitchDispatch(file, source, stripped, en);
  if (viaSwitch && viaSwitch.transitions.length > 0) return viaSwitch;

  const viaIfElse = findIfElseDispatch(file, source, stripped, en);
  if (viaIfElse && viaIfElse.transitions.length > 0) return viaIfElse;

  const viaDispatchTable = findDispatchTable(file, source, stripped, en, functions);
  if (viaDispatchTable && viaDispatchTable.transitions.length > 0) return viaDispatchTable;

  // Nothing found - still report the enum so the user sees it was detected.
  return { transitions: [], kind: 'unknown', confidence: 0.15 };
}

function findSwitchDispatch(
  file: string,
  source: string,
  stripped: string,
  en: EnumInfo,
): DispatchResult | null {
  const re = /\bswitch\s*\(/g;
  let m: RegExpExecArray | null;
  let best: DispatchResult | null = null;

  while ((m = re.exec(stripped))) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = findMatchingParen(stripped, parenOpen);
    if (parenClose === -1) continue;
    const switchExpr = stripped.slice(parenOpen + 1, parenClose - 1).trim();

    const braceOpenIdx = stripped.indexOf('{', parenClose);
    if (braceOpenIdx === -1) continue;
    const braceClose = findMatchingBrace(stripped, braceOpenIdx);
    if (braceClose === -1) continue;
    const body = stripped.slice(braceOpenIdx + 1, braceClose - 1);
    const bodyOffset = braceOpenIdx + 1;

    const cases = extractTopLevelCases(body);
    const matchingCases = cases.filter((c) => c.label && en.stateNameSet.has(c.label));
    if (matchingCases.length < Math.max(1, Math.ceil(en.states.length * 0.4))) {
      continue; // doesn't look like it's dispatching on this enum
    }

    const tail = lastIdentifier(switchExpr);
    const transitions: Transition[] = [];
    for (const c of cases) {
      if (!c.label || !en.stateNameSet.has(c.label)) continue;
      const slice = body.slice(c.start, c.end);
      const found = extractTransitionsFromSlice(file, source, slice, c.start + bodyOffset, tail, en);
      for (const t of found) transitions.push({ ...t, from: c.label });
    }

    const ratio = matchingCases.length / en.states.length;
    const candidate: DispatchResult = {
      transitions,
      stateVariable: switchExpr,
      kind: 'switch-case',
      confidence: Math.min(0.95, 0.5 + ratio * 0.5),
    };
    if (!best || candidate.transitions.length > best.transitions.length) {
      best = candidate;
    }
  }
  return best;
}

interface CaseSlice {
  label: string | null; // null for `default`
  start: number; // offset within `body`, just after the colon
  end: number; // offset within `body`, exclusive
}

function extractTopLevelCases(body: string): CaseSlice[] {
  const markers: { label: string | null; colonEnd: number }[] = [];
  let depth = 0;
  const re = /\b(case\s+(?:[A-Za-z_]\w*\s*::\s*)?([A-Za-z_]\w*)\s*:|default\s*:)/g;
  let m: RegExpExecArray | null;

  // We need depth at each match position relative to `body` (which starts at depth 0).
  // Compute depth incrementally by scanning, checking matches as we go.
  let lastIndex = 0;
  let runningDepth = 0;
  const positions: { idx: number; label: string | null; len: number }[] = [];
  while ((m = re.exec(body))) {
    positions.push({ idx: m.index, label: m[2] ?? null, len: m[0].length });
  }
  for (const p of positions) {
    for (let i = lastIndex; i < p.idx; i++) {
      if (body[i] === '{') runningDepth++;
      else if (body[i] === '}') runningDepth--;
    }
    lastIndex = p.idx;
    if (runningDepth === 0) {
      markers.push({ label: p.label, colonEnd: p.idx + p.len });
    }
  }
  void depth;

  const cases: CaseSlice[] = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].colonEnd;
    const end = i + 1 < markers.length ? findCaseBoundary(markers, i, body) : body.length;
    cases.push({ label: markers[i].label, start, end });
  }
  return cases;
}

function findCaseBoundary(markers: { label: string | null; colonEnd: number }[], i: number, body: string): number {
  // The boundary for case[i] is the *start of the case/default keyword* of case[i+1],
  // not the colon end, so we search backward a little from next colonEnd to the keyword start.
  const nextColonEnd = markers[i + 1].colonEnd;
  const before = body.slice(Math.max(0, nextColonEnd - 40), nextColonEnd);
  const kw = before.match(/(case\s+[A-Za-z_]\w*\s*:|default\s*:)\s*$/);
  if (kw) return nextColonEnd - kw[0].length;
  return nextColonEnd;
}

function lastIdentifier(expr: string): string {
  const cleaned = expr.replace(/[()]/g, '');
  const parts = cleaned.split(/->|\./);
  return parts[parts.length - 1].trim();
}

function extractTransitionsFromSlice(
  file: string,
  source: string,
  slice: string,
  sliceOffsetInStripped: number,
  tail: string,
  en: EnumInfo,
): Omit<Transition, 'from'>[] {
  const results: Omit<Transition, 'from'>[] = [];
  const escapedTail = tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Matches `tail = STATE_X;` possibly via pointer/member access right before `tail`.
  const assignRe = new RegExp(`(?:[\\w>.\\->]*?\\b)?${escapedTail}\\s*=\\s*(?:[A-Za-z_]\\w*\\s*::\\s*)?([A-Za-z_]\\w*)\\s*;`, 'g');
  let m: RegExpExecArray | null;
  while ((m = assignRe.exec(slice))) {
    const to = m[1];
    if (!en.stateNameSet.has(to)) continue;
    const offset = sliceOffsetInStripped + m.index;
    const label = inferGuardLabel(slice, m.index);
    results.push({
      to,
      label,
      kind: 'switch-case',
      location: { file, line: lineAt(source, offset) },
    });
  }
  return results;
}

/**
 * Find the innermost if / else-if condition(s) that enclose `assignIndex` within the
 * given case-block `slice`.  Unlike the old 250-char look-back, this walks every
 * if/else-if in the slice and checks whether the assignment falls inside that
 * branch's body — so deep nesting and multi-line guards are handled correctly.
 */
function inferGuardLabel(slice: string, assignIndex: number): string | undefined {
  const conditions: string[] = [];
  // Match both `if (` and `else if (`
  const ifRe = /\b(?:else\s+)?if\s*\(/g;
  let m: RegExpExecArray | null;

  while ((m = ifRe.exec(slice))) {
    const ifStart = m.index;
    if (ifStart >= assignIndex) break;

    const parenOpen = ifStart + m[0].length - 1; // index of '('
    const parenClose = findMatchingParen(slice, parenOpen); // index just after ')'
    if (parenClose === -1 || parenClose > assignIndex) continue;

    const cond = slice.slice(parenOpen + 1, parenClose - 1).trim();
    if (!cond || cond.length > 100) continue;

    // Determine the body extent: either a brace-delimited block or a brace-less single statement
    const afterCond = slice.slice(parenClose);
    const braceMatch = afterCond.match(/^\s*\{/);

    let bodyEnd: number;
    if (braceMatch) {
      // Brace-delimited block – find its closing brace
      const braceOpen2 = parenClose + braceMatch[0].length - 1;
      const braceClose2 = findMatchingBrace(slice, braceOpen2);
      bodyEnd = braceClose2 !== -1 ? braceClose2 : slice.length;
    } else {
      // Brace-less: body ends at the next ';'
      const semiIdx = afterCond.indexOf(';');
      bodyEnd = semiIdx !== -1 ? parenClose + semiIdx + 1 : slice.length;
    }

    if (assignIndex > parenClose && assignIndex < bodyEnd) {
      conditions.push(cond);
    }
  }

  if (conditions.length > 0) {
    // Use the innermost (most recent) enclosing condition
    const cond = conditions[conditions.length - 1];
    return `on ${cond}`;
  }

  // Fallback: look for a function call immediately preceding the assignment
  const before = slice.slice(Math.max(0, assignIndex - 120), assignIndex);
  const callMatch = before.match(/([A-Za-z_]\w*)\s*\([^()]*\)\s*;\s*$/);
  if (callMatch && !C_KEYWORDS.has(callMatch[1])) return `after ${callMatch[1]}()`;

  return undefined;
}

function findIfElseDispatch(
  file: string,
  source: string,
  stripped: string,
  en: EnumInfo,
): DispatchResult | null {
  // Find a plausible state-variable expression by looking for `<expr> == STATE_X` comparisons
  // against this enum's values, then look inside the following block for reassignment.
  const transitions: Transition[] = [];
  let stateVariable: string | undefined;

  for (const stateName of en.stateNameSet) {
    const cmpRe = new RegExp(`([A-Za-z_][\\w>.\\->]*)\\s*==\\s*(?:[A-Za-z_]\\w*\\s*::\\s*)?${stateName}\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = cmpRe.exec(stripped))) {
      const expr = m[1];
      const tail = lastIdentifier(expr);
      if (!stateVariable) stateVariable = expr;

      // Find the block following this comparison's enclosing `if (...) {`
      const ifBraceOpen = stripped.indexOf('{', m.index + m[0].length);
      if (ifBraceOpen === -1 || ifBraceOpen - (m.index + m[0].length) > 80) continue;
      const ifBraceClose = findMatchingBrace(stripped, ifBraceOpen);
      if (ifBraceClose === -1) continue;
      const block = stripped.slice(ifBraceOpen + 1, ifBraceClose - 1);

      const found = extractTransitionsFromSlice(file, source, block, ifBraceOpen + 1, tail, en);
      for (const t of found) transitions.push({ ...t, from: stateName, kind: 'if-else' });
    }
  }

  if (transitions.length === 0) return null;
  const statesReached = new Set(transitions.map((t) => t.from)).size;
  const ratio = statesReached / en.states.length;
  return {
    transitions,
    stateVariable,
    kind: 'if-else',
    confidence: Math.min(0.85, 0.35 + ratio * 0.5),
  };
}

function findDispatchTable(
  file: string,
  source: string,
  stripped: string,
  en: EnumInfo,
  functions: FunctionInfo[],
): DispatchResult | null {
  // Look for an array initializer whose element count matches the enum's state count
  // and whose elements are bare identifiers that are also known local function names.
  const funcNames = new Set(functions.map((f) => f.name));
  const re = /=\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    const braceOpen = m.index + m[0].length - 1;
    const braceClose = findMatchingBrace(stripped, braceOpen);
    if (braceClose === -1) continue;
    const body = stripped.slice(braceOpen + 1, braceClose - 1);
    const elements = splitTopLevel(body, ',').map((e) => e.replace(/[&\s]/g, ''));
    if (elements.length !== en.states.length) continue;
    const matchedFns = elements.filter((e) => funcNames.has(e));
    if (matchedFns.length < Math.ceil(elements.length * 0.6)) continue;

    // Looks like a dispatch table: map state[i] -> handler function elements[i].
    const transitions: Transition[] = [];
    for (let i = 0; i < en.states.length; i++) {
      const fn = functions.find((f) => f.name === elements[i]);
      if (!fn) continue;
      const fnBody = stripped.slice(fn.bodyStart, fn.bodyEnd);
      // Look for assignment to *any* state-like variable to the enum's values inside this handler.
      const assignRe = /\b([A-Za-z_]\w*(?:[Ss]tate)\w*)\s*=\s*(?:[A-Za-z_]\w*\s*::\s*)?([A-Za-z_]\w*)\s*;/g;
      let am: RegExpExecArray | null;
      while ((am = assignRe.exec(fnBody))) {
        if (!en.stateNameSet.has(am[2])) continue;
        transitions.push({
          from: en.states[i].name,
          to: am[2],
          label: `via ${fn.name}()`,
          kind: 'dispatch-table',
          location: { file, line: lineAt(source, fn.bodyStart + am.index) },
        });
      }
    }
    if (transitions.length > 0) {
      return {
        transitions,
        stateVariable: undefined,
        kind: 'dispatch-table',
        confidence: 0.6,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// I/O surface extraction
// ---------------------------------------------------------------------------

function extractIO(
  file: string,
  source: string,
  stripped: string,
  functions: FunctionInfo[],
): IOPort[] {
  const io: IOPort[] = [];

  // Includes -> dependencies
  const incRe = /^[ \t]*#include\s*[<"]([^>"]+)[>"]/gm;
  let m: RegExpExecArray | null;
  while ((m = incRe.exec(source))) {
    io.push({
      name: m[1],
      direction: 'dependency',
      mechanism: 'include',
      location: { file, line: lineAt(source, m.index) },
    });
  }

  // Function definitions -> input hooks (non-static) / getters / setters
  for (const fn of functions) {
    if (fn.isStatic) continue;
    let mechanism: IOMechanism = 'function-call-in';
    if (/(^|_)(Get|get)([A-Z_]|$)/.test(fn.name)) mechanism = 'getter';
    else if (/(^|_)(Set|set)([A-Z_]|$)/.test(fn.name)) mechanism = 'setter';
    io.push({
      name: fn.name + '()',
      direction: 'input',
      mechanism,
      detail: fn.isVirtual ? 'virtual / overridable' : undefined,
      location: { file, line: fn.line },
    });
  }

  // Outgoing calls -> calls into other modules
  const localNames = new Set<string>();
  for (const f of functions) {
    localNames.add(f.name);
    const lastSeg = f.name.split('::').pop();
    if (lastSeg) localNames.add(lastSeg);
  }
  const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
  const seenOut = new Set<string>();
  while ((m = callRe.exec(stripped))) {
    const name = m[1];
    if (C_KEYWORDS.has(name) || localNames.has(name) || seenOut.has(name)) continue;
    // Skip obvious macro-ish ALL_CAPS-with-no-letters-lowercase single tokens used as type casts, etc.
    if (name.length < 2) continue;
    seenOut.add(name);
    io.push({
      name: name + '()',
      direction: 'output',
      mechanism: 'function-call-out',
      location: { file, line: lineAt(stripped, m.index) },
    });
  }

  // extern globals -> shared variables
  const externRe = /^[ \t]*extern\s+(?!"C")[\w\s\*]+?\b([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;/gm;
  while ((m = externRe.exec(stripped))) {
    io.push({
      name: m[1],
      direction: 'shared',
      mechanism: 'global-variable',
      location: { file, line: lineAt(stripped, m.index) },
    });
  }

  // Callback / handler field registration
  const cbRe = /\b([A-Za-z_]\w*(?:[Cc]allback|[Hh]andler|[Cc]b))\s*=\s*([A-Za-z_]\w*)\s*;/g;
  while ((m = cbRe.exec(stripped))) {
    if (C_KEYWORDS.has(m[2])) continue;
    io.push({
      name: m[2] + '()',
      direction: 'output',
      mechanism: 'callback-registration',
      detail: `registered as ${m[1]}`,
      location: { file, line: lineAt(stripped, m.index) },
    });
  }

  // C++ class inheritance
  const classRe = /\bclass\s+([A-Za-z_]\w*)\s*:\s*((?:public|private|protected)\s+[A-Za-z_:]\w*(?:\s*,\s*(?:public|private|protected)\s+[A-Za-z_:]\w*)*)/g;
  while ((m = classRe.exec(stripped))) {
    const bases = m[2].split(',').map((b) => b.replace(/\b(public|private|protected)\b/, '').trim());
    for (const base of bases) {
      io.push({
        name: base,
        direction: 'dependency',
        mechanism: 'class-extension',
        detail: `${m[1]} extends ${base}`,
        location: { file, line: lineAt(stripped, m.index) },
      });
    }
  }

  return io;
}
