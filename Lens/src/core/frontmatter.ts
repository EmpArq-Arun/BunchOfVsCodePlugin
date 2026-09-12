import { ENTRY_KINDS, isEntryKind, type JournalEntry } from './model.js';

/**
 * Minimal YAML frontmatter reader/writer.
 *
 * A general YAML parser is not warranted here: the frontmatter schema is fixed,
 * flat, and entirely machine-written. Hand-rolling ~80 lines avoids a runtime
 * dependency in a bundled extension and keeps the on-disk format something a
 * human can confidently edit by hand — which matters, because these files are
 * committed and will be merged by git.
 */

const DELIM = '---';

export class FrontmatterError extends Error {}

interface RawDoc {
  fields: Record<string, string>;
  body: string;
}

function splitDocument(text: string): RawDoc {
  const normalised = text.replace(/\r\n/g, '\n');
  if (!normalised.startsWith(DELIM + '\n')) {
    throw new FrontmatterError('entry does not start with a frontmatter block');
  }
  const end = normalised.indexOf('\n' + DELIM, DELIM.length);
  if (end === -1) {
    throw new FrontmatterError('unterminated frontmatter block');
  }

  const head = normalised.slice(DELIM.length + 1, end);
  const body = normalised.slice(end + DELIM.length + 1).replace(/^\n+/, '').trimEnd();

  const fields: Record<string, string> = {};
  for (const line of head.split('\n')) {
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) {
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) {
      continue;
    }
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fields, body };
}

function unquote(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

function quote(v: string): string {
  if (v.length === 0) {
    return '""';
  }
  return /^[\w./:+-]+$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`;
}

function parseList(v: string | undefined): string[] {
  if (!v) {
    return [];
  }
  const inner = v.trim().replace(/^\[/, '').replace(/\]$/, '');
  return inner
    .split(',')
    .map((s) => unquote(s.trim()))
    .filter((s) => s.length > 0);
}

export function parseEntry(text: string): JournalEntry {
  const { fields, body } = splitDocument(text);

  const anchor = unquote(fields.anchor ?? '');
  if (!anchor.startsWith('lens:')) {
    throw new FrontmatterError(`missing or malformed anchor: ${fields.anchor ?? '<none>'}`);
  }

  const kindRaw = unquote(fields.kind ?? '');
  if (!isEntryKind(kindRaw)) {
    throw new FrontmatterError(`unknown kind "${kindRaw}" (expected one of ${ENTRY_KINDS.join(', ')})`);
  }

  const revisitRaw = unquote(fields.revisitAt ?? '');
  const confidence = Number.parseInt(unquote(fields.confidence ?? '0'), 10);
  const line = Number.parseInt(unquote(fields.line ?? '1'), 10);
  const created = unquote(fields.created ?? '') || new Date(0).toISOString();

  return {
    anchor,
    anchorMode: unquote(fields.anchorMode ?? 'symbol') === 'fingerprint' ? 'fingerprint' : 'symbol',
    kind: kindRaw,
    symbol: unquote(fields.symbol ?? '(unknown)'),
    symbolKind: unquote(fields.symbolKind ?? 'Unknown'),
    detail: fields.detail ? unquote(fields.detail) : undefined,
    file: unquote(fields.file ?? ''),
    line: Number.isFinite(line) && line > 0 ? line : 1,
    created,
    updated: unquote(fields.updated ?? '') || created,
    revisitAt: revisitRaw && revisitRaw !== 'null' ? revisitRaw : null,
    confidence: Number.isFinite(confidence) && confidence >= 0 ? confidence : 0,
    tags: parseList(fields.tags),
    body,
  };
}

export function serialiseEntry(e: JournalEntry): string {
  const lines: string[] = [DELIM];
  const put = (k: string, v: string) => lines.push(`${k}: ${v}`);

  put('anchor', e.anchor);
  put('anchorMode', e.anchorMode);
  put('kind', e.kind);
  put('symbol', quote(e.symbol));
  put('symbolKind', quote(e.symbolKind));
  if (e.detail) {
    put('detail', quote(e.detail));
  }
  put('file', quote(e.file));
  put('line', String(e.line));
  put('created', e.created);
  put('updated', e.updated);
  put('revisitAt', e.revisitAt ?? 'null');
  put('confidence', String(e.confidence));
  put('tags', `[${e.tags.map(quote).join(', ')}]`);

  lines.push(DELIM, '', e.body.trimEnd(), '');
  return lines.join('\n');
}

/** Filesystem-safe, human-legible slug from a qualified symbol name. */
export function slugify(symbol: string): string {
  const s = symbol
    .replace(/::/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  return (s.length > 0 ? s : 'entry').slice(0, 60);
}

export function entryFilename(e: JournalEntry): string {
  return `${e.kind}-${slugify(e.symbol)}-${e.anchor.slice(5, 13)}.md`;
}
