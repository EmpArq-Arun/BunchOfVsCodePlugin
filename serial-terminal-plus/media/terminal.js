// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  const $ = (id) => /** @type {any} */ (document.getElementById(id));

  const el = {
    dot: $('dot'), port: $('port'), refreshPorts: $('refreshPorts'), baud: $('baud'),
    dataBits: $('dataBits'), parity: $('parity'), stopBits: $('stopBits'), rtscts: $('rtscts'),
    connect: $('connect'), openGraph: $('openGraph'), openResponse: $('openResponse'),
    lineEnding: $('lineEnding'), timestamps: $('timestamps'), autoscroll: $('autoscroll'),
    hexView: $('hexView'), filter: $('filter'), clearLog: $('clearLog'),
    startAll: $('startAll'), stopAll: $('stopAll'), banner: $('banner'),
    logToggle: $('logToggle'), logChoose: $('logChoose'), logFlush: $('logFlush'),
    logOpen: $('logOpen'), logStatus: $('logStatus'),
    log: $('log'), manual: $('manual'), send: $('send'),
    addCommand: $('addCommand'), importCommands: $('importCommands'), exportCommands: $('exportCommands'),
    cmdRows: $('cmdRows'), cmdCount: $('cmdCount'),
    editor: $('editor'), dlgTitle: $('dlgTitle'), dlgSave: $('dlgSave'), dlgCancel: $('dlgCancel'),
    fName: $('fName'), fPayload: $('fPayload'), fEncoding: $('fEncoding'), fEol: $('fEol'),
    fRepeat: $('fRepeat'), fColor: $('fColor'), fMode: $('fMode'), fPattern: $('fPattern'),
    fFlags: $('fFlags'), fChannels: $('fChannels'), fPlot: $('fPlot'), fWindow: $('fWindow'),
    fEnabled: $('fEnabled'), fSample: $('fSample'), fTest: $('fTest'), fTestOut: $('fTestOut')
  };

  /** @type {any} */
  let state = {
    connected: false, connecting: false, ports: [], commands: [], running: [],
    portConfig: {}, maxGraphWindows: 16, scrollback: 2000, serialAvailable: true
  };
  /** @type {any[]} */
  let lines = [];
  let editing = null;
  const history = [];
  let historyIndex = -1;

  const pad = (n) => String(n).padStart(2, '0');
  function timeOf(ts) {
    const d = new Date(ts);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }

  function toHex(text) {
    const bytes = new TextEncoder().encode(text);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  }

  // ------------------------------------------------------------------ logging

  function renderLog() {
    const filter = el.filter.value.trim().toLowerCase();
    const frag = document.createDocumentFragment();
    for (const entry of lines) {
      if (filter && entry.text.toLowerCase().indexOf(filter) === -1) {
        continue;
      }
      const div = document.createElement('div');
      div.className = entry.dir;
      if (el.timestamps.checked) {
        const ts = document.createElement('span');
        ts.className = 'ts';
        ts.textContent = timeOf(entry.ts);
        div.appendChild(ts);
      }
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = entry.dir === 'rx' ? '<<' : entry.dir === 'tx' ? '>>' : entry.dir === 'err' ? '!!' : '--';
      div.appendChild(tag);
      const body = document.createElement('span');
      const showHex = el.hexView.checked && (entry.dir === 'rx' || entry.dir === 'tx');
      body.textContent = showHex ? toHex(entry.text) : entry.text;
      div.appendChild(body);
      frag.appendChild(div);
    }
    el.log.replaceChildren(frag);
    if (el.autoscroll.checked) {
      el.log.scrollTop = el.log.scrollHeight;
    }
  }

  function appendLogs(entries) {
    lines.push(...entries);
    const max = state.scrollback || 2000;
    if (lines.length > max) {
      lines = lines.slice(-max);
    }
    renderLog();
  }

  // ------------------------------------------------------------------- state

  function renderPorts() {
    const current = state.portConfig?.path || el.port.value;
    el.port.replaceChildren();
    for (const p of state.ports || []) {
      const opt = document.createElement('option');
      opt.value = p.path;
      opt.textContent = p.friendlyName ? `${p.path} — ${p.friendlyName}` : p.path;
      el.port.appendChild(opt);
    }
    if (current) {
      el.port.value = current;
    }
  }

  function renderCommands() {
    const running = new Set(state.running || []);
    const frag = document.createDocumentFragment();

    for (const cmd of state.commands || []) {
      const tr = document.createElement('tr');
      tr.dataset.id = cmd.id;

      const swatch = document.createElement('td');
      const dot = document.createElement('span');
      dot.className = 'swatch';
      dot.style.background = cmd.color;
      swatch.appendChild(dot);
      tr.appendChild(swatch);

      const add = (text, mono) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (mono) { td.className = 'mono'; }
        tr.appendChild(td);
        return td;
      };

      add(cmd.name);
      add(cmd.payload, true);
      add(cmd.repeatMs > 0 ? `${cmd.repeatMs} ms` : 'one-shot');
      add(cmd.channels.map((c) => cmd.channelLabels?.[String(c)] || `ch${c}`).join(', '));
      add(cmd.plot ? 'yes' : 'no');
      add(cmd.plot ? `#${cmd.graphWindow + 1}` : '—');

      const stateTd = document.createElement('td');
      const chip = document.createElement('span');
      const isRunning = running.has(cmd.id);
      chip.className = 'chip' + (isRunning ? ' run' : '');
      chip.textContent = isRunning ? 'running' : 'idle';
      stateTd.appendChild(chip);
      tr.appendChild(stateTd);

      const actions = document.createElement('td');
      actions.className = 'actions';
      actions.appendChild(button(isRunning ? '■ Stop' : '▶ Start', 'secondary', () => {
        vscode.postMessage({ type: 'toggleRun', id: cmd.id, run: !isRunning });
      }));
      actions.appendChild(button('Send', 'icon', () => vscode.postMessage({ type: 'sendOnce', id: cmd.id })));
      actions.appendChild(button('Edit', 'icon', () => openEditor(cmd)));
      actions.appendChild(button('✕', 'icon', () => {
        vscode.postMessage({ type: 'deleteCommand', id: cmd.id });
      }));
      tr.appendChild(actions);

      frag.appendChild(tr);
    }

    el.cmdRows.replaceChildren(frag);
    el.cmdCount.textContent = `${(state.commands || []).length} defined · ${running.size} running`;
  }

  function button(text, cls, onClick) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderLoggerStatus(logger) {
    const active = !!(logger && logger.active);
    el.logToggle.textContent = active ? '⏹ Stop logging' : '⏺ Log to file';
    el.logToggle.classList.toggle('secondary', !active);
    el.logFlush.disabled = !active;
    el.logOpen.disabled = !logger;

    if (!logger) {
      el.logStatus.textContent = '';
      el.logStatus.title = '';
      return;
    }
    const name = logger.filePath.split(/[\\/]/).pop();
    const parts = [
      name,
      `${formatBytes(logger.totalWritten)} written`,
      `${formatBytes(logger.buffered)} buffered`,
      `${logger.flushes} write${logger.flushes === 1 ? '' : 's'}`
    ];
    if (logger.rotations) { parts.push(`${logger.rotations} rotation${logger.rotations === 1 ? '' : 's'}`); }
    if (logger.error) { parts.push(`⚠ ${logger.error}`); }
    el.logStatus.textContent = parts.join(' · ');
    el.logStatus.title = logger.filePath;
  }

  function formatBytes(n) {
    if (!n) { return '0 B'; }
    if (n < 1024) { return `${n} B`; }
    if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KiB`; }
    return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  }

  function applyState(next) {
    state = next;
    renderPorts();
    renderCommands();
    renderLoggerStatus(state.logger);

    el.dot.className = 'status-dot' + (state.connected ? ' on' : state.connecting ? ' busy' : state.lastError ? ' err' : '');
    el.connect.textContent = state.connected ? 'Disconnect' : state.connecting ? 'Connecting…' : 'Connect';
    for (const control of [el.port, el.baud, el.dataBits, el.parity, el.stopBits, el.rtscts]) {
      control.disabled = state.connected;
    }

    const cfg = state.portConfig || {};
    if (cfg.baudRate) { el.baud.value = cfg.baudRate; }
    if (cfg.dataBits) { el.dataBits.value = String(cfg.dataBits); }
    if (cfg.parity) { el.parity.value = cfg.parity; }
    if (cfg.stopBits) { el.stopBits.value = String(cfg.stopBits); }
    el.rtscts.checked = !!cfg.rtscts;
    el.lineEnding.value = state.lineEnding === 'none' ? 'none'
      : state.lineEnding === '\n' ? '\\n'
      : state.lineEnding === '\r' ? '\\r' : '\\r\\n';

    const problems = [];
    if (!state.serialAvailable) {
      problems.push('Native "serialport" module unavailable — run `npm install` in the extension folder. The SIMULATOR port still works.');
    }
    if (state.lastError) {
      problems.push(state.lastError);
    }
    el.banner.textContent = problems.join('  •  ');
    el.banner.classList.toggle('hidden', problems.length === 0);
  }

  // ------------------------------------------------------------------ editor

  function buildChannelPickers(selected) {
    el.fChannels.replaceChildren();
    for (let c = 1; c <= 16; c++) {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = String(c);
      cb.checked = selected.includes(c);
      label.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = `ch${c}`;
      label.appendChild(span);
      el.fChannels.appendChild(label);
    }
  }

  function buildWindowOptions(selected) {
    el.fWindow.replaceChildren();
    const max = Math.min(16, state.maxGraphWindows || 16);
    for (let w = 0; w < max; w++) {
      const opt = document.createElement('option');
      opt.value = String(w);
      opt.textContent = `Window #${w + 1}`;
      el.fWindow.appendChild(opt);
    }
    el.fWindow.value = String(Math.min(selected || 0, max - 1));
  }

  function openEditor(cmd) {
    editing = cmd ? { ...cmd } : null;
    el.dlgTitle.textContent = cmd ? `Edit “${cmd.name}”` : 'Add command';
    el.fName.value = cmd?.name ?? '';
    el.fPayload.value = cmd?.payload ?? '';
    el.fEncoding.value = cmd?.encoding ?? 'ascii';
    el.fEol.value = cmd ? encodeEol(cmd.lineEnding) : '\\r\\n';
    el.fRepeat.value = cmd?.repeatMs ?? 1000;
    el.fColor.value = cmd?.color ?? '#4FC3F7';
    el.fMode.value = cmd?.response?.mode ?? 'template';
    el.fPattern.value = cmd?.response?.pattern ?? 'or <COMMAND> ch1:<data> ch2:<data> ch3:<data> ch4:<data>';
    el.fFlags.value = cmd?.response?.flags ?? 'i';
    el.fPlot.checked = cmd ? !!cmd.plot : true;
    el.fEnabled.checked = cmd ? !!cmd.enabled : true;
    el.fSample.value = '';
    el.fTestOut.textContent = '';
    el.fTestOut.className = 'span4 test-out';
    buildChannelPickers(cmd?.channels ?? [1, 2, 3, 4]);
    buildWindowOptions(cmd?.graphWindow ?? nextFreeWindow());
    el.editor.showModal();
    el.fName.focus();
  }

  function nextFreeWindow() {
    const used = new Set((state.commands || []).filter((c) => c.plot).map((c) => c.graphWindow));
    const max = Math.min(16, state.maxGraphWindows || 16);
    for (let w = 0; w < max; w++) {
      if (!used.has(w)) { return w; }
    }
    return 0;
  }

  function encodeEol(value) {
    return value === 'none' ? 'none' : value === '\n' ? '\\n' : value === '\r' ? '\\r' : '\\r\\n';
  }

  function collectCommand() {
    const channels = Array.from(el.fChannels.querySelectorAll('input:checked')).map((i) => Number(i.value));
    return {
      id: editing?.id,
      name: el.fName.value.trim(),
      payload: (el.fPayload.value || el.fName.value).trim(),
      encoding: el.fEncoding.value,
      lineEnding: el.fEol.value === 'none' ? 'none' : el.fEol.value === '\\n' ? '\n' : el.fEol.value === '\\r' ? '\r' : '\r\n',
      repeatMs: Number(el.fRepeat.value) || 0,
      enabled: el.fEnabled.checked,
      plot: el.fPlot.checked,
      graphWindow: Number(el.fWindow.value) || 0,
      channels: channels.length ? channels : [1],
      channelLabels: editing?.channelLabels ?? {},
      response: { mode: el.fMode.value, pattern: el.fPattern.value, flags: el.fFlags.value },
      color: el.fColor.value
    };
  }

  // ------------------------------------------------------------------ events

  el.connect.addEventListener('click', () => {
    if (state.connected) {
      vscode.postMessage({ type: 'disconnect' });
      return;
    }
    vscode.postMessage({
      type: 'connect',
      config: {
        path: el.port.value,
        baudRate: Number(el.baud.value) || 115200,
        dataBits: Number(el.dataBits.value),
        parity: el.parity.value,
        stopBits: Number(el.stopBits.value),
        rtscts: el.rtscts.checked
      }
    });
  });

  el.refreshPorts.addEventListener('click', () => vscode.postMessage({ type: 'listPorts' }));
  el.openGraph.addEventListener('click', () => vscode.postMessage({ type: 'openView', view: 'graph' }));
  el.openResponse.addEventListener('click', () => vscode.postMessage({ type: 'openView', view: 'response' }));
  el.startAll.addEventListener('click', () => vscode.postMessage({ type: 'startAll' }));
  el.stopAll.addEventListener('click', () => vscode.postMessage({ type: 'stopAll' }));
  el.importCommands.addEventListener('click', () => vscode.postMessage({ type: 'importCommands' }));
  el.exportCommands.addEventListener('click', () => vscode.postMessage({ type: 'exportCommands' }));
  el.addCommand.addEventListener('click', () => openEditor(null));
  el.clearLog.addEventListener('click', () => { lines = []; renderLog(); });
  el.logToggle.addEventListener('click', () => vscode.postMessage({ type: 'toggleLogging' }));
  el.logChoose.addEventListener('click', () => vscode.postMessage({ type: 'chooseLogFile' }));
  el.logFlush.addEventListener('click', () => vscode.postMessage({ type: 'flushLog' }));
  el.logOpen.addEventListener('click', () => vscode.postMessage({ type: 'openLogFile' }));
  el.filter.addEventListener('input', renderLog);
  el.timestamps.addEventListener('change', renderLog);
  el.hexView.addEventListener('change', renderLog);
  el.lineEnding.addEventListener('change', () => vscode.postMessage({ type: 'setLineEnding', value: el.lineEnding.value }));

  function sendManual() {
    const text = el.manual.value;
    if (!text) { return; }
    vscode.postMessage({ type: 'send', text });
    history.push(text);
    historyIndex = history.length;
    el.manual.value = '';
  }

  el.send.addEventListener('click', sendManual);
  el.manual.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendManual(); }
    else if (e.key === 'ArrowUp' && history.length) {
      historyIndex = Math.max(0, historyIndex - 1);
      el.manual.value = history[historyIndex] ?? '';
    } else if (e.key === 'ArrowDown' && history.length) {
      historyIndex = Math.min(history.length, historyIndex + 1);
      el.manual.value = history[historyIndex] ?? '';
    }
  });

  el.fTest.addEventListener('click', () => {
    vscode.postMessage({ type: 'testPattern', id: 'editor', command: collectCommand(), sample: el.fSample.value });
  });

  el.dlgSave.addEventListener('click', (e) => {
    const command = collectCommand();
    if (!command.name) {
      e.preventDefault();
      el.fName.focus();
      return;
    }
    vscode.postMessage({ type: 'saveCommand', command });
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'state':
        applyState(msg.state);
        break;
      case 'ports':
        state.ports = msg.ports;
        renderPorts();
        break;
      case 'logs':
        appendLogs(msg.logs);
        break;
      case 'loggerStatus':
        state.logger = msg.logger;
        renderLoggerStatus(msg.logger);
        break;
      case 'testResult': {
        if (msg.result.ok) {
          el.fTestOut.className = 'span4 test-out ok';
          el.fTestOut.textContent = '✓ ' + msg.result.values.map((v) => `${v.label}=${v.value}`).join('   ');
        } else {
          el.fTestOut.className = 'span4 test-out bad';
          el.fTestOut.textContent = '✗ ' + msg.result.error;
        }
        break;
      }
      default:
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
