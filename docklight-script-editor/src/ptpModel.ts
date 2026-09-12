/**
 * Docklight .ptp file model.
 *
 * IMPORTANT HONESTY NOTE:
 * Docklight's .ptp text layout is not officially published by Kickdrive/FuH.
 * This parser is deliberately generic and structural rather than semantic,
 * and it has already had to adapt once to real-world files that don't match
 * the very first sample — so it's built to bend without breaking:
 *
 *   - The file is a sequence of BLOCKS. A new block starts either after a
 *     blank line, OR when a line exactly matches a KNOWN keyword (VERSION,
 *     COMMSETTINGS, COMMDISPLAY, COMMCHANNELS, SEND, RECEIVE) even with no
 *     blank line before it. This handles files that are blank-line-separated
 *     (the first sample given) as well as files that pack blocks back-to-back
 *     (a second sample given without blank lines between VERSION/COMMSETTINGS/
 *     COMMDISPLAY).
 *   - Within a SEND block, the exact number of lines is NOT assumed. Two real
 *     samples have shown different shapes:
 *       sample A: index / ASCII label / hex bytes / flag / delay   (5 lines)
 *       sample B: index / name / hex bytes / trailing field         (4 lines)
 *     So instead of fixed positions, the hex-bytes line is located by pattern
 *     (a line of 2+ whitespace-separated 2-digit hex byte tokens). Everything
 *     between the index and the hex line is treated as "label lines".
 *     Everything after the hex line is treated as opaque "trailing fields"
 *     (shown in the UI, editable, but not claimed to mean anything specific).
 *
 * This keeps the parser lossless for block types/shapes it doesn't fully
 * understand, at the cost of not being able to name every field with
 * certainty. See README.md for the recommended verification step before
 * relying on this for real device testing.
 */

export type Block = {
  /** The keyword line, e.g. "SEND", "VERSION", "COMMCHANNELS". */
  keyword: string;
  /** Raw lines following the keyword, in original order, NOT including the keyword line. */
  lines: string[];
};

export type SendCommand = {
  /** Index into the parsed blocks array, so we can write back in place. */
  blockIndex: number;
  /** First line of the block - normally a small integer position, but not validated as such. */
  index: string;
  /** Line(s) between the index and the detected hex-bytes line. Usually just one (a name/ASCII label). */
  labelLines: string[];
  /** The detected hex-bytes line, e.g. "41 54 51 30 0D 0A". */
  hex: string;
  /** Any line(s) after the hex line. Meaning not confirmed - shown generically in the UI. */
  trailingFields: string[];
};

export type ParsedPtp = {
  blocks: Block[];
  /** Convenience view: indices of blocks that are SEND blocks, in file order. */
  sendBlockIndices: number[];
};

const LINE_SPLIT = /\r\n|\r|\n/;

/** Keywords that always start a new block, even without a preceding blank line. */
const KNOWN_KEYWORDS = new Set([
  'VERSION',
  'COMMSETTINGS',
  'COMMDISPLAY',
  'COMMCHANNELS',
  'SEND',
  'RECEIVE',
]);

/** A line of 2+ space-separated 2-digit hex byte tokens. Requires at least 2 tokens
 *  so a lone single-token numeric field (an index, flag, or delay value) is never
 *  mistaken for a hex-bytes line. */
const HEX_LINE_RE = /^([0-9a-fA-F]{2})(\s+[0-9a-fA-F]{2})+$/;

function looksLikeHexLine(line: string): boolean {
  return HEX_LINE_RE.test(line.trim());
}

/** Detect the line ending style used in the original file, so we can preserve it on save. */
export function detectEol(text: string): string {
  const crlfCount = (text.match(/\r\n/g) || []).length;
  const lfOnlyCount = (text.match(/(?<!\r)\n/g) || []).length;
  return crlfCount >= lfOnlyCount ? '\r\n' : '\n';
}

export function parsePtp(text: string): ParsedPtp {
  const rawLines = text.split(LINE_SPLIT);

  // Trim a single trailing empty line caused by a final newline in the file.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop();
  }

  const blocks: Block[] = [];
  let i = 0;
  while (i < rawLines.length) {
    // Skip blank lines between blocks.
    while (i < rawLines.length && rawLines[i].trim() === '') {
      i++;
    }
    if (i >= rawLines.length) break;

    const keyword = rawLines[i];
    i++;
    const lines: string[] = [];
    while (
      i < rawLines.length &&
      rawLines[i].trim() !== '' &&
      !KNOWN_KEYWORDS.has(rawLines[i].trim())
    ) {
      lines.push(rawLines[i]);
      i++;
    }
    blocks.push({ keyword, lines });
  }

  const sendBlockIndices = blocks
    .map((b, idx) => (b.keyword === 'SEND' ? idx : -1))
    .filter((idx) => idx !== -1);

  return { blocks, sendBlockIndices };
}

export function serializePtp(parsed: ParsedPtp, eol: string): string {
  const chunks: string[] = [];
  for (const block of parsed.blocks) {
    chunks.push([block.keyword, ...block.lines].join(eol));
  }
  return chunks.join(eol + eol) + eol;
}

export function blockToSendCommand(block: Block, blockIndex: number): SendCommand {
  const lines = block.lines;
  const hexLineIdx = lines.findIndex((l, idx) => idx > 0 && looksLikeHexLine(l));

  if (hexLineIdx === -1) {
    // No recognizable hex line at all (e.g. an empty/malformed SEND block).
    // Preserve everything as label lines rather than losing data.
    return {
      blockIndex,
      index: lines[0] ?? '',
      labelLines: lines.slice(1),
      hex: '',
      trailingFields: [],
    };
  }

  return {
    blockIndex,
    index: lines[0] ?? '',
    labelLines: lines.slice(1, hexLineIdx),
    hex: lines[hexLineIdx],
    trailingFields: lines.slice(hexLineIdx + 1),
  };
}

export function sendCommandToBlock(cmd: SendCommand): Block {
  const lines = [cmd.index, ...cmd.labelLines, cmd.hex, ...cmd.trailingFields];
  return { keyword: 'SEND', lines };
}

export function getSendCommands(parsed: ParsedPtp): SendCommand[] {
  return parsed.sendBlockIndices.map((idx) => blockToSendCommand(parsed.blocks[idx], idx));
}

/** Renumber the `index` field of all SEND blocks to match their position (0-based), like Docklight does. */
export function renumberSendCommands(parsed: ParsedPtp): void {
  let n = 0;
  for (const idx of parsed.sendBlockIndices) {
    if (parsed.blocks[idx].lines.length > 0) {
      parsed.blocks[idx].lines[0] = String(n);
    }
    n++;
  }
}

/**
 * Convert a hex-bytes line into a fully reversible, human-editable ASCII form.
 * This is the PRIMARY representation shown to the user - the raw hex is an
 * implementation detail of the file format, not something they need to look
 * at for ordinary AT-command-style text sequences.
 *
 *   - printable ASCII (0x20-0x7E), except backslash, stays as the literal character
 *   - carriage return (0x0D) -> \r
 *   - line feed   (0x0A) -> \n
 *   - tab         (0x09) -> \t
 *   - NUL         (0x00) -> \0
 *   - backslash   (0x5C) -> \\
 *   - anything else non-printable -> \xNN (2-digit uppercase hex)
 *
 * This keeps the conversion lossless for arbitrary bytes while reading
 * naturally for the common case of plain text commands terminated by CRLF.
 */
export function hexToEditableAscii(hex: string): string {
  const tokens = hex.trim().split(/\s+/).filter(Boolean);
  let out = '';
  for (const tok of tokens) {
    const val = parseInt(tok, 16);
    if (Number.isNaN(val)) continue;
    out += byteToEscapedChar(val);
  }
  return out;
}

function byteToEscapedChar(val: number): string {
  switch (val) {
    case 0x0d:
      return '\\r';
    case 0x0a:
      return '\\n';
    case 0x09:
      return '\\t';
    case 0x00:
      return '\\0';
    case 0x5c:
      return '\\\\';
  }
  if (val >= 0x20 && val < 0x7f) {
    return String.fromCharCode(val);
  }
  return '\\x' + val.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Inverse of hexToEditableAscii: parses \r \n \t \0 \\ and \xNN escapes,
 * encodes everything else as its plain character code (UTF-16 code unit,
 * truncated to a byte). This is what runs when the user types new text and
 * it needs to become hex bytes for saving to the file.
 */
export function editableAsciiToHex(text: string): string {
  const bytes: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      const next = text[i + 1];
      if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 2, i + 4))) {
        bytes.push(text.slice(i + 2, i + 4).toUpperCase());
        i += 4;
        continue;
      }
      if (next === 'r') {
        bytes.push('0D');
        i += 2;
        continue;
      }
      if (next === 'n') {
        bytes.push('0A');
        i += 2;
        continue;
      }
      if (next === 't') {
        bytes.push('09');
        i += 2;
        continue;
      }
      if (next === '0') {
        bytes.push('00');
        i += 2;
        continue;
      }
      if (next === '\\') {
        bytes.push('5C');
        i += 2;
        continue;
      }
      // Unrecognized escape: treat the backslash as a literal byte and
      // continue from the next character, rather than silently dropping data.
      bytes.push('5C');
      i += 1;
      continue;
    }
    bytes.push((text.charCodeAt(i) & 0xff).toString(16).toUpperCase().padStart(2, '0'));
    i += 1;
  }
  return bytes.join(' ');
}

export function isValidHex(hex: string): boolean {
  const tokens = hex.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((t) => /^[0-9a-fA-F]{1,2}$/.test(t));
}
