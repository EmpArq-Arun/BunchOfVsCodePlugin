/**
 * Text-level helpers used by the heuristic C/C++ parser.
 *
 * The parser deliberately avoids a full tokenizer/AST. Instead it works on a
 * "stripped" copy of the source where comments and string/char literals are
 * blanked out to spaces (preserving every original character offset and line
 * number), so regexes only ever match real code structure. Original text is
 * then sliced out of the *original* source using offsets discovered in the
 * stripped copy, so identifiers and expressions keep their real spelling.
 */

export function stripCommentsAndLiterals(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // Line comment
    if (c === '/' && c2 === '/') {
      out += '  ';
      i += 2;
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }

    // Block comment
    if (c === '/' && c2 === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    // String literal
    if (c === '"') {
      out += ' ';
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          out += '  ';
          i += 2;
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += ' ';
        i++;
      }
      continue;
    }

    // Char literal
    if (c === "'") {
      out += ' ';
      i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\' && i + 1 < n) {
          out += '  ';
          i += 2;
          continue;
        }
        out += src[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += ' ';
        i++;
      }
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

/** Given the index of an opening brace, return the index just after its matching close brace. */
export function findMatchingBrace(stripped: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    else if (stripped[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Given index of an opening paren, return index just after its matching close paren. */
export function findMatchingParen(stripped: string, openParenIndex: number): number {
  let depth = 0;
  for (let i = openParenIndex; i < stripped.length; i++) {
    if (stripped[i] === '(') depth++;
    else if (stripped[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 1-based line number for a character offset. */
export function lineAt(src: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < src.length; i++) {
    if (src[i] === '\n') line++;
  }
  return line;
}

/** Split a top-level comma list (e.g. enum body), ignoring commas inside (), {}, <>. */
export function splitTopLevel(text: string, sep = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '{' || ch === '<' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === '>' || ch === ']') depth--;
    if (ch === sep && depth <= 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}
