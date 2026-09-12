import { assert } from './helpers';
import { formatDoxygenComment, parseDoxygenComment } from '../src/annotations/doxygen';

export async function run(): Promise<void> {
  const original = 'Buffer overflow check: validate that idx stays within bufferSize before this array access';

  const wrapped = formatDoxygenComment(original, 50);
  const lines = wrapped.split('\n');
  assert(lines.length > 1, 'expected the long label to wrap across multiple lines at width 50');
  for (const line of lines) {
    assert(line.length <= 55, `wrapped line exceeds the configured width with some margin: "${line}"`); // small margin for the comment delimiters themselves
  }
  assert(wrapped.trimStart().startsWith('/**'), 'expected a Doxygen-style opener');
  assert(wrapped.trimEnd().endsWith('*/'), 'expected a closing */');

  // With multiline comment support, parseDoxygenComment preserves \n between content lines.
  // The round-trip should produce the same TEXT content when whitespace-normalized.
  const roundTripped = parseDoxygenComment(wrapped);
  const normalise = (s: string) => s.replace(/\s+/g, ' ').trim();
  assert(normalise(roundTripped) === normalise(original),
    `round-trip mismatch:\n  in:  "${original}"\n  out: "${roundTripped}"`);

  // a short label should NOT wrap unnecessarily
  const short = formatDoxygenComment('Null check', 80);
  assert(!short.includes('\n'), 'short labels should stay on one line');
  assert(parseDoxygenComment(short) === 'Null check', 'short label round-trip failed');

  console.log('  doxygen wrap/parse round-trip: OK');
}
