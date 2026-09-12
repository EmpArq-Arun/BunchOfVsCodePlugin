// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const MAX_WINDOWS = 16;

  const el = {
    grid: $('grid'), empty: $('empty'), summary: $('summary'), layout: $('layout'),
    points: $('points'), xmode: $('xmode'), autoscale: $('autoscale'),
    ymin: $('ymin'), ymax: $('ymax'), combine: $('combine'),
    pause: $('pause'), clear: $('clear')
  };

  /** windowIndex -> { el, canvas, ctx, legend, series: Map<key, {color,label,points:[{t,v}]}> } */
  const windows = new Map();
  let paused = false;
  let maxPoints = 600;
  let t0 = Date.now();
  let needsLayout = false;

  // ------------------------------------------------------------------ layout

  function ensureWindow(index) {
    let win = windows.get(index);
    if (win) { return win; }

    const box = document.createElement('div');
    box.className = 'chart';

    const head = document.createElement('div');
    head.className = 'chart-head';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = `#${index + 1}`;
    head.appendChild(title);
    const legend = document.createElement('div');
    legend.className = 'legend';
    head.appendChild(legend);
    box.appendChild(head);

    const canvas = document.createElement('canvas');
    box.appendChild(canvas);
    el.grid.appendChild(box);

    win = {
      index,
      el: box,
      canvas,
      ctx: canvas.getContext('2d'),
      legend,
      legendKey: '',
      series: new Map()
    };
    windows.set(index, win);
    needsLayout = true;
    return win;
  }

  function applyGridLayout() {
    const count = windows.size;
    el.empty.classList.toggle('hidden', count > 0);
    if (!count) { return; }

    let cols;
    if (el.layout.value === 'auto') {
      cols = count <= 1 ? 1 : count <= 2 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
    } else {
      cols = Number(el.layout.value);
    }
    const rows = Math.ceil(count / cols);
    el.grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    el.grid.style.gridTemplateRows = `repeat(${rows}, minmax(140px, 1fr))`;

    // Keep windows ordered by index.
    const ordered = [...windows.values()].sort((a, b) => a.index - b.index);
    for (const win of ordered) { el.grid.appendChild(win.el); }
  }

  function resizeCanvas(win) {
    const dpr = window.devicePixelRatio || 1;
    const rect = win.canvas.getBoundingClientRect();
    const w = Math.max(50, Math.floor(rect.width * dpr));
    const h = Math.max(50, Math.floor(rect.height * dpr));
    if (win.canvas.width !== w || win.canvas.height !== h) {
      win.canvas.width = w;
      win.canvas.height = h;
    }
  }

  function updateLegend(win) {
    const key = [...win.series.values()].map((s) => `${s.label}:${s.color}`).join('|');
    if (key === win.legendKey) { return; }
    win.legendKey = key;
    const frag = document.createDocumentFragment();
    for (const s of win.series.values()) {
      const span = document.createElement('span');
      const dot = document.createElement('i');
      dot.style.background = s.color;
      span.appendChild(dot);
      const text = document.createElement('span');
      text.textContent = `${s.commandName}·${s.label}`;
      span.appendChild(text);
      frag.appendChild(span);
    }
    win.legend.replaceChildren(frag);
  }

  // ------------------------------------------------------------------- data

  function addSample(sample) {
    const target = el.combine.checked ? 0 : Math.min(MAX_WINDOWS - 1, Math.max(0, sample.window || 0));
    const win = ensureWindow(target);
    let s = win.series.get(sample.series);
    if (!s) {
      s = {
        key: sample.series,
        label: sample.label,
        commandName: sample.commandName,
        color: sample.color,
        points: []
      };
      win.series.set(sample.series, s);
      win.legendKey = '';
    }
    s.color = sample.color;
    s.label = sample.label;
    s.points.push({ t: sample.ts, v: sample.value });
    if (s.points.length > maxPoints) {
      s.points.splice(0, s.points.length - maxPoints);
    }
  }

  // ---------------------------------------------------------------- painting

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  }

  function niceStep(range, targetTicks) {
    if (!(range > 0)) { return 1; }
    const rough = range / targetTicks;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  function draw(win) {
    resizeCanvas(win);
    const ctx = win.ctx;
    if (!ctx) { return; }

    const dpr = window.devicePixelRatio || 1;
    const W = win.canvas.width;
    const H = win.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const fg = cssVar('--vscode-foreground', '#ccc');
    const grid = 'rgba(128,128,128,0.22)';
    const padL = 52 * dpr, padR = 10 * dpr, padT = 10 * dpr, padB = 22 * dpr;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    if (plotW <= 10 || plotH <= 10) { return; }

    const seriesList = [...win.series.values()].filter((s) => s.points.length > 0);

    // ---- ranges
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    const byIndex = el.xmode.value === 'index';
    for (const s of seriesList) {
      const n = s.points.length;
      for (let i = 0; i < n; i++) {
        const p = s.points[i];
        const x = byIndex ? i - (n - 1) : (p.t - t0) / 1000;
        if (x < xMin) { xMin = x; }
        if (x > xMax) { xMax = x; }
        if (p.v < yMin) { yMin = p.v; }
        if (p.v > yMax) { yMax = p.v; }
      }
    }
    if (!seriesList.length) {
      xMin = 0; xMax = 1; yMin = 0; yMax = 1;
    }
    if (!el.autoscale.checked) {
      const lo = Number(el.ymin.value), hi = Number(el.ymax.value);
      if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) { yMin = lo; yMax = hi; }
    }
    if (xMax - xMin < 1e-9) { xMax = xMin + 1; }
    if (yMax - yMin < 1e-9) { yMin -= 0.5; yMax += 0.5; }
    else {
      const pad = (yMax - yMin) * 0.08;
      yMin -= pad; yMax += pad;
    }

    const xOf = (x) => padL + ((x - xMin) / (xMax - xMin)) * plotW;
    const yOf = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    // ---- grid + axes
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = grid;
    ctx.fillStyle = fg;
    ctx.font = `${10 * dpr}px var(--vscode-font-family, sans-serif)`;
    ctx.textBaseline = 'middle';

    const yStep = niceStep(yMax - yMin, 5);
    ctx.textAlign = 'right';
    for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax; v += yStep) {
      const y = yOf(v);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.globalAlpha = 0.85;
      ctx.fillText(formatTick(v, yStep), padL - 6 * dpr, y);
    }

    const xStep = niceStep(xMax - xMin, 5);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax; x += xStep) {
      const px = xOf(x);
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.stroke();
      ctx.globalAlpha = 0.85;
      ctx.fillText(formatTick(x, xStep), px, padT + plotH + 4 * dpr);
    }
    ctx.globalAlpha = 1;

    ctx.strokeStyle = 'rgba(128,128,128,0.55)';
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.stroke();

    // ---- traces
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of seriesList) {
      ctx.beginPath();
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6 * dpr;
      const n = s.points.length;
      for (let i = 0; i < n; i++) {
        const p = s.points[i];
        const x = xOf(byIndex ? i - (n - 1) : (p.t - t0) / 1000);
        const y = yOf(p.v);
        if (i === 0) { ctx.moveTo(x, y); } else { ctx.lineTo(x, y); }
      }
      ctx.stroke();

      // last-value marker
      const last = s.points[n - 1];
      const lx = xOf(byIndex ? 0 : (last.t - t0) / 1000);
      const ly = yOf(last.v);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(lx, ly, 2.6 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function formatTick(v, step) {
    const decimals = step >= 1 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
    if (Math.abs(v) >= 1e6) { return v.toExponential(1); }
    return v.toFixed(decimals);
  }

  function frame() {
    if (needsLayout) {
      needsLayout = false;
      applyGridLayout();
    }
    if (!paused) {
      let seriesCount = 0;
      for (const win of windows.values()) {
        updateLegend(win);
        draw(win);
        seriesCount += win.series.size;
      }
      el.summary.textContent = `${windows.size} window${windows.size === 1 ? '' : 's'} · ${seriesCount} series`;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------------ events

  el.layout.addEventListener('change', applyGridLayout);
  el.points.addEventListener('change', () => {
    maxPoints = Math.min(20000, Math.max(10, Number(el.points.value) || 600));
    for (const win of windows.values()) {
      for (const s of win.series.values()) {
        if (s.points.length > maxPoints) { s.points.splice(0, s.points.length - maxPoints); }
      }
    }
  });
  el.autoscale.addEventListener('change', () => {
    el.ymin.disabled = el.autoscale.checked;
    el.ymax.disabled = el.autoscale.checked;
  });
  el.combine.addEventListener('change', () => {
    for (const win of windows.values()) { win.el.remove(); }
    windows.clear();
    needsLayout = true;
    applyGridLayout();
  });
  el.pause.addEventListener('click', () => {
    paused = !paused;
    el.pause.textContent = paused ? 'Resume' : 'Pause';
  });
  el.clear.addEventListener('click', () => {
    for (const win of windows.values()) { win.el.remove(); }
    windows.clear();
    t0 = Date.now();
    applyGridLayout();
  });
  window.addEventListener('resize', () => { needsLayout = true; });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'samples') {
      if (paused) { return; }
      for (const sample of msg.samples) { addSample(sample); }
    } else if (msg.type === 'state') {
      const n = msg.state?.maxPointsPerSeries;
      if (n && Number(el.points.value) === maxPoints) {
        maxPoints = n;
        el.points.value = String(n);
      }
    } else if (msg.type === 'clear') {
      for (const win of windows.values()) { win.el.remove(); }
      windows.clear();
      applyGridLayout();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
