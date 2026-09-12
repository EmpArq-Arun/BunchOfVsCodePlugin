/**
 * Lightweight namespace tracker for heuristic mode.
 * Handles: named namespaces, C++17 nested (`namespace A::B {}`),
 * anonymous namespaces, and arbitrary nesting depth.
 *
 * Works on the CLEANED source (comments/literals stripped, attributes replaced
 * with spaces) so offsets stay consistent with those from functionExtractor.
 */

export interface NamespaceRange {
  /** Fully-qualified namespace name, e.g. "MyApp::UI".  Empty string = anonymous. */
  name: string;
  /** Offset of the `{` opening the namespace body. */
  start: number;
  /** Offset just past the matching `}`. */
  end: number;
}

/**
 * Extracts all namespace ranges from `cleanedSrc`.
 * Returns them sorted by start offset, with names as fully-qualified paths
 * (e.g., the inner `namespace Bar` inside `namespace Foo` gets name `Foo::Bar`).
 */
export function extractNamespaceRanges(cleanedSrc: string): NamespaceRange[] {
  const ranges: NamespaceRange[] = [];
  const n = cleanedSrc.length;

  const NS_RE = /\bnamespace\s*((?:[A-Za-z_]\w*\s*::\s*)*[A-Za-z_]\w*)?\s*\{/g;
  let m: RegExpExecArray | null;

  while ((m = NS_RE.exec(cleanedSrc))) {
    const localName = (m[1] ?? '').replace(/\s+/g, '');
    const braceOpen = m.index + m[0].length - 1;
    const end = findMatchingBrace(cleanedSrc, braceOpen);
    if (end === -1) continue;

    ranges.push({ name: localName, start: braceOpen + 1, end });
  }

  ranges.sort((a, b) => a.start - b.start);

  // Build fully-qualified names: for each range, find its nearest enclosing
  // parent range (the one with the largest start that still contains this range)
  // and prefix the parent's already-qualified name.
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    // Search all earlier (outer) ranges for the innermost parent
    let parent: NamespaceRange | undefined;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = ranges[j];
      if (candidate.start <= r.start && candidate.end >= r.end) {
        // candidate contains r — take the innermost (largest start)
        if (!parent || candidate.start > parent.start) parent = candidate;
      }
    }
    if (parent && parent.name && r.name) {
      r.name = `${parent.name}::${r.name}`;
    } else if (parent && parent.name && !r.name) {
      r.name = parent.name; // anonymous inside a named namespace
    }
  }

  return ranges;
}

/**
 * Returns the most deeply nested namespace name that contains `offset`.
 * Returns `undefined` if the offset is at file scope (not inside any namespace).
 */
export function namespaceAt(offset: number, ranges: NamespaceRange[]): string | undefined {
  // Walk all ranges and pick the innermost one (largest start that is still ≤ offset).
  let best: NamespaceRange | undefined;
  for (const r of ranges) {
    if (offset < r.start || offset >= r.end) continue;
    if (!best || r.start > best.start) best = r;
  }
  return best?.name;
}

/**
 * Builds a fully-qualified name by prepending the namespace.
 * e.g., `qualifyName("Circle", "MyApp::Shapes")` → `"MyApp::Shapes::Circle"`
 */
export function qualifyName(name: string, namespace: string | undefined): string {
  return namespace ? `${namespace}::${name}` : name;
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
