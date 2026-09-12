/* eslint-disable no-undef */
(function () {
  const vscode = acquireVsCodeApi();

  const METRICS = {
    ccn:    { label:"Cyclomatic",   unit:"CCN",    bands:[3,5,7,11,16,24,40] },
    nloc:   { label:"Lines (NLOC)", unit:"NLOC",   bands:[8,18,30,50,80,120,180] },
    tokens: { label:"Tokens",       unit:"TOK",    bands:[60,120,220,360,560,820,1100] },
    params: { label:"Parameters",   unit:"PARAM",  bands:[1,2,3,4,5,6,7] },
    length: { label:"Span (lines)", unit:"LINES",  bands:[10,20,35,55,85,130,200] },
  };
  const TIERS = [
    { cls:"t0", name:"Asteroid",     risk:"Trivial" },
    { cls:"t1", name:"Moon",         risk:"Simple" },
    { cls:"t2", name:"Planet",       risk:"Modest" },
    { cls:"t3", name:"Gas giant",    risk:"Notable" },
    { cls:"t4", name:"Star",         risk:"Heavy" },
    { cls:"t5", name:"Red giant",    risk:"Severe" },
    { cls:"t6", name:"Neutron star", risk:"Critical" },
    { cls:"t7", name:"Black hole",   risk:"Untestable" },
  ];

  let state = { metric:"ccn", thresholds:{}, functions:[], file:"" };

  const $ = (id) => document.getElementById(id);
  const sel = $("metric"), thrInput = $("thr"), scaleEl = $("scale"), listEl = $("list"), fileEl = $("file");

  Object.entries(METRICS).forEach(([k, v]) => {
    const o = document.createElement("option"); o.value = k; o.textContent = v.label; sel.appendChild(o);
  });

  function tierOf(v, bands) { let t = 0; for (const b of bands) { if (v > b) t++; else break; } return t; }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;" }[c])); }

  function bodyHTML(cls) {
    if (cls === "t6") return `<span class="body ${cls}"><span class="beams"></span><span class="beams b2"></span><span class="core"></span></span>`;
    if (cls === "t7") return `<span class="body ${cls}"><span class="disk"></span><span class="horizon"></span></span>`;
    return `<span class="body ${cls}"><span class="core"></span></span>`;
  }

  function sparkline(series, threshold) {
    const w = 132, h = 34, pad = 4;
    if (!series || series.length < 2) series = [series && series[0] || 0, series && series[0] || 0];
    const all = series.concat([threshold]);
    let lo = Math.min(...all), hi = Math.max(...all); if (hi - lo < 1e-6) hi = lo + 1;
    const x = (i) => pad + i * (w - 2 * pad) / (series.length - 1);
    const y = (v) => h - pad - (v - lo) * (h - 2 * pad) / (hi - lo);
    const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const area = `${pad},${h - pad} ${pts} ${w - pad},${h - pad}`;
    const last = series[series.length - 1];
    const col = last > threshold ? "var(--sev)" : (last > series[0] ? "var(--warn)" : "var(--ok)");
    const ty = y(threshold).toFixed(1);
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polygon points="${area}" fill="${col}" opacity="0.10"/>
      <line x1="0" y1="${ty}" x2="${w}" y2="${ty}" stroke="var(--faint)" stroke-width="1" stroke-dasharray="3 3" opacity="0.7"/>
      <polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(series.length - 1)}" cy="${y(last)}" r="2.4" fill="${col}"/></svg>`;
  }

  function render() {
    const m = state.metric, M = METRICS[m];
    const thr = Number(thrInput.value) || state.thresholds[m] || 10;
    sel.value = m;
    fileEl.textContent = state.file || "—";

    scaleEl.innerHTML = `<div class="scale-row">` + TIERS.map((t, i) => {
      const lo = i === 0 ? 0 : M.bands[i - 1] + 1;
      const hi = i === TIERS.length - 1 ? "∞" : M.bands[i];
      const range = i === TIERS.length - 1 ? `${lo}+` : (lo === hi ? `${lo}` : `${lo}–${hi}`);
      return `<div class="scale-step">${bodyHTML(t.cls)}<div class="blabel">${t.name}</div><div class="brange">${range}</div></div>`;
    }).join("") + `</div><div class="scale-cap"><span>← easy to reason about</span><span>understanding can't escape →</span></div>`;

    if (!state.functions.length) {
      listEl.innerHTML = `<div class="empty">No functions analyzed yet.<br/>Open a C/C++ file, or run <code>Complexity Cosmos: Snapshot</code>.</div>`;
      return;
    }

    const rows = state.functions
      .map((f) => ({ f, v: f[m], tier: tierOf(f[m], M.bands) }))
      .sort((a, b) => b.v - a.v);

    listEl.innerHTML = rows.map(({ f, v, tier }) => {
      const t = TIERS[tier];
      const flagged = v > thr, severe = v > thr * 2 || tier >= 6;
      const series = (f.hist && f.hist[m] && f.hist[m].length) ? f.hist[m] : [v];
      const d = +(series[series.length - 1] - series[0]).toFixed(1);
      const dCls = Math.abs(d) < 0.5 ? "flat" : (d > 0 ? "up" : "down");
      const dArrow = dCls === "up" ? "▲" : dCls === "down" ? "▼" : "—";
      return `<div class="card ${flagged ? "flagged" : ""} ${severe ? "severe" : ""}" data-file="${esc(f.file)}" data-start="${f.start}">
        <div class="bodywrap">${bodyHTML(t.cls)}</div>
        <div class="meta">
          <div class="fname">${esc(f.name)}</div>
          <div class="sig">${esc(f.longName || "")}</div>
          <div class="tierline"><span class="pill">${t.name} · ${t.risk}</span><span class="flag">⚠ over threshold</span></div>
        </div>
        <div class="right">
          <div class="spark">${sparkline(series, thr)}<span class="delta ${dCls}">${dArrow} ${d > 0 ? "+" : ""}${d}</span></div>
          <div class="val"><div class="num">${v}</div><div class="unit">${M.unit}</div></div>
        </div></div>`;
    }).join("");

    listEl.querySelectorAll(".card").forEach((el) => {
      el.addEventListener("click", () => {
        vscode.postMessage({ type:"reveal", file: el.dataset.file, start: Number(el.dataset.start) });
      });
    });
  }

  sel.addEventListener("change", () => {
    state.metric = sel.value;
    thrInput.value = state.thresholds[state.metric] ?? "";
    vscode.postMessage({ type:"setMetric", metric: state.metric });
    render();
  });
  let thrTimer;
  thrInput.addEventListener("input", () => {
    render();
    clearTimeout(thrTimer);
    thrTimer = setTimeout(() => vscode.postMessage({ type:"setThreshold", metric: state.metric, value: Number(thrInput.value) }), 350);
  });

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "data") {
      state = { metric: msg.metric, thresholds: msg.thresholds, functions: msg.functions, file: msg.file };
      thrInput.value = state.thresholds[state.metric] ?? "";
      render();
    }
  });

  // ready handshake — avoids dropped first message
  vscode.postMessage({ type:"ready" });
})();
