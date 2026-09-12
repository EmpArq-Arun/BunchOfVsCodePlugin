import { isControlKeyword } from './textUtils';

export interface RawCallSite {
  name: string;            // unqualified or Qualified::name as written
  offset: number;           // offset of the identifier, within the same text the body was sliced from
}

// `identifier(` or `Scope::identifier(`, not preceded by '.' or '->' member
// access in a way that would make it a method call on an unrelated object
// chain we can't resolve anyway (those are kept too — best-effort: a method
// call site is still useful, just may not resolve to a unique node).
const CALL_RE = /\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\(/g;

export function extractCallSites(body: string): RawCallSite[] {
  const sites: RawCallSite[] = [];
  CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = CALL_RE.exec(body))) {
    const name = m[1];
    const last = name.includes('::') ? name.split('::').pop()! : name;

    if (isControlKeyword(last) || isControlKeyword(name)) continue;

    // Skip what's almost certainly a type declaration immediately followed by
    // a parenthesized initializer, e.g. "int result(0);" — heuristic only:
    // if the char immediately before the match (ignoring whitespace) is also
    // an identifier character preceded by a type-looking token, we can't
    // cheaply disambiguate, so we accept some false positives here by design.

    sites.push({ name, offset: m.index });
  }

  return sites;
}
