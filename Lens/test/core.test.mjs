import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { normaliseSignature, symbolAnchor, fingerprintAnchor, qualify } from '../out-test/core/anchor.js';
import { parseEntry, serialiseEntry, slugify, entryFilename } from '../out-test/core/frontmatter.js';
import {
  nextRevisit,
  isDue,
  dueEntries,
  markUnderstood,
  markUnclear,
  resolveQuestion,
  rampUpStatus,
  DEFAULT_INTERVALS,
} from '../out-test/core/review.js';
import { Journal } from '../out-test/core/journal.js';

const NOW = new Date('2026-08-05T12:00:00.000Z');

function entry(over = {}) {
  return {
    anchor: 'lens:0123456789abcdef',
    anchorMode: 'symbol',
    kind: 'wtf',
    symbol: 'motor::Controller::step',
    symbolKind: 'Method',
    detail: 'void (uint16_t rpm)',
    file: 'src/motor/controller.cpp',
    line: 88,
    created: '2026-07-01T09:00:00.000Z',
    updated: '2026-07-01T09:00:00.000Z',
    revisitAt: '2026-07-08T09:00:00.000Z',
    confidence: 0,
    tags: ['virtual', 'dispatch'],
    body: 'Why does this go through a vtable when there is only one derived class?',
    ...over,
  };
}

describe('signature normalisation', () => {
  test('strips parameter names but keeps types', () => {
    assert.equal(normaliseSignature('void (uint16_t rpm, bool force)'), '(uint16_t,bool)');
  });

  test('keeps bare types that have no parameter name', () => {
    assert.equal(normaliseSignature('(int, const char *)'), '(int,const char*)');
  });

  test('collapses pointer and reference spacing variants to one form', () => {
    // The property that matters is convergence, not any particular spelling:
    // clangd and cpptools punctuate declarations differently and both must
    // anchor to the same id.
    const forms = ['(const char *p)', '(const char* p)', '(const  char *  p)', '(const char *)'];
    const [first, ...rest] = forms.map(normaliseSignature);
    for (const f of rest) {
      assert.equal(f, first);
    }
  });

  test('treats an empty and a void parameter list identically', () => {
    assert.equal(normaliseSignature('void ()'), normaliseSignature('void (void)'));
  });

  test('captures trailing qualifiers that participate in overload resolution', () => {
    assert.equal(normaliseSignature('int (int a) const'), '(int)const');
    assert.notEqual(normaliseSignature('int (int a) const'), normaliseSignature('int (int a)'));
  });

  test('ignores default arguments', () => {
    assert.equal(normaliseSignature('void (int a = 3)'), '(int)');
  });

  test('tolerates a missing detail string', () => {
    assert.equal(normaliseSignature(undefined), '');
    assert.equal(normaliseSignature('someNonFunctionDetail'), '');
  });
});

describe('anchoring', () => {
  const base = { qualifiedName: 'motor::Controller::step', symbolKind: 'Method', detail: 'void (uint16_t rpm)' };

  test('is stable across identical input', () => {
    assert.equal(symbolAnchor(base), symbolAnchor({ ...base }));
  });

  test('ignores parameter names, so renaming an argument does not orphan a note', () => {
    assert.equal(symbolAnchor(base), symbolAnchor({ ...base, detail: 'void (uint16_t desired)' }));
  });

  test('ignores whitespace in the qualified name', () => {
    assert.equal(symbolAnchor(base), symbolAnchor({ ...base, qualifiedName: 'motor:: Controller::step' }));
  });

  test('distinguishes overloads by parameter type', () => {
    assert.notEqual(symbolAnchor(base), symbolAnchor({ ...base, detail: 'void (float rpm)' }));
  });

  test('distinguishes symbols of the same name in different scopes', () => {
    assert.notEqual(symbolAnchor(base), symbolAnchor({ ...base, qualifiedName: 'servo::Controller::step' }));
  });

  test('distinguishes a method from a field of the same name', () => {
    assert.notEqual(symbolAnchor(base), symbolAnchor({ ...base, symbolKind: 'Field' }));
  });

  test('produces a prefixed, fixed-width id', () => {
    assert.match(symbolAnchor(base), /^lens:[0-9a-f]{16}$/);
  });

  test('fingerprint anchors ignore whitespace but not content', () => {
    const a = fingerprintAnchor('src/x.c', ['  int a = 1;', 'foo();']);
    assert.equal(a, fingerprintAnchor('src/x.c', ['int a=1;', '  foo();  ']));
    assert.notEqual(a, fingerprintAnchor('src/x.c', ['int a = 2;', 'foo();']));
    assert.notEqual(a, fingerprintAnchor('src/y.c', ['int a = 1;', 'foo();']));
  });

  test('qualify skips empty segments', () => {
    assert.equal(qualify(['motor', ''], 'step'), 'motor::step');
    assert.equal(qualify([], 'step'), 'step');
  });
});

describe('frontmatter', () => {
  test('round-trips without loss', () => {
    const original = entry();
    const parsed = parseEntry(serialiseEntry(original));
    for (const key of Object.keys(original)) {
      assert.deepEqual(parsed[key], original[key], `field ${key} did not round-trip`);
    }
  });

  test('round-trips a retired entry with a null revisit date', () => {
    const parsed = parseEntry(serialiseEntry(entry({ revisitAt: null, confidence: 3 })));
    assert.equal(parsed.revisitAt, null);
    assert.equal(parsed.confidence, 3);
  });

  test('round-trips a body containing the frontmatter delimiter', () => {
    const body = 'A horizontal rule follows.\n\n---\n\nAnd text after it.';
    assert.equal(parseEntry(serialiseEntry(entry({ body }))).body, body);
  });

  test('round-trips symbols containing characters that need quoting', () => {
    const symbol = 'std::vector<int, std::allocator<int>>::push_back';
    assert.equal(parseEntry(serialiseEntry(entry({ symbol }))).body.length > 0, true);
    assert.equal(parseEntry(serialiseEntry(entry({ symbol }))).symbol, symbol);
  });

  test('round-trips an empty tag list', () => {
    assert.deepEqual(parseEntry(serialiseEntry(entry({ tags: [] }))).tags, []);
  });

  test('rejects a document with no frontmatter', () => {
    assert.throws(() => parseEntry('just a note'), /frontmatter/);
  });

  test('rejects an unterminated frontmatter block', () => {
    assert.throws(() => parseEntry('---\nanchor: lens:abc\n'), /unterminated/);
  });

  test('rejects an unknown kind rather than guessing', () => {
    const bad = serialiseEntry(entry()).replace('kind: wtf', 'kind: musings');
    assert.throws(() => parseEntry(bad), /unknown kind/);
  });

  test('rejects a malformed anchor', () => {
    const bad = serialiseEntry(entry()).replace(/anchor: .*/, 'anchor: nope');
    assert.throws(() => parseEntry(bad), /anchor/);
  });

  test('tolerates CRLF line endings', () => {
    const parsed = parseEntry(serialiseEntry(entry()).replace(/\n/g, '\r\n'));
    assert.equal(parsed.symbol, 'motor::Controller::step');
  });

  test('slugs are filesystem safe and bounded', () => {
    assert.equal(slugify('motor::Controller::step'), 'motor-controller-step');
    assert.equal(slugify('operator<<'), 'operator');
    assert.ok(slugify('a'.repeat(200)).length <= 60);
    assert.equal(slugify('::'), 'entry');
  });

  test('filename encodes kind, symbol and a disambiguating id fragment', () => {
    assert.equal(entryFilename(entry()), 'wtf-motor-controller-step-01234567.md');
  });
});

describe('review scheduling', () => {
  test('first interval is seven days out', () => {
    assert.equal(nextRevisit('wtf', 0, NOW), '2026-08-12T12:00:00.000Z');
  });

  test('confidence walks the interval table', () => {
    assert.equal(nextRevisit('learned', 1, NOW), '2026-09-04T12:00:00.000Z');
    assert.equal(nextRevisit('learned', 2, NOW), '2026-11-03T12:00:00.000Z');
  });

  test('retires once confidence exhausts the table', () => {
    assert.equal(nextRevisit('learned', DEFAULT_INTERVALS.length, NOW), null);
  });

  test('honours custom intervals', () => {
    assert.equal(nextRevisit('wtf', 0, NOW, [1]), '2026-08-06T12:00:00.000Z');
    assert.equal(nextRevisit('wtf', 1, NOW, [1]), null);
  });

  test('todo entries are never scheduled', () => {
    assert.equal(nextRevisit('todo', 0, NOW), null);
  });

  test('due detection respects the boundary and ignores retired entries', () => {
    assert.equal(isDue(entry({ revisitAt: '2026-08-05T11:59:00.000Z' }), NOW), true);
    assert.equal(isDue(entry({ revisitAt: '2026-08-06T00:00:00.000Z' }), NOW), false);
    assert.equal(isDue(entry({ revisitAt: null }), NOW), false);
  });

  test('due entries come back oldest first', () => {
    const list = [
      entry({ revisitAt: '2026-08-01T00:00:00.000Z', symbol: 'b' }),
      entry({ revisitAt: '2026-07-01T00:00:00.000Z', symbol: 'a' }),
      entry({ revisitAt: '2026-09-01T00:00:00.000Z', symbol: 'c' }),
    ];
    assert.deepEqual(dueEntries(list, NOW).map((e) => e.symbol), ['a', 'b']);
  });

  test('understanding pushes the entry further out', () => {
    const after = markUnderstood(entry(), NOW);
    assert.equal(after.confidence, 1);
    assert.equal(after.revisitAt, '2026-09-04T12:00:00.000Z');
  });

  test('three confirmations retire an entry', () => {
    let e = entry();
    for (let i = 0; i < 3; i++) {
      e = markUnderstood(e, NOW);
    }
    assert.equal(e.revisitAt, null);
    assert.equal(e.confidence, 3);
  });

  test('remaining unclear resets to the front of the schedule without penalty', () => {
    const after = markUnclear(entry({ confidence: 2 }), NOW);
    assert.equal(after.confidence, 0);
    assert.equal(after.revisitAt, '2026-08-12T12:00:00.000Z');
  });

  test('resolving a question converts it to learned and resets confidence', () => {
    const after = resolveQuestion(entry({ confidence: 2 }), 'Only one derived class today, but the HAL is swapped at link time.', NOW);
    assert.equal(after.kind, 'learned');
    assert.equal(after.confidence, 0);
    assert.match(after.body, /\*\*Resolved:\*\* Only one derived class/);
    assert.match(after.body, /vtable/);
  });

  test('resolving with an empty note leaves the body untouched', () => {
    const original = entry();
    assert.equal(resolveQuestion(original, '   ', NOW).body, original.body);
  });

  test('mutations are non-destructive', () => {
    const original = entry();
    markUnderstood(original, NOW);
    assert.equal(original.confidence, 0);
  });
});

describe('ramp-up status', () => {
  test('counts kinds, modules, open questions and retirements', () => {
    const s = rampUpStatus(
      [
        entry({ kind: 'wtf', file: 'src/motor/a.cpp', created: '2026-01-01T00:00:00.000Z' }),
        entry({ kind: 'wtf', file: 'src/motor/b.cpp' }),
        entry({ kind: 'learned', file: 'src/comms/c.cpp', revisitAt: null }),
        entry({ kind: 'todo', file: 'app/main.cpp', revisitAt: null }),
      ],
      NOW,
    );
    assert.equal(s.total, 4);
    assert.equal(s.openQuestions, 2);
    assert.equal(s.byKind.learned, 1);
    assert.equal(s.modulesTouched, 3);
    // The retired count excludes `todo`, which was never on the schedule.
    assert.equal(s.retired, 1);
    assert.equal(s.oldestOpenQuestionDays, 216);
  });

  test('handles an empty journal', () => {
    const s = rampUpStatus([], NOW);
    assert.equal(s.total, 0);
    assert.equal(s.oldestOpenQuestionDays, null);
  });
});

describe('journal store', () => {
  let dir;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lens-'));
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a missing journal folder loads as empty rather than throwing', async () => {
    const j = new Journal(path.join(dir, 'absent'));
    await j.load();
    assert.equal(j.entries.length, 0);
  });

  test('saves, reloads and indexes by anchor', async () => {
    const j = new Journal(path.join(dir, 'journal'));
    await j.save(entry());
    await j.load();
    assert.equal(j.entries.length, 1);
    assert.equal(j.for('lens:0123456789abcdef').length, 1);
    assert.equal(j.ofKind('wtf').length, 1);
  });

  test('holds several entries against one anchor', async () => {
    const j = new Journal(path.join(dir, 'multi'));
    await j.save(entry({ kind: 'wtf', created: '2026-07-01T09:00:00.000Z' }));
    await j.save(entry({ kind: 'quirk', created: '2026-07-02T09:00:00.000Z' }));
    await j.load();
    assert.equal(j.for('lens:0123456789abcdef').length, 2);
  });

  test('a malformed file is reported and skipped, not fatal', async () => {
    const bad = path.join(dir, 'mixed');
    const j = new Journal(bad);
    await j.save(entry());
    await fs.writeFile(path.join(bad, 'broken.md'), 'not an entry', 'utf8');
    await j.load();
    assert.equal(j.entries.length, 1);
    assert.equal(j.loadProblems.length, 1);
    assert.match(j.loadProblems[0], /broken\.md/);
  });

  test('changing kind renames the backing file and leaves no duplicate', async () => {
    const d = path.join(dir, 'rename');
    const j = new Journal(d);
    const saved = await j.save(entry());
    const previous = saved.path;
    await j.saveRenaming({ ...saved, kind: 'learned' }, previous);
    await j.load();
    assert.equal(j.entries.length, 1);
    assert.equal(j.entries[0].kind, 'learned');
    assert.deepEqual((await fs.readdir(d)).sort(), ['learned-motor-controller-step-01234567.md']);
  });

  test('removal deletes the file', async () => {
    const j = new Journal(path.join(dir, 'removal'));
    const saved = await j.save(entry());
    await j.remove(saved);
    await j.load();
    assert.equal(j.entries.length, 0);
  });

  test('export groups by kind and omits empty sections', async () => {
    const j = new Journal(path.join(dir, 'export'));
    await j.save(entry({ kind: 'wtf' }));
    await j.save(entry({ kind: 'learned', created: '2026-07-03T09:00:00.000Z', symbol: 'hal::spi::send' }));
    await j.load();
    const md = j.export('Test');
    assert.match(md, /^# Test/);
    assert.match(md, /## Open questions \(1\)/);
    assert.match(md, /## Learned \(1\)/);
    assert.doesNotMatch(md, /## Quirks/);
    assert.match(md, /### `hal::spi::send`/);
  });

  test('export of an empty journal says so rather than producing a bare heading', async () => {
    const j = new Journal(path.join(dir, 'empty-export'));
    await j.load();
    assert.match(j.export(), /_No entries yet\._/);
  });
});
