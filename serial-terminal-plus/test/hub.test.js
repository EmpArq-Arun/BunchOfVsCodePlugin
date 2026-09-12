const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stub = require('./vscode-stub.js');

stub.install();
const { Hub } = require('../out-test/hub.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lastState(view) {
  const states = stub.captured[view].filter((m) => m.type === 'state');
  return states.length ? states[states.length - 1].state : undefined;
}

function allSamples(view) {
  return stub.captured[view].filter((m) => m.type === 'samples').flatMap((m) => m.samples);
}

function allLogs() {
  return stub.captured.terminal.filter((m) => m.type === 'logs').flatMap((m) => m.logs);
}

test('end-to-end: simulator port feeds terminal, response and graph windows', async (t) => {
  const hub = new Hub(stub.makeContext());
  t.after(() => hub.dispose());

  hub.showAll();
  assert.ok(stub.handlers.terminal, 'terminal webview handler registered');
  assert.ok(stub.handlers.response, 'response webview handler registered');
  assert.ok(stub.handlers.graph, 'graph webview handler registered');

  const send = (view, msg) => stub.handlers[view](msg);

  // Webviews announce themselves and receive the initial state.
  send('terminal', { type: 'ready' });
  send('response', { type: 'ready' });
  send('graph', { type: 'ready' });

  const initial = lastState('terminal');
  assert.ok(initial, 'initial state delivered');
  assert.strictEqual(initial.connected, false);
  assert.ok(initial.commands.length >= 1, 'seeded commands present');

  // Ports always include the built-in simulator.
  await hub.refreshPorts();
  const ports = stub.captured.terminal.filter((m) => m.type === 'ports').pop();
  assert.ok(ports.ports.some((p) => p.path === 'SIMULATOR'), 'SIMULATOR port offered');

  // Connect to the simulator.
  send('terminal', { type: 'connect', config: { path: 'SIMULATOR', baudRate: 115200 } });
  await sleep(60);
  assert.strictEqual(lastState('terminal').connected, true, 'connected to simulator');

  // Define two commands targeting different graph windows.
  send('terminal', {
    type: 'saveCommand',
    command: {
      name: 'VOLT', payload: 'VOLT', repeatMs: 40, plot: true, graphWindow: 2,
      channels: [1, 2, 3, 4], channelLabels: { 1: 'v' },
      response: { mode: 'template', pattern: 'or <COMMAND> ch1:<data> ch2:<data> ch3:<data> ch4:<data>', flags: 'i' }
    }
  });
  send('terminal', {
    type: 'saveCommand',
    command: {
      name: 'TEMP', payload: 'TEMP', repeatMs: 40, plot: false, graphWindow: 5,
      channels: [1],
      response: { mode: 'template', pattern: 'or <COMMAND> ch1:<data> <any>', flags: 'i' }
    }
  });

  const withCommands = lastState('terminal');
  const volt = withCommands.commands.find((c) => c.name === 'VOLT');
  const temp = withCommands.commands.find((c) => c.name === 'TEMP');
  assert.ok(volt && temp, 'both commands stored');

  // Run them on their repeat timers.
  send('terminal', { type: 'toggleRun', id: volt.id, run: true });
  send('terminal', { type: 'toggleRun', id: temp.id, run: true });
  assert.deepStrictEqual(new Set(lastState('terminal').running), new Set([volt.id, temp.id]));

  await sleep(400);

  // Terminal received both TX echoes and RX lines.
  const logs = allLogs();
  assert.ok(logs.some((l) => l.dir === 'tx' && l.text === 'VOLT'), 'VOLT transmitted');
  assert.ok(logs.some((l) => l.dir === 'tx' && l.text === 'TEMP'), 'TEMP transmitted');
  assert.ok(logs.filter((l) => l.dir === 'rx').length >= 4, 'simulator replies logged');

  // Repeat timer really repeats.
  const voltSends = logs.filter((l) => l.dir === 'tx' && l.text === 'VOLT').length;
  assert.ok(voltSends >= 3, `expected repeated sends, got ${voltSends}`);

  // Response window sees every parsed series, including the non-plotted command.
  const responseSamples = allSamples('response');
  const responseSeries = new Set(responseSamples.map((s) => s.series));
  assert.ok(responseSeries.has('VOLT.ch1'), 'VOLT.ch1 in response window');
  assert.ok(responseSeries.has('VOLT.ch4'), 'VOLT.ch4 in response window');
  assert.ok(responseSeries.has('TEMP.ch1'), 'TEMP.ch1 in response window');

  // Graph window only receives plot-enabled samples, routed to the chosen window.
  const graphSamples = allSamples('graph');
  assert.ok(graphSamples.length > 0, 'graph received samples');
  assert.ok(graphSamples.every((s) => s.plot === true), 'only plot-enabled samples reach the graph');
  assert.ok(graphSamples.every((s) => s.commandName === 'VOLT'), 'TEMP excluded from the plotter');
  assert.deepStrictEqual([...new Set(graphSamples.map((s) => s.window))], [2], 'routed to window #3');
  assert.ok(graphSamples.every((s) => Number.isFinite(s.value)), 'values are numeric');

  // Stop everything.
  send('terminal', { type: 'stopAll' });
  assert.deepStrictEqual(lastState('terminal').running, []);
  // Let the hub's pending-log queue drain before sampling the baseline.
  await sleep(150);
  const txBefore = allLogs().filter((l) => l.dir === 'tx').length;
  await sleep(250);
  assert.strictEqual(allLogs().filter((l) => l.dir === 'tx').length, txBefore, 'no sends after stop');

  send('terminal', { type: 'disconnect' });
  await sleep(80);
  assert.strictEqual(lastState('terminal').connected, false, 'disconnected');
});

test('manual send is rejected when the port is closed', async (t) => {
  const hub = new Hub(stub.makeContext());
  t.after(() => hub.dispose());
  stub.captured.terminal.length = 0;
  hub.show('terminal');
  stub.handlers.terminal({ type: 'ready' });
  stub.handlers.terminal({ type: 'send', text: 'PING' });
  await sleep(120);
  const logs = allLogs();
  assert.ok(logs.some((l) => l.dir === 'err' && /not open/i.test(l.text)), 'error logged');
});

test('file logging captures live serial traffic with coalesced writes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stp-hub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.log');

  // Large buffer + no idle timer, so writes only happen when we ask for them.
  stub.settings.set('logging.flushKiB', 64);
  stub.settings.set('logging.flushIntervalMs', 0);
  stub.settings.set('logging.timestamps', false);
  t.after(() => stub.settings.clear());

  const hub = new Hub(stub.makeContext());
  t.after(() => hub.dispose());
  stub.captured.terminal.length = 0;
  hub.show('terminal');
  stub.handlers.terminal({ type: 'ready' });

  await hub.startLogging(file);
  assert.ok(lastState('terminal').logger.active, 'logger reported as active');

  stub.handlers.terminal({ type: 'connect', config: { path: 'SIMULATOR', baudRate: 115200 } });
  await sleep(60);

  stub.handlers.terminal({
    type: 'saveCommand',
    command: {
      name: 'LOGME', payload: 'LOGME', repeatMs: 20, plot: true, graphWindow: 0, channels: [1, 2],
      response: { mode: 'template', pattern: 'or <COMMAND> ch1:<data> ch2:<data> <any>', flags: 'i' }
    }
  });
  const cmd = lastState('terminal').commands.find((c) => c.name === 'LOGME');
  stub.handlers.terminal({ type: 'toggleRun', id: cmd.id, run: true });

  await sleep(500);
  stub.handlers.terminal({ type: 'toggleRun', id: cmd.id, run: false });
  await sleep(120);

  // Many records have been produced, but the 64 KiB buffer has not filled,
  // so nothing has been written to the flash yet.
  const midStatus = lastState('terminal').logger;
  assert.ok(midStatus.buffered > 0, 'records buffered in RAM');
  assert.strictEqual(midStatus.flushes, 0, 'no disk write issued for a partial buffer');
  assert.strictEqual(fs.statSync(file).size, 0, 'file untouched so far');

  // Explicit flush pushes everything out in one write.
  hub.flushLog();
  const flushed = lastState('terminal').logger;
  assert.strictEqual(flushed.flushes, 1, 'exactly one write syscall');
  assert.strictEqual(flushed.buffered, 0, 'buffer drained');

  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('>> LOGME'), 'transmitted commands logged');
  assert.ok(/<< or LOGME ch1:/.test(text), 'received responses logged');

  const rxCount = text.split(/\r\n/).filter((l) => l.startsWith('<< or LOGME')).length;
  assert.ok(rxCount >= 5, `expected several logged responses, got ${rxCount}`);
  assert.ok(rxCount > flushed.flushes * 4, 'many records coalesced into a single write');

  // Stopping drains and closes the file.
  hub.stopLogging();
  assert.strictEqual(lastState('terminal').logger, null, 'logger cleared from state');
  assert.ok(fs.statSync(file).size > 0, 'log persisted on disk');
});

test('pattern tester reports matches and failures', async (t) => {
  const hub = new Hub(stub.makeContext());
  t.after(() => hub.dispose());
  stub.captured.terminal.length = 0;
  hub.show('terminal');
  stub.handlers.terminal({ type: 'ready' });

  const command = {
    name: 'READ', payload: 'READ', channels: [1, 2],
    response: { mode: 'template', pattern: 'or <COMMAND> ch1:<data> ch2:<data>', flags: 'i' }
  };

  stub.handlers.terminal({ type: 'testPattern', id: 'editor', command, sample: 'or READ ch1:7 ch2:8' });
  let result = stub.captured.terminal.filter((m) => m.type === 'testResult').pop().result;
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.values.map((v) => v.value), [7, 8]);

  stub.handlers.terminal({ type: 'testPattern', id: 'editor', command, sample: 'nonsense' });
  result = stub.captured.terminal.filter((m) => m.type === 'testResult').pop().result;
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /No match/i);
});
