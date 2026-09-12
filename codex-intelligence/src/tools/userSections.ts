/**
 * userSections.ts
 *
 * Implements the two-way feedback loop (R6): the user edits the generated
 * markdown, and those edits (a) survive regeneration and (b) are fed back
 * into the agent's context on subsequent runs.
 *
 * Two mechanisms:
 *
 * 1. PROTECTED SECTIONS — blocks fenced by HTML comments that the agent
 *    writes but never overwrites:
 *
 *      <!-- codex:user-start -->
 *      Anything the user types here is preserved verbatim forever.
 *      <!-- codex:user-end -->
 *
 * 2. CORRECTION MARKERS — the user prefixes any agent-written line with
 *    a marker to correct it in place:
 *
 *      **Purpose:** [corrected] Actually drives the motor, not the LED.
 *
 *    A field marked [corrected] is locked: the agent keeps the user's
 *    text on regeneration and includes it in context as authoritative.
 *
 * No vscode dependency — directly unit-testable.
 */

export const USER_START = '<!-- codex:user-start -->';
export const USER_END   = '<!-- codex:user-end -->';
export const CORRECTION_MARKER = '[corrected]';

export interface PreservedContent {
  /** Text inside the user-protected block, '' if absent/empty */
  userNotes: string;
  /** Field name -> user-corrected value, for fields marked [corrected] */
  corrections: Record<string, string>;
}

/** Reads an existing generated file and extracts everything the agent
 *  must not clobber. Safe on missing/empty input. */
export function extractPreserved(existingMarkdown: string | null): PreservedContent {
  const empty: PreservedContent = { userNotes: '', corrections: {} };
  if (!existingMarkdown) { return empty; }

  // 1. Protected block
  let userNotes = '';
  const startIdx = existingMarkdown.indexOf(USER_START);
  const endIdx   = existingMarkdown.indexOf(USER_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    userNotes = existingMarkdown.slice(startIdx + USER_START.length, endIdx).trim();
  }

  // 2. Correction markers on bold-labelled fields, e.g.
  //    **Purpose:** [corrected] real description here
  const corrections: Record<string, string> = {};
  const fieldRe = /\*\*([A-Za-z][A-Za-z ]*?):\*\*\s*\[corrected\]\s*(.+)/g;
  let m: RegExpExecArray | null;
  while ((m = fieldRe.exec(existingMarkdown)) !== null) {
    corrections[m[1].trim().toLowerCase()] = m[2].trim();
  }

  return { userNotes, corrections };
}

/** Renders the protected block for embedding in a generated file.
 *  Always emitted (even when empty) so the user has an obvious place to
 *  write, and so the markers exist for the next extractPreserved(). */
export function renderUserBlock(userNotes: string): string {
  const body = userNotes.trim() || '_Add your own notes here — the agent will never overwrite this block, and will read it as authoritative context._';
  return `${USER_START}\n${body}\n${USER_END}`;
}

/** Applies a user correction to a field if one exists, otherwise returns
 *  the agent's generated value. Keeps the [corrected] marker in the output
 *  so the lock persists across regenerations. */
export function applyCorrection(
  fieldName: string,
  agentValue: string,
  preserved: PreservedContent
): string {
  const corrected = preserved.corrections[fieldName.toLowerCase()];
  return corrected ? `${CORRECTION_MARKER} ${corrected}` : agentValue;
}

/** True if the given field was user-corrected — used to skip
 *  regeneration work and to mark context as authoritative. */
export function isCorrected(fieldName: string, preserved: PreservedContent): boolean {
  return Object.prototype.hasOwnProperty.call(preserved.corrections, fieldName.toLowerCase());
}

/** Strips the marker for display/context purposes. */
export function stripMarker(value: string): string {
  return value.replace(CORRECTION_MARKER, '').trim();
}

/** Builds the context fragment the agent sees for user feedback on an
 *  entry. Returns '' when the user has contributed nothing, so callers
 *  can cheaply skip it. */
export function feedbackContext(label: string, preserved: PreservedContent): string {
  const parts: string[] = [];
  const correctionKeys = Object.keys(preserved.corrections);
  if (correctionKeys.length > 0) {
    parts.push(`USER CORRECTIONS for ${label} (authoritative — trust these over your own analysis):`);
    for (const k of correctionKeys) {
      parts.push(`- ${k}: ${preserved.corrections[k]}`);
    }
  }
  if (preserved.userNotes && !preserved.userNotes.startsWith('_Add your own notes')) {
    parts.push(`USER NOTES for ${label} (authoritative):`);
    parts.push(preserved.userNotes);
  }
  return parts.length ? parts.join('\n') + '\n' : '';
}
