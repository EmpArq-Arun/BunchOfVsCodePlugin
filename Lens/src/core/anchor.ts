import { createHash } from 'node:crypto';
import type { AnchorMode, SymbolPath } from './model.js';

/**
 * Anchoring strategy for P0.
 *
 * Identity is derived from *what the symbol is called*, not where it sits. A
 * qualified name plus symbol kind plus a normalised signature hashes to a stable
 * id, so an entry written today still resolves after the function moves down the
 * file, after clang-format rewraps it, and after the file itself is moved.
 *
 * What this does not survive: renaming the symbol. That is correct behaviour —
 * a renamed symbol is arguably a different thing — but the UI surfaces orphaned
 * entries rather than silently dropping them, and offers re-anchoring.
 *
 * Overload disambiguation is best-effort. Language servers disagree on the shape
 * of `DocumentSymbol.detail` (clangd emits a return type and parameter list,
 * cpptools often emits nothing), so the normaliser reduces whatever it is given
 * to a parameter-type spine and tolerates its absence. Firmware codebases rarely
 * overload on type alone. P2 replaces this wholesale with real clangd USRs, and
 * `detail` is stored verbatim on every entry so that migration is lossless.
 */

const ID_PREFIX = 'lens:';
const ID_LENGTH = 16;

/**
 * Reduce a language-server `detail` string to a comparable parameter spine.
 *
 * `void (uint16_t rpm, bool force) const` -> `(uint16_t,bool)const`
 * `(int)`                                 -> `(int)`
 * `` / undefined                          -> ``
 */
export function normaliseSignature(detail?: string): string {
  if (!detail) {
    return '';
  }
  const open = detail.indexOf('(');
  if (open === -1) {
    return '';
  }
  const close = detail.lastIndexOf(')');
  if (close <= open) {
    return '';
  }

  const params = detail
    .slice(open + 1, close)
    .split(',')
    .map((p) => stripParameterName(p))
    .filter((p) => p.length > 0 && p !== 'void');

  // Qualifiers after the parameter list participate in overload resolution.
  const trailing = detail
    .slice(close + 1)
    .replace(/->.*$/, '')
    .replace(/[^a-z&]/g, '');
  const quals = ['const', 'volatile', 'noexcept', '&&', '&']
    .filter((q) => trailing.includes(q))
    .join('');

  return `(${params.join(',')})${quals}`;
}

/**
 * Drop the parameter name from a declaration, keeping the type.
 *
 * The name is the trailing identifier, but only when something precedes it and
 * that something is not just a pointer/reference decoration — `uint16_t rpm`
 * yields `uint16_t`, while a bare `uint16_t` yields itself.
 */
function stripParameterName(raw: string): string {
  let p = raw.trim().replace(/\s*=.*$/, ''); // default argument
  if (p.length === 0) {
    return '';
  }
  // Array suffix belongs to the type, not the name.
  p = p.replace(/\s*\[\s*\d*\s*\]\s*$/, '[]');

  const m = /^(.*?)([A-Za-z_]\w*)$/.exec(p);
  if (m) {
    const lead = m[1].trim();
    // Only strip when the lead is a plausible type, not an empty string or a
    // lone decoration (which would mean we matched the type itself).
    if (lead.length > 0 && /[A-Za-z_>\]]/.test(lead)) {
      p = lead;
    }
  }
  return p.replace(/\s+/g, ' ').replace(/\s*([*&<>:,])\s*/g, '$1').trim();
}

function digest(payload: string): string {
  return ID_PREFIX + createHash('sha1').update(payload, 'utf8').digest('hex').slice(0, ID_LENGTH);
}

/** Stable id for a named symbol. */
export function symbolAnchor(sym: SymbolPath): string {
  const parts = [
    sym.qualifiedName.replace(/\s+/g, ''),
    sym.symbolKind,
    normaliseSignature(sym.detail),
  ];
  return digest(parts.join('|'));
}

/**
 * Stable id for a position the language server could not name.
 *
 * Hashes the workspace-relative path together with the non-whitespace content of
 * the anchored line and its two neighbours, so the entry survives edits made
 * elsewhere in the file but is honestly reported as orphaned if the anchored
 * text itself changes.
 */
export function fingerprintAnchor(relPath: string, contextLines: string[]): string {
  const spine = contextLines.map((l) => l.replace(/\s+/g, '')).join('\n');
  return digest(['fp', relPath, spine].join('|'));
}

export function anchorFor(
  mode: AnchorMode,
  sym: SymbolPath | undefined,
  relPath: string,
  contextLines: string[],
): string {
  if (mode === 'symbol' && sym) {
    return symbolAnchor(sym);
  }
  return fingerprintAnchor(relPath, contextLines);
}

/** Join a container chain into a qualified name, skipping empty segments. */
export function qualify(containers: string[], name: string): string {
  return [...containers, name].filter((s) => s && s.length > 0).join('::');
}
