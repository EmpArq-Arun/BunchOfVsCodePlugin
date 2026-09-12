const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stub = require('./vscode-stub.js');

stub.install();
const { FileLogger, DEFAULT_LOGGER_OPTIONS } = require('../out-test/logger.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stp-log-'));
}

function options(filePath, overrides = {}) {
  return { ...DEFAULT_LOGGER_OPTIONS, filePath, flushIntervalMs: 0, ...overrides };
}

function entry(text, dir = 'rx') {
  return { dir, text, ts: Date.UTC(2026, 0, 2, 3, 4, 5) };
}

test('nothing is written to disk until the buffer threshold is reached', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.log');

  const logger = new FileLogger(options(file, { flushBytes: 4096, timestamps: false }), () => {});
  logger.start();

  // The text header is small, so the file is still empty on disk.
  for (let i = 0; i < 20; i++) {
    logger.appendLog(entry(`or READ ch1:${i} ch2:${i} ch3:${i} ch4:${i}`));
  }
  assert.ok(logger.status().buffered > 0, 'records are held in RAM');
  assert.strictEqual(logger.status().flushes, 0, 'no write issued yet');
  assert.strictEqual(fs.readFileSync(file, 'utf8').length, 0, 'file still empty');

  logger.stop();
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('or READ ch1:19'), 'stop() drains the buffer');
});

test('a single write is issued per full buffer, not per record', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'b.log');

  const logger = new FileLogger(options(file, { flushBytes: 4096, timestamps: false }), () => {});
  logger.start();

  const line = 'x'.repeat(99); // 102 bytes per record incl. tag + CRLF
  const records = 1000;
  for (let i = 0; i < records; i++) {
    logger.appendLog(entry(line));
  }
  const status = logger.status();

  // ~102 KB of data through a 4 KB buffer => ~25 writes, versus 1000 unbuffered.
  assert.ok(status.flushes > 0, 'some writes happened');
  assert.ok(status.flushes < 40, `expected far fewer writes than records, got ${status.flushes}`);
  assert.ok(records / status.flushes > 20, 'at least 20 records coalesced per write');

  logger.stop();
  const written = fs.readFileSync(file, 'utf8');
  assert.strictEqual(written.split(/\r\n/).filter((l) => l.includes(line)).length, records, 'no records lost');
});

test('the idle timer flushes a slowly filling buffer', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'c.log');

  const logger = new FileLogger(options(file, { flushBytes: 1024 * 1024, flushIntervalMs: 80, timestamps: false }), () => {});
  t.after(() => logger.stop());
  logger.start();

  logger.appendLog(entry('slow trickle'));
  assert.strictEqual(logger.status().flushes, 0, 'not written immediately');
  await sleep(200);
  assert.ok(logger.status().flushes >= 1, 'idle timer flushed');
  assert.ok(fs.readFileSync(file, 'utf8').includes('slow trickle'));
});

test('direction filters are honoured', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'd.log');

  const logger = new FileLogger(
    options(file, { includeTx: false, includeInfo: false, flushBytes: 16, timestamps: false }),
    () => {}
  );
  logger.start();
  logger.appendLog(entry('received-line', 'rx'));
  logger.appendLog(entry('SENT-CMD', 'tx'));
  logger.appendLog(entry('connected', 'info'));
  logger.stop();

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('received-line'), 'rx kept');
  assert.ok(!text.includes('SENT-CMD'), 'tx filtered out');
  assert.ok(!text.includes('connected'), 'info filtered out');
});

test('csv format writes a header and one row per parsed sample', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'e.csv');

  const logger = new FileLogger(
    options(file, { format: 'csv', includeSamples: true, includeRx: false, includeInfo: false }),
    () => {}
  );
  logger.start();
  logger.appendSamples([
    { ts: Date.now(), commandName: 'READ', channel: 1, series: 'READ.ch1', value: 1.25, raw: '', label: 'ch1', window: 0, color: '#fff', plot: true, commandId: 'x' },
    { ts: Date.now(), commandName: 'READ', channel: 2, series: 'READ.ch2', value: -3, raw: '', label: 'ch2', window: 0, color: '#fff', plot: true, commandId: 'x' }
  ]);
  logger.stop();

  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r\n/);
  assert.ok(rows[0].startsWith('iso_time,epoch_ms,kind,command,channel,series,value,text'), 'header present');
  assert.strictEqual(rows.length, 3, 'header + two samples');
  assert.ok(rows[1].includes(',READ,1,READ.ch1,1.25,'), 'first sample row');
  assert.ok(rows[2].includes(',READ,2,READ.ch2,-3,'), 'second sample row');
});

test('csv escapes quotes and commas in raw text', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'f.csv');

  const logger = new FileLogger(options(file, { format: 'csv' }), () => {});
  logger.start();
  logger.appendLog(entry('a,b "quoted" c'));
  logger.stop();

  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r\n/);
  assert.ok(rows[1].endsWith('"a,b ""quoted"" c"'), `unexpected row: ${rows[1]}`);
});

test('jsonl format emits one parsable object per line', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'g.jsonl');

  const logger = new FileLogger(options(file, { format: 'jsonl' }), () => {});
  logger.start();
  logger.appendLog(entry('hello'));
  logger.appendLog(entry('WORLD', 'tx'));
  logger.stop();

  const objects = fs.readFileSync(file, 'utf8').trim().split(/\r\n/).map((l) => JSON.parse(l));
  assert.deepStrictEqual(objects.map((o) => [o.kind, o.text]), [['rx', 'hello'], ['tx', 'WORLD']]);
});

test('files rotate and old generations are pruned', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'h.log');

  const logger = new FileLogger(
    options(file, { flushBytes: 512, maxFileBytes: 2048, maxFiles: 2, timestamps: false }),
    () => {}
  );
  logger.start();
  for (let i = 0; i < 400; i++) {
    logger.appendLog(entry(`line ${i} ${'y'.repeat(40)}`));
  }
  logger.stop();

  assert.ok(logger.status().rotations >= 2, `expected rotations, got ${logger.status().rotations}`);
  assert.ok(fs.existsSync(file), 'active file exists');
  assert.ok(fs.existsSync(path.join(dir, 'h.1.log')), 'first rotation exists');
  assert.ok(fs.existsSync(path.join(dir, 'h.2.log')), 'second rotation exists');
  assert.ok(!fs.existsSync(path.join(dir, 'h.3.log')), 'pruned beyond maxFiles');
});

test('appending to an existing log preserves previous content', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'i.log');

  const first = new FileLogger(options(file, { flushBytes: 16, timestamps: false }), () => {});
  first.start();
  first.appendLog(entry('session-one'));
  first.stop();

  const second = new FileLogger(options(file, { flushBytes: 16, timestamps: false }), () => {});
  second.start();
  second.appendLog(entry('session-two'));
  second.stop();

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('session-one') && text.includes('session-two'), 'both sessions retained');
});

test('missing directories are created', async (t) => {
  const dir = tmpDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'deeper', 'j.log');

  const logger = new FileLogger(options(file, { flushBytes: 16, timestamps: false }), () => {});
  logger.start();
  logger.appendLog(entry('created'));
  logger.stop();
  assert.ok(fs.existsSync(file), 'nested log file created');
});

