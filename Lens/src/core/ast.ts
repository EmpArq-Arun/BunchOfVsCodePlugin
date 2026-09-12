/**
 * clang JSON AST ingest.
 *
 * `clang++ -Xclang -ast-dump=json -Xclang -ast-dump-filter=<name> -fsyntax-only`
 * is the parse for the Rosetta lens. The filter is essential rather than an
 * optimisation: an unfiltered dump of a real translation unit is hundreds of
 * megabytes because it includes every declaration pulled in by every header.
 * Filtered to one function it is around 150 KB, which is a different kind of
 * problem entirely.
 *
 * Two properties of the format need handling and neither is optional.
 *
 * First, clang emits several top-level JSON objects when the filter matches more
 * than one declaration, concatenated with no enclosing array. `JSON.parse` on
 * the whole text fails.
 *
 * Second, and more subtly, source locations are *differential*. A node's
 * `loc.file` appears only when the file differs from the previously emitted
 * location, and `line` only when the line differs. Reading a node in isolation
 * therefore gives a location that is wrong rather than absent, which is the
 * worst of both. Reconstructing it requires replaying the same pre-order walk
 * clang used to write it, carrying file and line forward.
 */

export interface RawLoc {
  offset?: number;
  file?: string;
  line?: number;
  col?: number;
  tokLen?: number;
  /** Present for locations inside macro expansions. */
  spellingLoc?: RawLoc;
  expansionLoc?: RawLoc;
  includedFrom?: { file: string };
}

export interface AstNode {
  id?: string;
  kind?: string;
  name?: string;
  mangledName?: string;
  loc?: RawLoc;
  range?: { begin?: RawLoc; end?: RawLoc };
  type?: { qualType?: string; desugaredQualType?: string };
  inner?: AstNode[];
  [key: string]: unknown;
}

export class AstParseError extends Error {}

/**
 * Split concatenated top-level JSON objects by brace balance, ignoring braces
 * inside string literals. A streaming split is needed because clang does not
 * wrap multiple matches in an array.
 */
export function splitJsonObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        throw new AstParseError('unbalanced braces in AST dump');
      }
    }
  }
  if (depth !== 0) {
    throw new AstParseError('truncated AST dump — clang output ended mid-object');
  }
  return out;
}

export function parseAstDump(text: string): AstNode[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  return splitJsonObjects(trimmed).map((chunk, i) => {
    try {
      return JSON.parse(chunk) as AstNode;
    } catch (err) {
      throw new AstParseError(`AST object ${i} is not valid JSON: ${(err as Error).message}`);
    }
  });
}

export interface Span {
  file: string;
  beginLine: number;
  beginCol: number;
  endLine: number;
  endCol: number;
}

export interface Located {
  node: AstNode;
  span: Span;
  /** Ancestor chain, outermost first. Used by detectors that need context. */
  ancestors: AstNode[];
}

interface LocState {
  file: string;
  line: number;
}

/**
 * Resolve one differential location against the running state, updating it.
 * Macro expansions carry a nested `expansionLoc`; the expansion point is what a
 * reader wants to be shown, not the macro body.
 */
function resolve(loc: RawLoc | undefined, state: LocState): { line: number; col: number } | undefined {
  if (!loc) {
    return undefined;
  }
  const effective = loc.expansionLoc ?? loc;
  if (effective.file !== undefined) {
    state.file = effective.file;
  }
  if (effective.line !== undefined) {
    state.line = effective.line;
  }
  if (effective.line === undefined && effective.col === undefined && effective.offset === undefined) {
    return undefined;
  }
  return { line: state.line, col: effective.col ?? 1 };
}

/**
 * Pre-order walk reproducing clang's emission order, so differential locations
 * resolve correctly. Nodes whose location falls outside `mainFile` are yielded
 * too — filtering is the caller's decision, because a detector may legitimately
 * care about a declaration in a header.
 */
export function walk(roots: AstNode[], mainFile: string): Located[] {
  const out: Located[] = [];
  const state: LocState = { file: mainFile, line: 1 };
  const ancestors: AstNode[] = [];

  const visit = (node: AstNode): void => {
    // `loc` is emitted before `range` for a given node, and `range.begin`
    // before `range.end`. Resolving in that order is what keeps the running
    // state aligned with how clang wrote the file.
    resolve(node.loc, state);
    const begin = resolve(node.range?.begin, state);
    const beginFile = state.file;
    const beginLine = begin?.line ?? state.line;
    const end = resolve(node.range?.end, state);

    out.push({
      node,
      span: {
        file: beginFile,
        beginLine,
        beginCol: begin?.col ?? 1,
        endLine: end?.line ?? beginLine,
        endCol: end?.col ?? begin?.col ?? 1,
      },
      ancestors: [...ancestors],
    });

    if (node.inner) {
      ancestors.push(node);
      for (const child of node.inner) {
        visit(child);
      }
      ancestors.pop();
    }
  };

  for (const root of roots) {
    visit(root);
  }
  return out;
}

export function inMainFile(located: Located, mainFile: string): boolean {
  return located.span.file === mainFile || located.span.file.endsWith(`/${mainFile}`);
}

/** First ancestor of a given kind, innermost first. */
export function enclosing(located: Located, kind: string): AstNode | undefined {
  for (let i = located.ancestors.length - 1; i >= 0; i--) {
    if (located.ancestors[i].kind === kind) {
      return located.ancestors[i];
    }
  }
  return undefined;
}

export function typeName(node: AstNode): string {
  return node.type?.qualType ?? node.type?.desugaredQualType ?? '';
}

/** Strip references, pointers and cv-qualifiers to the underlying record name. */
export function bareTypeName(qual: string): string {
  return qual
    .replace(/\b(const|volatile)\b/g, '')
    .replace(/[*&]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
