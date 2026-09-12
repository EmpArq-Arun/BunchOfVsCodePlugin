// Best-effort preprocessor tracking for heuristic mode. We do NOT have a real
// preprocessor or the build's actual defines, so this only resolves two safe
// cases definitively:
//   1. `#if 0` ... `#endif`            -> always inactive
//   2. `#ifdef X` / `#ifndef X` where `#define X` appears earlier at file
//      scope (and is not `#undef`-ed before this point) -> resolvable
// Anything else is left "active" but the function/branch is tagged as
// conditional so the UI can show "conditional — unresolved" rather than
// silently hiding or silently trusting it.

export interface InactiveRange {
  start: number;
  end: number;
}

export interface ConditionalInfo {
  inactiveRanges: InactiveRange[];
  /** Ranges whose activity we could NOT resolve (depends on an externally-defined macro). */
  unresolvedRanges: { start: number; end: number; macro: string }[];
}

interface StackFrame {
  directiveStart: number;
  // Tri-state: true = active, false = inactive, undefined = unresolved
  branchActive: boolean | undefined;
  macroName?: string;
  /** Whether any branch in this if/elif/else chain has already been taken. */
  anyBranchTaken: boolean;
  parentActive: boolean | undefined; // combined with branchActive to get effective activity
}

const DIRECTIVE_RE = /^[ \t]*#[ \t]*(if|ifdef|ifndef|elif|else|endif|define|undef)\b(.*)$/;

export function trackConditionals(src: string): ConditionalInfo {
  const definedLocally = new Set<string>();
  const inactiveRanges: InactiveRange[] = [];
  const unresolvedRanges: { start: number; end: number; macro: string }[] = [];
  const stack: StackFrame[] = [];

  let pos = 0;
  const lines = src.split('\n');
  let offset = 0;

  const currentEffectiveActive = (): boolean | undefined => {
    if (stack.length === 0) return true;
    return stack[stack.length - 1].branchActive;
  };

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the '\n'

    const m = DIRECTIVE_RE.exec(line);
    if (!m) continue;
    const directive = m[1];
    const rest = m[2].trim();

    if (directive === 'define') {
      const name = rest.split(/[\s(]/)[0];
      if (name) definedLocally.add(name);
      continue;
    }
    if (directive === 'undef') {
      const name = rest.split(/\s/)[0];
      if (name) definedLocally.delete(name);
      continue;
    }

    if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef') {
      const parentActive = currentEffectiveActive();
      let active: boolean | undefined;
      let macroName: string | undefined;

      if (directive === 'if' && rest.replace(/\s/g, '') === '0') {
        active = false;
      } else if (directive === 'ifdef') {
        macroName = rest.split(/\s/)[0];
        active = definedLocally.has(macroName) ? true : undefined;
      } else if (directive === 'ifndef') {
        macroName = rest.split(/\s/)[0];
        active = definedLocally.has(macroName) ? false : undefined;
      } else {
        active = undefined; // arbitrary #if EXPR — not evaluated
      }

      const combined = parentActive === false ? false : active;
      stack.push({
        directiveStart: lineStart,
        branchActive: combined,
        macroName,
        anyBranchTaken: combined === true,
        parentActive,
      });
      recordRangeStart(combined, macroName, lineStart, inactiveRanges, unresolvedRanges, true);
      continue;
    }

    if (directive === 'elif' || directive === 'else') {
      const frame = stack[stack.length - 1];
      if (!frame) continue;
      closeRange(frame, lineStart, inactiveRanges, unresolvedRanges);

      let active: boolean | undefined;
      if (frame.anyBranchTaken) {
        active = false; // an earlier branch already matched
      } else if (directive === 'else') {
        active = frame.branchActive === undefined ? undefined : true;
      } else {
        active = undefined; // un-evaluated #elif condition
      }

      const combined = frame.parentActive === false ? false : active;
      frame.branchActive = combined;
      frame.directiveStart = lineStart;
      if (combined === true) frame.anyBranchTaken = true;
      recordRangeStart(combined, frame.macroName, lineStart, inactiveRanges, unresolvedRanges, true);
      continue;
    }

    if (directive === 'endif') {
      const frame = stack.pop();
      if (!frame) continue;
      closeRange(frame, lineStart, inactiveRanges, unresolvedRanges);
      continue;
    }
  }

  return { inactiveRanges, unresolvedRanges };
}

function recordRangeStart(
  active: boolean | undefined,
  macroName: string | undefined,
  start: number,
  inactiveRanges: InactiveRange[],
  unresolvedRanges: { start: number; end: number; macro: string }[],
  _opening: boolean,
) {
  // Ranges are closed out in closeRange(); this just stashes the pending
  // state on the frame via the caller (branchActive / directiveStart), so
  // nothing to do here besides documenting intent. Kept as a no-op hook
  // point for clarity / future extension.
}

function closeRange(
  frame: StackFrame,
  end: number,
  inactiveRanges: InactiveRange[],
  unresolvedRanges: { start: number; end: number; macro: string }[],
) {
  if (frame.branchActive === false) {
    inactiveRanges.push({ start: frame.directiveStart, end });
  } else if (frame.branchActive === undefined) {
    unresolvedRanges.push({ start: frame.directiveStart, end, macro: frame.macroName ?? '<expr>' });
  }
}

export function isOffsetInactive(offset: number, info: ConditionalInfo): boolean {
  return info.inactiveRanges.some((r) => offset >= r.start && offset < r.end);
}

export function unresolvedMacroAt(offset: number, info: ConditionalInfo): string | undefined {
  const hit = info.unresolvedRanges.find((r) => offset >= r.start && offset < r.end);
  return hit?.macro;
}
