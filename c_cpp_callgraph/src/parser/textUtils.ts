// Strips comments and string/char literal contents so later regex passes
// don't get confused by braces/parens/keywords inside them — while keeping
// the exact same length and line/column layout (replaced with spaces) so
// offsets computed against the cleaned text still map back to the original.

export function stripCommentsAndLiterals(src: string): string {
  const out: string[] = new Array(src.length);
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : '';

    // line comment
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }

    // block comment
    if (c === '/' && c2 === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out[i] = src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }

    // string literal
    if (c === '"') {
      out[i] = '"';
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        out[i] = src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out[i] = '"';
        i++;
      }
      continue;
    }

    // char literal
    if (c === "'") {
      out[i] = "'";
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        out[i] = ' ';
        i++;
      }
      if (i < n) {
        out[i] = "'";
        i++;
      }
      continue;
    }

    out[i] = c;
    i++;
  }

  return out.join('');
}

/** Replaces __attribute__((...)) and __declspec(...) annotations with spaces,
 *  preserving the exact character count so all offsets remain valid. */
export function stripCompilerAnnotations(src: string): string {
  // Match __attribute__((   ...nested parens...   )) with balanced depth
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    if (src[i] === '_' && src.startsWith('__attribute__', i)) {
      let j = i + 13; // length of '__attribute__'
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '(') {
        const start = i;
        let depth = 0;
        while (j < n) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')') { depth--; if (depth === 0) { j++; break; } }
          j++;
        }
        for (let k = start; k < j; k++) if (out[k] !== '\n') out[k] = ' ';
        i = j;
        continue;
      }
    }
    if (src[i] === '_' && src.startsWith('__declspec', i)) {
      let j = i + 10;
      while (j < n && /\s/.test(src[j])) j++;
      if (src[j] === '(') {
        const start = i;
        let depth = 0;
        while (j < n) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')') { depth--; if (depth === 0) { j++; break; } }
          j++;
        }
        for (let k = start; k < j; k++) if (out[k] !== '\n') out[k] = ' ';
        i = j;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

export class LineIndex {
  private lineStarts: number[] = [0];

  constructor(src: string) {
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '\n') this.lineStarts.push(i + 1);
    }
  }

  /** Converts a 0-based character offset to a 1-based {line, column}. */
  toLineCol(offset: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - this.lineStarts[lo] + 1 };
  }
}

const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'new', 'delete',
  'static_assert', 'decltype', 'typeof', '__attribute__', 'alignof', 'noexcept',
  'throw', 'else', 'do', 'typeid', 'using', 'namespace', 'template', 'explicit',
]);

export function isControlKeyword(name: string): boolean {
  return CONTROL_KEYWORDS.has(name);
}
