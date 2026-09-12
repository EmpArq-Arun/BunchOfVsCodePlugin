import { escapeXml } from './render.js';
import type { MergedField, MergedLayout } from './layoutmerge.js';

/**
 * Object layout byte-map.
 *
 * A row per 8-byte line, a cell per byte, so the reader sees the object the way
 * it sits in memory rather than as a list of declarations. Hidden storage — vptrs
 * and virtual-base machinery — is drawn in the same space as real members,
 * because the whole point is that it occupies the same space.
 *
 * Where a field's size is unknown (pahole could not read the type, which is every
 * polymorphic class) the cell spans to the next known offset and is drawn with a
 * dashed edge. It is not guessed silently: the reader can see which extents are
 * measured and which are inferred.
 */

const CELL = 26;
const ROW_H = 30;
const LEFT = 54;
const PAD = 16;
const PER_ROW = 8;

type Segment = {
  start: number;
  length: number;
  label: string;
  cls: 'field' | 'vptr' | 'base' | 'pad' | 'unknown';
  title: string;
};

/**
 * Turn the field list into byte segments.
 *
 * Base and bitfield entries are folded into their containing bytes rather than
 * given their own segments: a base subobject is not a thing that occupies bytes
 * separately from its members.
 */
export function segments(l: MergedLayout): Segment[] {
  const leaves = l.fields.filter((f) => f.kind === 'field' || f.kind === 'vtable-pointer' || f.kind === 'bitfield');
  const out: Segment[] = [];

  const placed = leaves
    .map((f, i) => ({ f, i }))
    .filter(({ f }, idx, arr) => arr.findIndex((x) => x.f.offset === f.offset && x.f.name === f.name) === idx)
    .sort((a, b) => a.f.offset - b.f.offset || a.i - b.i);

  for (let i = 0; i < placed.length; i++) {
    const f = placed[i].f;
    const next = placed[i + 1]?.f.offset ?? l.dataSize;
    const known = f.size !== undefined;
    const length = Math.max(1, known ? f.size! : Math.max(1, next - f.offset));

    out.push({
      start: f.offset,
      length,
      label: label(f),
      cls: f.kind === 'vtable-pointer' ? 'vptr' : known ? 'field' : 'unknown',
      title: title(f, known, length),
    });

    const gapStart = f.offset + length;
    if (next > gapStart) {
      out.push({
        start: gapStart,
        length: next - gapStart,
        label: '',
        cls: 'pad',
        title: `${next - gapStart} bytes of padding — inserted for alignment, not declared`,
      });
    }
  }

  if (l.sizeOf > l.dataSize) {
    out.push({
      start: l.dataSize,
      length: l.sizeOf - l.dataSize,
      label: '',
      cls: 'pad',
      title: `${l.sizeOf - l.dataSize} bytes of tail padding — keeps alignment correct in arrays`,
    });
  }
  return out;
}

function label(f: MergedField): string {
  if (f.kind === 'vtable-pointer') {
    return `vptr (${f.name})`;
  }
  if (f.kind === 'bitfield' && f.bits) {
    return `${f.name || '(unnamed)'}:${f.bits.last - f.bits.first + 1}`;
  }
  return f.name || f.type;
}

function title(f: MergedField, known: boolean, length: number): string {
  const base = f.kind === 'vtable-pointer' ? `Hidden vtable pointer for ${f.name}` : `${f.type} ${f.name}`;
  const extent = known ? `${length} bytes` : `${length} bytes (inferred — no observed size available)`;
  return `${base}\noffset ${f.offset}, ${extent}`;
}

export function renderLayoutSvg(l: MergedLayout): string {
  const segs = segments(l);
  const rows = Math.max(1, Math.ceil(l.sizeOf / PER_ROW));
  const width = LEFT + PER_ROW * CELL + PAD * 2;
  const height = PAD * 2 + 18 + rows * ROW_H;

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="var(--vscode-editor-font-family, monospace)">`,
  ];

  // Byte ruler.
  for (let b = 0; b < PER_ROW; b++) {
    parts.push(
      `<text x="${LEFT + PAD + b * CELL + CELL / 2}" y="${PAD + 10}" text-anchor="middle" font-size="9" fill="var(--lens-muted)">${b}</text>`,
    );
  }

  for (let r = 0; r < rows; r++) {
    const y = PAD + 18 + r * ROW_H;
    parts.push(
      `<text x="${LEFT - 8 + PAD}" y="${y + 19}" text-anchor="end" font-size="10" fill="var(--lens-muted)">+${r * PER_ROW}</text>`,
    );
  }

  for (const s of segs) {
    // A segment can straddle rows; draw one rectangle per row it touches.
    let remaining = s.length;
    let at = s.start;
    let first = true;
    while (remaining > 0 && at < l.sizeOf) {
      const row = Math.floor(at / PER_ROW);
      const col = at % PER_ROW;
      const span = Math.min(remaining, PER_ROW - col);
      const x = LEFT + PAD + col * CELL;
      const y = PAD + 18 + row * ROW_H;
      const w = span * CELL;
      const dash = s.cls === 'unknown' ? ' stroke-dasharray="4 3"' : '';
      const fill = {
        field: 'var(--lens-node)',
        vptr: 'var(--lens-vptr)',
        base: 'var(--lens-node)',
        pad: 'var(--lens-pad)',
        unknown: 'var(--lens-node)',
      }[s.cls];

      parts.push(
        `<g><rect x="${x}" y="${y}" width="${w - 2}" height="${ROW_H - 6}" rx="2" fill="${fill}" ` +
          `stroke="var(--lens-border)" stroke-width="1"${dash}/>`,
      );
      if (first && s.label) {
        parts.push(
          `<text x="${x + 5}" y="${y + 16}" font-size="10.5" fill="var(--lens-fg)">${escapeXml(
            clip(s.label, span),
          )}</text>`,
        );
      }
      parts.push(`<title>${escapeXml(s.title)}</title></g>`);
      remaining -= span;
      at += span;
      first = false;
    }
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function clip(text: string, spanCells: number): string {
  const max = Math.max(3, Math.floor((spanCells * CELL - 8) / 6));
  return text.length <= max ? text : `${text.slice(0, max - 1)}.`;
}

export const LAYOUT_LEGEND = [
  { cls: 'field', meaning: 'a member you declared' },
  { cls: 'vptr', meaning: 'hidden vtable pointer — nothing in the source mentions it' },
  { cls: 'pad', meaning: 'padding inserted for alignment' },
  { cls: 'unknown', meaning: 'extent inferred, not measured — no observed size for this type' },
];
