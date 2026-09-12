// Detects "variable bound to a known function" patterns so later calls
// through that variable can be linked back to the real function (1C in the
// plan). This is intentionally approximate: bindings are resolved by
// "most recent assignment before this offset" in the same file when
// available, falling back to any binding for that variable name in any
// file when not (common for callback fields wired up in one .c and invoked
// in another) — not real scope/control-flow analysis. Lambdas are traced
// into one level (their own call sites are extracted by the caller using
// the returned body span) rather than just flagged.

export interface PointerBinding {
  variable: string;
  functionName: string;
  offset: number; // position of the assignment, for "most recent before call site" resolution
}

export interface LambdaBinding {
  variable: string;
  offset: number;    // position of the assignment
  bodyStart: number;  // offset of the lambda's '{'
  bodyEnd: number;     // offset just past the matching '}'
}

// `(*fp)(params) = &funcName;`  or  `= funcName;`
const FUNC_PTR_DECL_RE = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\([^)]*\)\s*=\s*&?([A-Za-z_]\w*)\s*[;,)]/g;

// `var = &funcName;`  `var = funcName;`  `obj->field = &funcName;`  `obj.field = funcName;`
const BARE_ASSIGN_RE =
  /(?:^|[^.\w])(?:[A-Za-z_]\w*(?:->|\.))?([A-Za-z_]\w*)\s*=\s*&?([A-Za-z_]\w*)\s*[;,)]/g;

// Designated struct/union initializer — the critical pattern for HAL vtable structs:
//   .Enable = &SCCP1_PWM_Enable,   ← &  is now accepted
//   .Enable = SCCP1_PWM_Enable,    ← no &  still works
// Group 1 = field name, Group 2 = function being assigned (& stripped).
const DESIGNATED_INIT_RE = /\.(\w+)\s*=\s*&?([A-Za-z_]\w*)\s*[,}]/g;

// Address-of: `&funcName` — address taken, almost always a function pointer assignment
const ADDR_OF_RE = /&([A-Za-z_]\w*)\b/g;

// Function passed as a direct argument (no &) to another call.
// Match: `identifier(  ...  , knownFunc  ,  ...  )` where knownFunc is between commas/parens.
// We scan for known names in argument positions after a '(' to catch register_callback(ctx, handler) patterns.
const FUNC_IN_ARG_RE = /\b([A-Za-z_]\w*)\s*(?=[,)])/g;

const LAMBDA_ASSIGN_RE = /(?:^|[^.\w])(?:[A-Za-z_]\w*(?:->|\.))?([A-Za-z_]\w*)\s*=\s*\[[^\]]*\]\s*\(/g;

const ARRAY_INIT_RE = /=\s*\{([^{}]*)\}/g;

function findMatchingParen(src: string, openOffset: number): number {
  let depth = 0;
  for (let i = openOffset; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
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

export function findPointerBindings(
  cleanedSrc: string,
  knownFunctionNames: Set<string>,
): { bindings: PointerBinding[]; lambdas: LambdaBinding[] } {
  const bindings: PointerBinding[] = [];
  const lambdas: LambdaBinding[] = [];

  let m: RegExpExecArray | null;

  FUNC_PTR_DECL_RE.lastIndex = 0;
  while ((m = FUNC_PTR_DECL_RE.exec(cleanedSrc))) {
    const [, variable, fn] = m;
    if (knownFunctionNames.has(fn)) {
      bindings.push({ variable, functionName: fn, offset: m.index });
    }
  }

  BARE_ASSIGN_RE.lastIndex = 0;
  while ((m = BARE_ASSIGN_RE.exec(cleanedSrc))) {
    const [, variable, fn] = m;
    if (knownFunctionNames.has(fn) && variable !== fn) {
      bindings.push({ variable, functionName: fn, offset: m.index });
    }
  }

  // Designated initializers: { .read = my_read, .write = my_write }
  // Store TWO bindings per match:
  //   1. Named: variable = fieldName  → allows  ptr->fieldName()  to resolve
  //   2. Anonymous: variable = '<designated-init>'  → general "placed in struct" tracking
  DESIGNATED_INIT_RE.lastIndex = 0;
  while ((m = DESIGNATED_INIT_RE.exec(cleanedSrc))) {
    const fieldName = m[1];
    const fn = m[2];
    if (knownFunctionNames.has(fn)) {
      // Named binding lets ptr->fieldName() resolve through the ops table
      bindings.push({ variable: fieldName, functionName: fn, offset: m.index });
      // Anonymous marker for generic "was placed in a struct/table" tracking
      bindings.push({ variable: '<designated-init>', functionName: fn, offset: m.index });
    }
  }

  // Address-of: &funcName.  Record the function as "address taken" so callers of a
  // variable containing it are linked even when we can't trace the exact variable name.
  ADDR_OF_RE.lastIndex = 0;
  while ((m = ADDR_OF_RE.exec(cleanedSrc))) {
    const fn = m[1];
    if (knownFunctionNames.has(fn)) {
      bindings.push({ variable: '<addr-of>', functionName: fn, offset: m.index });
    }
  }

  // Function names passed as direct arguments to other calls.
  // Scan inside every call-expression argument list for known names.
  // Pattern: `callerIdent(  ... , knownFunc , ... )` — we find the outer `(` and scan inside.
  const CALL_WITH_ARGS_RE = /\b[A-Za-z_]\w*\s*\(([^()]*)\)/g;
  CALL_WITH_ARGS_RE.lastIndex = 0;
  while ((m = CALL_WITH_ARGS_RE.exec(cleanedSrc))) {
    const args = m[1];
    FUNC_IN_ARG_RE.lastIndex = 0;
    let am: RegExpExecArray | null;
    while ((am = FUNC_IN_ARG_RE.exec(args))) {
      const fn = am[1];
      if (knownFunctionNames.has(fn)) {
        bindings.push({ variable: '<passed-as-arg>', functionName: fn, offset: m.index });
      }
    }
  }

  // Dispatch-table array initializers (unnamed)
  ARRAY_INIT_RE.lastIndex = 0;
  while ((m = ARRAY_INIT_RE.exec(cleanedSrc))) {
    const items = m[1].split(',').map((s) => s.trim());
    for (const item of items) {
      if (/^[A-Za-z_]\w*$/.test(item) && knownFunctionNames.has(item)) {
        bindings.push({ variable: '<dispatch-table>', functionName: item, offset: m.index });
      }
    }
  }

  LAMBDA_ASSIGN_RE.lastIndex = 0;
  while ((m = LAMBDA_ASSIGN_RE.exec(cleanedSrc))) {
    // m[0] ends right after the lambda's parameter-list '('; walk forward to
    // find that list's matching ')', then skip qualifiers (mutable/noexcept/
    // trailing return type) up to the body's opening '{', then brace-match.
    const paramOpen = m.index + m[0].length - 1;
    const paramClose = findMatchingParen(cleanedSrc, paramOpen);
    if (paramClose === -1) continue;

    const braceOpen = cleanedSrc.indexOf('{', paramClose);
    if (braceOpen === -1) continue;
    // Guard against accidentally skipping into an unrelated later '{' if
    // there's a stray ';' (malformed/unsupported syntax) before it.
    const semiBetween = cleanedSrc.slice(paramClose, braceOpen).includes(';');
    if (semiBetween) continue;

    const bodyEnd = findMatchingBrace(cleanedSrc, braceOpen);
    if (bodyEnd === -1) continue;

    lambdas.push({ variable: m[1], offset: m.index, bodyStart: braceOpen, bodyEnd });
  }

  return { bindings, lambdas };
}

/** Most recent binding for `variable` at or before `callOffset`, in the same file. */
export function resolveBindingAt(
  variable: string,
  callOffset: number,
  bindings: PointerBinding[],
): PointerBinding | undefined {
  let best: PointerBinding | undefined;
  for (const b of bindings) {
    if (b.variable !== variable) continue;
    if (b.offset > callOffset) continue;
    if (!best || b.offset > best.offset) best = b;
  }
  return best;
}

/**
 * Cross-file-aware variant: each binding carries the file it came from.
 * Prefers the most recent same-file binding before the call site (precise);
 * falls back to any binding for that variable name in any other file
 * (common for callback fields wired up in one translation unit and invoked
 * in another — e.g. a HAL/driver vtable). Cross-file matches are flagged so
 * callers can show reduced confidence if desired.
 */
export interface FileScopedPointerBinding extends PointerBinding {
  file: string;
}

export function resolveBindingAcrossFiles(
  variable: string,
  callOffset: number,
  callFile: string,
  bindings: FileScopedPointerBinding[],
): { binding: FileScopedPointerBinding; crossFile: boolean } | undefined {
  let bestSameFile: FileScopedPointerBinding | undefined;
  for (const b of bindings) {
    if (b.variable !== variable || b.file !== callFile || b.offset > callOffset) continue;
    if (!bestSameFile || b.offset > bestSameFile.offset) bestSameFile = b;
  }
  if (bestSameFile) return { binding: bestSameFile, crossFile: false };

  const otherFileMatch = bindings.find((b) => b.variable === variable && b.file !== callFile);
  if (otherFileMatch) return { binding: otherFileMatch, crossFile: true };

  return undefined;
}
