/**
 * Word-wraps `text` to `maxWidth` and formats it as a Doxygen-style block comment:
 *
 *   /** Buffer overflow check: validate that idx stays
 *    *  within bufferSize before this array access
 *    *​/
 *
 * Only ever called when Vistacode itself writes a comment (click-to-rename).
 * Hand-written comments are never passed through this function.
 */
export function formatDoxygenComment(text: string, maxWidth: number, indent: string = ''): string {
  const safeWidth = Math.max(20, maxWidth); // refuse pathologically tiny widths
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    // account for the "/** " prefix on the first line / " *  " on continuations
    const prefixLen = lines.length === 0 ? 4 : 5;
    if (prefixLen + candidate.length > safeWidth && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    lines.push(current);
  }
  if (lines.length === 0) {
    lines.push('');
  }

  if (lines.length === 1) {
    return `${indent}/** ${lines[0]} */`;
  }

  const body = lines
    .map((line, i) => (i === 0 ? `${indent}/** ${line}` : `${indent} *  ${line}`))
    .join('\n');
  return `${body}\n${indent} */`;
}

/**
 * Strips Doxygen/plain block-comment delimiters and per-line `*` continuation
 * prefixes, rejoining into one normalized logical label string. Works for
 * both tool-written (formatDoxygenComment output) and hand-written comments,
 * since the cache hash needs to treat both consistently.
 */
export function parseDoxygenComment(rawCommentText: string): string {
  let text = rawCommentText.trim();

  // Strip /** , /*! , /// , //! , */ delimiters
  text = text.replace(/^\/\*[*!]?/, '').replace(/\*\/$/, '');
  text = text.replace(/^\/\/[/!]?/gm, '');

  const lines = text.split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, '').trim())
    .filter((line) => line.length > 0);

  // Single line: return as-is (most trailing // comments)
  if (lines.length <= 1) return lines.join('').trim();

  // Multi-line: preserve line structure so Cytoscape can wrap each line separately
  return lines.join('\n').trim();
}

/** True if a raw comment node's text looks like a `/* ... *\/` block comment (vs `//`). */
export function isBlockComment(rawCommentText: string): boolean {
  return rawCommentText.trim().startsWith('/*');
}
