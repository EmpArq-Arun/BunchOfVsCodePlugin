const test = require('node:test');
const assert = require('node:assert');
const { buildMatcher, parseLine, compileTemplate } = require('../out-test/parser.js');

const TEMPLATE = 'or <COMMAND> ch1:<data> ch2:<data> ch3:<data> ch4:<data>';

function makeCommand(overrides = {}) {
  return {
    id: overrides.id || 'c1',
    name: overrides.name || 'READ',
    payload: overrides.payload || overrides.name || 'READ',
    encoding: 'ascii',
    lineEnding: '\r\n',
    repeatMs: 500,
    enabled: true,
    plot: overrides.plot !== false,
    graphWindow: overrides.graphWindow ?? 0,
    channels: overrides.channels || [1, 2, 3, 4],
    channelLabels: overrides.channelLabels || {},
    response: overrides.response || { mode: 'template', pattern: TEMPLATE, flags: 'i' },
    color: '#4FC3F7'
  };
}

function run(line, commands) {
  const matchers = new Map(commands.map((c) => [c.id, buildMatcher(c.id, c.response)]));
  return parseLine(line, commands, matchers);
}

test('template compiles to named capture groups', () => {
  const { bindings, hasCommandGroup } = compileTemplate(TEMPLATE);
  assert.strictEqual(hasCommandGroup, true);
  assert.deepStrictEqual(bindings.map((b) => b.channel), [1, 2, 3, 4]);
});

test('extracts four channels including negatives, exponents and bare decimals', () => {
  const samples = run('or READ ch1:1.5 ch2:-2 ch3:3e2 ch4:.5', [makeCommand()]);
  assert.strictEqual(samples.length, 4);
  assert.deepStrictEqual(samples.map((s) => s.value), [1.5, -2, 300, 0.5]);
  assert.deepStrictEqual(samples.map((s) => s.series), [
    'READ.ch1', 'READ.ch2', 'READ.ch3', 'READ.ch4'
  ]);
});

test('tolerates extra whitespace and surrounding noise', () => {
  const samples = run('[12:00:01]   or   READ   ch1:1  ch2:2  ch3:3  ch4:4  <end>', [makeCommand()]);
  assert.strictEqual(samples.length, 4);
  assert.deepStrictEqual(samples.map((s) => s.value), [1, 2, 3, 4]);
});

test('rejects a response echoed for a different command', () => {
  const samples = run('or STATUS ch1:1 ch2:2 ch3:3 ch4:4', [makeCommand({ name: 'READ' })]);
  assert.strictEqual(samples.length, 0);
});

test('only the selected channels are emitted', () => {
  const samples = run('or READ ch1:1 ch2:2 ch3:3 ch4:4', [makeCommand({ channels: [2, 4] })]);
  assert.deepStrictEqual(samples.map((s) => s.channel), [2, 4]);
  assert.deepStrictEqual(samples.map((s) => s.value), [2, 4]);
});

test('channel labels are used for the series label', () => {
  const samples = run('or READ ch1:9 ch2:8 ch3:7 ch4:6', [
    makeCommand({ channels: [1], channelLabels: { 1: 'voltage' } })
  ]);
  assert.strictEqual(samples[0].label, 'voltage');
});

test('one line can feed several commands and separate graph windows', () => {
  const a = makeCommand({ id: 'a', name: 'READ', graphWindow: 0, channels: [1] });
  const b = makeCommand({ id: 'b', name: 'READ', graphWindow: 3, channels: [2] });
  const samples = run('or READ ch1:10 ch2:20 ch3:30 ch4:40', [a, b]);
  assert.strictEqual(samples.length, 2);
  assert.deepStrictEqual(samples.map((s) => s.window), [0, 3]);
  assert.deepStrictEqual(samples.map((s) => s.value), [10, 20]);
});

test('explicit <chN> placeholders bind to the given channel', () => {
  const cmd = makeCommand({
    channels: [3, 7],
    response: { mode: 'template', pattern: '<COMMAND> a=<ch7> b=<ch3>', flags: 'i' }
  });
  const samples = run('READ a=1.25 b=9.5', [cmd]);
  assert.deepStrictEqual(samples.map((s) => [s.channel, s.value]), [[7, 1.25], [3, 9.5]]);
});

test('<hex> placeholder parses hexadecimal payloads', () => {
  const cmd = makeCommand({
    channels: [1],
    response: { mode: 'template', pattern: '<COMMAND> val=<hex>', flags: 'i' }
  });
  const samples = run('READ val=0x1F', [cmd]);
  assert.strictEqual(samples[0].value, 31);
});

test('<any> acts as filler', () => {
  const cmd = makeCommand({
    channels: [1],
    response: { mode: 'template', pattern: 'or <COMMAND> <any> v:<data>', flags: 'i' }
  });
  const samples = run('or READ status=ok flags=3 v:42', [cmd]);
  assert.strictEqual(samples[0].value, 42);
});

test('raw regex mode with named d-groups', () => {
  const cmd = makeCommand({
    channels: [1, 2],
    response: {
      mode: 'regex',
      pattern: 'or\\s+(?<cmd>\\w+)\\s+ch1:(?<d1>[-\\d.]+)\\s+ch2:(?<d2>[-\\d.]+)',
      flags: 'i'
    }
  });
  const samples = run('or READ ch1:5 ch2:6', [cmd]);
  assert.deepStrictEqual(samples.map((s) => s.value), [5, 6]);
});

test('raw regex mode falls back to positional groups', () => {
  const cmd = makeCommand({
    channels: [1, 2],
    response: { mode: 'regex', pattern: 'TEMP=([-\\d.]+) HUM=([-\\d.]+)', flags: 'i' }
  });
  const samples = run('TEMP=21.5 HUM=48', [cmd]);
  assert.deepStrictEqual(samples.map((s) => [s.channel, s.value]), [[1, 21.5], [2, 48]]);
});

test('an invalid regex is reported instead of throwing', () => {
  const matcher = buildMatcher('x', { mode: 'regex', pattern: '([unclosed', flags: '' });
  assert.ok(matcher.error);
  assert.strictEqual(parseLine('anything', [makeCommand()], new Map([['c1', matcher]])).length, 0);
});

test('non-matching and empty lines produce nothing', () => {
  assert.strictEqual(run('garbage output', [makeCommand()]).length, 0);
  assert.strictEqual(run('   ', [makeCommand()]).length, 0);
});

test('simulator response format matches the default template', () => {
  const line = `or READ ch1:${(12.3).toFixed(3)} ch2:${(-4.5).toFixed(3)} ch3:${(0.25).toFixed(3)} ch4:${(100).toFixed(3)}`;
  const samples = run(line, [makeCommand()]);
  assert.deepStrictEqual(samples.map((s) => s.value), [12.3, -4.5, 0.25, 100]);
});

test('up to 16 graph windows are addressable', () => {
  const commands = [];
  for (let w = 0; w < 16; w++) {
    commands.push(makeCommand({ id: `c${w}`, name: 'READ', graphWindow: w, channels: [1] }));
  }
  const samples = run('or READ ch1:1 ch2:2 ch3:3 ch4:4', commands);
  assert.strictEqual(samples.length, 16);
  assert.deepStrictEqual([...new Set(samples.map((s) => s.window))].length, 16);
});
