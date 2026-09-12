// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {any} */ (document.getElementById(id));

  const el = {
    rows: $('rows'), empty: $('empty'), summary: $('summary'), decimals: $('decimals'),
    showRaw: $('showRaw'), showRate: $('showRate'), filter: $('filter'),
    freeze: $('freeze'), clear: $('clear')
  };

  /** series key -> record (values are replaced in place, never appended) */
  const series = new Map();
  let frozen = false;
  let dirty = false;

  function format(value) {
    const d = Math.min(9, Math.max(0, Number(el.decimals.value) || 0));
    if (!Number.isFinite(value)) { return '—'; }
    if (Math.abs(value) >= 1e9 || (value !== 0 && Math.abs(value) < 1e-6)) {
      return value.toExponential(d);
    }
    return value.toFixed(d);
  }

  const pad = (n) => String(n).padStart(2, '0');
  function timeOf(ts) {
    const t = new Date(ts);
    return `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${String(t.getMilliseconds()).padStart(3, '0')}`;
  }

  function upsert(sample) {
    let rec = series.get(sample.series);
    if (!rec) {
      rec = {
        key: sample.series,
        commandName: sample.commandName,
        label: sample.label,
        color: sample.color,
        min: sample.value,
        max: sample.value,
        count: 0,
        firstTs: sample.ts,
        lastTs: sample.ts,
        node: null
      };
      series.set(sample.series, rec);
    }
    rec.value = sample.value;
    rec.raw = sample.raw;
    rec.color = sample.color;
    rec.label = sample.label;
    rec.min = Math.min(rec.min, sample.value);
    rec.max = Math.max(rec.max, sample.value);
    rec.count += 1;
    rec.lastTs = sample.ts;
    dirty = true;
  }

  function buildRow(rec) {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const dot = document.createElement('span');
    dot.className = 'swatch';
    dot.style.background = rec.color;
    nameTd.appendChild(dot);
    const name = document.createElement('span');
    name.textContent = `${rec.commandName} · ${rec.label}`;
    nameTd.appendChild(name);
    tr.appendChild(nameTd);

    const valueTd = document.createElement('td');
    const box = document.createElement('input');
    box.className = 'value-box';
    box.readOnly = true;
    valueTd.appendChild(box);
    tr.appendChild(valueTd);

    const cells = {};
    for (const key of ['min', 'max', 'count', 'rate', 'updated', 'raw']) {
      const td = document.createElement('td');
      if (key === 'raw') { td.className = 'raw mono'; }
      else { td.className = 'mono'; }
      tr.appendChild(td);
      cells[key] = td;
    }

    rec.node = { tr, box, cells, lastRendered: null };
    return tr;
  }

  function render() {
    const filter = el.filter.value.trim().toLowerCase();
    const visible = [...series.values()]
      .filter((r) => !filter || r.key.toLowerCase().includes(filter) || r.commandName.toLowerCase().includes(filter))
      .sort((a, b) => a.key.localeCompare(b.key));

    el.empty.classList.toggle('hidden', visible.length > 0);

    const existing = new Set();
    const frag = document.createDocumentFragment();
    for (const rec of visible) {
      if (!rec.node) { buildRow(rec); }
      frag.appendChild(rec.node.tr);
      existing.add(rec.key);

      // In-place value replacement + brief highlight when it changes.
      const text = format(rec.value);
      if (rec.node.lastRendered !== text) {
        rec.node.box.value = text;
        rec.node.box.classList.add('flash');
        const node = rec.node;
        setTimeout(() => node.box.classList.remove('flash'), 220);
        rec.node.lastRendered = text;
      }
      rec.node.box.style.color = rec.color;
      rec.node.cells.min.textContent = format(rec.min);
      rec.node.cells.max.textContent = format(rec.max);
      rec.node.cells.count.textContent = String(rec.count);
      const span = (rec.lastTs - rec.firstTs) / 1000;
      rec.node.cells.rate.textContent = el.showRate.checked && span > 0
        ? `${((rec.count - 1) / span).toFixed(2)} Hz`
        : '';
      rec.node.cells.updated.textContent = timeOf(rec.lastTs);
      rec.node.cells.raw.textContent = el.showRaw.checked ? rec.raw : '';
      rec.node.cells.raw.title = rec.raw || '';
      rec.node.tr.classList.toggle('stale', Date.now() - rec.lastTs > 5000);
    }
    el.rows.replaceChildren(frag);
    el.summary.textContent = `${visible.length} series${series.size !== visible.length ? ` (of ${series.size})` : ''}`;
  }

  setInterval(() => {
    if (dirty && !frozen) {
      dirty = false;
      render();
    }
  }, 100);
  setInterval(() => { if (!frozen) { render(); } }, 1000);

  el.freeze.addEventListener('click', () => {
    frozen = !frozen;
    el.freeze.textContent = frozen ? 'Resume' : 'Freeze';
    el.freeze.classList.toggle('secondary', !frozen);
  });
  el.clear.addEventListener('click', () => { series.clear(); render(); });
  el.filter.addEventListener('input', render);
  el.decimals.addEventListener('change', () => {
    for (const rec of series.values()) { if (rec.node) { rec.node.lastRendered = null; } }
    render();
  });
  el.showRaw.addEventListener('change', render);
  el.showRate.addEventListener('change', render);

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'samples') {
      for (const sample of msg.samples) { upsert(sample); }
    } else if (msg.type === 'clear') {
      series.clear();
      render();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
