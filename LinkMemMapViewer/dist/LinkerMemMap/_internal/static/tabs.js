// ═══════════════════════════════════════════════════════════════════════════
// BLOAT
// ═══════════════════════════════════════════════════════════════════════════
function renderBloat(){
  const hasSym=S.syms.length>0,hasMap=!!S.mapData;
  if(!hasSym&&!hasMap){$('bloat-empty').style.display='';$('bloat-content').style.display='none';return;}
  $('bloat-empty').style.display='none';$('bloat-content').style.display='';
  // Stats
  const fns=S.syms.filter(s=>s.type==='function'&&s.size>0).sort((a,b)=>b.size-a.size);
  const vars=S.syms.filter(s=>s.type==='variable'&&s.size>0).sort((a,b)=>b.size-a.size);
  const totalCode=fns.reduce((s,f)=>s+f.size,0);
  const totalData=vars.reduce((s,v)=>s+v.size,0);
  $('bloat-stats').innerHTML=`
    <div class="stat"><div class="snum">${fz(totalCode)}</div><div class="slbl">Total code (functions)</div></div>
    <div class="stat"><div class="snum" style="color:var(--ora)">${fz(totalData)}</div><div class="slbl">Total data (variables)</div></div>
    <div class="stat"><div class="snum" style="color:var(--pur)">${fns.length}</div><div class="slbl">Functions</div></div>
    <div class="stat"><div class="snum" style="color:var(--red)">${vars.length}</div><div class="slbl">Variables</div></div>`;

  // Treemap from map file
  if(hasMap&&feat('f_bloattree')){
    $('bloat-treemap-wrap').style.display='';
    renderTreemap('bloat-treemap',S.mapData.summary.by_file,'flash');
  } else $('bloat-treemap-wrap').style.display='none';

  // Functions table
  if(feat('f_bloatfn'))renderBloatTable('bloat-fn',fns.slice(0,50),['name','size','section','file']);
  // Variables table
  if(feat('f_bloatvar'))renderBloatTable('bloat-var',vars.slice(0,50),['name','size','section','file']);

  // Extra symbol analysis (issue 5)
  renderExtraSymbolAnalysis();

  // Duplicates
  if(feat('f_bloatdup')&&S.syms.length){
    const byName={};
    S.syms.filter(s=>s.type==='function').forEach(s=>{
      if(!byName[s.name])byName[s.name]=[];
      byName[s.name].push(s);
    });
    const dups=Object.entries(byName).filter(([,v])=>v.length>1).sort((a,b)=>b[1].length-a[1].length);
    const dc=$('dup-card');dc.style.display=dups.length?'':'none';
    const db=$('bloat-dup');db.innerHTML='';
    dups.slice(0,30).forEach(([name,syms])=>{
      const tr=document.createElement('tr');tr.className='clickable';
      tr.innerHTML=`<td style="color:var(--acc);font-size:11px">${name}</td>
        <td class="sz">${syms.length}</td>
        <td class="dim" style="font-size:10px">${[...new Set(syms.map(s=>s.file).filter(Boolean))].join(', ')||'—'}</td>`;
      tr.addEventListener('click',()=>openDuplicatePopup(name,syms));
      db.appendChild(tr);
    });
  }
}
function renderBloatTable(tbodyId,syms,cols){
  const tbody=$(tbodyId);tbody.innerHTML='';
  syms.forEach((s,i)=>{
    const tr=document.createElement('tr');tr.className='clickable';
    tr.innerHTML=`<td style="font-size:11px;color:var(--txt)" title="${s.name}">${s.name}</td>
      <td class="sz">${fz(s.size)}</td>
      <td class="dim">${s.section||'—'}</td>
      <td class="dim" style="font-size:10px">${s.file||'—'}</td>`;
    tr.addEventListener('click',()=>openSymbolPopup(s));
    tbody.appendChild(tr);
  });
}
function sortBloat(table,col){/* simplified — re-render with new sort */}

function renderTreemap(containerId,data,sizeKey){
  const container=$(containerId);container.innerHTML='';
  if(!data.length)return;
  const total=data.reduce((s,r)=>s+r[sizeKey],0);
  if(!total)return;
  const COLORS=['#3b82f6','#f97316','#10b981','#8b5cf6','#f59e0b','#ef4444','#06b6d4','#ec4899','#84cc16','#6366f1'];
  // Use flex-wrap layout — each cell is proportional but min 120px wide
  // Height scales with importance so large contributors are visually dominant
  const maxVal=data[0][sizeKey]||1;
  data.slice(0,40).forEach((r,i)=>{
    if(!r[sizeKey])return;
    const pct=r[sizeKey]/total;
    const pctOfMax=r[sizeKey]/maxVal;
    // Width: proportional, min 140px, max 320px
    const w=Math.min(320,Math.max(140,Math.round(pct*1800)));
    // Height: taller for bigger contributors
    const h=Math.min(120,Math.max(64,Math.round(pctOfMax*110+40)));
    const col=COLORS[i%COLORS.length];
    const cell=document.createElement('div');
    cell.className='tree-cell';
    cell.style.cssText=`width:${w}px;height:${h}px;`
      +`background:${col}1a;border:1px solid ${col}55;`
      +`display:flex;flex-direction:column;justify-content:flex-end;padding:8px;`
      +`cursor:pointer;border-radius:4px;overflow:hidden;position:relative;transition:.15s`;
    // Percentage bar at bottom
    cell.innerHTML=`
      <div style="position:absolute;bottom:0;left:0;right:0;height:${Math.round(pctOfMax*100)}%;`
        +`background:${col}22;z-index:0"></div>
      <div style="position:relative;z-index:1">
        <div style="font-size:10px;font-weight:600;color:var(--txt);white-space:nowrap;`
          +`overflow:hidden;text-overflow:ellipsis;line-height:1.3;margin-bottom:3px"`
          +` title="${r.file}">${r.file.split('/').pop().split('\\\\').pop()}</div>
        <div style="font-size:11px;color:${col};font-weight:700">${fz(r[sizeKey])}</div>
        <div style="font-size:9px;color:#6e7681">${Math.round(pct*100)}%</div>
      </div>`;
    cell.addEventListener('click',()=>{$('sym-f').value=r.file;filterSyms();switchTab('sym');});
    cell.addEventListener('mouseenter',()=>cell.style.filter='brightness(1.3)');
    cell.addEventListener('mouseleave',()=>cell.style.filter='');
    addTip(cell,{name:r.file,rows:[
      ['Flash',fz(r.flash)],['RAM',fz(r.ram)],['Total',fz(r.total)],
      ['% of total',Math.round(pct*100)+'%']
    ],desc:'Click to filter symbols by this file'});
    container.appendChild(cell);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════
function renderStartup(){
  const ss=$('start-stats'),sr=$('start-rows');ss.innerHTML='';sr.innerHTML='';
  if(!S.startup){
    ss.innerHTML='<div class="stat"><div class="snum" style="color:#6e7681">?</div><div class="slbl">Load ELF for exact figures</div></div>';return;
  }
  const {total_copy,total_zero,items}=S.startup;
  ss.innerHTML=`
    <div class="stat"><div class="snum">${fz(total_copy)}</div><div class="slbl">Copied flash→RAM<br>larger = slower boot</div></div>
    <div class="stat"><div class="snum" style="color:var(--grn)">${fz(total_zero)}</div><div class="slbl">Zeroed (BSS)<br>fast memset</div></div>`;
  items.forEach(it=>{
    const contrib=S.mapData?.sections.find(s=>s.name===it.section);
    const d=document.createElement('div');d.className='sr';
    d.innerHTML=`<span class="stype ${it.type}">${it.type}</span>
      <span style="color:var(--txt);flex:1;font-size:12px">${it.section}</span>
      <span class="sz">${fz(it.size)}</span>
      ${it.vma?`<span class="dim" style="font-size:11px">${it.vma}</span>`:''}
      ${it.lma?`<span class="dim" style="font-size:11px">← ${it.lma}</span>`:''}
      ${contrib&&feat('f_startfile')?`<span style="font-size:10px;color:var(--dim)">${contrib.units.length} files</span>`:''}`;
    d.addEventListener('click',()=>{if(contrib)openSectionContribPopup(it.section,contrib.units);});
    sr.appendChild(d);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// MAP FILE TAB
// ═══════════════════════════════════════════════════════════════════════════
function renderMapFile(){
  if(!S.mapData){$('map2-empty').style.display='';$('map2-content').style.display='none';return;}
  $('map2-empty').style.display='none';$('map2-content').style.display='';
  const {total_flash,total_ram,by_file}=S.mapData.summary;
  const _mapArch = S.mapData.arch || 'auto';
  const _archBadge = _mapArch === 'esp32'
    ? '<span class="chip" style="background:#1a0f05;border-color:#f97316;color:#f97316;font-size:10px">📡 ESP32</span>'
    : '<span class="chip" style="background:var(--s2);border-color:#3b82f6;color:#3b82f6;font-size:10px">⚙ ARM</span>';
  $('map2-stats').innerHTML=`
    <div class="stat"><div class="snum">${fz(total_flash)}</div><div class="slbl">Total flash</div></div>
    <div class="stat"><div class="snum" style="color:var(--ora)">${fz(total_ram)}</div><div class="slbl">Total RAM</div></div>
    <div class="stat"><div class="snum" style="color:var(--pur)">${by_file.length}</div><div class="slbl">Object files</div></div>
    <div class="stat"><div class="snum" style="color:var(--dim)">${S.mapData.discarded.length}</div><div class="slbl">GC'd sections</div></div>
    <div class="stat">${_archBadge}<div class="slbl" style="margin-top:4px">Architecture</div></div>`;

  // Library filter
  if(feat('f_maplib')){
    const libs=[...new Set(by_file.map(r=>{const m=r.file.match(/([^/\\]+\.a)\(/);return m?m[1]:null;}).filter(Boolean))].sort();
    const ml=$('map2-lib');ml.innerHTML='<option value="">All libraries</option>';
    libs.forEach(l=>{const o=document.createElement('option');o.value=l;o.textContent=l;ml.appendChild(o);});
  }

  filterMapFiles();
  renderSectionContribs();
  renderDiscarded();
}
function filterMapFiles(){
  const q=($('map2-q')?.value||'').toLowerCase();
  const lib=$('map2-lib')?.value||'';
  const rows=(S.mapData?.summary.by_file||[]).filter(r=>{
    if(q&&!r.file.toLowerCase().includes(q))return false;
    if(lib&&!r.file.includes(lib))return false;
    return true;
  });
  $('map2-cnt').textContent=`${rows.length} files`;
  renderMapTable(rows);
}
let mapSortCol='total',mapSortDir=-1;
function sortMap(col){if(mapSortCol===col)mapSortDir*=-1;else{mapSortCol=col;mapSortDir=-1;}filterMapFiles();}
function renderMapTable(rows){
  const maxFlash=Math.max(...rows.map(r=>r.flash),1);
  const sorted=[...rows].sort((a,b)=>(typeof a[mapSortCol]==='number'?a[mapSortCol]-b[mapSortCol]:a[mapSortCol].localeCompare(b[mapSortCol]))*mapSortDir);
  const tbody=$('map2-tbody');tbody.innerHTML='';
  sorted.forEach(r=>{
    const barW=Math.round((r.flash/maxFlash)*100);
    // Region colour if feature enabled
    let rowColor='';
    if(feat('f_mapregion')&&S.ld){
      const addr=S.mapData?.sections.flatMap(s=>s.units).find(u=>u.file===r.file)?.addr||0;
      const reg=S.ld.regions.find(rg=>addr>=rg.origin&&addr<rg.end);
      if(reg)rowColor=`border-left:3px solid ${reg.color}`;
    }
    // DMA hazard
    let dmaBadge='';
    if(feat('f_mapdma')&&S.ld){
      const fileUnits=(S.mapData?.sections||[]).flatMap(s=>s.units.filter(u=>u.file===r.file));
      const inCached=fileUnits.some(u=>S.ld.sections.find(s=>s.name===u.subsection?.split('.').slice(0,2).join('.')&&s.cacheable));
      const inNC=fileUnits.some(u=>S.ld.sections.find(s=>s.name===u.subsection?.split('.').slice(0,2).join('.')&&s.dma_safe));
      if(inCached&&inNC)dmaBadge='<span class="badge cb" style="margin-left:4px">⚠ DMA</span>';
    }
    // Symbol count if cross-referenced
    const symCount=feat('f_mapsym')?S.syms.filter(s=>s.file===r.file).length:0;
    const tr=document.createElement('tr');tr.className='clickable';
    tr.style=rowColor;
    tr.innerHTML=`
      <td style="font-size:11px;color:var(--txt);max-width:240px" title="${r.file}">${r.file}${dmaBadge}</td>
      <td class="sz">${r.flash?fz(r.flash):'—'}</td>
      <td style="color:var(--ora)">${r.ram?fz(r.ram):'—'}</td>
      <td class="dim">${fz(r.total)}</td>
      <td><div class="fill-bg" style="width:100px"><div class="fill-bar" style="width:${barW}px;background:#3b82f6"></div></div></td>
      <td class="dim">${symCount||'—'}</td>`;
    tr.addEventListener('click',()=>openFilePopup(r));
    tbody.appendChild(tr);
  });
}
function renderSectionContribs(){
  const tbody=$('sec-contrib-body');tbody.innerHTML='';
  (S.mapData?.sections||[]).forEach(sec=>{
    if(!sec.units.length)return;
    const top=sec.units.slice().sort((a,b)=>b.size-a.size).slice(0,3);
    const tr=document.createElement('tr');tr.className='clickable';
    tr.innerHTML=`
      <td style="color:var(--acc);font-size:11px">${sec.name}</td>
      <td class="sz">${fz(sec.size)}</td>
      <td style="font-size:11px;color:var(--dim)">${top.map(u=>`${u.file} (${fz(u.size)})`).join(', ')}</td>`;
    tr.addEventListener('click',()=>openSectionContribPopup(sec.name,sec.units));
    tbody.appendChild(tr);
  });
}
function renderDiscarded(){
  const disc=$('map2-disc');disc.innerHTML='';
  const d=S.mapData?.discarded||[];
  if(!d.length){disc.innerHTML='<tr><td colspan="2" style="color:var(--dim);padding:10px">No discarded sections</td></tr>';return;}
  d.forEach(s=>{
    const tr=document.createElement('tr');tr.className='clickable';
    tr.innerHTML=`<td style="color:#f97316;font-size:11px">${s.name}</td><td class="dim" style="font-size:11px">${s.file}</td>`;
    disc.appendChild(tr);
  });
}
function exportMapCSV(){
  if(!S.mapData)return;
  const lines=['File,Flash,RAM,Total'];
  S.mapData.summary.by_file.forEach(r=>lines.push(`"${r.file}","${r.flash}","${r.ram}","${r.total}"`));
  download('map_breakdown.csv',lines.join('\n'));
}

// ═══════════════════════════════════════════════════════════════════════════
// DEAD CODE
// ═══════════════════════════════════════════════════════════════════════════
function renderDeadCode(){
  if(!S.mapData){$('dead-empty').style.display='';$('dead-content').style.display='none';return;}
  $('dead-empty').style.display='none';$('dead-content').style.display='';
  const disc=S.mapData.discarded||[];
  const byFile={};
  disc.forEach(d=>{if(!byFile[d.file])byFile[d.file]={file:d.file,count:0,size:0,sections:[]};byFile[d.file].count++;byFile[d.file].sections.push(d.name);});
  const rows=Object.values(byFile).sort((a,b)=>b.count-a.count);
  $('dead-stats').innerHTML=`
    <div class="stat"><div class="snum" style="color:var(--red)">${disc.length}</div><div class="slbl">Sections GC'd</div></div>
    <div class="stat"><div class="snum" style="color:var(--grn)">${rows.length}</div><div class="slbl">Files with dead code</div></div>`;
  const tbody=$('dead-tbody');tbody.innerHTML='';
  rows.forEach(r=>{
    const tr=document.createElement('tr');tr.className='clickable';
    tr.innerHTML=`<td style="font-size:11px;color:var(--txt)">${r.file}</td>
      <td class="sz">${r.count}</td><td class="dim">—</td>`;
    tr.addEventListener('click',()=>openDeadFilePopup(r));
    tbody.appendChild(tr);
  });
  filterDead();
}
function filterDead(){
  const q=($('dead-q')?.value||'').toLowerCase();
  const disc=(S.mapData?.discarded||[]).filter(d=>!q||d.name.toLowerCase().includes(q)||d.file.toLowerCase().includes(q));
  const da=$('dead-all');da.innerHTML='';
  disc.forEach(d=>{
    const tr=document.createElement('tr');
    tr.innerHTML=`<td style="color:#f97316;font-size:11px">${d.name}</td><td class="dim" style="font-size:11px">${d.file}</td>`;
    da.appendChild(tr);
  });
}
function sortDead(col){}

// ═══════════════════════════════════════════════════════════════════════════
// ADDRESS INSPECTOR
// Cross-references an address against ELF symbols, LD sections,
// map file, and addr2line simultaneously.
// ═══════════════════════════════════════════════════════════════════════════

// Called from drops.js / symbol clicks — sets the input and inspects
function doA2L(addr) {
  if (addr) { $('a2l-addr').value = addr; }
  inspectAddress();
}
function setAiStatus(msg, pct) {
  const s = document.getElementById('ai-status');
  if (s) s.textContent = msg || 'Done';
  const p = $('ai-progress');
  if (p) p.value = pct;
}

function onAddrInput(inp) {
  // Accept bare hex without 0x prefix
  const v = inp.value.replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '');
  inp.dataset.clean = v;
}

function clearInspector() {
  $('a2l-addr').value = '';
  $('ai-results').style.display = 'none';
}

function clearHistory() {
  S.a2lHistory = [];
  $('ai-history').innerHTML = '';
}

async function inspectAddress() {
  const raw = ($('a2l-addr').value || '').trim();
  if (!raw) return;

  let addrInt;
  try {
    addrInt = parseInt(raw.replace(/^0x/i, ''), 16);
    if (isNaN(addrInt)) throw new Error();
  } catch(e) {
    $('ai-results').style.display = '';
    $('ai-banner').className = 'ai-banner notfound';
    $('ai-banner').innerHTML = '<span class="ai-addr">' + raw + '</span><span class="ai-sum">Not a valid hex address</span>';
    return;
  }

  const hexAddr = '0x' + addrInt.toString(16).toUpperCase().padStart(8, '0');
  $('a2l-addr').value = hexAddr;
  $('ai-results').style.display = '';
  $('ai-progress').style.display = '';
  $('ai-progress').value = 0;
  $('ai-banner').className = 'ai-banner';
  $('ai-banner').innerHTML = '<span class="ai-addr">' + hexAddr + '</span>'
    + '<span class="ai-sum" id="ai-status">Inspecting…</span>';

  // ── 1. ELF symbol lookup ──────────────────────────────────────────────
  setStatus('Searching symbols…', 20);
  const symResult = inspectSymbol(addrInt);

  // ── 2. LD section / region lookup ────────────────────────────────────
  setStatus('Checking sections…', 45);
  const secResult = inspectSection(addrInt);

  // ── 3. Map file lookup ────────────────────────────────────────────────
  setStatus('Searching map file…', 60);
  const mapResult = inspectMap(addrInt);

  // ── 4. addr2line (async — server call) ───────────────────────────────
  setStatus('Calling addr2line…', 80);
  const a2lResult = await inspectA2L(addrInt);
  setAiStatus('', 100);
  $('ai-progress').style.display = 'none';

  // ── Render all four cards ─────────────────────────────────────────────
  renderSymCard(symResult, addrInt);
  renderSecCard(secResult);
  renderMapCard(mapResult);
  renderA2LCard(a2lResult);

  // ── Summary banner ────────────────────────────────────────────────────
  renderBanner(hexAddr, symResult, secResult, mapResult, a2lResult);

  // ── Offset bar ────────────────────────────────────────────────────────
  if (symResult.sym) renderOffsetBar(addrInt, symResult.sym);
  else $('ai-offset-bar').style.display = 'none';

  // ── Disassembly (async — runs objdump on the function) ──────────────
  setAiStatus('Disassembling…', 95);
  fetchDisassembly(addrInt, symResult);   // does not block — updates panel independently

  // ── History ───────────────────────────────────────────────────────────
  const entry = {
    addr:    hexAddr,
    symName: symResult.sym ? symResult.sym.name : '—',
    secName: secResult.sec ? secResult.sec.name : '—',
    source:  a2lResult.short || '—',
  };
  S.a2lHistory.unshift(entry);
  if (S.a2lHistory.length > 30) S.a2lHistory.pop();
  renderInspectHistory();
}

// ── Symbol lookup ─────────────────────────────────────────────────────────

function inspectSymbol(addr) {
  if (!S.syms || !S.syms.length) return { sym: null, reason: 'no_elf' };

  // Find symbol that contains this address (addr >= sym.addr && addr < sym.addr + sym.size)
  let best = null;
  for (const sym of S.syms) {
    if (sym.size > 0 && addr >= sym.addr && addr < sym.addr + sym.size) {
      // Prefer smaller (more specific) symbol
      if (!best || sym.size < best.size) best = sym;
    }
  }

  // If no ranged match, find nearest symbol below (for zero-size symbols)
  if (!best) {
    const below = S.syms.filter(s => s.addr <= addr).sort((a, b) => b.addr - a.addr);
    if (below.length) {
      const nearest = below[0];
      const gap = addr - nearest.addr;
      return { sym: nearest, offset: gap, exact: false, reason: 'nearest' };
    }
    return { sym: null, reason: 'not_found' };
  }

  return { sym: best, offset: addr - best.addr, exact: true, reason: 'found' };
}

// ── Section / region lookup ───────────────────────────────────────────────

function inspectSection(addr) {
  const result = { sec: null, reg: null, elfSec: null };
  if (!S.ld) return result;

  // Find LD section by cross-referencing ELF section addresses
  for (const [name, es] of Object.entries(S.elfSecs || {})) {
    if (es.size > 0 && addr >= es.addr && addr < es.addr + es.size) {
      result.elfSec = { name, ...es };
      // Find matching LD section
      result.sec = S.ld.sections.find(s => s.name === name) || null;
      break;
    }
  }

  // Find memory region
  for (const reg of (S.ld.regions || [])) {
    if (reg.length > 0 && addr >= reg.origin && addr < reg.end) {
      result.reg = reg;
      break;
    }
  }

  return result;
}

// ── Map file lookup ───────────────────────────────────────────────────────

function inspectMap(addr) {
  if (!S.mapData) return { unit: null, reason: 'no_map' };

  // Search through all section units for one whose address range contains addr
  for (const sec of S.mapData.sections) {
    for (const unit of sec.units) {
      if (unit.size > 0 && addr >= unit.addr && addr < unit.addr + unit.size) {
        return { unit, section: sec, reason: 'found' };
      }
    }
  }

  // Nearest unit below addr
  let best = null, bestDist = Infinity;
  for (const sec of S.mapData.sections) {
    for (const unit of sec.units) {
      if (unit.addr <= addr) {
        const d = addr - unit.addr;
        if (d < bestDist) { bestDist = d; best = { unit, section: sec }; }
      }
    }
  }
  if (best) return { ...best, offset: bestDist, reason: 'nearest' };
  return { unit: null, reason: 'not_found' };
}

// ── addr2line ─────────────────────────────────────────────────────────────

async function inspectA2L(addr) {
  if (!S.elfFile) return { result: null, short: null, reason: 'no_elf' };
  try {
    const fd = new FormData();
    fd.append('addr',     '0x' + addr.toString(16));
    const _a2lT=_getToolsForCurrentTarget();
    fd.append('prefix',   _a2lT.prefix);
    fd.append('a2l_tool', _a2lT.a2l);
    fd.append('target',   getTargetJson());
    fd.append('elf',      S.elfFile);
    const res = await fetch('/addr2line', { method: 'POST', body: fd });
    const d   = await res.json();
    const raw = d.result || '';
    if (!raw || raw.includes('??')) return { result: raw, short: null, reason: 'unknown' };
    // Extract short form: last path component + line
    const atIdx = raw.indexOf(' at ');
    const afterAt = atIdx >= 0 ? raw.slice(atIdx + 4) : raw;
    const slashIdx = Math.max(afterAt.lastIndexOf('/'), afterAt.lastIndexOf('\\'));
    const short = slashIdx >= 0 ? afterAt.slice(slashIdx + 1) : afterAt;
    return { result: raw, short, reason: 'found' };
  } catch(e) {
    return { result: null, short: null, reason: 'error', error: e.message };
  }
}

// ── Card renderers ────────────────────────────────────────────────────────

function aiRow(key, value, cls) {
  return `<div class="ai-row"><span class="k">${key}</span><span class="v ${cls||''}">${value}</span></div>`;
}

function renderSymCard(r, addr) {
  const body = $('ai-sym-body');
  if (r.reason === 'no_elf') {
    body.innerHTML = '<span class="ai-na">Load ELF and click Analyse ELF</span>';
    return;
  }
  if (!r.sym) {
    body.innerHTML = '<span class="ai-na">No symbol found at this address</span>';
    return;
  }
  const sym = r.sym;
  const TCOL = { function:'#3b82f6', variable:'#f97316', constant:'#10b981',
                  weak:'#6366f1', undefined:'#6e7681', other:'#374151' };
  const col  = TCOL[sym.type] || TCOL.other;
  const offsetStr = r.offset !== undefined
    ? `+0x${r.offset.toString(16).toUpperCase()} (${r.offset} bytes in)`
    : '';
  const exact = r.reason === 'found';

  body.innerHTML =
    `<div class="ai-row" style="cursor:pointer" title="Click: view function disassembly or source"
        onclick="openSymbolDisasmPopup()">
      <div class="ai-row-label">Name</div>
      <div class="ai-row-val" style="color:var(--acc);text-decoration:underline dotted;font-weight:600">
        ${_escHtml(sym.name)}
        <span style="color:var(--dim);font-size:10px;font-weight:400"> (click to view)</span>
      </div>
     </div>` +
    aiRow('Type',    `<span style="color:${col}">${sym.type}</span>${sym.global ? '' : ' <span style="color:var(--dim);font-size:10px">(local)</span>'}`) +
    aiRow('Start',   `0x${sym.addr.toString(16).toUpperCase().padStart(8,'0')}`, 'hx') +
    (sym.size ? aiRow('Size', fz(sym.size) + ` (${sym.size} bytes)`, 'sz') : '') +
    (sym.size ? aiRow('End',  `0x${(sym.addr+sym.size-1).toString(16).toUpperCase().padStart(8,'0')} (inclusive)`, 'hx') : '') +
    (offsetStr ? aiRow(exact ? 'Offset' : 'Nearest offset', offsetStr, exact ? 'sz' : 'warn') : '') +
    (sym.file ? aiRow('File', sym.file, 'file') : '');
}

function renderSecCard(r) {
  const body = $('ai-sec-body');
  if (!S.ld) {
    body.innerHTML = '<span class="ai-na">Load a .ld linker script</span>';
    return;
  }
  if (!r.reg && !r.sec) {
    body.innerHTML = '<span class="ai-na">Address is outside all defined memory regions</span>';
    return;
  }
  let html = '';
  if (r.reg) {
    html +=
      aiRow('Region',   `<strong style="color:var(--txt)">${r.reg.name}</strong>`) +
      aiRow('Type',     r.reg.type) +
      aiRow('Range',    `0x${r.reg.origin.toString(16).toUpperCase()} – 0x${r.reg.end.toString(16).toUpperCase()}`, 'hx') +
      aiRow('Size',     fz(r.reg.length), 'sz');
  }
  if (r.elfSec) {
    html += `<div style="border-top:1px solid var(--bdr);margin:6px 0;padding-top:6px">` +
      aiRow('Section',  `<strong style="color:var(--txt)">${r.elfSec.name}</strong>`) +
      aiRow('ELF size', fz(r.elfSec.size), 'sz') +
      `</div>`;
  }
  if (r.sec) {
    html +=
      (r.sec.cacheable ? aiRow('Cache', '<span class="v warn">⚠ CACHEABLE — unsafe for DMA</span>') : '') +
      (r.sec.dma_safe  ? aiRow('DMA',   '<span class="v ok">✓ DMA-safe (non-cacheable)</span>') : '') +
      (r.sec.noload    ? aiRow('NOLOAD','Not in flash image — zeroed/filled at startup') : '') +
      (r.sec.lma       ? aiRow('LMA',   'Copied from ' + r.sec.lma + ' at startup', 'file') : '');
  }
  body.innerHTML = html || '<span class="ai-na">No section info available</span>';
}

function renderMapCard(r) {
  const body = $('ai-map-body');
  if (r.reason === 'no_map') {
    body.innerHTML = '<span class="ai-na">Load a .map file</span>';
    return;
  }
  if (!r.unit) {
    body.innerHTML = '<span class="ai-na">Address not found in map file</span>';
    return;
  }
  const inRange = r.reason === 'found';
  body.innerHTML =
    aiRow('File',       `<strong style="color:var(--txt)">${r.unit.file}</strong>`) +
    (r.unit.file_full !== r.unit.file ? aiRow('Full path', r.unit.file_full, 'file') : '') +
    aiRow('Subsection', r.unit.subsection) +
    aiRow('Unit start', `0x${r.unit.addr.toString(16).toUpperCase().padStart(8,'0')}`, 'hx') +
    aiRow('Unit size',  fz(r.unit.size), 'sz') +
    aiRow('In section', r.section.name) +
    (!inRange ? aiRow('Note', `+0x${r.offset.toString(16)} after unit start (nearest match)`, 'warn') : '');
}

function renderA2LCard(r) {
  const body = $('ai-a2l-body');
  if (r.reason === 'no_elf') {
    body.innerHTML = '<span class="ai-na">Load ELF and click Analyse ELF</span>';
    return;
  }
  if (!r.result || r.reason === 'error') {
    body.innerHTML = '<span class="ai-na">' + (r.error || 'addr2line not available') + '</span>';
    return;
  }
  if (r.reason === 'unknown') {
    body.innerHTML = '<span class="ai-na">Symbol not found (may be stripped or inline)</span>';
    return;
  }
  // Parse the addr2line output:  "funcname() at file.c:123"
  const parts  = r.result.match(/^(.*?) at (.+):(\d+)$/);
  if (parts) {
    body.innerHTML =
      aiRow('Function', `<strong style="color:var(--txt)">${parts[1]}</strong>`) +
      aiRow('File',     parts[2], 'src') +
      aiRow('Line',     `<strong style="color:var(--acc)">${parts[3]}</strong>`);
  } else {
    body.innerHTML = `<div style="font-size:11px;color:var(--pur);word-break:break-all">${r.result}</div>`;
  }
}

function renderBanner(hexAddr, symR, secR, mapR, a2lR) {
  const banner = $('ai-banner');
  const hasAny = symR.sym || secR.reg || mapR.unit;
  banner.className = 'ai-banner ' + (hasAny ? 'found' : 'notfound');

  let parts = [`<span class="ai-addr">${hexAddr}</span>`];
  if (symR.sym) {
    const exact = symR.reason === 'found';
    const TCOL = { function:'#3b82f6', variable:'#f97316', constant:'#10b981',
                    weak:'#6366f1', other:'#374151' };
    const col = TCOL[symR.sym.type] || TCOL.other;
    parts.push(`<span class="ai-sum">→ <span class="ai-sym-name">${symR.sym.name}</span>` +
      (exact && symR.offset ? ` <span style="color:var(--dim)">+0x${symR.offset.toString(16)}</span>` : '') +
      ` <span style="color:${col};font-size:11px">${symR.sym.type}</span></span>`);
  }
  if (secR.reg) {
    parts.push(`<span style="color:var(--dim);font-size:11px">in ${secR.reg.name}` +
      (secR.elfSec ? ` / ${secR.elfSec.name}` : '') + `</span>`);
  }
  if (secR.sec && secR.sec.cacheable) {
    parts.push('<span style="color:var(--ora);font-size:11px">⚠ cacheable</span>');
  }
  if (mapR.unit) {
    parts.push(`<span style="color:var(--ora);font-size:11px">📂 ${mapR.unit.file}</span>`);
  }
  if (!hasAny) {
    parts.push('<span class="ai-sum">Address not found in any loaded data source</span>');
  }
  banner.innerHTML = parts.join(' ');
}

function renderOffsetBar(addr, sym) {
  if (!sym.size) { $('ai-offset-bar').style.display = 'none'; return; }
  $('ai-offset-bar').style.display = '';
  const pct    = Math.min(1, (addr - sym.addr) / sym.size);
  const pctPx  = Math.round(pct * 100);
  $('ai-offset-fill').style.width   = pctPx + '%';
  $('ai-offset-marker').style.left  = pctPx + '%';
  const offset = addr - sym.addr;
  $('ai-offset-labels').innerHTML =
    `<span>0x${sym.addr.toString(16).toUpperCase()} (start)</span>` +
    `<span style="color:var(--acc)">+0x${offset.toString(16)} = ${Math.round(pct*100)}%</span>` +
    `<span>0x${(sym.addr+sym.size).toString(16).toUpperCase()} (end)</span>`;
}

function renderInspectHistory() {
  const tbody = $('ai-history');
  tbody.innerHTML = '';
  S.a2lHistory.forEach(h => {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    tr.innerHTML =
      `<td class="hx">${h.addr}</td>` +
      `<td style="color:var(--txt);font-size:11px">${h.symName}</td>` +
      `<td class="dim" style="font-size:11px">${h.secName}</td>` +
      `<td class="dim" style="font-size:11px">${h.source}</td>`;
    tr.addEventListener('click', () => {
      $('a2l-addr').value = h.addr;
      inspectAddress();
    });
    tbody.appendChild(tr);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// DEBUG
// ═══════════════════════════════════════════════════════════════════════════
function populateDebug(dbg){
  let out='';
  if(dbg.prefix_in)out+=`Prefix input:    ${dbg.prefix_in}\nPrefix resolved: ${dbg.prefix_out}\n\n`;
  [['NM',dbg.nm_tool,dbg.nm_ok,dbg.nm_rc,dbg.nm_lines,dbg.nm_stderr,dbg.nm_sample],
   ['READELF',dbg.re_tool,dbg.re_ok,dbg.re_rc,0,dbg.re_stderr,dbg.re_sample],
   ['SIZE',dbg.sz_tool,dbg.sz_ok,dbg.sz_rc,0,dbg.sz_stderr,'']].forEach(([n,t,ok,rc,lines,err,sample])=>{
    out+=`${'═'.repeat(52)}\nTOOL: ${n}\n  Path:    ${t}\n  Found:   ${ok?'✅ YES':'❌ NO — wrong path or not installed'}\n  RC:      ${rc}\n`;
    if(n==='NM')out+=`  Symbols: ${lines} ${lines>0?'✅':'❌'}\n`;
    if(err)out+=`  STDERR:  ${err}\n`;
    if(sample)out+=`\nSAMPLE:\n${sample}\n`;
    out+='\n';
  });
  $('dbg-out').textContent=out;
}
async function runDebug(){
  if(!S.elfFile){$('dbg-out').textContent='Drop an ELF file first';return;}
  const tools = _getToolsForCurrentTarget();
  const prefix = tools.prefix;
  $('dbg-out').textContent = 'Running diagnostics…\n' +
    'Tools resolved:\n' +
    '  nm:      ' + tools.nm + '\n' +
    '  readelf: ' + tools.re + '\n' +
    '  size:    ' + tools.size + '\n' +
    '  addr2line:' + tools.a2l + '\n' +
    '  objdump: ' + tools.objdump + '\n' +
    '  prefix:  ' + (tools.prefix || '(none — PATH mode)') + '\n';
  const fd=new FormData();fd.append('elf',S.elfFile);fd.append('tools',JSON.stringify(tools));
  const res=await fetch('/debug_elf',{method:'POST',body:fd});
  const d=await res.json();
  if(d.error){$('dbg-out').textContent='ERROR: '+d.error;return;}
  let out=`File size: ${(d.file_size/1024).toFixed(1)} KB\nPrefix in:  ${d.prefix_in||'(none)'}\nPrefix out: ${d.prefix_out||'(none)'}\n\n`;
  for(const[n,t] of Object.entries(d.tools||{})){
    out+=`${'═'.repeat(52)}\nTOOL: ${n.toUpperCase()}\n  Path:   ${t.path}\n  Found:  ${t.found?'✅':'❌'}\n  RC:     ${t.rc}\n  Lines:  ${t.lines} ${t.lines>0?'✅':'⚠'}\n`;
    if(t.stderr)out+=`  STDERR: ${t.stderr}\n`;
    if(t.stdout)out+=`\nOUTPUT:\n${t.stdout}\n`;
    out+='\n';
  }
  $('dbg-out').textContent=out;
}

// ═══════════════════════════════════════════════════════════════════════════
// ISSUE 5 — EXTRA SYMBOL ANALYSIS
// Additional symbol intelligence beyond duplicate detection
// ═══════════════════════════════════════════════════════════════════════════

function renderExtraSymbolAnalysis() {
  if (!S.syms.length) return;

  // ── Weak symbols with no strong override ──────────────────────────────
  const weakSyms = S.syms.filter(s => s.type === 'weak' || s.type === 'weak_obj');
  const strongNames = new Set(S.syms.filter(s => s.type === 'function' || s.type === 'variable').map(s => s.name));
  const unresolved = weakSyms.filter(s => !strongNames.has(s.name));

  // ── printf/malloc/heap usage ───────────────────────────────────────────
  const heapSigns = ['malloc','free','calloc','realloc','_malloc_r','_sbrk',
                     'printf','fprintf','sprintf','snprintf','puts','scanf'];
  const heapSyms = S.syms.filter(s => heapSigns.includes(s.name));

  // ── Interrupt handlers (ISR detection) ───────────────────────────────
  const isrPatterns = [/^[A-Z][A-Za-z0-9_]+_IRQHandler$/, /^[A-Z][A-Za-z0-9_]+_Handler$/,
                       /^SysTick/, /^HardFault/, /^NMI_/, /^PendSV/];
  const isrSyms = S.syms.filter(s => s.type === 'function'
    && isrPatterns.some(p => p.test(s.name)));

  // ── Section size contribution per file (from map) ─────────────────────
  // (already in map file tab — cross-reference here)

  // Expose via bloat content area as extra cards
  const bloatContent = $('bloat-content');
  if (!bloatContent) return;

  // Remove old extra cards
  document.querySelectorAll('.extra-sym-card').forEach(e => e.remove());

  const makeCard = (title, subtitle, rows, clickCb) => {
    const card = document.createElement('div');
    card.className = 'card-wrap extra-sym-card';
    let rowsHtml = rows.slice(0,20).map(r =>
      `<tr class="clickable" data-sym-name="${r.name}" data-sym-addr="${r.addr}">
        <td style="color:var(--acc);font-size:11px">${r.name}</td>
        <td class="hx">${hx(r.addr)}</td>
        <td class="sz">${r.size ? fz(r.size) : '—'}</td>
        <td class="dim" style="font-size:10px">${r.file||r.section||'—'}</td>
       </tr>`).join('');
    card.innerHTML = `<div class="tbl-hdr">${title}<span class="sub">${subtitle}</span></div>
      <table><thead><tr><th>Name</th><th>Address</th><th>Size</th><th>File/Section</th></tr></thead>
      <tbody>${rowsHtml||'<tr><td colspan="4" style="color:var(--dim);padding:10px">None found</td></tr>'}</tbody></table>`;
    card.querySelectorAll('tr[data-sym-name]').forEach(tr => {
      tr.addEventListener('click', () => {
        const sym = findSymbol(tr.dataset.symName, parseInt(tr.dataset.symAddr));
        if (sym) openSymbolPopup(sym);
      });
    });
    return card;
  };

  if (unresolved.length) {
    bloatContent.appendChild(makeCard(
      '⚠ Weak symbols with no strong definition',
      'these use the weak fallback — may be intentional or a missing implementation',
      unresolved
    ));
  }

  if (heapSyms.length) {
    bloatContent.appendChild(makeCard(
      '🧱 Dynamic memory / printf family',
      'linked symbols that indicate heap or formatted I/O usage',
      heapSyms
    ));
  }

  if (isrSyms.length) {
    bloatContent.appendChild(makeCard(
      '⚡ Interrupt handlers',
      'ISR functions — candidates for ITCM placement for fast response',
      isrSyms.sort((a,b) => b.size - a.size)
    ));
  }
}

// =============================================================================
// STACK DEPTH ANALYSIS
// =============================================================================
//
// This tab supports two levels of analysis depending on which GCC flags
// were used during the build:
//
//   Level 1 — .su only (needs -fstack-usage)
//     • Per-function stack frame size
//     • Static / dynamic / dynamic-bounded classification
//     • Sorted list with bar chart
//     • Unbounded frame warning
//
//   Level 2 — .su + .ci (needs -fstack-usage AND -fcallgraph-info=su,da)
//     • Everything from Level 1 PLUS:
//     • Worst-case stack depth across the full call chain
//     • "IpcMaster_Task calls BswSpi_Exchange calls LPSPI_DRV_MasterTransfer"
//     • Recursive function detection
//     • Top-N deepest call chains with path visualisation
//
// HOW TO ENABLE (S32DS / arm-none-eabi-gcc):
//   Project → Properties → C/C++ Build → Settings →
//   Compiler → Miscellaneous → Other flags, add:
//     -fstack-usage -fcallgraph-info=su,da -Wstack-usage=256
//
//   Then use the scan feature to point at the Debug/ or Release/ build folder.
//   The tool finds all .su and .ci files automatically across all subfolders.
//
// WHY WORST-CASE MATTERS (embedded engineer note):
//   Each FreeRTOS task needs a stack large enough for its deepest call chain.
//   .su alone gives "IpcMaster_Task frame = 64 bytes".
//   .ci tells you "IpcMaster_Task → BswSpi_Exchange → LPSPI_DRV_MasterTransfer
//   total = 64 + 8 + 32 + 4 + 128 = 236 bytes".
//   Without this, you're guessing task stack sizes — common cause of stack overflow.
// =============================================================================

// ── Shared state ─────────────────────────────────────────────────────────────

const SU_DATA = {
    entries:      [],   // {func, file, line, size, type}  — from .su files
    loadedFiles:  [],   // {name, count}                   — files loaded so far
    scanResults:  null, // full scan response from /scan_su
    ciContents:   [],   // {name, content}                 — raw .ci file text
    cgResult:     null, // result from /analyse_callgraph
    filtered:     [],
    sortCol: 'worst_case', sortDir: -1,  // default sort: worst-case depth
};

// ── Drop zone wiring ──────────────────────────────────────────────────────────

/**
 * Called from DOMContentLoaded in index.html.
 * Wires up the .su / .ci file drop zone and click-to-browse.
 * Inputs are display:none siblings — no CSS overlay tricks needed.
 */
function initStackDrop() {
    const div = document.getElementById('su-drop');
    const inp = document.getElementById('su-fi');
    if (!div || !inp) { console.warn('[stack] su-drop or su-fi not found'); return; }

    div.addEventListener('dragover',  e => { e.preventDefault(); div.classList.add('over'); });
    div.addEventListener('dragleave', ()  => div.classList.remove('over'));
    div.addEventListener('drop', e => {
        e.preventDefault(); div.classList.remove('over');
        loadSUFiles(Array.from(e.dataTransfer.files));
    });
    // Click anywhere on the div opens the file picker
    div.addEventListener('click', e => { if (e.target !== inp) inp.click(); });
    inp.addEventListener('change', e => {
        loadSUFiles(Array.from(e.target.files));
        inp.value = '';   // allow re-selecting the same file
    });
}

// ── File loading (drag-and-drop or file picker) ───────────────────────────────

/**
 * Process files dropped or selected by the user.
 * Accepts any mix of .su and .ci files in one drop.
 * Calling this again adds to existing data (does not replace it).
 */
function loadSUFiles(files) {
    const suFiles = files.filter(f => f.name.endsWith('.su'));
    const ciFiles = files.filter(f => f.name.endsWith('.ci'));

    if (!suFiles.length && !ciFiles.length) {
        suScanStatus('No .su or .ci files found. Drop files from your GCC build output directory.');
        return;
    }

    const total = suFiles.length + ciFiles.length;
    let done = 0;

    const onAllLoaded = () => {
        done++;
        if (done === total) {
            updateSUDropLabel();
            if (SU_DATA.ciContents.length) {
                runCallgraphAnalysis();   // .ci present → compute worst-case chains
            } else {
                renderStackDepth();       // .su only → render frame sizes
            }
        }
    };

    suFiles.forEach(file => {
        readText(file, text => {
            const count = parseSUFile(file.name, text);
            upsertLoadedFile(file.name, count);
            onAllLoaded();
        });
    });

    ciFiles.forEach(file => {
        readText(file, text => {
            // Upsert: replace if same file re-dropped
            const idx = SU_DATA.ciContents.findIndex(c => c.name === file.name);
            if (idx >= 0) SU_DATA.ciContents[idx] = { name: file.name, content: text };
            else          SU_DATA.ciContents.push(  { name: file.name, content: text });
            onAllLoaded();
        });
    });
}

function readText(file, cb) {
    const r = new FileReader();
    r.onload  = e => cb(e.target.result);
    r.onerror = () => suScanStatus('Failed to read ' + file.name);
    r.readAsText(file);
}

// ── Directory scan ────────────────────────────────────────────────────────────

/**
 * Send the typed directory path to the server.
 * Server walks the ENTIRE tree (all subdirectories) and returns all
 * .su, .ci, .d, .o files it finds.
 *
 * The server route uses os.walk() which Python documents as:
 *   "For each directory in the tree rooted at top (including top itself),
 *    it yields a 3-tuple (dirpath, dirnames, filenames)."
 * This means ALL subdirectories are searched automatically.
 */
async function scanSUPath() {
    const pathEl  = document.getElementById('su-path');
    const path = (pathEl ? pathEl.value : '').trim();
    if (!path) { suScanStatus('Enter a directory path first'); return; }

    suScanStatus('Scanning all subdirectories…');
    document.getElementById('su-picker').style.display = 'none';

    try {
        const fd = new FormData();
        fd.append('path', path);
        const res = await fetch('/scan_su', { method: 'POST', body: fd });
        const d   = await res.json();

        if (d.error) {
            suScanStatus('Error: ' + d.error + (d.hint ? ' — ' + d.hint : ''));
            return;
        }

        SU_DATA.scanResults = d;

        // Show what was found before the picker
        renderScanSummary(d);

        if (d.has_su || d.has_ci) {
            renderSUPicker(d);
        }
    } catch(e) {
        suScanStatus('Network error: ' + e.message);
    }
}

/**
 * Display a colour-coded summary of what the scan found.
 * This tells the user clearly whether they have full or partial analysis.
 */
function renderScanSummary(d) {
    const status = document.getElementById('su-scan-status');

    const icons = { full: '✅', partial: '⚠️', none: '❌' };
    const cols  = { full: 'var(--grn)', partial: 'var(--ora)', none: 'var(--red)' };

    let html = `<span style="color:${cols[d.level]}">${icons[d.level]} ${d.summary}</span>`;

    if (d.level === 'partial') {
        html += `<br><span style="color:var(--dim);font-size:10px">
            Add <code style="color:var(--acc)">-fcallgraph-info=su,da</code> to GCC flags
            for worst-case call-chain analysis, then rebuild.</span>`;
    } else if (d.level === 'none') {
        html += `<br><span style="color:var(--dim);font-size:10px">
            Add <code style="color:var(--acc)">-fstack-usage</code> to GCC flags
            and rebuild. Files go in the same directory as your .o files.</span>`;
    }

    if (d.has_su && d.has_ci && d.matched > 0) {
        html += `<br><span style="color:var(--dim);font-size:10px">
            ${d.matched} matched .su/.ci pairs — full worst-case depth available.</span>`;
    }

    status.innerHTML = html;
}

/**
 * Render the file picker list.
 * Files are grouped by subdirectory for readability.
 * .ci files are shown alongside their matching .su file.
 */
function renderSUPicker(d) {
    const picker = document.getElementById('su-picker');
    const list   = document.getElementById('su-picker-list');
    const title  = document.getElementById('su-picker-title');

    const suCount = d.su_files.length;
    const ciCount = d.ci_files.length;

    title.textContent =
        suCount + ' .su' + (ciCount ? ' + ' + ciCount + ' .ci' : '') +
        ' files found across all subdirectories';

    list.innerHTML = '';

    // Group files by directory for easier navigation
    const dirs = {};
    d.su_files.forEach(f => {
        if (!dirs[f.dir]) dirs[f.dir] = { su: [], ci: [] };
        dirs[f.dir].su.push(f);
    });
    d.ci_files.forEach(f => {
        if (!dirs[f.dir]) dirs[f.dir] = { su: [], ci: [] };
        dirs[f.dir].ci.push(f);
    });

    // Initialise selected state on scanResults
    SU_DATA.scanResults.su_files.forEach(f => { if (f.selected === undefined) f.selected = true; });
    SU_DATA.scanResults.ci_files.forEach(f => { if (f.selected === undefined) f.selected = true; });

    // Render one group per directory
    Object.keys(dirs).sort().forEach(dir => {
        const group = dirs[dir];

        // Directory header row
        const hdr = document.createElement('div');
        hdr.style.cssText = 'padding:5px 6px 2px;font-size:10px;color:var(--acc);' +
            'font-weight:600;border-top:1px solid var(--bdr);margin-top:4px';
        hdr.textContent = dir;
        list.appendChild(hdr);

        // .su file rows
        group.su.forEach(f => {
            const hasCi = dirs[dir].ci.some(c => c.stem === f.stem);
            const row = makePickerRow(
                f, 'su', hasCi ? '🔗' : '📄',
                hasCi ? 'Matched .ci found — worst-case analysis available' : '',
                SU_DATA.scanResults.su_files
            );
            list.appendChild(row);
        });

        // .ci-only rows (ci with no matching .su — unusual but possible)
        group.ci.filter(c => !dirs[dir].su.some(s => s.stem === c.stem)).forEach(f => {
            const row = makePickerRow(f, 'ci', '📊', 'Call graph only — no .su match', SU_DATA.scanResults.ci_files);
            list.appendChild(row);
        });
    });

    picker.style.display = '';
}

function makePickerRow(f, ext, icon, hint, listRef) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 6px;' +
        'border-radius:4px;cursor:pointer;transition:.1s';
    row.innerHTML =
        `<input type="checkbox" ${f.selected ? 'checked' : ''} style="accent-color:var(--acc);flex-shrink:0">` +
        `<span style="font-size:10px;color:${ext==='ci'?'var(--ora)':'var(--acc)'};flex-shrink:0">${icon}</span>` +
        `<span style="font-size:11px;color:var(--txt);flex-shrink:0">${f.name}</span>` +
        `<span style="font-size:10px;color:var(--dim);flex-grow:1">${hint}</span>` +
        `<span style="font-size:10px;color:var(--dim);flex-shrink:0">${(f.size/1024).toFixed(1)}KB</span>`;

    row.addEventListener('mouseenter', () => row.style.background = 'var(--s2)');
    row.addEventListener('mouseleave', () => row.style.background = '');

    const cb = row.querySelector('input');
    const toggle = () => {
        f.selected = !f.selected; cb.checked = f.selected;
    };
    cb.addEventListener('change', () => { f.selected = cb.checked; });
    row.addEventListener('click', e => { if (e.target !== cb) toggle(); });
    return row;
}

function suPickerSelectAll() {
    if (!SU_DATA.scanResults) return;
    SU_DATA.scanResults.su_files.forEach(f => f.selected = true);
    SU_DATA.scanResults.ci_files.forEach(f => f.selected = true);
    renderSUPicker(SU_DATA.scanResults);
}
function suPickerSelectNone() {
    if (!SU_DATA.scanResults) return;
    SU_DATA.scanResults.su_files.forEach(f => f.selected = false);
    SU_DATA.scanResults.ci_files.forEach(f => f.selected = false);
    renderSUPicker(SU_DATA.scanResults);
}

/**
 * Load the files the user selected from the picker.
 * Sends paths to the server which reads them — browser never needs filesystem access.
 */
async function loadSelectedSU() {
    if (!SU_DATA.scanResults) return;
    const selSU = SU_DATA.scanResults.su_files.filter(f => f.selected);
    const selCI = SU_DATA.scanResults.ci_files.filter(f => f.selected);

    if (!selSU.length && !selCI.length) {
        alert('Select at least one file from the list'); return;
    }

    const btn = document.querySelector('[onclick="loadSelectedSU()"]');
    if (btn) { btn.textContent = 'Loading…'; btn.disabled = true; }
    suScanStatus('Loading ' + (selSU.length + selCI.length) + ' files…');

    try {
        const allPaths = [
            ...selSU.map(f => ({ path: f.path, type: 'su', name: f.name })),
            ...selCI.map(f => ({ path: f.path, type: 'ci', name: f.name })),
        ];

        const fd = new FormData();
        fd.append('paths', JSON.stringify(allPaths.map(f => f.path)));
        const res = await fetch('/load_su_files', { method: 'POST', body: fd });
        const d   = await res.json();

        if (d.error) { suScanStatus('Error: ' + d.error); return; }

        // Distribute loaded contents into .su and .ci buckets
        d.files.forEach(f => {
            if (f.name.endsWith('.su')) {
                const count = parseSUFile(f.name, f.content);
                upsertLoadedFile(f.name, count);
            } else if (f.name.endsWith('.ci')) {
                const idx = SU_DATA.ciContents.findIndex(c => c.name === f.name);
                if (idx >= 0) SU_DATA.ciContents[idx] = { name: f.name, content: f.content };
                else          SU_DATA.ciContents.push(  { name: f.name, content: f.content });
            }
        });

        document.getElementById('su-picker').style.display = 'none';
        updateSUDropLabel();

        if (d.errors && d.errors.length) {
            suScanStatus('Loaded with ' + d.errors.length + ' errors: ' + d.errors[0]);
        } else {
            suScanStatus('');
        }

        if (SU_DATA.ciContents.length) {
            await runCallgraphAnalysis();
        } else {
            renderStackDepth();
        }
    } catch(e) {
        suScanStatus('Load failed: ' + e.message);
    } finally {
        if (btn) { btn.textContent = '▶ Load selected'; btn.disabled = false; }
    }
}

// ── .su file parsing ──────────────────────────────────────────────────────────

/**
 * Parse one GCC .su file.
 *
 * GCC .su format (one line per function):
 *   path/to/source.c:lineNo:colNo:functionName   frameBytes   frameType
 *
 * frameType is one of:
 *   static           — known at compile time, reliable
 *   dynamic          — uses alloca() or VLAs, UNBOUNDED, investigate
 *   dynamic,bounded  — dynamic but compiler proved an upper bound exists
 *
 * EMBEDDED ENGINEER NOTE:
 *   Only "static" frames can be safely summed for worst-case stack calculation.
 *   "dynamic" frames are a red flag — they can grow without bound at runtime.
 *
 * Returns: count of functions parsed
 */
function parseSUFile(filename, content) {
    const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
    const shortName = slash >= 0 ? filename.slice(slash + 1) : filename;
    let count = 0;

    for (const line of content.split('\n')) {
        // Match: "path/file.c:NN:NN:funcName   NNN   type"
        const m = line.match(/^([^:]+):(\d+):\d+:(\S+)\s+(\d+)\s+(\S+)/);
        if (!m) continue;

        const entry = {
            file: shortName,
            line: parseInt(m[2]),
            func: m[3],
            size: parseInt(m[4]),
            // Normalise "dynamic,bounded" → "dynamic bounded" for easier display
            type: m[5].replace(',', ' '),
        };

        // Upsert: update existing entry if the same file is re-loaded
        const idx = SU_DATA.entries.findIndex(
            e => e.func === entry.func && e.file === shortName
        );
        if (idx >= 0) SU_DATA.entries[idx] = entry;
        else          SU_DATA.entries.push(entry);
        count++;
    }
    return count;
}

// ── Callgraph analysis (Level 2) ──────────────────────────────────────────────

/**
 * Send loaded .ci contents to the server for worst-case stack computation.
 * The server uses callgraph_parser.py to run DFS over the call graph.
 * Results are merged back into the UI alongside the .su frame sizes.
 */
async function runCallgraphAnalysis() {
    suScanStatus('Computing worst-case call chains…');
    try {
        const fd = new FormData();
        fd.append('ci_contents', JSON.stringify(SU_DATA.ciContents));
        fd.append('su_entries',  JSON.stringify(SU_DATA.entries));
        const res = await fetch('/analyse_callgraph', { method: 'POST', body: fd });
        const d   = await res.json();

        if (d.error) {
            suScanStatus('Callgraph error: ' + d.error);
            // Still show .su data even if .ci analysis failed
            renderStackDepth();
            return;
        }

        SU_DATA.cgResult = d;
        suScanStatus('');
        renderStackDepth();
    } catch(e) {
        suScanStatus('Callgraph request failed: ' + e.message);
        renderStackDepth();
    }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Main render function for the Stack Depth tab.
 * Adapts its output based on what data is available:
 *   - .su only  → shows frame sizes, flags unbounded frames
 *   - .su + .ci → additionally shows worst-case totals and call chains
 */
function renderStackDepth() {
    if (!SU_DATA.entries.length) return;

    $('stack-content').style.display = '';

    const entries    = SU_DATA.entries;
    const cg         = SU_DATA.cgResult;   // null if no .ci files
    const hasCG      = cg !== null;

    // ── Stats cards ─────────────────────────────────────────────────────
    const totalFuncs   = entries.length;
    const unbounded    = entries.filter(e => e.type.includes('dynamic') && !e.type.includes('bounded'));
    const maxFrame     = Math.max(...entries.map(e => e.size), 0);
    const maxWorstCase = hasCG
        ? Math.max(...Object.values(cg.worst_case).map(v => v.worst_case), 0)
        : maxFrame;

    $('stack-stats').innerHTML = `
        <div class="stat">
            <div class="snum">${totalFuncs}</div>
            <div class="slbl">Functions analysed</div>
        </div>
        <div class="stat">
            <div class="snum" style="color:var(--grn)">${maxFrame}</div>
            <div class="slbl">Largest single frame<br>(bytes, .su data)</div>
        </div>
        ${hasCG ? `<div class="stat">
            <div class="snum" style="color:var(--acc)">${maxWorstCase}</div>
            <div class="slbl">Worst-case call chain<br>(bytes, .ci data)</div>
        </div>` : `<div class="stat" style="opacity:0.5">
            <div class="snum">—</div>
            <div class="slbl">Worst-case chain<br>add -fcallgraph-info=su,da</div>
        </div>`}
        <div class="stat">
            <div class="snum" style="color:${unbounded.length ? 'var(--red)' : 'var(--grn)'}">
                ${unbounded.length}
            </div>
            <div class="slbl">Unbounded dynamic frames<br>${unbounded.length ? '⚠ investigate' : '✓ none'}</div>
        </div>
        ${hasCG && cg.has_recursive ? `<div class="stat">
            <div class="snum" style="color:var(--ora)">⟳</div>
            <div class="slbl">Recursive calls detected<br>stack depth is unbounded</div>
        </div>` : ''}`;

    // ── Callgraph top-N panel (only when .ci data available) ─────────────
    const cgPanel = $('stack-cg-panel');
    if (cgPanel) {
        if (hasCG && cg.top_worst && cg.top_worst.length) {
            cgPanel.style.display = '';
            const tbody = $('stack-cg-tbody');
            tbody.innerHTML = '';
            const absMax = cg.top_worst[0].worst_case || 1;
            cg.top_worst.forEach(item => {
                const pct = Math.round(item.worst_case / absMax * 100);
                const tr = document.createElement('tr');
                tr.className = 'clickable';
                // Show call chain as "A → B → C"
                const chain = item.path.join(' → ');
                tr.innerHTML = `
                    <td style="font-size:11px;color:var(--txt)">${item.func}</td>
                    <td>
                        <span class="sz" style="margin-right:6px">${item.worst_case}</span>
                        <div class="fill-bg" style="width:80px;display:inline-block">
                            <div class="fill-bar" style="width:${pct * 0.8}px;background:${
                                item.worst_case > 1024 ? 'var(--red)' :
                                item.worst_case > 512  ? 'var(--ora)' : 'var(--grn)'
                            }"></div>
                        </div>
                    </td>
                    <td class="sz">${item.frame}</td>
                    <td class="chain-cell" style="font-size:10px;color:var(--acc);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:underline dotted;cursor:pointer">${chain}</td>
                    <td>${item.recursive
                        ? '<span class="stack-type-badge stack-dynamic">recursive</span>' : ''}</td>`;
                // Wire hover diagram + click popup on the chain cell
                const chainCell = tr.querySelector('.chain-cell');
                if (chainCell && item.path && item.path.length > 1) {
                    attachChainInteraction(chainCell, item.path, item.func);
                }
                tr.addEventListener('click', e => {
                    if (e.target.classList.contains('chain-cell')) return; // handled above
                    // Cross-tab: open symbol popup if ELF is loaded
                    const sym = findSymbol(item.func, null);
                    if (sym) openSymbolPopup(sym);
                    else {
                        // Fall back to address inspector
                        $('a2l-addr').value = item.func;
                        switchTab('a2l');
                    }
                });
                tbody.appendChild(tr);
            });
        } else {
            cgPanel.style.display = 'none';
        }
    }

    // ── Unbounded warning card ────────────────────────────────────────────
    const ubCard = $('stack-unbounded-card');
    ubCard.style.display = unbounded.length ? '' : 'none';
    const ubBody = $('stack-unbounded');
    ubBody.innerHTML = '';
    unbounded.forEach(e => {
        const tr = document.createElement('tr');
        tr.className = 'stack-unbounded-row clickable';
        tr.innerHTML = `<td style="font-size:11px">${e.func}</td>
            <td class="dim" style="font-size:11px">${e.file}:${e.line}</td>`;
        tr.addEventListener('click', () => {
            const sym = findSymbol(e.func, null);
            if (sym) openSymbolPopup(sym);
        });
        ubBody.appendChild(tr);
    });

    filterStack();
}

function filterStack() {
    const q   = ($('stack-q')?.value   || '').toLowerCase();
    const typ = $('stack-type')?.value || '';
    SU_DATA.filtered = SU_DATA.entries.filter(e => {
        if (q   && !e.func.toLowerCase().includes(q)
                && !e.file.toLowerCase().includes(q)) return false;
        if (typ && !e.type.includes(typ)) return false;
        return true;
    });
    sortAndRenderStack();
}

function sortStack(col) {
    // When sorting by worst_case but no .ci data, fall back to size
    if (col === 'worst_case' && !SU_DATA.cgResult) col = 'size';
    if (SU_DATA.sortCol === col) SU_DATA.sortDir *= -1;
    else { SU_DATA.sortCol = col; SU_DATA.sortDir = -1; }
    sortAndRenderStack();
}

function sortAndRenderStack() {
    const { sortCol: col, sortDir: dir } = SU_DATA;
    const cg = SU_DATA.cgResult;

    const sorted = [...SU_DATA.filtered].sort((a, b) => {
        let va, vb;
        if (col === 'size') {
            va = a.size; vb = b.size;
        } else if (col === 'worst_case') {
            // Merge .ci worst-case into sort value; fall back to .su frame size
            va = cg?.worst_case[a.func]?.worst_case ?? a.size;
            vb = cg?.worst_case[b.func]?.worst_case ?? b.size;
        } else {
            va = a[col] || ''; vb = b[col] || '';
        }
        return (typeof va === 'number' ? va - vb : va.toString().localeCompare(vb.toString())) * dir;
    });

    $('stack-cnt').textContent = `${sorted.length} / ${SU_DATA.entries.length}`;

    const tbody   = $('stack-tbody');
    tbody.innerHTML = '';
    const maxSize = Math.max(...SU_DATA.entries.map(e => e.size), 1);
    const hasCG   = !!cg;

    sorted.slice(0, 500).forEach(e => {
        const typeClass =
            e.type.includes('dynamic') && !e.type.includes('bounded') ? 'stack-dynamic' :
            e.type.includes('bounded')                                  ? 'stack-bounded' :
                                                                          'stack-static';
        const barW = Math.round(e.size / maxSize * 80);
        const wc   = hasCG ? cg.worst_case[e.func] : null;
        const wcStr = wc ? `${wc.worst_case}` : '—';
        const wcCol = !wc ? 'var(--dim)' :
                      wc.worst_case > 1024 ? 'var(--red)' :
                      wc.worst_case > 512  ? 'var(--ora)' : 'var(--grn)';
        const chainStr = wc && wc.path.length > 1
            ? wc.path.slice(1).join(' → ')
            : '';

        const tr = document.createElement('tr');
        tr.className = 'clickable';
        tr.innerHTML = `
            <td style="font-size:11px;color:var(--txt)">${e.func}</td>
            <td>
                <span class="sz" style="margin-right:6px">${e.size}</span>
                <div class="fill-bg" style="width:80px;display:inline-block">
                    <div class="fill-bar" style="width:${barW}px;background:${
                        e.size > 1024 ? 'var(--red)' : e.size > 256 ? 'var(--ora)' : 'var(--grn)'
                    }"></div>
                </div>
            </td>
            <td style="color:${wcCol};font-weight:${wc?'600':'400'}">${wcStr}</td>
            <td><span class="stack-type-badge ${typeClass}">${e.type}</span></td>
            <td class="dim" style="font-size:10px">${e.file}:${e.line}</td>
            <td class="chain-cell" style="font-size:10px;color:${chainStr?'var(--acc)':'var(--dim)'};max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${chainStr?'text-decoration:underline dotted;cursor:pointer':''}">${chainStr}</td>`;

        // Wire hover diagram on chain cell (if chain data available)
        if (wc && wc.path && wc.path.length > 1) {
            const chainCell = tr.querySelector('.chain-cell');
            if (chainCell) attachChainInteraction(chainCell, wc.path, e.func);
        }

        tr.addEventListener('click', ev => {
            if (ev.target.classList.contains('chain-cell')) return;
            // Link to ELF symbol popup when ELF is loaded
            const sym = findSymbol(e.func, null);
            if (sym) openSymbolPopup(sym);
            else {
                // Link to stack depth tab isn't circular — click opens symbol search
                $('sym-q').value = e.func;
                filterSyms();
                switchTab('sym');
            }
        });
        tbody.appendChild(tr);
    });
}

function exportStackCSV() {
    const hasCG = !!SU_DATA.cgResult;
    const lines = ['Function,Frame bytes,Worst-case bytes,Type,File,Line,Call chain'];
    SU_DATA.filtered.forEach(e => {
        const wc = hasCG ? SU_DATA.cgResult.worst_case[e.func] : null;
        lines.push(`"${e.func}","${e.size}","${wc ? wc.worst_case : ''}","${e.type}","${e.file}","${e.line}","${wc ? wc.path.join(' → ') : ''}"`);
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = 'stack_usage.csv';
    a.click();
}

// ── State management helpers ──────────────────────────────────────────────────

function upsertLoadedFile(name, count) {
    const ex = SU_DATA.loadedFiles.find(f => f.name === name);
    if (ex) ex.count = count;
    else    SU_DATA.loadedFiles.push({ name, count });
}

function updateSUDropLabel() {
    const n = SU_DATA.loadedFiles.length;
    const total = SU_DATA.entries.length;
    const ci    = SU_DATA.ciContents.length;

    const lblEl = document.getElementById('su-drop-label');
    if (lblEl) lblEl.textContent =
        `${n} .su${ci ? ' + ' + ci + ' .ci' : ''} file${n !== 1 ? 's' : ''} loaded` +
        ` (${total} functions) — drop more to add`;

    const cntEl = document.getElementById('su-file-count');
    if (cntEl) cntEl.textContent = `${n} file${n !== 1 ? 's' : ''}${ci ? ' + ' + ci + ' .ci' : ''}`;

    const clrBtn = document.getElementById('su-clear-btn');
    if (clrBtn) clrBtn.style.display = '';

    // Update loaded file chips
    const listEl  = document.getElementById('su-loaded-list');
    const itemsEl = document.getElementById('su-loaded-items');
    if (listEl && itemsEl) {
        listEl.style.display = '';
        itemsEl.innerHTML = '';
        SU_DATA.loadedFiles.forEach(f => {
            const chip = document.createElement('div');
            chip.style.cssText = 'display:flex;align-items:center;gap:5px;background:var(--s2);' +
                'border:1px solid var(--bdr);border-radius:4px;padding:2px 8px;font-size:11px;' +
                'color:var(--dim)';
            chip.innerHTML = `<span>${f.name}</span>` +
                `<span style="color:var(--dim)">(${f.count})</span>` +
                `<span style="cursor:pointer;color:var(--dim)" title="Remove this file">✕</span>`;
            chip.querySelector('span:last-child').addEventListener('click', () => removeSUFile(f.name));
            itemsEl.appendChild(chip);
        });
        // Show .ci chips too
        SU_DATA.ciContents.forEach(f => {
            const chip = document.createElement('div');
            chip.style.cssText = 'display:flex;align-items:center;gap:5px;background:var(--s2);' +
                'border:1px solid #5a3010;border-radius:4px;padding:2px 8px;font-size:11px;color:var(--ora)';
            chip.innerHTML = `<span>📊 ${f.name}</span>` +
                `<span style="cursor:pointer;color:var(--dim)" title="Remove .ci file">✕</span>`;
            chip.querySelector('span:last-child').addEventListener('click', () => removeCIFile(f.name));
            itemsEl.appendChild(chip);
        });
    }
}

function removeSUFile(filename) {
    SU_DATA.entries     = SU_DATA.entries.filter(e => e.file !== filename);
    SU_DATA.loadedFiles = SU_DATA.loadedFiles.filter(f => f.name !== filename);
    if (SU_DATA.loadedFiles.length) {
        updateSUDropLabel();
        SU_DATA.cgResult = null;  // invalidate callgraph — frame data changed
        if (SU_DATA.ciContents.length) runCallgraphAnalysis();
        else renderStackDepth();
    } else {
        clearSUData();
    }
}

function removeCIFile(filename) {
    SU_DATA.ciContents = SU_DATA.ciContents.filter(c => c.name !== filename);
    SU_DATA.cgResult   = null;
    updateSUDropLabel();
    if (SU_DATA.ciContents.length) runCallgraphAnalysis();
    else renderStackDepth();
}

function clearSUData() {
    SU_DATA.entries      = [];
    SU_DATA.filtered     = [];
    SU_DATA.loadedFiles  = [];
    SU_DATA.scanResults  = null;
    SU_DATA.ciContents   = [];
    SU_DATA.cgResult     = null;

    ['stack-content','su-loaded-list','su-picker'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    const clr = document.getElementById('su-clear-btn');
    if (clr) clr.style.display = 'none';
    const cnt = document.getElementById('su-file-count');
    if (cnt) cnt.textContent = '';
    const lbl = document.getElementById('su-drop-label');
    if (lbl) lbl.textContent = 'Drop .su or .ci files here (multiple OK) — or click to browse';
    suScanStatus('');
}

function suScanStatus(msg) {
    const el = document.getElementById('su-scan-status');
    if (el) el.innerHTML = msg;
}

// =============================================================================
// CI FORMAT DEBUGGER
// =============================================================================
// The GCC -fcallgraph-info=su,da format is not well-documented.
// This tool shows the raw parsed result so we can verify the parser.
// =============================================================================

function toggleCIDebug() {
    const body = document.getElementById('ci-debug-body');
    if (body) body.style.display = body.style.display === 'none' ? '' : 'none';
}

async function inspectCIFormat() {
    const text = (document.getElementById('ci-sample-text')?.value || '').trim();
    const out  = document.getElementById('ci-debug-out');
    if (!text) { if (out) out.textContent = 'Paste some .ci content first'; return; }

    if (out) out.textContent = 'Sending to server…';

    try {
        const fd = new FormData();
        fd.append('content', text);
        const res = await fetch('/debug_ci', { method: 'POST', body: fd });
        const d   = await res.json();

        if (d.error) { if (out) out.textContent = 'Error: ' + d.error; return; }

        // Show the raw lines so we can see the actual format
        let report = `Total lines in sample: ${d.total_lines}\n\n`;
        report += `First ${Math.min(60, d.sample.length)} lines:\n`;
        report += '─'.repeat(60) + '\n';
        d.sample.forEach((line, i) => {
            report += `${String(i+1).padStart(3,'0')}: ${line}\n`;
        });
        report += '\n─'.repeat(60) + '\n';
        report += 'Copy the above and send to the developer so the parser can be fixed.\n';
        report += 'GitHub issue / email: include file name and GCC version (arm-none-eabi-gcc --version)';

        if (out) out.textContent = report;
    } catch(e) {
        if (out) out.textContent = 'Request failed: ' + e.message;
    }
}

// =============================================================================
// CALL CHAIN FLOW DIAGRAM
// =============================================================================
//
// Renders a vertical function flow diagram for a call chain path.
// Used in two contexts:
//   1. Hover tooltip  — lightweight floating preview
//   2. Click popup    — persistent modal, snapshotable with browser screenshot
//
// Each node shows:
//   • Function name
//   • Own stack frame (bytes)
//   • Running cumulative total at this point in the chain
//   • Source file:line (if available from .ci data)
//   • Stack type badge (static / dynamic / bounded)
//
// An arrow connects each node to the next, labelled with the caller's
// contribution to the total.
//
// EMBEDDED ENGINEER NOTE:
//   Read the diagram top-to-bottom = outermost caller → deepest callee.
//   The cumulative total at each node = stack depth IF that function is
//   the deepest point of execution.  The bottom node's cumulative total
//   is the worst-case stack requirement for the entry function.
// =============================================================================

/**
 * Build an SVG string for a vertical call chain flow diagram.
 *
 * @param {string[]} path   Function names in call order (outermost first)
 * @param {object}   cg     SU_DATA.cgResult  (for per-node frame sizes)
 * @param {object[]} suData SU_DATA.entries   (for type/file data)
 * @param {object}   opts   {compact: bool, maxWidth: number}
 * @returns {string}        SVG markup
 */
function buildChainSVG(path, cg, suData, opts = {}) {
    const compact  = opts.compact  || false;
    // maxWidth is a hint — we expand if names are longer
    const hintW    = opts.maxWidth || 380;

    // ── Gather per-node data ─────────────────────────────────────────────
    const nodes = path.map(name => {
        const wc    = cg?.worst_case?.[name];
        const su    = suData.find(e => e.func === name);
        const frame = wc?.frame ?? su?.size ?? 0;
        const type  = su?.type  ?? 'static';
        const file  = wc?.file  ?? su?.file ?? '';
        const line  = wc?.line  ?? su?.line ?? 0;
        return { name, frame, type, file, line };
    });

    // Cumulative stack at each step (top-down)
    let cumulative = 0;
    const cumulatives = nodes.map(n => { cumulative += n.frame; return cumulative; });

    // ── Approximate text width (monospace, ~7.2px per char at 12px font) ─
    // We use this to size the node wide enough that no name is ever clipped.
    const CHAR_W_NAME = compact ? 6.8 : 7.2;   // px per character at name font size
    const FRAME_BADGE = 52;                      // px reserved for "NNNNB" on the right
    const PAD_L       = 18;                      // left padding (after accent bar)
    const PAD_R       = 10;                      // right padding

    // Find the minimum node width that fits the longest function name
    const longestNamePx = Math.max(
        ...nodes.map(n => n.name.length * CHAR_W_NAME),
        120
    );
    // Also account for file:line text (smaller font, but can be long)
    const longestLocPx = compact ? 0 : Math.max(
        ...nodes.map(n => {
            const loc = n.file + (n.line ? ':' + n.line : '');
            return loc.length * 6.0;  // 9px font ≈ 6px per char
        }), 0
    );

    const NODE_W = Math.max(
        hintW - 20,                                      // caller's hint
        longestNamePx + PAD_L + FRAME_BADGE + PAD_R,    // name fits
        longestLocPx  + PAD_L + PAD_R                   // file:line fits
    );

    // SVG layout
    const NODE_H  = compact ? 52 : 68;
    const ARROW_H = compact ? 20 : 28;
    const STEP_H  = NODE_H + ARROW_H;
    const SVG_W   = NODE_W + 20;                        // +10px margin each side
    const SVG_H   = nodes.length * STEP_H - ARROW_H + 24;
    const X0      = 10;
    const NS      = 'http://www.w3.org/2000/svg';

    // ── Colour helpers ────────────────────────────────────────────────────
    const frameCol = f =>
        f > 1024 ? '#f85149' : f > 256 ? '#d29922' : '#3fb950';
    const typeCol  = t =>
        t.includes('dynamic') && !t.includes('bounded') ? '#f97316' :
        t.includes('bounded')                            ? '#58a6ff' : '#3fb950';

    let svg = `<svg xmlns="${NS}" width="${SVG_W}" height="${SVG_H}"
        viewBox="0 0 ${SVG_W} ${SVG_H}">`;
    svg += `<defs>
      <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="#444d56"/>
      </marker>
    </defs>`;

    nodes.forEach((node, i) => {
        const y      = i * STEP_H + 12;
        const cx     = SVG_W / 2;
        const fc     = frameCol(node.frame);
        const tc     = typeCol(node.type);
        const cum    = cumulatives[i];
        const isLast = i === nodes.length - 1;

        // ── Node background ───────────────────────────────────────────────
        svg += `<rect x="${X0}" y="${y}" width="${NODE_W}" height="${NODE_H}"
            rx="5" fill="${i === 0 ? '#0d2140' : '#0d1117'}"
            stroke="${i === 0 ? '#3b82f6' : '#21262d'}" stroke-width="1"/>`;

        // Left severity bar
        svg += `<rect x="${X0}" y="${y}" width="4" height="${NODE_H}"
            rx="2" fill="${fc}"/>`;

        // ── Full function name — no truncation ────────────────────────────
        // The node is sized to fit, so we never need to truncate.
        // For very long C++ mangled names we split at '::' boundaries.
        const nameLines = _wrapName(node.name, NODE_W - PAD_L - FRAME_BADGE - PAD_R, CHAR_W_NAME);
        const nameFS    = compact ? 11 : 12;
        const nameColor = i === 0 ? '#58a6ff' : '#ffffff';

        if (nameLines.length === 1) {
            svg += `<text x="${X0 + PAD_L}" y="${y + (compact ? 18 : 20)}"
                font-family="JetBrains Mono,monospace"
                font-size="${nameFS}" font-weight="600"
                fill="${nameColor}">${_svgEsc(nameLines[0])}</text>`;
        } else {
            // Multi-line name using tspan
            svg += `<text x="${X0 + PAD_L}" y="${y + (compact ? 13 : 15)}"
                font-family="JetBrains Mono,monospace"
                font-size="${nameFS}" font-weight="600" fill="${nameColor}">`;
            nameLines.forEach((ln, li) => {
                svg += `<tspan x="${X0 + PAD_L}" dy="${li === 0 ? 0 : nameFS + 2}">${_svgEsc(ln)}</tspan>`;
            });
            svg += '</text>';
        }

        if (!compact) {
            // File:line — full path, never truncated (node is wide enough)
            if (node.file) {
                const loc = node.file + (node.line ? ':' + node.line : '');
                const locY = nameLines.length > 1 ? y + 15 + nameLines.length * 14 : y + 33;
                svg += `<text x="${X0 + PAD_L}" y="${locY}"
                    font-family="JetBrains Mono,monospace"
                    font-size="9" fill="#6e7681">${_svgEsc(loc)}</text>`;
            }
        }

        // Frame size — right-aligned, never overlaps name because NODE_W accounts for it
        svg += `<text x="${X0 + NODE_W - 8}" y="${y + (compact ? 18 : 20)}"
            font-family="JetBrains Mono,monospace"
            font-size="${compact ? 11 : 12}" font-weight="600"
            fill="${fc}" text-anchor="end">${node.frame}B</text>`;

        // Cumulative total — bottom right
        svg += `<text x="${X0 + NODE_W - 8}" y="${y + NODE_H - 8}"
            font-family="JetBrains Mono,monospace"
            font-size="9" fill="${isLast ? fc : '#555d66'}"
            text-anchor="end">Σ ${cum}B</text>`;

        // Stack type — bottom left
        svg += `<text x="${X0 + PAD_L}" y="${y + NODE_H - 8}"
            font-family="JetBrains Mono,monospace"
            font-size="9" fill="${tc}">${_svgEsc(node.type)}</text>`;

        // ── Downward arrow ─────────────────────────────────────────────────
        if (!isLast) {
            const ay1 = y + NODE_H;
            const ay2 = ay1 + ARROW_H - 4;
            svg += `<line x1="${cx}" y1="${ay1}" x2="${cx}" y2="${ay2}"
                stroke="#444d56" stroke-width="1.5" marker-end="url(#arr)"/>`;
            svg += `<text x="${cx + 6}" y="${ay1 + ARROW_H / 2}"
                font-family="JetBrains Mono,monospace"
                font-size="9" fill="#444d56">calls</text>`;
        }
    });

    svg += '</svg>';
    return { svg, totalBytes: cumulatives[cumulatives.length - 1] || 0, nodeCount: nodes.length, svgW: SVG_W };
}

/**
 * Split a function name into lines that fit within maxPx width.
 * Prefers splitting at C++ '::' and '_' boundaries.
 * Returns array of line strings.
 */
function _wrapName(name, maxPx, charW) {
    if (name.length * charW <= maxPx) return [name];   // fits on one line

    const maxChars = Math.max(10, Math.floor(maxPx / charW));

    // Try splitting at '::' first (C++ namespaces/classes)
    const ccParts = name.split('::');
    if (ccParts.length > 1) {
        const lines = [];
        let cur = '';
        ccParts.forEach((part, i) => {
            const sep = i < ccParts.length - 1 ? '::' : '';
            if ((cur + part + sep).length <= maxChars) {
                cur += part + sep;
            } else {
                if (cur) lines.push(cur);
                cur = (i > 0 ? '  ' : '') + part + sep;  // indent continuations
            }
        });
        if (cur) lines.push(cur);
        if (lines.length > 1) return lines;
    }

    // Fall back to hard-wrap at maxChars, preferring '_' boundaries
    const lines = [];
    let remaining = name;
    while (remaining.length > maxChars) {
        // Find last '_' within maxChars
        let cut = maxChars;
        const lastUnderscore = remaining.lastIndexOf('_', maxChars);
        if (lastUnderscore > maxChars * 0.5) cut = lastUnderscore + 1;
        lines.push(remaining.slice(0, cut));
        remaining = '  ' + remaining.slice(cut);   // indent continuation
    }
    if (remaining.trim()) lines.push(remaining);
    return lines;
}

function _svgEsc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── Hover tooltip for chain cell ─────────────────────────────────────────────

/**
 * Attach hover + click behaviour to a chain-display element.
 *
 * @param {HTMLElement} el    The cell/span that shows the chain text
 * @param {string[]}    path  Full call path (outermost → deepest)
 * @param {string}      title Entry function name (for popup title)
 */
function attachChainInteraction(el, path, title) {
    if (!path || path.length < 2) return;

    const cg  = SU_DATA.cgResult;
    const su  = SU_DATA.entries;

    // ── Hover: custom SVG tooltip (not the generic addTip system) ────────
    el.style.cursor = 'pointer';
    el.title = '';   // suppress native title tooltip

    let hoverTimeout;
    el.addEventListener('mouseenter', e => {
        hoverTimeout = setTimeout(() => {
            const { svg, totalBytes } = buildChainSVG(path, cg, su, { compact: true, maxWidth: 300 });
            const tip = getTip();
            tip.innerHTML = `
                <div class="tn" style="margin-bottom:8px">
                    📊 ${_svgEsc(title)}
                    <span style="color:var(--dim);font-size:10px;font-weight:400;margin-left:6px">
                        worst-case: ${totalBytes}B — click to pin
                    </span>
                </div>
                ${svg}
                <div style="font-size:10px;color:var(--dim);margin-top:6px;border-top:1px solid var(--bdr);padding-top:5px">
                    Click to open persistent popup · ${path.length} functions in chain
                </div>`;
            tip.classList.add('on');
            tipPos(e);
        }, 120);   // short delay prevents flicker when moving mouse across table
    });
    el.addEventListener('mousemove', e => { if (getTip().classList.contains('on')) tipPos(e); });
    el.addEventListener('mouseleave', () => {
        clearTimeout(hoverTimeout);
        getTip().classList.remove('on');
    });

    // ── Click: persistent modal popup ────────────────────────────────────
    el.addEventListener('click', e => {
        e.stopPropagation();   // don't trigger row click (symbol popup)
        getTip().classList.remove('on');
        clearTimeout(hoverTimeout);
        openChainPopup(path, title);
    });
}

/**
 * Open a persistent modal showing the full call chain flow diagram.
 * The modal stays open until the user closes it, allowing screenshots.
 *
 * Layout:
 *   Header:  entry function name + worst-case total
 *   Body:    full-size vertical SVG flow diagram
 *   Footer:  "Copy as text" + "Export SVG" buttons
 */
function openChainPopup(path, title) {
    const cg  = SU_DATA.cgResult;
    const su  = SU_DATA.entries;
    const { svg, totalBytes, nodeCount } = buildChainSVG(path, cg, su, {
        compact: false, maxWidth: 440
    });

    // Plain-text version for clipboard copy
    let textChain = 'Call chain: ' + path.join(' → ') + '\n\n';
    let cum = 0;
    path.forEach((name, i) => {
        const wc = cg?.worst_case?.[name];
        const s  = su.find(e => e.func === name);
        const f  = wc?.frame ?? s?.size ?? 0;
        cum += f;
        textChain += `${'  '.repeat(i)}${i > 0 ? '↳ ' : ''}${name}  (frame: ${f}B, cumulative: ${cum}B)\n`;
    });
    textChain += `\nWorst-case total: ${totalBytes}B`;

    // Build a data URL so Copy as text works without async clipboard API issues
    const textB64 = btoa(unescape(encodeURIComponent(textChain)));

    const body = `
        <div style="padding:18px 20px">
            <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
                <button class="hbtn" id="chain-copy-btn"
                    onclick="(()=>{
                        const txt = decodeURIComponent(escape(atob('${textB64}')));
                        navigator.clipboard.writeText(txt)
                            .then(()=>{this.textContent='✓ Copied!';setTimeout(()=>this.textContent='📋 Copy as text',2000)})
                            .catch(()=>{this.textContent='Failed';setTimeout(()=>this.textContent='📋 Copy as text',2000)});
                    })()">
                    📋 Copy as text
                </button>
                <button class="hbtn" onclick="downloadChainSVG(this)">
                    ⬇ Export SVG
                </button>
                <span style="font-size:11px;color:var(--dim)">
                    ${nodeCount} functions · ${totalBytes}B worst-case
                </span>
                <span style="margin-left:auto;font-size:10px;color:var(--dim)">
                    Ctrl+Shift+S or Print→PDF to snapshot
                </span>
            </div>
            <div id="chain-svg-container"
                style="background:var(--surf);border:1px solid var(--bdr);border-radius:var(--rad);
                       padding:16px;overflow:auto;max-height:70vh;max-width:100%">
                ${svg}
            </div>
        </div>`;

    // Store path for SVG export
    openChainPopup._lastPath  = path;
    openChainPopup._lastTitle = title;

    openModal(
        '📊',
        title,
        `Worst-case stack chain · ${totalBytes} bytes · ${nodeCount} functions`,
        [],        // no tabs — single pane
        [body]
    );
}

/**
 * Export the current chain diagram as a standalone SVG file.
 * Called from the button inside the popup.
 */
function downloadChainSVG(btn) {
    const path  = openChainPopup._lastPath;
    const title = openChainPopup._lastTitle;
    if (!path) return;

    // Build at generous width — no maxWidth constraint for export
    // The _wrapName function auto-sizes the node, so names are never truncated
    const { svg, totalBytes, svgW } = buildChainSVG(
        path, SU_DATA.cgResult, SU_DATA.entries,
        { compact: false, maxWidth: Math.max(520, svgW || 0) }
    );

    // Add a background rect so the SVG looks correct when opened standalone
    // (browsers default to white background; we want dark)
    const standalone = svg.replace(
        '</defs>',
        `</defs><rect width="100%" height="100%" fill="#0d1117"/>`
    );

    const blob = new Blob(
        ['<' + '?xml version="1.0" encoding="UTF-8"?>\n', standalone],
        { type: 'image/svg+xml' }
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = title.replace(/[^a-zA-Z0-9_]/g, '_') + '_stack_chain.svg';
    a.click();

    if (btn) {
        btn.textContent = '✓ Downloaded';
        setTimeout(() => btn.textContent = '⬇ Export SVG', 2000);
    }
}

// =============================================================================
// DISASSEMBLY VIEW
// =============================================================================
//
// Shows arm-none-eabi-objdump disassembly of the function containing the
// inspected address, with:
//   • The target instruction highlighted with ► and a blue left border
//   • C source lines interleaved (if ELF was built with -g)
//   • N lines of context around the target (user-adjustable)
//   • Colour-coded mnemonics: green=load, orange=store, purple=branch
//   • Fault analysis banner when a crash pattern is detected
//
// EMBEDDED ENGINEER NOTE ON COLOURS:
//   Green  (LDR family)  — reading from memory.  If this faults, the READ
//                          address is bad (NULL, wrong region, misaligned).
//   Orange (STR family)  — writing to memory.  If this faults, the WRITE
//                          address is bad (flash, MPU-protected, NULL).
//   Purple (B/BL/BX)     — branch/call.  If this faults, a function pointer
//                          is corrupt or the return address was smashed.
//
// SOFTWARE ENGINEER NOTE:
//   objdump --source requires the ELF to have DWARF debug sections (.debug_info,
//   .debug_line etc.).  These are present when compiling with -g or -g3.
//   They don't affect code size — they're stripped by the bootloader/flasher.
// =============================================================================

// Cached last disassembly result — used by toggleDisasmFull / rerunDisasm
let _lastDisasmResult   = null;
let _lastDisasmAddr     = 0;
let _disasmShowFull     = false;   // false = N-line context, true = full function

// Cache of addr2line results keyed by hex address string.
// Populated when addr2line succeeds; reused when it returns empty on re-inspect.
// This avoids flaky results when source_dir is temporarily unavailable.
const _a2lCache = {};   // { '0x40CB00': { source_file, source_line } }

/**
 * Fetch and render disassembly for a given address.
 * Called from inspectAddress() after the four-card results are shown.
 *
 * @param {number} addrInt     The target address (integer)
 * @param {object} symResult   Result from inspectSymbol() — used for func bounds
 */

/**
 * Fetch and render disassembly for a given address.
 * Single canonical definition — called from inspectAddress and rerunDisasm.
 * Always calls updateSourceBar after render so source injection runs.
 *
 * @param {number} addrInt     Target address (integer)
 * @param {object} symResult   From inspectSymbol() — provides func bounds
 * @param {string} sourceDir   Optional source root path to pass to server
 */
async function fetchDisassembly(addrInt, symResult, sourceDir) {
    if (!S.elfFile) return;

    _lastDisasmAddr = addrInt;
    _disasmShowFull = false;   // reset to context view on new inspect

    const panel = $('ai-disasm-panel');
    const body  = $('ai-disasm-body');
    if (panel) panel.style.display = '';
    if (body)  body.innerHTML = '<div style="padding:14px;color:var(--dim)">⏳ Disassembling…</div>';
    const faultBanner = $('ai-fault-banner');
    if (faultBanner) faultBanner.style.display = 'none';

    // Pick up source dir: explicit arg → field value → sessionStorage
    const srcDir = sourceDir
        || (document.getElementById('ai-src-dir')?.value || '').trim()
        || localStorage.getItem('lmv_src_dir')    // survives browser restart
        || sessionStorage.getItem('lmv_src_dir')  // fallback
        || '';
    if (srcDir) {
        localStorage.setItem('lmv_src_dir', srcDir);    // persist across sessions
        sessionStorage.setItem('lmv_src_dir', srcDir);  // also session-scoped
    }

    const tools = _getToolsForCurrentTarget();

    const ctxLines = parseInt($('ai-ctx-lines')?.value || '10');
    const fd = new FormData();
    fd.append('elf',           S.elfFile);
    fd.append('addr',          '0x' + addrInt.toString(16));
    fd.append('context_lines', String(ctxLines));
    fd.append('tools_json',    JSON.stringify(tools));
    if (srcDir) fd.append('source_dir', srcDir);
    // Use sym result bounds first; fall back to last known bounds for this address
    // This ensures the same function window on re-inspect even if S.syms is empty
    const knownStart = symResult?.sym?.addr
        || (_lastDisasmResult?.func_start && _lastDisasmAddr === addrInt
            ? _lastDisasmResult.func_start
            : (_lastDisasmResult?._base?.func_start && _lastDisasmAddr === addrInt
                ? _lastDisasmResult._base.func_start : null));
    const knownEnd   = symResult?.sym?.addr && symResult?.sym?.size
        ? symResult.sym.addr + symResult.sym.size
        : (_lastDisasmResult?.func_end && _lastDisasmAddr === addrInt
            ? _lastDisasmResult.func_end
            : (_lastDisasmResult?._base?.func_end && _lastDisasmAddr === addrInt
                ? _lastDisasmResult._base.func_end : null));

    if (knownStart) fd.append('func_start', '0x' + knownStart.toString(16));
    if (knownEnd)   fd.append('func_end',   '0x' + knownEnd.toString(16));

    try {
        const res = await fetch('/disassemble', { method: 'POST', body: fd });
        const d   = await res.json();

        if (d.error) {
            if (body) body.innerHTML =
                `<div style="padding:14px;color:var(--red)">❌ ${_escHtml(d.error)}</div>`;
            appendDisasmDebug({ error: d.error, addr: '0x'+addrInt.toString(16) });
            return;
        }

        // ── Cache addr2line result for this address ───────────────────────
        // When addr2line succeeds, cache the result.
        // When it fails (returns empty), restore from cache so UI is consistent.
        const addrKey = '0x' + addrInt.toString(16).toUpperCase();
        if (d.source_file && d.source_line) {
            // Good result — store it
            _a2lCache[addrKey] = {
                source_file: d.source_file,
                source_line: d.source_line,
            };
        } else if (_a2lCache[addrKey]) {
            // addr2line returned nothing this time but we have a previous good result
            const cached = _a2lCache[addrKey];
            d = { ...d, source_file: cached.source_file, source_line: cached.source_line };
        }

        // Store raw server result — inject will read this via d._base
        _lastDisasmResult = d;

        // Always render first so the user sees something immediately
        renderDisassembly(d, false);

        // Then try to inject source (updateSourceBar calls injectUserSourceIntoDisasm
        // if files are in the store).  This may update _lastDisasmResult.
        updateSourceBar(d);

        // Show register panel if fault detected
        if (d.fault_analysis) showRegPanelForFault();

        // Debug log — read _lastDisasmResult which may have been updated by injection
        appendDisasmDebug(_lastDisasmResult);

    } catch(e) {
        if (body) body.innerHTML =
            `<div style="padding:14px;color:var(--red)">❌ ${_escHtml(e.message)}</div>`;
    }
}



/**
 * Render the disassembly listing.
 *
 * Handles five record types from the Python parser:
 *   insn        — ARM instruction (coloured by category)
 *   source_code — C source line (from -g DWARF data embedded in ELF)
 *   source_loc  — file:line marker (e.g. "../src/file.c:122")
 *   func_sig    — function signature ("BswSpi_Exchange():")
 *   label       — objdump function header ("004012a0 <BswSpi_Exchange>:")
 *   blank       — empty line
 *
 * The TARGET instruction (crash point) is highlighted with ► and a blue
 * left border.  The C source line associated with it gets a red background.
 *
 * @param {object}  d         Disassembly result from /disassemble
 * @param {boolean} showFull  true = show entire function, false = N-line context
 */
function renderDisassembly(d, showFull) {
    if (!d || !d.instructions) return;

    const body   = $('ai-disasm-body');
    const fnEl   = $('ai-disasm-func');
    const footer = $('ai-disasm-footer');

    // ── Function header ───────────────────────────────────────────────────
    if (fnEl && d.func_name) {
        const start = d.func_start ? '0x' + d.func_start.toString(16).toUpperCase() : '?';
        const end   = d.func_end   ? '0x' + d.func_end.toString(16).toUpperCase()   : '?';
        fnEl.textContent = `${d.func_name}  (${start} – ${end})`;
    }

    // ── Fault analysis banner ─────────────────────────────────────────────
    const faultBanner = $('ai-fault-banner');
    if (d.fault_analysis) {
        const fa  = d.fault_analysis;
        const col = fa.confidence === 'high' ? 'high'
                  : fa.confidence === 'medium' ? 'medium' : 'low';
        faultBanner.style.display = '';
        faultBanner.innerHTML =
            `<div class="fault-banner ${col}">
               <div class="fault-icon">${fa.icon}</div>
               <div style="flex:1">
                 <div class="fault-title">${_escHtml(fa.title)}</div>
                 <div class="fault-conf ${col}">${fa.confidence.toUpperCase()} CONFIDENCE</div>
                 <div class="fault-detail">${_escHtml(fa.detail)}</div>
                 <div class="fault-desc">${_escHtml(fa.description)}</div>
                 <div class="fault-fix">💡 ${_escHtml(fa.fix)}</div>
               </div>
             </div>`;
    } else {
        faultBanner.style.display = 'none';
    }

    // ── Aligned address notice (if input was not already aligned) ────────
    const alignedAddr = d.target_addr_aligned;

    // ── Build the listing ─────────────────────────────────────────────────
    const records   = d.instructions;
    const tIdx      = d.target_idx;
    const ctxStart  = d.context_start;
    const ctxEnd    = d.context_end;
    // Which source line number corresponds to the target instruction?
    const tSrcLine  = d.target_source_line || 0;

    body.innerHTML  = '';
    let foldShown   = false;
    let targetEl    = null;

    records.forEach((rec, i) => {
        const inCtx    = i >= ctxStart && i <= ctxEnd;
        const isTarget = i === tIdx;

        // Context folding — show a clickable fold separator
        if (!showFull && !inCtx && !isTarget) {
            if (!foldShown || i === ctxEnd + 1) {
                if (!foldShown) {
                    const fold = document.createElement('div');
                    fold.className = 'disasm-fold';
                    fold.textContent = '···  ' +
                        (ctxStart > 0
                            ? `${ctxStart} lines above`
                            : `${records.length - ctxEnd - 1} lines below`) +
                        ' — click "Full fn" to expand';
                    fold.addEventListener('click', () => {
                        _disasmShowFull = true;
                        const lbl = $('ai-disasm-toggle-lbl');
                        if (lbl) lbl.textContent = 'Context';
                        renderDisassembly(_lastDisasmResult, true);
                    });
                    body.appendChild(fold);
                    foldShown = true;
                }
            }
            return;
        }
        foldShown = false;

        // ── source_loc: file:line marker ──────────────────────────────────
        // e.g. "../src/Bsw/Bsw_Spi.c:147"
        if (rec.type === 'source_loc') {
            const el = document.createElement('div');
            el.className = 'disasm-file-marker';
            const parts = _normPath(rec.file || '').split('/');
            const shortFile = parts.length >= 2 ? parts.slice(-2).join('/') : (rec.file || '');
            el.innerHTML =
                `<span style="color:var(--dim)">📄 ${_escHtml(shortFile)}</span>` +
                (rec.line ? `<span style="color:#555d66">:${rec.line}</span>` : '');
            if (!showFull && !inCtx) el.style.opacity = '0.3';
            body.appendChild(el);
            return;
        }

        // ── func_sig: function signature line ────────────────────────────
        if (rec.type === 'func_sig') {
            const el = document.createElement('div');
            el.className = 'disasm-func-sig';
            el.textContent = rec.text;
            if (!showFull && !inCtx) el.style.opacity = '0.3';
            body.appendChild(el);
            return;
        }

        // ── source_code: C source line ────────────────────────────────────
        if (rec.type === 'source_code') {
            const el = document.createElement('div');
            // Highlight the C source line that corresponds to the target instruction
            const isTargetSrc = tSrcLine > 0 && rec._src_line === tSrcLine;
            el.className = 'disasm-source' + (isTargetSrc ? ' target-source' : '');
            el.textContent = rec.text;
            if (!showFull && !inCtx) el.style.opacity = '0.3';
            body.appendChild(el);
            return;
        }

        // ── label: function header ────────────────────────────────────────
        if (rec.type === 'label') {
            const el = document.createElement('div');
            el.className = 'disasm-label';
            el.textContent = rec.text;
            body.appendChild(el);
            return;
        }

        // ── blank ─────────────────────────────────────────────────────────
        if (rec.type === 'blank') {
            return;  // skip blank lines — cleaner display
        }

        // ── insn: instruction line ────────────────────────────────────────
        if (rec.type !== 'insn') return;

        const row = document.createElement('div');
        row.className = 'disasm-line' +
            (isTarget ? ' target' : '') +
            (!showFull && !inCtx ? ' dimmed' : '');

        const addrHex = '0x' + rec.addr.toString(16).toUpperCase().padStart(8, '0');
        const mnemCls = rec.is_load    ? 'is-load'
                      : rec.is_store   ? 'is-store'
                      : rec.is_branch  ? 'is-branch' : '';

        row.innerHTML =
            `<span class="dc-addr">${addrHex}</span>` +
            `<span class="dc-bytes">${_escHtml(rec.raw_bytes)}</span>` +
            `<span class="dc-mnem ${mnemCls}">${_escHtml(rec.mnemonic)}</span>` +
            `<span class="dc-ops">${_escHtml(rec.operands)}</span>`;

        if (isTarget) {
            targetEl = row;
            row.title = '► Crash point (Thumb-aligned) — click another row to change target';
        } else {
            row.title = 'Click to inspect this address';
        }

        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
            const inp = $('a2l-addr');
            if (inp) inp.value = addrHex;
            // Don't re-run full inspect — just update the input
        });

        body.appendChild(row);
    });

    // Scroll target into view after render completes
    if (targetEl) {
        requestAnimationFrame(() =>
            targetEl.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    }

    // ── Footer ────────────────────────────────────────────────────────────
    if (footer) {
        footer.style.display = '';
        let html = '';
        if (d.source_file && d.source_line) {
            // Shorten the path for display
            const shortFile = _normPath(d.source_file).split('/').pop();
            html = `📄 <strong>${_escHtml(shortFile)}</strong>:<strong style="color:var(--acc)">${d.source_line}</strong>` +
                   `<span style="color:var(--dim);margin-left:6px">${_escHtml(d.source_file)}</span>`;
            if (!d.has_source) {
                html += `<br><span style="color:var(--ora);font-size:10px">` +
                    `Source lines not shown — rebuild with <code>-g</code> to interleave C source</span>`;
            }
        } else if (!d.has_source) {
            html = `<span style="color:var(--dim)">No DWARF debug info in ELF. ` +
                   `Rebuild with <code style="color:var(--acc)">-g</code> or <code style="color:var(--acc)">-g3</code> ` +
                   `to see C source interleaved with disassembly.</span>`;
        }
        if (alignedAddr !== undefined && alignedAddr !== _lastDisasmAddr) {
            html += `<br><span style="color:var(--dim);font-size:10px">` +
                `Note: address aligned from ${hex(_lastDisasmAddr)} to ${hex(alignedAddr)} (Thumb-2 alignment)</span>`;
        }
        footer.innerHTML = html;
    }
}

function toggleDisasmFull() {
    _disasmShowFull = !_disasmShowFull;
    const lbl = $('ai-disasm-toggle-lbl');
    if (lbl) lbl.textContent = _disasmShowFull ? 'Context' : 'Full fn';
    if (_lastDisasmResult) renderDisassembly(_lastDisasmResult, _disasmShowFull);
}

function rerunDisasm() {
    if (!_lastDisasmAddr || !S.elfFile || !_lastDisasmResult) return;
    // Re-fetch with new context lines setting
    const symResult = { sym: {
        addr: _lastDisasmResult.func_start,
        size: (_lastDisasmResult.func_end || 0) - (_lastDisasmResult.func_start || 0),
    }};
    fetchDisassembly(_lastDisasmAddr, symResult);
}

function copyDisasm() {
    if (!_lastDisasmResult) return;
    const lines = _lastDisasmResult.instructions
        .filter(ins => ins.type === 'insn' || ins.type === 'source')
        .map(ins => ins.type === 'source'
            ? '// ' + ins.text
            : `  ${('0x'+ins.addr.toString(16).toUpperCase().padStart(8,'0'))}  ${ins.raw_bytes.padEnd(24)}  ${ins.mnemonic.padEnd(8)} ${ins.operands}`)
        .join('\n');
    navigator.clipboard.writeText(lines)
        .then(() => alert('Disassembly copied to clipboard'))
        .catch(() => alert('Copy failed — use Ctrl+A on the disassembly panel'));
}

// Safe path normaliser — avoids regex with backslash (syntax issues in bundles)
function _normPath(p) { return String(p || '').split('\\').join('/'); }

function _escHtml(s) {
    return String(s||'')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// =============================================================================
// DISASSEMBLY — SOURCE FILE SUPPORT, REGISTER ANALYSIS, RAW VIEW
// =============================================================================
//
// Source path resolution:
//   GCC bakes source paths into DWARF sections at compile time.
//   On the same machine, objdump -S resolves them automatically.
//   On a different machine (e.g. CI built, analysing on Windows dev machine):
//     - The DWARF paths are relative to the build directory on the build machine
//     - objdump can't find the files → no source interleaving
//   Solution: user provides the local source root, server tries path remapping
//   with --prefix-strip + --prefix, or reads the file directly and injects lines.
//
//   Additionally: user can drop .c/.h files directly, which we match to the
//   addr2line-reported filename and inject source manually.
//
// Register analysis:
//   Cortex-M fault registers give precise information about what went wrong.
//   CFSR (Configurable Fault Status Register) has a bit for every fault type.
//   LR on ISR entry encodes the EXC_RETURN pattern (which stack, FPU used etc.)
//   We decode these into human-readable explanations alongside the disassembly.
// =============================================================================

// In-memory source files dropped by user: { filename → [line1, line2, ...] }
// =============================================================================
// SOURCE FILE MANAGEMENT
// =============================================================================
//
// Three ways to provide source files:
//
//   1. Server-side scan (recommended)
//      Type the source root directory path → server walks the whole tree →
//      file picker appears (same UX as .su/.ci) → load selected.
//      Path is persisted in sessionStorage until page refresh.
//
//   2. Drag-and-drop / file picker
//      Drop .c/.h files directly onto the drop zone.
//      The browser reads them client-side — no server access needed.
//
//   3. objdump --source auto-resolve (transparent)
//      If the ELF was built on this same machine, objdump finds the files
//      automatically from the paths baked into DWARF. No UI needed.
//
// STORAGE:
//   _srcStore — in-memory map {filename → [line0_unused, line1, line2, ...]}
//   Persisted across inspections until the page is refreshed.
//   sessionStorage saves the last-used directory path.
//
// SOURCE LINE INJECTION:
//   When objdump couldn't find source lines but we have a file in _srcStore
//   that matches the addr2line-reported filename, we inject source_code
//   records around the crash line into the instruction list.
//   The number of lines injected is user-controlled via the context dropdown.
// =============================================================================

// In-memory source store — persists until page refresh
// { filename → ['', line1_text, line2_text, ...] }  (index 0 unused so indices = line numbers)
const _srcStore = {};

/**
 * Look up a source file in _srcStore.
 * Accepts either a bare filename ("BswSpi.c") or a full/relative path.
 * Matching strategy (in order):
 *   1. Exact key match
 *   2. The store key ends with the basename of the query
 *   3. The basename of the store key equals the basename of the query
 * Returns the lines array or null.
 */
function _srcLookup(filenameOrPath) {
    if (!filenameOrPath) return null;
    const needle = _normPath(filenameOrPath).split('/').pop();  // bare basename

    // 1. Exact match
    if (_srcStore[filenameOrPath]) return _srcStore[filenameOrPath];
    if (_srcStore[needle])         return _srcStore[needle];

    // 2. Any stored key whose basename matches needle
    for (const [k, v] of Object.entries(_srcStore)) {
        const kBase = _normPath(k).split('/').pop();
        if (kBase === needle) return v;
    }
    return null;
}
let   _srcScanResults = [];   // [{path, name, ext, dir, selected}]
let   _srcRootPath = '';      // last used directory

// ── Initialise source drop zone ───────────────────────────────────────────────

function initSourceDrop() {
    const drop = document.getElementById('ai-src-drop');
    const inp  = document.getElementById('ai-src-file-picker');
    if (!drop || !inp) return;

    drop.addEventListener('dragover',  e => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', e => {
        e.preventDefault(); drop.classList.remove('over');
        onSourceFilePick(e.dataTransfer.files);
    });
    drop.addEventListener('click', e => { if (e.target !== inp) inp.click(); });
    inp.addEventListener('change', e => { onSourceFilePick(e.target.files); inp.value = ''; });

    // Restore last-used directory (localStorage survives restart; sessionStorage is fallback)
    const saved = localStorage.getItem('lmv_src_dir') || sessionStorage.getItem('lmv_src_dir');
    if (saved) {
        const el = document.getElementById('ai-src-dir');
        if (el) el.value = saved;
    }
}

// ── Path scan (server-side walk of entire tree) ───────────────────────────────

async function scanSourceDir() {
    const pathEl = document.getElementById('ai-src-dir');
    const path   = (pathEl?.value || '').trim();
    if (!path) { setSrcStatus('Enter a directory path first'); return; }

    setSrcStatus('Scanning…');
    document.getElementById('ai-src-picker').style.display = 'none';

    try {
        const fd = new FormData();
        fd.append('path', path);
        const res = await fetch('/scan_source', { method: 'POST', body: fd });
        const d   = await res.json();

        if (d.error) { setSrcStatus('Error: ' + d.error); return; }
        if (!d.files || !d.files.length) {
            setSrcStatus('No source files found. Check path and try parent directory.');
            return;
        }

        // Save path persistently (localStorage = survives restart; sessionStorage = tab)
        _srcRootPath = path;
        localStorage.setItem('lmv_src_dir', path);
        sessionStorage.setItem('lmv_src_dir', path);

        _srcScanResults = d.files.map(f => ({ ...f, selected: _shouldAutoSelect(f) }));
        setSrcStatus('');
        renderSourcePicker(d.files.length, d.root);
    } catch(e) {
        setSrcStatus('Scan failed: ' + e.message);
    }
}

/**
 * Auto-select heuristic: prefer .c and .cpp over .h in initial selection,
 * but always auto-select if filename matches the current crash source file.
 */
function _shouldAutoSelect(f) {
    const crashFile = _lastDisasmResult?.source_file
        ? _normPath(_lastDisasmResult.source_file).split('/').pop()
        : '';
    if (crashFile && f.name === crashFile) return true;   // exact match — always select
    return ['.c', '.cpp', '.cxx', '.cc'].includes(f.ext); // default: select implementation files
}

// ── Picker rendering (same style as .su/.ci picker) ──────────────────────────

function renderSourcePicker(total, root) {
    const picker = document.getElementById('ai-src-picker');
    const list   = document.getElementById('ai-src-picker-list');
    const title  = document.getElementById('ai-src-picker-title');
    if (!picker || !list || !title) return;

    // Shorten root path for display
    const displayRoot = root ? _normPath(root).split('/').slice(-2).join('/') : '';
    title.textContent = `${total} source file${total !== 1 ? 's' : ''} found in ${displayRoot || root}`;
    list.innerHTML = '';

    // Group by directory
    const dirs = {};
    _srcScanResults.forEach(f => {
        if (!dirs[f.dir]) dirs[f.dir] = [];
        dirs[f.dir].push(f);
    });

    // Colour by extension
    const extCol = e =>
        e === '.c' || e === '.cpp' ? 'var(--acc)' :
        e === '.h' || e === '.hpp' ? 'var(--grn)' :
        e === '.s' || e === '.asm' ? 'var(--pur)' : 'var(--dim)';

    // Crash source file — highlight it
    const crashFile = _lastDisasmResult?.source_file
        ? _normPath(_lastDisasmResult.source_file).split('/').pop()
        : '';

    Object.keys(dirs).sort().forEach(dir => {
        // Directory group header
        const hdr = document.createElement('div');
        hdr.style.cssText = 'padding:4px 6px 2px;font-size:10px;color:var(--acc);' +
            'font-weight:600;border-top:1px solid var(--bdr);margin-top:3px';
        hdr.textContent = dir;
        list.appendChild(hdr);

        dirs[dir].forEach(f => {
            const isCrash = crashFile && f.name === crashFile;
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:3px 6px;' +
                'border-radius:3px;cursor:pointer;' + (isCrash ? 'background:var(--s2);' : '');
            row.innerHTML =
                `<input type="checkbox" ${f.selected ? 'checked' : ''}` +
                ` style="accent-color:var(--acc);flex-shrink:0">` +
                `<span style="font-size:10px;color:${extCol(f.ext)};flex-shrink:0;` +
                    `width:36px">${f.ext}</span>` +
                `<span style="font-size:11px;color:${isCrash ? 'var(--acc)' : '#fff'};` +
                    `font-weight:${isCrash ? '600' : '400'}">${f.name}` +
                    `${isCrash ? ' ← crash file' : ''}</span>` +
                `<span style="font-size:10px;color:var(--dim);margin-left:auto">` +
                    `${(f.size / 1024).toFixed(1)}KB</span>`;

            const cb = row.querySelector('input');
            cb.addEventListener('change', () => { f.selected = cb.checked; });
            row.addEventListener('click', e => {
                if (e.target !== cb) { f.selected = !f.selected; cb.checked = f.selected; }
            });
            row.addEventListener('mouseenter', () => { if (!isCrash) row.style.background = 'var(--s2)'; });
            row.addEventListener('mouseleave', () => { if (!isCrash) row.style.background = ''; });
            list.appendChild(row);
        });
    });

    picker.style.display = '';
}

function srcPickerAll()  { _srcScanResults.forEach(f => f.selected = true);  renderSourcePicker(_srcScanResults.length, _srcRootPath); }
function srcPickerNone() { _srcScanResults.forEach(f => f.selected = false); renderSourcePicker(_srcScanResults.length, _srcRootPath); }
function srcPickerExt(ext) {
    _srcScanResults.forEach(f => f.selected = f.ext === ext);
    renderSourcePicker(_srcScanResults.length, _srcRootPath);
}

// ── Load selected files (server reads them) ───────────────────────────────────

async function loadSelectedSource() {
    const selected = _srcScanResults.filter(f => f.selected);
    if (!selected.length) { alert('Select at least one file'); return; }

    const btn = document.querySelector('[onclick="loadSelectedSource()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    setSrcStatus(`Loading ${selected.length} file${selected.length !== 1 ? 's' : ''}…`);

    try {
        const fd = new FormData();
        fd.append('paths', JSON.stringify(selected.map(f => f.path)));
        const res = await fetch('/load_source_files', { method: 'POST', body: fd });
        const d   = await res.json();

        if (d.error) { setSrcStatus('Error: ' + d.error); return; }

        d.files.forEach(f => storeSourceFile(f.name, f.content));

        document.getElementById('ai-src-picker').style.display = 'none';
        updateSrcChips();
        injectUserSourceIntoDisasm();
        // Update debug log after injection so user sees fresh state
        if (_lastDisasmResult) appendDisasmDebug(_lastDisasmResult);
    } catch(e) {
        setSrcStatus('Load failed: ' + e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '▶ Load selected'; }
    }
}

// ── Drag-and-drop / file picker ───────────────────────────────────────────────

function onSourceFilePick(fileList) {
    const files = Array.from(fileList);
    if (!files.length) return;

    let loaded = 0;
    const label = document.getElementById('ai-src-drop-label');

    files.forEach(file => {
        const reader = new FileReader();
        reader.onload = e => {
            storeSourceFile(file.name, e.target.result);
            loaded++;
            if (loaded === files.length) {
                if (label) label.textContent =
                    `${Object.keys(_srcStore).length} file${Object.keys(_srcStore).length !== 1 ? 's' : ''} loaded`;
                updateSrcChips();
                injectUserSourceIntoDisasm();
                if (_lastDisasmResult) appendDisasmDebug(_lastDisasmResult);
            }
        };
        reader.readAsText(file);
    });
}

// ── Source store ──────────────────────────────────────────────────────────────

function storeSourceFile(name, content) {
    // Index 0 unused — lines[lineNumber] = text, matching 1-based line numbers
    _srcStore[name] = [''].concat(content.split('\n'));
    // Update debug log immediately so user can see lookup result changed
    if (_lastDisasmResult) {
        const chk = _srcLookup(_lastDisasmResult.source_file || _lastDisasmResult._base?.source_file);
        if (chk) setSrcStatus(`✅ "${name}" matches crash file — click Scan/Load to inject`);
    }
}

function clearSourceFiles() {
    Object.keys(_srcStore).forEach(k => delete _srcStore[k]);
    _srcScanResults = [];
    updateSrcChips();
    setSrcStatus('');
    const label = document.getElementById('ai-src-drop-label');
    if (label) label.textContent = 'Drop .c/.h files here';
}

// Source bar state — persists across inspections
let _srcBarMinimised = false;

function closeSrcBar() {
    _srcBarMinimised = true;
    const bar = document.getElementById('ai-src-bar');
    if (bar) bar.style.display = 'none';
    // Show a small reopen button in the disassembly header
    const reopenBtn = document.getElementById('ai-src-reopen');
    if (reopenBtn) reopenBtn.style.display = '';
}

function openSrcBar() {
    _srcBarMinimised = false;
    const bar = document.getElementById('ai-src-bar');
    if (bar) bar.style.display = '';
    const reopenBtn = document.getElementById('ai-src-reopen');
    if (reopenBtn) reopenBtn.style.display = 'none';
}

function setSrcStatus(msg) {
    const el = document.getElementById('ai-src-status');
    if (el) el.textContent = msg;
}

function updateSrcChips() {
    const loaded = document.getElementById('ai-src-loaded');
    const chips  = document.getElementById('ai-src-chips');
    const names  = Object.keys(_srcStore);
    if (!loaded || !chips) return;
    loaded.style.display = names.length ? '' : 'none';
    chips.innerHTML = '';
    names.forEach(name => {
        const chip = document.createElement('div');
        chip.style.cssText = 'display:flex;align-items:center;gap:4px;background:var(--s2);' +
            'border:1px solid var(--bdr);border-radius:3px;padding:1px 6px;font-size:10px;color:#8b949e';
        chip.innerHTML = `<span>${name}</span>` +
            `<span style="cursor:pointer;color:var(--dim)" title="Remove">✕</span>`;
        chip.querySelector('span:last-child').addEventListener('click', () => {
            delete _srcStore[name];
            updateSrcChips();
        });
        chips.appendChild(chip);
    });
}

// ── Source injection into disassembly ─────────────────────────────────────────

/**
 * Insert source lines from _srcStore into the current disassembly result.
 *
 * Matches by filename — uses the addr2line-reported source_file basename.
 * The number of context lines is controlled by the #ai-src-ctx dropdown.
 *
 * Call this after new files are loaded, or when context lines dropdown changes.
 */
function injectUserSourceIntoDisasm() {
    if (!_lastDisasmResult) return;

    // Always work from the clean base — the original server response
    // without any previously-injected source records.
    // _lastDisasmResult._base stores this permanently.
    const d = _lastDisasmResult;
    const base = d._base || d;   // _base is set below on first inject

    // ── 1. Find the source file ───────────────────────────────────────────
    const srcLines = _srcLookup(base.source_file);
    if (!srcLines) {
        const fname = base.source_file
            ? _normPath(base.source_file).split('/').pop()
            : '(unknown)';
        setSrcStatus(`"${fname}" not loaded — use Scan folder or drop the file`);
        return;
    }

    // ── 2. Find the target line number ────────────────────────────────────
    const targetLine = base.source_line || base.target_source_line || 0;
    if (!targetLine) {
        setSrcStatus('No line number from addr2line — rebuild ELF with -g');
        return;
    }

    // ── 3. Determine context window ───────────────────────────────────────
    const ctxN      = parseInt(document.getElementById('ai-src-ctx')?.value || '5');
    const startLine = ctxN === 0 ? 1 : Math.max(1, targetLine - ctxN);
    const endLine   = ctxN === 0
        ? srcLines.length - 1
        : Math.min(srcLines.length - 1, targetLine + ctxN);

    const fname = _normPath(base.source_file || '').split('/').pop();

    // ── 4. Build the injected record list ─────────────────────────────────
    // Start from base.instructions (the clean server response).
    // Find the target instruction by address (reliable across re-injects).
    const targetAddr = base.target_addr_aligned;
    const baseInsns  = base.instructions;

    // Find the target instruction index in the BASE list
    const baseTargetIdx = base.target_idx >= 0 ? base.target_idx
        : baseInsns.findIndex(r => r.type === 'insn' && r.addr === targetAddr);

    if (baseTargetIdx < 0) {
        setSrcStatus('Could not locate target instruction');
        return;
    }

    const injected = [];
    let sourceInserted = false;

    for (let i = 0; i < baseInsns.length; i++) {
        const rec = baseInsns[i];

        // Insert source block BEFORE the target instruction
        if (!sourceInserted && rec.type === 'insn' && i === baseTargetIdx) {
            injected.push({
                type: 'source_loc',
                file: fname,
                line: startLine,
                text: fname + ':' + startLine,
                _injected: true,
            });
            for (let ln = startLine; ln <= endLine; ln++) {
                injected.push({
                    type:      'source_code',
                    text:      srcLines[ln] || '',
                    _src_line: ln,
                    _injected: true,
                });
            }
            sourceInserted = true;
        }
        injected.push(rec);
    }

    // ── 5. Find new target index in the injected list ─────────────────────
    const newTargetIdx = injected.findIndex(
        r => r.type === 'insn' && r.addr === targetAddr
    );

    // ── 6. Compute context window around the new target ───────────────────
    const disasmCtx   = parseInt(document.getElementById('ai-ctx-lines')?.value || '10');
    const insnIdxs    = injected.map((r, i) => r.type === 'insn' ? i : -1).filter(i => i >= 0);
    let ctxStart = 0, ctxEnd = injected.length - 1;
    if (insnIdxs.length && newTargetIdx >= 0) {
        const rank   = insnIdxs.findIndex(idx => idx >= newTargetIdx);
        const safeR  = rank >= 0 ? rank : insnIdxs.length - 1;
        ctxStart = insnIdxs[Math.max(0, safeR - disasmCtx)];
        ctxEnd   = insnIdxs[Math.min(insnIdxs.length - 1, safeR + disasmCtx)];
        // Expand backward to include the injected source records just above target
        while (ctxStart > 0 && injected[ctxStart - 1]?.type !== 'insn') ctxStart--;
    }

    // ── 7. Update and render ──────────────────────────────────────────────
    const newResult = {
        ...base,                        // start from clean base
        instructions:       injected,
        target_idx:         newTargetIdx >= 0 ? newTargetIdx : baseTargetIdx,
        target_source_line: targetLine,
        has_source:         true,
        context_start:      ctxStart,
        context_end:        ctxEnd,
        _base:              base._base || base,  // never overwrite the true base
    };

    _lastDisasmResult = newResult;
    renderDisassembly(newResult, _disasmShowFull);
    setSrcStatus('✓ ' + fname + ':' + targetLine + ' — ' + (endLine - startLine + 1) + ' lines shown');
}

// ── Source bar visibility ─────────────────────────────────────────────────────

/**
 * Show or hide the source panel based on whether source lines resolved.
 * Always shown if files are already in the store (persist across inspections).
 */
function updateSourceBar(d) {
    const bar    = document.getElementById('ai-src-bar');
    if (!bar) return;

    const hasStore    = Object.keys(_srcStore).length > 0;
    const needsSource = !d.has_source && !!d.source_file;
    const reopenBtn   = document.getElementById('ai-src-reopen');

    // Restore persisted source dir (localStorage survives browser restart)
    const saved = localStorage.getItem('lmv_src_dir') || sessionStorage.getItem('lmv_src_dir');
    const pathEl = document.getElementById('ai-src-dir');
    if (pathEl && saved && !pathEl.value) pathEl.value = saved;

    // Pre-fill path hint from ELF DWARF data
    if (pathEl && !pathEl.value && d.source_file) {
        const parts = _normPath(d.source_file).split('/');
        const hint  = parts.slice(0, -2).join('/');
        if (hint) pathEl.placeholder = `e.g. ${hint}`;
    }

    // Try injection immediately if we have files — this may resolve needsSource
    if (hasStore) {
        injectUserSourceIntoDisasm();
    }

    // Re-check after injection: _lastDisasmResult.has_source may now be true
    const injectedOk = !!_lastDisasmResult?.has_source;

    // Bar visibility logic:
    //   - User clicked ✕ (_srcBarMinimised): always hidden, show reopen button
    //   - Source is fully resolved (objdump OR injection): hide the warning, keep
    //     the bar available via the 📂 Source reopen button
    //   - Source needed and not yet resolved: show bar with orange warning
    //   - Store has files but source resolved: collapse bar, show reopen button
    if (_srcBarMinimised) {
        bar.style.display = 'none';
        if (reopenBtn) reopenBtn.style.display = '';
    } else if (injectedOk || d.has_source) {
        // Source resolved — hide the "⚠ Source lines not found" warning
        // but make it easy to reopen if user wants to manage files
        bar.style.display = 'none';
        if (reopenBtn) {
            reopenBtn.style.display = '';
            reopenBtn.textContent = hasStore ? '📂 Source ✓' : '📂 Source';
            reopenBtn.title = injectedOk
                ? 'Source injected — click to manage source files'
                : 'Source from ELF — click to manage source files';
        }
    } else if (needsSource && !_srcBarMinimised) {
        // Source needed but not resolved — show warning bar
        bar.style.display = '';
        if (reopenBtn) reopenBtn.style.display = 'none';
    } else if (hasStore && !_srcBarMinimised) {
        // Store has files but this address has no source info
        bar.style.display = '';
        if (reopenBtn) reopenBtn.style.display = 'none';
    }

    updateSrcChips();
}

function rerunDisasmWithSource() {
    if (!_lastDisasmAddr || !S.elfFile) return;
    const srcDir = (document.getElementById('ai-src-dir')?.value || '').trim();
    if (srcDir) sessionStorage.setItem('lmv_src_dir', srcDir);
    fetchDisassembly(_lastDisasmAddr,
        { sym: { addr: _lastDisasmResult?.func_start,
                 size: (_lastDisasmResult?.func_end||0) - (_lastDisasmResult?.func_start||0) } },
        srcDir);
}


// ── Register analysis panel ───────────────────────────────────────────────────

let _regPanelVisible = false;
function toggleRegPanel() {
    _regPanelVisible = !_regPanelVisible;
    const panel = document.getElementById('ai-reg-panel');
    if (panel) panel.style.display = _regPanelVisible ? '' : 'none';
}

// Show the register panel when a fault is detected
function showRegPanelForFault() {
    _regPanelVisible = true;
    const panel = document.getElementById('ai-reg-panel');
    if (panel) panel.style.display = '';
}

/**
 * Decode CPU registers and produce a plain-English explanation.
 *
 * CFSR (0xE000ED28) bits:
 *   [0]     IACCVIOL  — instruction fetch from non-executable region
 *   [1]     DACCVIOL  — data access to non-executable region (MPU)
 *   [3]     MUNSTKERR — unstacking for exception return caused MPU violation
 *   [4]     MSTKERR   — stacking for exception entry caused MPU violation
 *   [5]     MLSPERR   — lazy FP state preservation MPU violation (M4/M7 only)
 *   [7]     MMARVALID — MMFAR holds the address of the MPU violation
 *   [8]     IBUSERR   — instruction bus error
 *   [9]     PRECISERR — precise data bus error (BFAR is valid)
 *   [10]    IMPRECISERR — imprecise bus error (BFAR may not be valid)
 *   [11]    UNSTKERR  — BusFault on unstacking
 *   [12]    STKERR    — BusFault on stacking
 *   [15]    BFARVALID — BFAR holds the bus fault address
 *   [16]    UNDEFINSTR — undefined instruction
 *   [17]    INVSTATE  — illegal EPSR.T or EPSR.IT
 *   [18]    INVPC     — integrity check failure on EXC_RETURN
 *   [19]    NOCP      — no coprocessor (FPU not enabled)
 *   [24]    UNALIGNED — unaligned access (when CCR.UNALIGN_TRP is set)
 *   [25]    DIVBYZERO — divide by zero (when CCR.DIV_0_TRP is set)
 *
 * LR EXC_RETURN values:
 *   0xFFFFFFF1 — return to Handler mode, MSP, no FPU
 *   0xFFFFFFF9 — return to Thread mode,  MSP, no FPU
 *   0xFFFFFFFD — return to Thread mode,  PSP, no FPU
 *   0xFFFFFFE1 — return to Handler mode, MSP, FPU (M4/M7 only)
 *   0xFFFFFFE9 — return to Thread mode,  MSP, FPU (M4/M7 only)
 *   0xFFFFFFED — return to Thread mode,  PSP, FPU (M4/M7 only)
 */
function updateRegAnalysis() {
    const out = document.getElementById('reg-analysis-out');
    if (!out) return;

    const parse = id => {
        const v = (document.getElementById(id)?.value || '').trim();
        if (!v) return null;
        try { return parseInt(v, 0); } catch(e) { return null; }
    };

    const pc   = parse('reg-pc');
    const lr   = parse('reg-lr');
    const sp   = parse('reg-sp');
    const bfar = parse('reg-bfar');
    const cfsr = parse('reg-cfsr');

    if (pc === null && cfsr === null && bfar === null) {
        out.innerHTML = '';
        return;
    }

    const lines = [];

    // ── LR decode ──────────────────────────────────────────────────────
    if (lr !== null) {
        const EXC_RETURNS = {
            0xFFFFFFF1: 'Handler mode, Main Stack (MSP), no FPU context',
            0xFFFFFFF9: 'Thread mode,  Main Stack (MSP), no FPU context',
            0xFFFFFFFD: 'Thread mode,  Process Stack (PSP) ← FreeRTOS task',
            0xFFFFFFE1: 'Handler mode, Main Stack (MSP), FPU context saved',
            0xFFFFFFE9: 'Thread mode,  Main Stack (MSP), FPU context saved',
            0xFFFFFFED: 'Thread mode,  Process Stack (PSP), FPU context saved',
        };
        const exc = EXC_RETURNS[lr >>> 0];
        if (exc) {
            lines.push(`<b style="color:var(--acc)">LR (EXC_RETURN)</b>: ${exc}`);
            if ((lr & 0xFFFFFFE0) === 0xFFFFFFE0 && (lr & 0x10) === 0) {
                lines.push(`&nbsp;&nbsp;⚠ FPU context on stack — ensure <code>configUSE_TASK_FPU_SUPPORT=2</code> if using FPU in tasks`);
            }
            if (lr === 0xFFFFFFFD) {
                lines.push(`&nbsp;&nbsp;✓ This fault occurred in a FreeRTOS task (PSP in use)`);
            }
        } else if ((lr & 1) === 0) {
            lines.push(`<b style="color:var(--red)">LR bit 0 = 0</b>: LR is not a Thumb address or EXC_RETURN pattern. This is unusual and may indicate stack corruption.`);
        }
    }

    // ── CFSR decode ────────────────────────────────────────────────────
    if (cfsr !== null) {
        lines.push(`<b style="color:var(--acc)">CFSR 0x${cfsr.toString(16).toUpperCase().padStart(8,'0')}</b>:`);
        const CFSR_BITS = [
            [0,  'MemManage', 'IACCVIOL',   'Instruction fetch from MPU-prohibited region'],
            [1,  'MemManage', 'DACCVIOL',   'Data access to MPU-prohibited region'],
            [3,  'MemManage', 'MUNSTKERR',  'MPU fault on exception return (unstacking)'],
            [4,  'MemManage', 'MSTKERR',    'MPU fault on exception entry (stacking)'],
            [5,  'MemManage', 'MLSPERR',    'Lazy FP save MPU violation'],
            [7,  'MemManage', 'MMARVALID',  'MMFAR register contains valid address'],
            [8,  'BusFault',  'IBUSERR',    'Instruction bus error (prefetch fault)'],
            [9,  'BusFault',  'PRECISERR',  'Precise data bus error — BFAR is valid'],
            [10, 'BusFault',  'IMPRECISERR','Imprecise bus error — BFAR may be stale'],
            [11, 'BusFault',  'UNSTKERR',   'Bus fault on exception return (unstacking)'],
            [12, 'BusFault',  'STKERR',     'Bus fault on exception entry (stacking)'],
            [15, 'BusFault',  'BFARVALID',  'BFAR register contains valid address'],
            [16, 'UsageFault','UNDEFINSTR', 'Undefined instruction — check Thumb state'],
            [17, 'UsageFault','INVSTATE',   'Invalid EPSR state — likely non-Thumb branch'],
            [18, 'UsageFault','INVPC',      'Invalid PC on exception return — corrupt LR'],
            [19, 'UsageFault','NOCP',       'No coprocessor — FPU not enabled (check CPACR)'],
            [24, 'UsageFault','UNALIGNED',  'Unaligned memory access with UNALIGN_TRP set'],
            [25, 'UsageFault','DIVBYZERO',  'Divide by zero with DIV_0_TRP set'],
        ];
        let anySet = false;
        const typeColors = {MemManage:'var(--ora)', BusFault:'var(--red)', UsageFault:'var(--acc)'};
        CFSR_BITS.forEach(([bit, type, name, desc]) => {
            if (cfsr & (1 << bit)) {
                anySet = true;
                const col = typeColors[type] || 'var(--txt)';
                lines.push(`&nbsp;&nbsp;<span style="color:${col}">[${type}] ${name}</span>: ${desc}`);
            }
        });
        if (!anySet) lines.push('&nbsp;&nbsp;<span style="color:var(--dim)">No fault bits set</span>');
    }

    // ── BFAR / MMFAR ──────────────────────────────────────────────────
    if (bfar !== null && bfar !== 0) {
        const bfarHex = '0x' + bfar.toString(16).toUpperCase().padStart(8,'0');
        let region = 'unknown region';
        if (bfar < 0x100)         region = 'NULL window — likely null pointer dereference';
        else if (bfar < 0x10000000) region = 'flash / code memory range';
        else if (bfar < 0x20000000) region = 'external bus / QSPI range';
        else if (bfar < 0x40000000) region = 'SRAM range';
        else if (bfar < 0xE0000000) region = 'peripheral register space';
        else                        region = 'system space (SCS/PPB)';
        lines.push(`<b style="color:var(--acc)">BFAR</b>: ${bfarHex} — ${region}`);
        if ((cfsr !== null) && !(cfsr & (1 << 15))) {
            lines.push('&nbsp;&nbsp;<span style="color:var(--ora)">⚠ BFARVALID bit NOT set — this address may be from a previous fault</span>');
        }
        // Offer to inspect this address
        lines.push(`&nbsp;&nbsp;<a href="#" style="color:var(--acc)" ` +
            `onclick="event.preventDefault();$('a2l-addr').value='${bfarHex}';inspectAddress()">` +
            `→ Inspect BFAR address in Address Inspector</a>`);
    }

    // ── SP sanity check ────────────────────────────────────────────────
    if (sp !== null && S.ld) {
        const stackSec = S.ld.sections.find(s => s.name.toLowerCase().includes('stack'));
        const stackReg = S.ld.regions.find(r => r.name.toLowerCase().includes('dtcm')
            || r.name.toLowerCase().includes('sram'));
        if (stackReg) {
            if (sp < stackReg.origin || sp > stackReg.end) {
                lines.push(`<b style="color:var(--red)">SP 0x${sp.toString(16).toUpperCase()}</b>: ` +
                    `outside ${stackReg.name} region (0x${stackReg.origin.toString(16)}–0x${stackReg.end.toString(16)}) — stack corrupted or overflowed`);
            } else {
                lines.push(`<b style="color:var(--grn)">SP 0x${sp.toString(16).toUpperCase()}</b>: within ${stackReg.name} region ✓`);
            }
        }
    }

    out.innerHTML = lines.join('<br>');
}

// ── Raw objdump output viewer ─────────────────────────────────────────────────

function showRawObjdump() {
    const modal = document.getElementById('ai-raw-modal');
    const pre   = document.getElementById('ai-raw-out');
    if (!modal || !pre) return;
    pre.textContent = _lastDisasmResult?.raw_objdump || 'No raw output available — run Inspect first';
    modal.style.display = '';
}

// fetchDisassembly override removed — see canonical definition above

// =============================================================================
// ISSUE 4 & 5 — CRASH POINT POPUP + SOURCE/DISASSEMBLY POPUPS
// =============================================================================
//
// Issue 4: Clicking the highlighted (target) instruction row opens a popup
//   showing the disassembly context + available source lines side-by-side.
//   The popup can be screenshotted for bug reports.
//
// Issue 5: Clicking the source file path in "Source line  addr2line" card
//   opens the source file centred on the crash line (if file is in store).
//   Clicking the symbol name in the "Symbol" card opens full disassembly
//   (or source if available) with the crash address highlighted.
// =============================================================================

/**
 * Open a popup showing disassembly + source around the crash address.
 * Called when user clicks the highlighted ► instruction row.
 *
 * @param {object} d           The _lastDisasmResult
 * @param {number} targetIdx   Index of the target instruction
 */
function openCrashPopup(d, targetIdx) {
    if (!d) return;

    const target = d.instructions[targetIdx];
    if (!target) return;

    const crashAddr = '0x' + (target.addr||0).toString(16).toUpperCase().padStart(8,'0');
    const fa        = d.fault_analysis;
    const srcFile   = d.source_file || '';
    const srcLine   = d.source_line || d.target_source_line || 0;

    // ── Build disassembly snippet HTML ──────────────────────────────────
    // Show N lines around the target from instructions
    const insns = d.instructions.filter(r => r.type === 'insn');
    const tRank = insns.findIndex(r => r.addr === target.addr);
    const window = 6;
    const visible = insns.slice(Math.max(0, tRank - window),
                                Math.min(insns.length, tRank + window + 1));

    const disasmHtml = visible.map(ins => {
        const isT  = ins.addr === target.addr;
        const mc   = ins.is_load ? 'is-load' : ins.is_store ? 'is-store'
                   : ins.is_branch ? 'is-branch' : '';
        const addr = '0x' + ins.addr.toString(16).toUpperCase().padStart(8,'0');
        return `<div class="disasm-line${isT ? ' target' : ''}" style="padding:2px 0">
            <span class="dc-addr">${addr}</span>
            <span class="dc-bytes" style="width:90px">${_escHtml(ins.raw_bytes)}</span>
            <span class="dc-mnem ${mc}">${_escHtml(ins.mnemonic)}</span>
            <span class="dc-ops">${_escHtml(ins.operands)}</span>
        </div>`;
    }).join('');

    // ── Build source snippet HTML ────────────────────────────────────────
    let sourceHtml = '';
    if (srcLine && srcFile) {
        const fname   = srcFile.split('/').pop().split('\\').pop();
        const srcLines = Object.entries(_srcStore).find(([k]) => k === fname || fname.endsWith(k))?.[1];
        if (srcLines) {
            const ctx   = 6;
            const start = Math.max(1, srcLine - ctx);
            const end   = Math.min(srcLines.length - 1, srcLine + ctx);
            const lines = [];
            for (let ln = start; ln <= end; ln++) {
                const isTarget = ln === srcLine;
                lines.push(
                    `<div style="display:flex;gap:8px;padding:1px 0;` +
                    `${isTarget ? 'background:#200d0d;border-left:3px solid var(--red);padding-left:4px' : ''}">` +
                    `<span style="color:#555d66;min-width:32px;text-align:right;` +
                    `${isTarget ? 'color:var(--red);font-weight:600' : ''}">${ln}</span>` +
                    `<span style="color:${isTarget ? '#ff9999' : '#6e7681'};white-space:pre">` +
                    `${_escHtml(srcLines[ln] || '')}</span></div>`
                );
            }
            sourceHtml = `
                <div style="font-size:11px;color:var(--dim);margin-bottom:4px">
                    📄 ${_escHtml(fname)} — crash at line ${srcLine}
                </div>
                <div style="font:11px var(--mono);background:var(--bg);
                    border:1px solid var(--bdr);border-radius:4px;padding:8px;
                    overflow-y:auto;max-height:260px">${lines.join('')}</div>`;
        }
    }

    // ── Fault analysis summary ───────────────────────────────────────────
    const faHtml = fa ? `
        <div style="margin-bottom:12px">
            <div class="fault-banner ${fa.confidence}" style="border-radius:4px">
                <div class="fault-icon" style="font-size:18px">${fa.icon}</div>
                <div>
                    <div class="fault-title">${_escHtml(fa.title)}</div>
                    <div class="fault-conf ${fa.confidence}">${fa.confidence.toUpperCase()}</div>
                    <div class="fault-desc" style="font-size:10px">${_escHtml(fa.description)}</div>
                    <div class="fault-fix" style="font-size:10px">💡 ${_escHtml(fa.fix)}</div>
                </div>
            </div>
        </div>` : '';

    // ── Export to text ───────────────────────────────────────────────────
    const textContent = [
        `Crash at: ${crashAddr}`,
        `Function: ${d.func_name || ''}`,
        srcFile && srcLine ? `Source:   ${srcFile}:${srcLine}` : '',
        fa ? `\nFault analysis: ${fa.title} (${fa.confidence} confidence)\n${fa.detail}\n${fa.fix}` : '',
        '\nDisassembly:',
        visible.map(ins => {
            const addr = '0x' + ins.addr.toString(16).toUpperCase().padStart(8,'0');
            const mark = ins.addr === target.addr ? '►' : ' ';
            return `  ${mark} ${addr}  ${ins.raw_bytes.padEnd(16)}  ${ins.mnemonic.padEnd(8)} ${ins.operands}`;
        }).join('\n'),
    ].filter(Boolean).join('\n');

    const b64text = btoa(unescape(encodeURIComponent(textContent)));

    const body = `
        <div style="padding:16px 20px">
            ${faHtml}
            <div style="display:flex;gap:12px;flex-wrap:wrap">
                <!-- Disassembly column -->
                <div style="flex:1;min-width:280px">
                    <div style="font-size:11px;color:var(--dim);margin-bottom:4px">
                        💻 Disassembly — crash at ${crashAddr}
                    </div>
                    <div style="font:11px var(--mono);background:var(--bg);
                        border:1px solid var(--bdr);border-radius:4px;padding:8px;
                        overflow-y:auto;max-height:260px">${disasmHtml}</div>
                </div>
                <!-- Source column -->
                ${sourceHtml ? `<div style="flex:1;min-width:280px">${sourceHtml}</div>` : ''}
            </div>
            <div style="margin-top:12px;display:flex;gap:8px">
                <button class="hbtn"
                    onclick="navigator.clipboard.writeText(decodeURIComponent(escape(atob('${b64text}'))))
                        .then(()=>this.textContent='✓ Copied!').catch(()=>{})">
                    📋 Copy as text
                </button>
                <span style="font-size:10px;color:var(--dim);align-self:center">
                    Use browser Ctrl+Shift+S or Print → Save as PDF to snapshot this popup
                </span>
            </div>
        </div>`;

    openModal('💥', `Crash at ${crashAddr}`,
        `${d.func_name || ''} · ${srcFile ? srcFile.split('/').pop() : 'no source'} ${srcLine ? ':'+srcLine : ''}`,
        [], [body]);
}

/**
 * Issue 4b: Open source file popup centred on a given line.
 * Called when user clicks the file path in the addr2line card.
 */
function openSourcePopup(filename, targetLine) {
    if (!filename) return;
    const fname = filename.split('/').pop().split('\\').pop();
    const srcLines = _srcLookup(filename);

    if (!srcLines) {
        // Source not in store — show the source bar for loading
        openSrcBar();
        setSrcStatus(`Drop "${fname}" or scan its folder`);
        return;
    }

    // srcLines from _srcLookup
    const ctx   = 20;
    const start = targetLine ? Math.max(1, targetLine - ctx) : 1;
    const end   = targetLine ? Math.min(srcLines.length - 1, targetLine + ctx) : srcLines.length - 1;

    const lines = [];
    for (let ln = start; ln <= end; ln++) {
        const isT = ln === targetLine;
        lines.push(
            `<div style="display:flex;gap:10px;padding:1px 0;` +
            (isT ? 'background:#200d0d;border-left:3px solid var(--red);' : '') + `">` +
            `<span style="color:${isT?'var(--red)':'#555d66'};min-width:36px;` +
            `text-align:right;font-weight:${isT?'700':'400'}">${ln}</span>` +
            `<span style="color:${isT?'#ff9999':'#8b949e'};white-space:pre;overflow-x:auto">` +
            `${_escHtml(srcLines[ln]||'')}</span></div>`
        );
    }

    const body = `
        <div style="padding:16px 20px">
            <div style="font-size:11px;color:var(--dim);margin-bottom:8px">
                ${targetLine ? `Crash at line <strong style="color:var(--red)">${targetLine}</strong> —` : ''}
                showing ${start}–${end} of ${srcLines.length-1} lines
            </div>
            <div style="font:11px var(--mono);background:var(--bg);border:1px solid var(--bdr);
                border-radius:4px;padding:8px;max-height:70vh;overflow-y:auto" id="src-popup-body">
                ${lines.join('')}
            </div>
        </div>`;

    openModal('📄', fname,
        targetLine ? `Line ${targetLine} highlighted` : 'Full file',
        [], [body]);

    // Auto-scroll to highlighted line
    requestAnimationFrame(() => {
        const el = document.querySelector('#src-popup-body [style*="background:#200d0d"]');
        if (el) el.scrollIntoView({ block: 'center' });
    });
}

/**
 * Issue 5: Open a popup from the Symbol card showing full function disassembly
 * or source (if available), with the crash address highlighted.
 * Called by clicking the symbol name in the ELF symbol card.
 */
function openSymbolDisasmPopup() {
    if (!_lastDisasmResult) return;
    const d = _lastDisasmResult;

    // Try source first if available
    const srcFile  = d.source_file || '';
    const srcLine  = d.source_line || d.target_source_line || 0;
    const srcLines_sym = srcFile ? _srcLookup(srcFile) : null;

    if (srcLines_sym) {
        // Show full function source with crash line highlighted
        openSourcePopup(srcFile, srcLine);
    } else {
        // Show full function disassembly with target highlighted
        const insns = d.instructions.filter(r => r.type === 'insn');
        const target = d.instructions[d.target_idx];
        const targetAddr = target?.addr;

        const html = insns.map(ins => {
            const isT = ins.addr === targetAddr;
            const mc  = ins.is_load ? 'is-load' : ins.is_store ? 'is-store'
                      : ins.is_branch ? 'is-branch' : '';
            const addr = '0x' + ins.addr.toString(16).toUpperCase().padStart(8,'0');
            return `<div class="disasm-line${isT ? ' target' : ''}">
                <span class="dc-addr">${addr}</span>
                <span class="dc-bytes">${_escHtml(ins.raw_bytes)}</span>
                <span class="dc-mnem ${mc}">${_escHtml(ins.mnemonic)}</span>
                <span class="dc-ops">${_escHtml(ins.operands)}</span>
            </div>`;
        }).join('');

        const body = `
            <div style="padding:12px 20px">
                <div style="font:12px var(--mono);background:var(--bg);border:1px solid var(--bdr);
                    border-radius:4px;padding:8px;max-height:70vh;overflow-y:auto"
                    id="sym-disasm-body">${html}</div>
            </div>`;

        openModal('💻', d.func_name || 'Function disassembly',
            `${insns.length} instructions · crash address highlighted`,
            [], [body]);

        requestAnimationFrame(() => {
            const el = document.querySelector('#sym-disasm-body .target');
            if (el) el.scrollIntoView({ block: 'center' });
        });
    }
}

// =============================================================================
// DISASSEMBLY DEBUG LOG
// =============================================================================
// Appended to the existing Debug tab. Shows exactly what the disassembly
// subsystem received and did, so the user can report issues precisely.
//
// Keys shown on each entry:
//   source_file        — path baked into ELF DWARF (what addr2line returned)
//   source_line        — line number from addr2line
//   target_idx         — index of crash instruction in record list
//   target_addr_aligned— address after Thumb bit strip and alignment
//   has_source         — did objdump -S find source lines? (needs -g in ELF)
//   _base set          — is the clean base stored for re-inject?
//   _srcStore keys     — which source files are currently loaded
//   inject result      — did injectUserSourceIntoDisasm succeed?
// =============================================================================

const _disasmDebugLog = [];   // ring buffer, 20 entries max

function appendDisasmDebug(d) {
    const entry = {
        ts:                   new Date().toISOString().slice(11,23),
        addr:                 d.addr || ('0x' + (_lastDisasmAddr||0).toString(16).toUpperCase()),
        cache_hit:            !!(_a2lCache['0x' + (_lastDisasmAddr||0).toString(16).toUpperCase()]),
        error:                d.error || null,
        source_file:          d.source_file || '(none)',
        source_line:          d.source_line || 0,
        target_idx:           d.target_idx ?? -1,
        target_addr_aligned:  d.target_addr_aligned
                                ? '0x' + d.target_addr_aligned.toString(16).toUpperCase()
                                : '(none)',
        has_source_from_objdump: d.has_source || false,
        has_source_after_inject: _lastDisasmResult?.has_source || false,
        base_set:             !!_lastDisasmResult?._base,
        src_store_keys:       Object.keys(_srcStore),
        src_lookup_result:    d.source_file
            ? (_srcLookup(d.source_file)
                ? 'FOUND ✅ — injection should work'
                : 'NOT FOUND ❌ — need: ' + _normPath(d.source_file).split('/').pop())
            : 'no source_file — ELF needs -g and addr2line must resolve',
        inject_ran:           !!d._base,
        src_line_available:   !!(d.source_line || d.target_source_line),
        fault_pattern:        d.fault_analysis?.pattern || null,
        instruction_count:    (d.instructions || []).filter(r=>r.type==='insn').length,
        record_count:         (d.instructions || []).length,
        func_start:           d.func_start ? '0x'+(d.func_start).toString(16).toUpperCase() : '(auto-detected)',
        func_end:             d.func_end   ? '0x'+(d.func_end  ).toString(16).toUpperCase() : '(auto-detected)',
    };
    _disasmDebugLog.unshift(entry);
    if (_disasmDebugLog.length > 20) _disasmDebugLog.pop();
    renderDisasmDebug();
}

function renderDisasmDebug() {
    const el = document.getElementById('disasm-dbg-out');
    if (!el) return;
    if (!_disasmDebugLog.length) {
        el.textContent = 'No disassembly calls yet — run Inspect with an ELF loaded.';
        return;
    }

    const lines = ['═'.repeat(60)];
    _disasmDebugLog.forEach((e, i) => {
        lines.push(`[${e.ts}] ${i === 0 ? '← latest' : ''}`);
        if (e.error) {
            lines.push(`  ❌ ERROR: ${e.error}`);
            lines.push('');
            return;
        }
        lines.push(`  Address:         ${e.addr}${e.cache_hit ? ' (cached addr2line result available)' : ''}`);
        lines.push(`  Aligned addr:    ${e.target_addr_aligned}`);
        lines.push(`  Func bounds:     ${e.func_start} – ${e.func_end} (${e.instruction_count} instructions)`);
        lines.push(`  source_file:     ${e.source_file}`);
        lines.push(`  source_line:     ${e.source_line || '(not found by addr2line)'}`);
        lines.push(`  target_idx:      ${e.target_idx}  (index into ${e.record_count} records)`);
        lines.push(`  Instructions:    ${e.instruction_count}`);
        // objdump -S result
        lines.push(`  has_source (objdump):  ${e.has_source_from_objdump
            ? '✅ YES — C source lines embedded in ELF (-g active)'
            : '❌ NO — objdump could not resolve source paths (source dir mismatch or paths differ between build machine and this machine)'}`);
        lines.push(`  has_source (injected): ${e.has_source_after_inject ? '✅ YES — source injected from _srcStore' : '❌ NO'}`);
        lines.push(`  source line available: ${e.src_line_available ? '✅ YES — line ' + (e.source_line||0) : '❌ NO — addr2line returned nothing (address not in debug info)'}`);
        lines.push(`  injection ran:   ${e.inject_ran
            ? '✅ YES'
            : '❌ NOT YET — ' + (e.src_store_keys.length === 0
                ? 'load source files first (Scan folder or drop .c files)'
                : e.src_lookup_result.startsWith('NOT FOUND')
                    ? 'crash file not in store. Need: ' + (e.src_lookup_result.split('need: ')[1] || '?')
                    : 'source_file or source_line missing from ELF debug info')}`);
        lines.push(`  _srcStore: ${e.src_store_keys.length
            ? e.src_store_keys.length + ' files loaded: '
              + e.src_store_keys.slice(0,5).join(', ')
              + (e.src_store_keys.length > 5 ? ' … +' + (e.src_store_keys.length-5) + ' more' : '')
            : '(empty — use Scan folder in the Source panel)'}`);
        lines.push(`  _srcLookup: ${e.src_lookup_result}`);
        if (e.fault_pattern) lines.push(`  Fault pattern:   ${e.fault_pattern}`);
        lines.push('  ' + '─'.repeat(56));
    });

    el.textContent = lines.join('\n');
}

function clearDisasmDebug() {
    _disasmDebugLog.length = 0;
    renderDisasmDebug();
}

// =============================================================================
// TARGET PLATFORM SYSTEM
// =============================================================================
//
// Manages the target selector (ARM Cortex-M / ESP32 Xtensa / ESP32 RISC-V)
// and derives:
//   • Default toolchain prefix / bare tool names
//   • Section hints colour table (sent to server as JSON in POST body)
//   • Memory-map constants for fault analysis (sent to server)
//   • DMA-safe section names for warnings (sent to server)
//   • Disassembly ISA tag (sent to server so it picks the right objdump flags)
//
// The server uses the 'target' field in every POST to select the correct
// Python constant tables.  The JS stores the selection in localStorage so
// it persists across page refreshes.
//
// ADDING A NEW TARGET:
//   1. Add an entry to TARGET_PROFILES below.
//   2. Add a <button id="tgt-<id>" class="tgt-chip"> in index.html.
//   3. The server reads the 'target' field from every POST — extend the
//      Python TARGET_PROFILES dict in app.py to match.
// =============================================================================

const TARGET_PROFILES = {
  'arm': {
    label:          'ARM Cortex-M (S32K / STM32 / LPC)',
    icon:           '⚙',
    badgeClass:     'arm',
    // Bare tool names when on PATH
    tools: {
      nm:      'arm-none-eabi-nm',
      re:      'arm-none-eabi-readelf',
      size:    'arm-none-eabi-size',
      a2l:     'arm-none-eabi-addr2line',
      objdump: 'arm-none-eabi-objdump',
    },
    // Hint shown in prefix input placeholder
    prefixHint:  'D:\\NXP\\S32DS\\bin\\arm-none-eabi-',
    autoLabel:   'arm-none-eabi-{nm, readelf, size, addr2line, objdump}',
    // Disassembly ISA tag passed to server
    isa:         'thumb2',
    // Memory map for fault analysis (sent to server)
    memmap: {
      null_window:   0x100,
      flash_ranges:  [[0x00000000, 0x10000000]],
      sram_ranges:   [[0x20000000, 0x40000000]],
      periph_ranges: [[0x40000000, 0xE0000000]],
    },
    // Names of DMA-safe sections (server uses these for warning logic)
    dma_safe_sections: [
      '.non_cacheable_data', '.non_cacheable_bss',
      '.mcal_data_no_cacheable', '.mcal_bss_no_cacheable',
    ],
    // Names of cacheable sections (server checks if DMA buffers land here)
    cacheable_sections: [
      '.data', '.bss', '.sram_data', '.sram_bss',
      '.dtcm_data', '.dtcm_bss', '.ramcode',
    ],
    // Peripheral access warning wording
    periph_note: 'On S32K3: check PCC_<PERIPH>_CGC bit.',
    // INCLUDE preprocessor: try to inline INCLUDE directives from these subdirs
    ld_include_dirs: [],
  },

  'esp32-xtensa': {
    label:       'ESP32 Xtensa (ESP32 / S2 / S3)',
    icon:        '📡',
    badgeClass:  'esp-xtensa',
    tools: {
      nm:      'xtensa-esp-elf-nm',
      re:      'xtensa-esp-elf-readelf',
      size:    'xtensa-esp-elf-size',
      a2l:     'xtensa-esp-elf-addr2line',
      objdump: 'xtensa-esp-elf-objdump',
    },
    prefixHint:  'C:\\Users\\<you>\\.espressif\\tools\\xtensa-esp-elf\\bin\\xtensa-esp-elf-',
    autoLabel:   'xtensa-esp-elf-{nm, readelf, size, addr2line, objdump}',
    isa:         'xtensa',
    memmap: {
      null_window:   0x100,
      // ESP32 DRAM (data), IRAM (code), Flash cache (XIP), ROM, peripherals
      flash_ranges:  [[0x3F400000, 0x3FC00000],   // Flash data cache (XIP)
                      [0x40000000, 0x40080000]],   // IROM / ROM
      sram_ranges:   [[0x3FFA0000, 0x40000000],   // DRAM (data)
                      [0x40080000, 0x400C0000]],   // IRAM (code)
      periph_ranges: [[0x3FF00000, 0x3FFA0000],   // Peripherals + RTC
                      [0x60000000, 0x60100000]],   // SPI peripherals
    },
    dma_safe_sections: [
      '.dram0.dma_reserved', '.noinit',
    ],
    cacheable_sections: [
      '.dram0.data', '.dram0.bss',
    ],
    periph_note: 'On ESP32: ensure the peripheral is powered in power management and the RCC gate is enabled.',
    // Disassembly note — objdump ISA works but instruction colours may differ
    isa_note: 'Xtensa instructions use registers a0–a15. Source interleaving works with -g.',
    ld_include_dirs: [],
  },

  'esp32-riscv': {
    label:       'ESP32 RISC-V (C3 / C6 / H2 / P4)',
    icon:        '🖥',
    badgeClass:  'esp-riscv',
    tools: {
      nm:      'riscv32-esp-elf-nm',
      re:      'riscv32-esp-elf-readelf',
      size:    'riscv32-esp-elf-size',
      a2l:     'riscv32-esp-elf-addr2line',
      objdump: 'riscv32-esp-elf-objdump',
    },
    prefixHint:  'C:\\Users\\<you>\\.espressif\\tools\\riscv32-esp-elf\\bin\\riscv32-esp-elf-',
    autoLabel:   'riscv32-esp-elf-{nm, readelf, size, addr2line, objdump}',
    isa:         'riscv32',
    memmap: {
      null_window:   0x100,
      // ESP32-C3/C6 memory layout
      flash_ranges:  [[0x42000000, 0x44000000]],   // IROM (XIP flash)
      sram_ranges:   [[0x3FC80000, 0x3FCE0000],    // Data SRAM
                      [0x4037C000, 0x403E0000]],   // Instruction SRAM
      periph_ranges: [[0x60000000, 0x70000000]],   // Peripheral space
    },
    dma_safe_sections: [
      '.dram0.dma_reserved', '.noinit',
    ],
    cacheable_sections: [
      '.dram0.data', '.dram0.bss',
    ],
    periph_note: 'On ESP32-C3/C6: check SYSTEM_PERIP_CLK_EN register and APB bus arbitration.',
    isa_note: 'RISC-V 32-bit (RV32IMC). Disassembly works; source interleaving with -g.',
ld_include_dirs: [],
  },

  'x86-64-linux': {
    label:      'x86-64 Linux (native / GCC / Clang)',
    icon:       '🐧',
    badgeClass: 'x86',
    tools: {
      nm:      'nm',        // Bare names — native tools on PATH, no prefix
      re:      'readelf',
      size:    'size',
      a2l:     'addr2line',
      objdump: 'objdump',
    },
    prefixHint:  '/usr/bin/  or  /usr/local/bin/',
    autoLabel:   '{nm, readelf, size, addr2line, objdump}  (system GCC tools)',
    isa:         'x86-64',
    // x86-64 Linux virtual address layout (typical; ASLR shifts base at runtime)
    memmap: {
      null_window:   0x1000,
      // For PIE executables the base may be 0; for non-PIE typically 0x400000
      flash_ranges:  [[0x400000, 0x7F0000000000]],   // code + rodata on disk
      sram_ranges:   [[0x7FFC00000000, 0x800000000000]], // stack/heap (approximate)
      periph_ranges: [],
    },
    dma_safe_sections: [],
    cacheable_sections: ['.data', '.bss', '.rodata'],
    periph_note: 'Linux userspace: use mmap/mprotect for memory-mapped regions.',
    isa_note: 'x86-64 System V ABI. objdump uses AT&T syntax by default; pass -M intel for Intel syntax.',
    ld_include_dirs: [],
    // x86-specific: whether to show C++ analysis tab automatically
    show_cpp: true,
    // Hint: native builds differ from cross-compiled — PIE, shared libs, ASLR
    native_note: 'Native Linux binary: addresses are virtual; PIE base = 0 until loaded; PLT/GOT present for shared libraries.',
  },

  'x86-32-linux': {
    label:      'x86 32-bit Linux (i386 / i686)',
    icon:       '🐧',
    badgeClass: 'x86',
    tools: { nm:'nm', re:'readelf', size:'size', a2l:'addr2line', objdump:'objdump' },
    prefixHint:  '/usr/bin/',
    autoLabel:   '{nm, readelf, size, addr2line, objdump}  (system tools, 32-bit)',
    isa:         'x86-32',
    memmap: {
      null_window:   0x1000,
      flash_ranges:  [[0x8048000, 0xC0000000]],
      sram_ranges:   [[0xC0000000, 0xFFFFFFFF]],
      periph_ranges: [],
    },
    dma_safe_sections: [],
    cacheable_sections: ['.data', '.bss'],
    periph_note: 'Linux 32-bit: kernel lives at 0xC0000000+.',
    isa_note:    'IA-32 (i386). 4-byte pointers. objdump uses AT&T syntax.',
    ld_include_dirs: [],
    show_cpp:    true,
    native_note: '32-bit Linux ELF. vtable entries are 4 bytes. Exception frames use DWARF2.',
  },
};

// ── State ─

// ── State ────────────────────────────────────────────────────────────────────

let _currentTarget = localStorage.getItem('lmv_target') || 'arm';
let _tcDetailOpen  = false;

// ── Initialise ───────────────────────────────────────────────────────────────

function initTargetSelector() {
  const saved = localStorage.getItem('lmv_target') || 'arm';
  const savedMode = localStorage.getItem('lmv_tc_mode') || 'path';
  const savedCustomPrefix = localStorage.getItem('lmv_tc_custom_prefix') || '';

  _currentTarget = saved;

  // Restore radio
  const radio = document.getElementById(savedMode === 'prefix' ? 'tc-prefix' : 'tc-path');
  if (radio) radio.checked = true;

  // Restore custom prefix
  const prefixEl = document.getElementById('t-prefix');
  if (prefixEl && savedCustomPrefix) prefixEl.value = savedCustomPrefix;

  // Apply profile (sets chip states, fills tool fields)
  applyTargetProfile(saved, false);
  applyToolchainMode(false);
}

// ── Target selection ─────────────────────────────────────────────────────────

function selectTarget(id) {
  if (!TARGET_PROFILES[id]) return;
  _currentTarget = id;
  localStorage.setItem('lmv_target', id);

  // Update chip states
  for (const tid of Object.keys(TARGET_PROFILES)) {
    const btn = document.getElementById('tgt-' + tid);
    if (btn) btn.classList.toggle('active', tid === id);
  }

  applyTargetProfile(id, true);
  applyToolchainMode(true);

  // Update header badge
  _updateTargetBadge(id);
}

function applyTargetProfile(id, withNotify) {
  const profile = TARGET_PROFILES[id];
  if (!profile) return;

  // Auto-label
  const autoLabel = document.getElementById('tc-auto-label');
  if (autoLabel) autoLabel.textContent = profile.autoLabel;

  // Prefix hint
  const hintEl = document.getElementById('tc-prefix-hint');
  if (hintEl) hintEl.textContent = profile.prefixHint;

  // ISA note in disassembly panel (if visible)
  const isaNote = document.getElementById('ai-isa-note');
  if (isaNote && profile.isa_note) {
    isaNote.textContent = profile.isa_note;
    isaNote.style.display = '';
  } else if (isaNote) {
    isaNote.style.display = 'none';
  }

  if (withNotify) {
    setStatus('Target: ' + profile.label, 0);
  }
}

// ── Toolchain mode radio ─────────────────────────────────────────────────────

function applyToolchainMode(save) {
  const prefixRadio = document.getElementById('tc-prefix');
  const isPrefix = prefixRadio && prefixRadio.checked;

  // Show/hide prefix input row
  const prefixRow = document.getElementById('tc-prefix-row');
  const autoRow   = document.getElementById('tc-auto-row');
  if (prefixRow) prefixRow.style.display = isPrefix ? '' : 'none';
  if (autoRow)   autoRow.style.display   = isPrefix ? 'none' : '';

  if (save !== false) {
    localStorage.setItem('lmv_tc_mode', isPrefix ? 'prefix' : 'path');
  }

  // Fill hidden tool fields
  _fillToolFields(isPrefix);
}

function applyPrefixToFields() {
  const pfx = (document.getElementById('t-prefix')?.value || '').trim();
  localStorage.setItem('lmv_tc_custom_prefix', pfx);
  _fillToolFields(true);
}

function _fillToolFields(useCustomPrefix) {
  const profile = TARGET_PROFILES[_currentTarget];
  if (!profile) return;

  // Priority 1: explicit prefix (Custom prefix mode)
  if (useCustomPrefix) {
    const prefix = (document.getElementById('t-prefix')?.value || '').trim();
    if (prefix) {
      const setP = (id, bare) => { const el=document.getElementById(id); if(el) el.value=prefix+bare; };
      setP('t-nm','nm'); setP('t-re','readelf'); setP('t-sz','size'); setP('t-a2l','addr2line'); setP('t-objdump','objdump');
      return;
    }
  }

  // Priority 2: PATH directory (On PATH mode with optional directory)
  // t-path-dir contains the directory; applyPathDir() also mirrors it into t-prefix,
  // but we read t-path-dir directly so this works even when tc-path radio is active.
  const rawDir = (document.getElementById('t-path-dir')?.value || '').trim();
  if (rawDir) {
    // Normalise: ensure trailing separator
    const sep = rawDir.includes('/') && !rawDir.includes('\\') ? '/' : '\\';
    const dir = (rawDir.endsWith('/') || rawDir.endsWith('\\')) ? rawDir : rawDir + sep;
    // Extract the basename from the profile's full tool name (strips any existing dir prefix)
    const base = (full) => (full||'').split(/[\/]/).pop() || full;
    const setD = (id, profileKey) => {
      const el = document.getElementById(id);
      if (el) el.value = dir + base(profile.tools[profileKey] || profileKey);
    };
    setD('t-nm','nm'); setD('t-re','re'); setD('t-sz','size'); setD('t-a2l','a2l'); setD('t-objdump','objdump');
    // Also update t-prefix so _getToolsForCurrentTarget objdump path is correct
    const prefEl = document.getElementById('t-prefix');
    if (prefEl) prefEl.value = dir;
    return;
  }

  // Priority 3: bare profile defaults (no directory, no prefix)
  const set = (id, val) => { const el=document.getElementById(id); if(el) el.value=val; };
  set('t-nm', profile.tools.nm); set('t-re', profile.tools.re);
  set('t-sz', profile.tools.size); set('t-a2l', profile.tools.a2l);
  set('t-objdump', profile.tools.objdump);
  // Clear t-prefix so objdump doesn't accidentally pick up a stale directory
  const prefEl = document.getElementById('t-prefix');
  if (prefEl && !useCustomPrefix) prefEl.value = '';
}

// ── Expand/collapse individual tool fields ───────────────────────────────────

function toggleToolDetail() {
  _tcDetailOpen = !_tcDetailOpen;
  const detail = document.getElementById('tc-fields-detail');
  const lbl    = document.getElementById('tc-detail-label');
  if (detail) detail.style.display = _tcDetailOpen ? '' : 'none';
  if (lbl)    lbl.textContent = _tcDetailOpen
    ? '▾ Hide individual tools' : '▸ Show individual tools';
}

// ── Header badge ─────────────────────────────────────────────────────────────

function _updateTargetBadge(id) {
  const profile = TARGET_PROFILES[id];
  let badge = document.getElementById('tgt-header-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'tgt-header-badge';
    badge.className = 'chip tgt-badge';
    // Insert after the first chip in the header
    const header = document.querySelector('header');
    const firstChip = header?.querySelector('.chip');
    if (firstChip && firstChip.nextSibling) {
      header.insertBefore(badge, firstChip.nextSibling);
    } else if (header) {
      header.appendChild(badge);
    }
  }
  if (profile) {
    badge.className = 'chip tgt-badge ' + profile.badgeClass;
    badge.textContent = profile.icon + ' ' + profile.label;
  }
}

// ── Get current target profile (used by all analysis calls) ─────────────────

function getTargetProfile() {
  return TARGET_PROFILES[_currentTarget] || TARGET_PROFILES['arm'];
}

/**
 * Returns the target JSON string to append to every FormData POST.
 * Includes ISA tag, memory map constants, DMA-safe/cacheable section lists,
 * and the current toolchain prefix mode so the server can log it.
 */
function getTargetJson() {
  const profile = getTargetProfile();
  return JSON.stringify({
    id:                _currentTarget,
    isa:               profile.isa,
    memmap:            profile.memmap,
    dma_safe_sections: profile.dma_safe_sections,
    cacheable_sections:profile.cacheable_sections,
    periph_note:       profile.periph_note || '',
    isa_note:          profile.isa_note || '',
  });
}

// ── Patch getObjdumpTool to use target profile ───────────────────────────────
// fetchDisassembly reads tools.objdump — ensure it uses the right binary

/**
 * Return the tools dict to send to every server route.
 *
 * Priority (same logic as Python resolve_tools):
 *   1. Individual tool field value (from hidden #t-nm, #t-re etc.)
 *      — populated by _fillToolFields() whenever target or mode changes
 *   2. prefix + basename (when Custom prefix mode is active)
 *   3. Profile default bare name (when PATH mode is active)
 *
 * The "arm-none-eabi-" string ONLY appears here if the selected target
 * profile contains it (ARM Cortex-M). Never hardcoded as a fallback.
 */
function _getToolsForCurrentTarget() {
  const profile = getTargetProfile();
  const isPrefix = document.getElementById('tc-prefix')?.checked;
  const pfx = (document.getElementById('t-prefix')?.value || '').trim();

  // Derive the tool name for a given basename.
  // Reads the hidden field first (set by _fillToolFields); falls back to
  // prefix+bare or profile default — never to a hardcoded arm-none-eabi-.
  const toolVal = (fieldId, bare, profileKey) => {
    const fieldVal = (document.getElementById(fieldId)?.value || '').trim();
    if (fieldVal) return fieldVal;                          // explicit field
    if (isPrefix && pfx) return pfx + bare;                // prefix mode
    return profile.tools[profileKey] || bare;              // profile default or bare
  };

  // objdump: read hidden field first (set by _fillToolFields — same path as other tools)
  const objdump = (document.getElementById('t-objdump')?.value || '').trim()
    || profile.tools.objdump || 'objdump';

  return {
    nm:      toolVal('t-nm',  'nm',       'nm'),
    re:      toolVal('t-re',  'readelf',  're'),
    size:    toolVal('t-sz',  'size',     'size'),
    a2l:     toolVal('t-a2l', 'addr2line','a2l'),
    objdump,
    prefix:  pfx,
  };
}

// =============================================================================
// THEME SYSTEM (Light / Dark)
// =============================================================================

function toggleTheme() {
  const isLight = document.documentElement.classList.toggle('light');
  localStorage.setItem('lmv_theme', isLight ? 'light' : 'dark');
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = isLight ? '🌙' : '☀';
}

function initTheme() {
  const saved = localStorage.getItem('lmv_theme') || 'dark';
  if (saved === 'light') {
    document.documentElement.classList.add('light');
    const btn = document.getElementById('theme-btn');
    if (btn) btn.textContent = '🌙';
  }
}

// =============================================================================
// SETTINGS PANEL PERSISTENCE
// Remembers open/closed state; auto-closes when all 3 files are loaded
// =============================================================================

const _SETTINGS_KEY = 'lmv_settings_open';

function initSettingsState() {
  // Default: open on first visit (so user sees the target/toolchain config)
  const saved = localStorage.getItem(_SETTINGS_KEY);
  const shouldOpen = saved === null ? true : saved === '1';
  if (shouldOpen) {
    const panel = document.getElementById('settings-panel');
    if (panel) panel.classList.add('open');
    _updateSettingsToggle(true);
  }
}

function toggleSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  if (!panel) return;
  const isOpen = panel.classList.toggle('open');
  localStorage.setItem(_SETTINGS_KEY, isOpen ? '1' : '0');
  _updateSettingsToggle(isOpen);
}

function openSettingsPanel() {
  const panel = document.getElementById('settings-panel');
  if (!panel) return;
  panel.classList.add('open');
  localStorage.setItem(_SETTINGS_KEY, '1');
  _updateSettingsToggle(true);
}

function _updateSettingsToggle(isOpen) {
  const btn = document.getElementById('settings-toggle-btn');
  if (btn) {
    btn.classList.toggle('act', isOpen);
    btn.title = isOpen ? 'Hide settings' : 'Show target & toolchain settings';
  }
}

/** Called whenever a file is loaded. Auto-closes settings when all 3 are loaded. */
function _checkAutoCloseSettings() {
  const autoClose = localStorage.getItem('lmv_settings_autoclose') !== '0';
  if (!autoClose) return;
  const hasLd  = !!S?.ld;
  const hasElf = !!(S?.syms?.length) || !!(S?.syms?.some && S.syms.some(s => s._from_map));
  const hasMap = !!S?.mapData;
  // Close when: (LD + ELF) or (LD + MAP) or all three — don't require all 3
  if (hasLd && (hasElf || hasMap)) {
    const panel = document.getElementById('settings-panel');
    if (panel && panel.classList.contains('open')) {
      panel.classList.remove('open');
      localStorage.setItem(_SETTINGS_KEY, '0');
      _updateSettingsToggle(false);
    }
  }
}

// =============================================================================
// PATH DIRECTORY SUPPORT
// Lets "On PATH" users specify a directory where the toolchain binaries live
// without requiring a full prefix (handles both with and without trailing slash).
// =============================================================================

function applyPathDir() {
  const dirEl = document.getElementById('t-path-dir');
  const dir   = (dirEl?.value || '').trim();
  localStorage.setItem('lmv_path_dir', dir);
  // Update t-prefix hidden field so _getToolsForCurrentTarget picks it up:
  // We set the prefix to the directory + OS separator if it looks like a path
  // but has no toolchain triplet. This makes the server use dir+basename.
  const prefEl = document.getElementById('t-prefix');
  if (prefEl) {
    if (dir) {
      // Add trailing separator if missing so normalizePrefix treats it as a dir
      const sep = (dir.includes('/') && !dir.includes('\\')) ? '/' : '\\';
      prefEl.value = dir.endsWith('/') || dir.endsWith('\\') ? dir : dir + sep;
    } else {
      prefEl.value = '';
    }
  }
  _fillToolFields(!!dir);
}

function initPathDir() {
  // Do NOT restore t-path-dir from localStorage.
  // The user must explicitly type it each session or load a project file.
  // (applyPathDir() still saves it — so loadProject() can restore it deliberately.)
}

// =============================================================================
// RESOURCE MONITOR
// Polls /resource_stats every second and renders a mini sparkline chart.
// Detects: memory leaks (steadily rising RSS), CPU spikes, GC pressure.
// =============================================================================

const _RES = {
  timer:    null,
  interval: 1000,         // poll interval ms
  history:  [],           // [{ts, rss, cpu}]
  maxPts:   120,          // keep 2 minutes of data
  peak:     { rss: 0, cpu: 0 },
  open:     false,
};

function toggleResMonitor() {
  const body = document.getElementById('res-body');
  const icon = document.getElementById('res-toggle-icon');
  _RES.open = !_RES.open;
  if (body) body.style.display = _RES.open ? '' : 'none';
  if (icon) icon.textContent   = _RES.open ? '▾' : '▸';
  if (_RES.open && !_RES.timer) startResMonitor();
}

function startResMonitor() {
  if (_RES.timer) return;
  const startBtn = document.getElementById('res-start-btn');
  const stopBtn  = document.getElementById('res-stop-btn');
  if (startBtn) { startBtn.disabled = true;  startBtn.style.opacity = '0.5'; }
  if (stopBtn)  { stopBtn.disabled  = false; stopBtn.style.opacity  = '1'; }
  _pollResStats();
  _RES.timer = setInterval(_pollResStats, _RES.interval);
}

function stopResMonitor() {
  if (_RES.timer) { clearInterval(_RES.timer); _RES.timer = null; }
  const startBtn = document.getElementById('res-start-btn');
  const stopBtn  = document.getElementById('res-stop-btn');
  if (startBtn) { startBtn.disabled = false; startBtn.style.opacity = '1'; }
  if (stopBtn)  { stopBtn.disabled  = true;  stopBtn.style.opacity  = '0.5'; }
}

async function _pollResStats() {
  try {
    const res = await fetch('/resource_stats', { cache: 'no-store' });
    const d   = await res.json();
    if (d.error) { _resSetStatus('⚠ ' + d.error); return; }

    const ts  = Date.now();
    _RES.history.push({ ts, rss: d.rss_bytes, cpu: d.cpu_pct });
    if (_RES.history.length > _RES.maxPts) _RES.history.shift();
    _RES.peak.rss = Math.max(_RES.peak.rss, d.rss_bytes);
    _RES.peak.cpu = Math.max(_RES.peak.cpu, d.cpu_pct);

    _renderResStats(d);
    _renderResChart();
    _detectResIssues(d);
  } catch (e) {
    _resSetStatus('⚠ Cannot reach server');
  }
}

function _renderResStats(d) {
  const el = document.getElementById('res-grid');
  if (!el) return;
  const mb  = (b) => (b / 1048576).toFixed(1) + ' MB';
  const pct = (n) => n.toFixed(1) + '%';
  const leak = _detectLeak() ? ' <span style="color:var(--red)">↑ leak?</span>' : '';

  el.innerHTML = `
    <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:4px;padding:5px 7px">
      <div style="font-size:9px;color:var(--dim);margin-bottom:1px">RSS</div>
      <div style="font-size:12px;font-weight:600;color:var(--acc)">${mb(d.rss_bytes)}${leak}</div>
    </div>
    <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:4px;padding:5px 7px">
      <div style="font-size:9px;color:var(--dim);margin-bottom:1px">CPU</div>
      <div style="font-size:12px;font-weight:600;color:${d.cpu_pct>50?'var(--red)':d.cpu_pct>20?'var(--ora)':'var(--grn)'}">${pct(d.cpu_pct)}</div>
    </div>
    <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:4px;padding:5px 7px">
      <div style="font-size:9px;color:var(--dim);margin-bottom:1px">Threads</div>
      <div style="font-size:12px;color:var(--txt)">${d.threads}</div>
    </div>
    <div style="background:var(--s2);border:1px solid var(--bdr);border-radius:4px;padding:5px 7px">
      <div style="font-size:9px;color:var(--dim);margin-bottom:1px">Uptime</div>
      <div style="font-size:12px;color:var(--dim)">${_fmtUptime(d.uptime_s)}</div>
    </div>`;

  // GC info
  const gcEl = document.getElementById('res-gc');
  if (gcEl && d.gc_counts) {
    const [g0,g1,g2] = d.gc_counts;
    gcEl.innerHTML = `GC gen0=${g0} gen1=${g1} gen2=${g2}`
      + (g2 > 50 ? ' <span style="color:var(--ora)">⚠ gen2 high</span>' : '');
  }
}

function _renderResChart() {
  const canvas = document.getElementById('res-chart');
  if (!canvas || !_RES.history.length) return;
  canvas.width = canvas.offsetWidth || 220;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const pts = _RES.history;
  const maxRss = Math.max(...pts.map(p => p.rss), 1);

  // RAM line (blue)
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(88,166,255,0.8)';
  ctx.lineWidth = 1.5;
  pts.forEach((p, i) => {
    const x = (i / (pts.length - 1 || 1)) * W;
    const y = H - (p.rss / maxRss) * (H - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // CPU line (green)
  ctx.beginPath();
  ctx.strokeStyle = 'rgba(63,185,80,0.8)';
  ctx.lineWidth = 1.5;
  pts.forEach((p, i) => {
    const x = (i / (pts.length - 1 || 1)) * W;
    const y = H - (p.cpu / 100) * (H - 4) - 2;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/** Return true if RSS has risen > 15% over the last 60 samples. */
function _detectLeak() {
  if (_RES.history.length < 30) return false;
  const recent = _RES.history.slice(-30);
  const first = recent[0].rss, last = recent[recent.length - 1].rss;
  return (last - first) / first > 0.15;
}

function _detectResIssues(d) {
  const issues = [];
  if (_detectLeak())    issues.push('⬆ RSS rising — possible memory leak');
  if (d.cpu_pct > 80)  issues.push('🔥 CPU > 80%');
  if (d.threads > 20)  issues.push('⚠ High thread count: ' + d.threads);
  const gcEl = document.getElementById('res-gc');
  if (gcEl && issues.length) {
    const extra = document.getElementById('res-issues') ||
      Object.assign(document.createElement('div'), {id:'res-issues',
        style:'font-size:10px;color:var(--red);margin-top:4px'});
    extra.textContent = issues.join(' · ');
    gcEl.parentNode?.insertBefore(extra, gcEl.nextSibling);
  }
}

function _resSetStatus(msg) {
  const el = document.getElementById('res-grid');
  if (el) el.innerHTML = `<div style="grid-column:1/-1;color:var(--dim);font-size:11px">${msg}</div>`;
}

function _fmtUptime(s) {
  if (s < 60)   return Math.round(s) + 's';
  if (s < 3600) return Math.floor(s/60) + 'm ' + Math.round(s%60) + 's';
  return Math.floor(s/3600) + 'h ' + Math.floor((s%3600)/60) + 'm';
}


// TAB NAVIGATION: removed at user request
function initTabNav() {}  // stub so boot script still works


// =============================================================================
// RESET FILTER FUNCTIONS
// =============================================================================

function resetSymFilters() {
  ['sym-q','sym-t','sym-s','sym-f','sym-g'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  filterSyms();
}

function resetMapFilters() {
  ['map2-q','map2-lib'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  filterMapFiles();
}

function resetStackFilters() {
  ['stack-q','stack-type'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  filterStack();
}

// =============================================================================
// PROJECT SAVE / LOAD / SHARE
// Persists: target, toolchain settings, file paths, theme, features
// Does NOT store file binary data — only paths so server can re-read them
// =============================================================================

const _PROJ_VERSION = '1.0';
const _PROJ_STORAGE_KEY = 'lmv_saved_project';

function _gatherProjectData() {
  return {
    version:    _PROJ_VERSION,
    savedAt:    new Date().toISOString(),
    target:     localStorage.getItem('lmv_target') || 'arm',
    tc_mode:    localStorage.getItem('lmv_tc_mode') || 'path',
    tc_prefix:  (document.getElementById('t-prefix')?.value || '').trim(),
    tc_path_dir:(document.getElementById('t-path-dir')?.value || '').trim(),
    theme:      localStorage.getItem('lmv_theme') || 'dark',
    features:   localStorage.getItem('lmv_features') || '',
    settings_open: localStorage.getItem('lmv_settings_open') || '1',
    // File paths last used (server-side paths the user dropped)
    last_files: {
      ld:  document.getElementById('ld-name')?.textContent || '',
      elf: document.getElementById('elf-name')?.textContent || '',
      map: document.getElementById('map-name')?.textContent || '',
    },
    // Note for the user
    note: 'Linker MemMap Viewer project file. File binary data is not stored; re-drop files to reload.'
  };
}

function saveProject() {
  const data = _gatherProjectData();
  const json = JSON.stringify(data, null, 2);
  // Save to localStorage for auto-restore on next load
  localStorage.setItem(_PROJ_STORAGE_KEY, json);
  // Also trigger a download
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'linker-memmap.lmvproj';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('✓ Project saved', 2000);
}

function loadProjectFile() {
  document.getElementById('project-fi')?.click();
}

function onProjectFileLoad(input) {
  const file = input.files[0];
  if (!file) return;
  const fr = new FileReader();
  fr.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      _applyProject(data);
    } catch (err) {
      alert('Invalid project file: ' + err.message);
    }
  };
  fr.readAsText(file);
  input.value = '';
}

function _applyProject(data) {
  if (!data || data.version !== _PROJ_VERSION) {
    if (!confirm('Project file version mismatch. Try to load anyway?')) return;
  }
  // Apply target
  if (data.target) selectTarget(data.target);
  // Apply toolchain
  if (data.tc_mode) {
    const radio = document.getElementById(data.tc_mode === 'prefix' ? 'tc-prefix' : 'tc-path');
    if (radio) { radio.checked = true; applyToolchainMode(); }
  }
  if (data.tc_prefix) {
    const el = document.getElementById('t-prefix');
    if (el) { el.value = data.tc_prefix; applyPrefixToFields(); }
  }
  if (data.tc_path_dir) {
    const el = document.getElementById('t-path-dir');
    if (el) { el.value = data.tc_path_dir; applyPathDir(); }
  }
  // Apply theme
  if (data.theme) {
    const isLight = data.theme === 'light';
    document.documentElement.classList.toggle('light', isLight);
    localStorage.setItem('lmv_theme', data.theme);
    const btn = document.getElementById('theme-btn');
    if (btn) btn.textContent = isLight ? '🌙' : '☀';
  }
  // Apply features
  if (data.features) {
    localStorage.setItem('lmv_features', data.features);
    loadFeatureState();
    buildFeaturesPanel();
  }
  localStorage.setItem(_PROJ_STORAGE_KEY, JSON.stringify(data));
  setStatus('✓ Project loaded', 2000);
}

function exportBundle() {
  const data = _gatherProjectData();
  data._export_note = 'Share this file with teammates using the same project. ' +
    'They must have the same source files at the same paths, or re-drop them.';
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'linker-memmap-bundle.lmvproj';
  a.click();
  URL.revokeObjectURL(url);
  setStatus('✓ Bundle exported', 2000);
}

// =============================================================================
// STARTUP DIALOG — offer to restore last project
// =============================================================================

function checkStartupProject() {
  const saved = localStorage.getItem(_PROJ_STORAGE_KEY);
  if (!saved) return;   // No saved project, skip dialog
  try {
    const data = JSON.parse(saved);
    const overlay = document.getElementById('startup-overlay');
    const meta    = document.getElementById('startup-meta');
    const nameEl  = document.getElementById('startup-project-name');
    if (!overlay) return;
    const dt = new Date(data.savedAt).toLocaleString();
    if (nameEl) nameEl.textContent = 'A saved project was found from ' + dt;
    if (meta) {
      const files = data.last_files || {};
      meta.innerHTML = [
        files.ld  ? '📋 LD:  ' + files.ld  : '',
        files.elf ? '⚙ ELF: ' + files.elf : '',
        files.map ? '🗺 MAP: ' + files.map : '',
        '🎯 Target: ' + (data.target || 'arm').toUpperCase(),
        '🔧 Toolchain: ' + (data.tc_path_dir || data.tc_prefix || 'default'),
      ].filter(Boolean).map(l => `<div>${l}</div>`).join('');
    }
    // Store for the load handler
    overlay._projectData = data;
    overlay.style.display = 'flex';
  } catch (e) { /* corrupt saved data, skip */ }
}

function startupLoadProject() {
  const overlay = document.getElementById('startup-overlay');
  if (overlay?._projectData) _applyProject(overlay._projectData);
  if (overlay) overlay.style.display = 'none';
}

function startupFresh() {
  const overlay = document.getElementById('startup-overlay');
  if (overlay) overlay.style.display = 'none';
  // Don't delete saved project — user can load it again from the panel
}

// Helper to show brief status messages
function setStatus(msg, durationMs) {
  const el = document.getElementById('tool-status');
  if (!el) return;
  const prev = el.textContent;
  el.textContent = msg;
  if (durationMs) setTimeout(() => { if (el.textContent === msg) el.textContent = prev; }, durationMs);
}


// =============================================================================
// SHOW DEBUG TAB DIRECTLY (accessible from welcome screen)
// =============================================================================
function showDebugDirect() {
  const app     = document.getElementById('app');
  const welcome = document.getElementById('welcome');
  if (app)     app.style.display     = '';
  if (welcome) welcome.style.display = 'none';
  switchTab('dbg');
  diagLog('ui', 'Debug console opened from welcome screen');
}

// =============================================================================
// DIAGNOSTIC LOG (Issue 8)
// Logs all file loads, analysis calls, errors — never navigation unless verbose
// =============================================================================

const _DIAG = {
  entries: [],
  verbose: false,
  maxEntries: 500,
};

function diagSetVerbose(v) {
  _DIAG.verbose = !!v;
  diagLog('system', 'Verbose mode ' + (v ? 'ON' : 'OFF'));
}

/**
 * Log an event.
 * @param {string} category  'file'|'analysis'|'error'|'system'|'nav'|'ui'
 * @param {string} message
 * @param {object} [detail]  optional key-value object for additional info
 */
function diagLog(category, message, detail) {
  if (category === 'nav' && !_DIAG.verbose) return;
  const ts   = new Date().toISOString().split('T')[1].replace('Z','');
  const icon = { file:'📂', analysis:'🔬', error:'❌', system:'ℹ', nav:'🧭', ui:'🖱' }[category] || 'ℹ';
  let line = `[${ts}] ${icon} ${message}`;
  if (detail && typeof detail === 'object') {
    const pairs = Object.entries(detail)
      .filter(([k,v]) => v !== undefined && v !== null && v !== '')
      .map(([k,v]) => `${k}=${JSON.stringify(v)}`)
      .join('  ');
    if (pairs) line += '\n           ' + pairs;
  }
  _DIAG.entries.push(line);
  if (_DIAG.entries.length > _DIAG.maxEntries) _DIAG.entries.shift();
  _renderDiagLog();
}

function _renderDiagLog() {
  const el = document.getElementById('diag-log-out');
  if (!el) return;
  el.textContent = _DIAG.entries.join('\n');
  el.scrollTop = el.scrollHeight;
}

function clearDiagLog() {
  _DIAG.entries = ['[cleared ' + new Date().toLocaleTimeString() + ']'];
  _renderDiagLog();
}

function copyDiagLog() {
  navigator.clipboard?.writeText(_DIAG.entries.join('\n'))
    .then(() => diagLog('system', 'Log copied to clipboard'))
    .catch(() => diagLog('error', 'Clipboard copy failed'));
}

// Stack setup toggle
function toggleStackSetup() {
  const body   = document.getElementById('stack-setup-body');
  const toggle = document.getElementById('stack-setup-toggle');
  if (!body) return;
  const open = body.style.display === 'none' || !body.style.display;
  body.style.display   = open ? '' : 'none';
  if (toggle) toggle.textContent = open ? '▾ Hide flags' : '▸ Show flags';
}

// Auto-collapse stack setup when .su files are loaded
function collapseStackSetup() {
  const body   = document.getElementById('stack-setup-body');
  const toggle = document.getElementById('stack-setup-toggle');
  if (body)   body.style.display = 'none';
  if (toggle) toggle.textContent = '▸ Show flags';
}

// =============================================================================
// C++ ARTIFACT TAB  (tab id: "cpp")
// =============================================================================

let _cppData = null;   // cached result from /parse_cpp

async function runCppAnalysis() {
  if (!S.elfFile) {
    diagLog('error', 'C++ analysis: no ELF file loaded');
    return;
  }
  const btn = document.getElementById('cpp-analyse-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analysing…'; }
  diagLog('analysis', 'C++ analysis started');

  try {
    const tools   = _getToolsForCurrentTarget();
    const profile = getTargetProfile();
    const fd      = new FormData();
    fd.append('elf',         S.elfFile);
    fd.append('tools_json',  JSON.stringify(tools));
    fd.append('target',      getTargetJson());
    // Pass already-parsed symbols to avoid re-running nm
    if (S.syms && S.syms.length) {
      fd.append('symbols_json', JSON.stringify(
        S.syms.map(s => ({name:s.name,addr:s.addr,size:s.size,type:s.type,section:s.section}))
      ));
    }
    // Pass LD sections for exception/dynamic analysis
    if (S.ld && S.ld.sections) {
      fd.append('sections_json', JSON.stringify(S.ld.sections.map(s => ({name:s.name,size:s.size||0}))));
    }

    const res = await fetch('/parse_cpp', { method: 'POST', body: fd });
    const d   = await res.json();

    if (d.error) {
      diagLog('error', 'C++ analysis failed: ' + d.error);
      const out = document.getElementById('cpp-error');
      if (out) { out.style.display = ''; out.textContent = '❌ ' + d.error; }
      return;
    }

    _cppData = d;
    diagLog('analysis', 'C++ analysis complete', {
      is_cpp: d.is_cpp, classes: d.summary?.class_count,
      mangled: d.summary?.mangled_count, templates: d.summary?.template_instantiations,
      exception_bytes: d.summary?.exception_bytes, plt_imports: d.summary?.plt_imports,
    });

    // Merge demangled names into S.syms so the Symbols tab shows readable
    // C++ names (e.g. "Circle::Circle(double)" instead of "_ZN6CircleC1Ed").
    // The mangled name is kept as the row tooltip. Re-render if symbols
    // were already on screen so the change is visible immediately.
    if (d.is_cpp && d.demangled && S.syms && S.syms.length) {
      let merged = 0;
      S.syms.forEach(s => {
        if (d.demangled[s.name] && d.demangled[s.name] !== s.name) {
          s.demangled = d.demangled[s.name];
          merged++;
        }
      });
      diagLog('analysis', `Demangled names merged into Symbols tab: ${merged} symbols`);
      if (typeof sortAndRenderSyms === 'function' && document.getElementById('sym-body')) {
        sortAndRenderSyms();
      }
    }

    renderCppTab(d);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '▶ Analyse C++'; }
  }
}

function renderCppTab(d) {
  const err = document.getElementById('cpp-error');
  if (err) err.style.display = 'none';

  if (!d || !d.is_cpp) {
    const empty = document.getElementById('cpp-empty');
    if (empty) {
      empty.style.display = '';
      empty.innerHTML = '<div class="eico">🔤</div><h3>No C++ symbols found</h3>'
        + '<p>Binary appears to be pure C, or symbols are stripped.<br>'
        + 'Rebuild with <code>g++</code> and without <code>-s</code>.</p>';
    }
    return;
  }
  const empty = document.getElementById('cpp-empty');
  if (empty) empty.style.display = 'none';

  const content = document.getElementById('cpp-content');
  if (content) content.style.display = '';

  _renderCppSummary(d);
  _renderVtableTab(d);
  _renderTemplatesTab(d);
  _renderExceptionsTab(d);
  _renderDynamicTab(d);
  _renderInitOrderTab(d);
}

function _renderCppSummary(d) {
  const el = document.getElementById('cpp-stats');
  if (!el) return;
  const s = d.summary || {};
  const isNative = _currentTarget.startsWith('x86');
  const profile  = getTargetProfile();
  el.innerHTML = `
    <div class="stat"><div class="snum">${s.class_count||0}</div><div class="slbl">Polymorphic classes</div></div>
    <div class="stat"><div class="snum">${s.mangled_count||0}</div><div class="slbl">C++ symbols</div></div>
    <div class="stat"><div class="snum" style="color:var(--ora)">${s.template_instantiations||0}</div><div class="slbl">Template instantiations</div></div>
    <div class="stat"><div class="snum" style="color:var(--pur)">${fz(s.exception_bytes||0)}</div><div class="slbl">Exception overhead</div></div>
    <div class="stat"><div class="snum" style="color:var(--grn)">${s.ctor_count||0} / ${s.dtor_count||0}</div><div class="slbl">Ctors / Dtors</div></div>
    ${isNative ? `<div class="stat"><div class="snum" style="color:var(--acc)">${s.plt_imports||0}</div><div class="slbl">PLT imports (dyn. libs)</div></div>` : ''}
  `;
  const noteEl = document.getElementById('cpp-native-note');
  if (noteEl && profile.native_note) {
    noteEl.style.display = isNative ? '' : 'none';
    noteEl.textContent = '💡 ' + profile.native_note;
  }
}

function _renderVtableTab(d) {
  const el = document.getElementById('cpp-vtable-body');
  if (!el) return;
  const classes = d.vtables?.classes || [];
  if (!classes.length) { el.innerHTML = '<tr><td colspan="5" style="color:var(--dim)">No vtables found</td></tr>'; return; }
  const is64 = _currentTarget === 'x86-64-linux' || _currentTarget === 'esp32-xtensa';
  const ptrSize = is64 ? 8 : 4;

  el.innerHTML = classes.map(c => {
    const slots = c.vtable_size > 0
      ? Math.max(0, Math.round((c.vtable_size - 2 * ptrSize) / ptrSize))
      : '?';
    const note = c.has_typeinfo
      ? `<span style="color:var(--grn);font-size:10px">✓ RTTI</span>`
      : `<span style="color:var(--dim);font-size:10px">no RTTI</span>`;
    return `<tr>
      <td style="color:var(--txt);font-weight:500">${c.name}</td>
      <td><code style="font-size:10px">${c.vtable_sym||'—'}</code></td>
      <td style="color:var(--acc)">${c.vtable_size ? fz(c.vtable_size) : '—'}</td>
      <td style="color:var(--ora)">${slots}</td>
      <td>${note}</td>
    </tr>`;
  }).join('');
}

function _renderTemplatesTab(d) {
  const el = document.getElementById('cpp-tmpl-body');
  if (!el) return;
  const tmpls = d.templates || [];
  if (!tmpls.length) { el.innerHTML = '<tr><td colspan="4" style="color:var(--dim)">No template instantiations found</td></tr>'; return; }
  el.innerHTML = tmpls.map(t => `
    <tr onclick="toggleTemplateExpand(this)" style="cursor:pointer">
      <td style="color:var(--acc);font-weight:500">${t.template}</td>
      <td style="color:var(--txt)">${t.count}</td>
      <td style="color:var(--ora)">${fz(t.total_size)}</td>
      <td style="color:var(--dim);font-size:10px">${(t.instantiations||[]).slice(0,3).map(i=>i.demangled.split('<').slice(0,2).join('<')+'…').join('<br>')}</td>
    </tr>
  `).join('');
}

function toggleTemplateExpand(row) {
  const next = row.nextElementSibling;
  if (next && next.classList.contains('tmpl-expand')) { next.remove(); return; }
  // Find the template data
  const name = row.cells[0]?.textContent;
  const tmpl = (_cppData?.templates||[]).find(t=>t.template===name);
  if (!tmpl) return;
  const detail = document.createElement('tr');
  detail.className = 'tmpl-expand';
  detail.innerHTML = `<td colspan="4" style="padding:8px 16px;background:var(--s2)">
    <div style="font-size:11px;color:var(--dim);margin-bottom:6px">All instantiations of <strong style="color:var(--txt)">${name}</strong>:</div>
    <div style="display:flex;flex-direction:column;gap:3px">
    ${tmpl.instantiations.map(i=>`<div style="display:flex;justify-content:space-between;font-size:11px">
      <span style="color:var(--txt)">${i.demangled}</span>
      <span style="color:var(--acc);margin-left:12px">${fz(i.size)}</span>
    </div>`).join('')}
    </div></td>`;
  row.after(detail);
}

function _renderExceptionsTab(d) {
  const el = document.getElementById('cpp-exc-body');
  if (!el) return;
  const exc = d.exceptions || {};
  const secs = exc.sections || [];
  if (!secs.length) { el.innerHTML = '<tr><td colspan="3" style="color:var(--dim)">No exception sections found (possibly built with -fno-exceptions)</td></tr>'; return; }
  el.innerHTML = secs.map(s => `
    <tr>
      <td><code style="color:var(--acc)">${s.name}</code></td>
      <td style="color:var(--ora)">${fz(s.size)}</td>
      <td style="color:var(--dim);font-size:11px">${s.note||''}</td>
    </tr>
  `).join('');
  const note = document.getElementById('cpp-exc-note');
  if (note) note.textContent = exc.note || '';
}

function _renderDynamicTab(d) {
  const wrap = document.getElementById('cpp-dynamic-wrap');
  if (!wrap) return;
  const dyn = d.dynamic || {};
  if (!dyn.is_dynamic) {
    wrap.innerHTML = `<div style="padding:14px;color:var(--grn);font-size:12px">
      ✓ Static binary — no PLT/GOT. All library code is included directly in the binary.
      <br><span style="color:var(--dim);font-size:11px">Cross-compiled firmware typically uses this model.</span>
    </div>`;
    return;
  }
  const secs = dyn.sections || [];
  wrap.innerHTML = `
    <div style="padding:8px 14px;font-size:11px;color:var(--ora);border-bottom:1px solid var(--bdr)">
      📦 ${dyn.note}
    </div>
    <div style="padding:8px 14px;font-size:11px;color:var(--dim)">
      <strong style="color:var(--txt)">Key concept:</strong> When your Linux binary calls printf() or std::cout, 
      the call goes through the PLT (one 16-byte stub). The PLT stub jumps through the GOT, which initially 
      points to the dynamic linker. On the first call, ld.so resolves the address and patches the GOT entry 
      (lazy binding). Subsequent calls go directly to the function. This is invisible at runtime but adds 
      latency to first calls.
    </div>
    <table style="width:100%"><thead><tr>
      <th>Section</th><th>Size</th><th>Purpose</th>
    </tr></thead><tbody>
    ${secs.map(s=>`<tr>
      <td><code style="color:var(--acc)">${s.name}</code> <span style="color:var(--dim);font-size:9px">${s.tag||''}</span></td>
      <td style="color:var(--ora)">${fz(s.size)}</td>
      <td style="color:var(--dim);font-size:11px">${s.note||''}</td>
    </tr>`).join('')}
    </tbody></table>`;
}

function _renderInitOrderTab(d) {
  const el = document.getElementById('cpp-init-body');
  if (!el) return;
  const init = d.init_order || {};
  const inits = init.init_syms || [];
  const finis = init.fini_syms || [];

  const renderList = (syms, label) => {
    if (!syms.length) return `<div style="color:var(--dim);font-size:11px;padding:6px 0">No ${label} found</div>`;
    return `<div style="font-size:11px;color:var(--dim);margin-bottom:4px">${label} (in call order):</div>`
      + syms.map((s,i) => `<div style="display:flex;align-items:baseline;gap:8px;padding:3px 0;border-bottom:1px solid var(--bdr)">
        <span style="color:var(--dim2);min-width:22px;font-size:10px">${i+1}.</span>
        <span style="color:var(--txt);font-size:11px;flex:1">${s.demangled||s.name}</span>
        <span style="color:var(--acc);font-size:10px">${fz(s.size)}</span>
        <span style="color:var(--dim2);font-size:10px">${s.section||''}</span>
        ${s.note?`<span style="color:var(--dim2);font-size:9px">${s.note}</span>`:''}
      </div>`).join('');
  };

  el.innerHTML = `
    <div style="padding:8px 14px;font-size:11px;color:var(--dim);border-bottom:1px solid var(--bdr)">
      ${init.note || ''}
      <br><strong style="color:var(--txt)">Key concept:</strong> Global C++ objects run their constructors 
      before main() in link order. This is why global std::string, std::vector, and other class instances 
      "just work" — their constructors have already run. Watch for constructor code that calls other 
      uninitialised globals (static initialisation order fiasco).
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:0">
      <div style="padding:10px 14px;border-right:1px solid var(--bdr)">
        ${renderList(inits, '🔨 Constructors (before main)')}
      </div>
      <div style="padding:10px 14px">
        ${renderList(finis, '🗑 Destructors (after main exits)')}
      </div>
    </div>`;
}

// =============================================================================
// ISR (INTERRUPT) HEALTH TAB
// =============================================================================

let _isrData  = null;   // cached /analyse_isr result
let _isrSort  = { col: 'total_stack_budget', dir: -1 };
let _isrFilt  = [];     // filtered display list

// ── Update data-source status indicators ─────────────────────────────────────
function updateIsrDataBar() {
  const set = (id, ok, label) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = (ok ? '✅ ' : '⚪ ') + label;
    el.style.color = ok ? 'var(--grn)' : 'var(--dim)';
  };
  set('isr-src-elf', S.syms && S.syms.length > 0, 'ELF: ' + (S.syms && S.syms.length > 0 ? S.syms.length + ' symbols' : 'not loaded'));
  set('isr-src-su',  SU_DATA.entries.length > 0,   '.su: ' + (SU_DATA.entries.length > 0 ? SU_DATA.entries.length + ' functions' : 'not loaded') + ' (stack frames)');
  set('isr-src-ci',  !!SU_DATA.cgResult,            '.ci: ' + (SU_DATA.cgResult ? 'loaded (call depths)' : 'not loaded (call depths)'));
  set('isr-src-ld',  !!S.ld,                        '.ld: ' + (S.ld ? 'loaded (fast-mem sections)' : 'not loaded'));
}

// ── Main analysis entry point ────────────────────────────────────────────────
async function runIsrAnalysis() {
  const btn = document.getElementById('isr-analyse-btn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analysing…'; }
  updateIsrDataBar();

  try {
    const fd = new FormData();
    // Symbols from ELF analysis
    if (S.syms && S.syms.length) {
      fd.append('symbols_json', JSON.stringify(
        S.syms.map(s => ({ name:s.name, type:s.type, section:s.section, addr:s.addr, size:s.size }))
      ));
    }
    // Stack frame data from .su files
    if (SU_DATA.entries.length) {
      fd.append('su_entries', JSON.stringify(SU_DATA.entries));
    }
    // Call graph from .ci files
    if (SU_DATA.cgResult) {
      fd.append('cg_result', JSON.stringify(SU_DATA.cgResult));
    }
    // LD section data for fast-memory classification
    if (S.ld && S.ld.sections) {
      fd.append('ld_sections', JSON.stringify(
        S.ld.sections.map(s => ({ name: s.name, type: s.type, addr: s.addr }))
      ));
    }
    // Target profile for architecture
    fd.append('target_json', getTargetJson());

    const res = await fetch('/analyse_isr', { method: 'POST', body: fd });
    const d   = await res.json();

    if (d.error) {
      diagLog('error', 'ISR analysis failed: ' + d.error);
      alert('ISR analysis error: ' + d.error);
      return;
    }

    _isrData = d;
    diagLog('analysis', 'ISR analysis complete', {
      arch: d.arch, isrs: d.isrs?.length,
      with_stack: d.summary?.with_su_data,
      hazards: d.summary?.with_hazards,
      errors: d.summary?.n_errors,
    });

    renderIsrTab(d);
  } catch (e) {
    diagLog('error', 'ISR fetch failed: ' + e.message);
    alert('ISR analysis failed: ' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Analyse ISRs'; }
  }
}

// ── Render full ISR tab ───────────────────────────────────────────────────────
function renderIsrTab(d) {
  const empty   = document.getElementById('isr-empty');
  const content = document.getElementById('isr-content');
  const badge   = document.getElementById('isr-badge');

  if (!d || !d.isrs || !d.isrs.length) {
    if (empty)   { empty.style.display = ''; empty.querySelector('h3').textContent = 'No ISRs detected'; }
    if (content) content.style.display = 'none';
    return;
  }

  if (empty)   empty.style.display   = 'none';
  if (content) content.style.display = '';

  const s = d.summary;

  // Badge on tab
  if (badge && s.n_errors > 0) {
    badge.style.display = '';
    badge.textContent   = s.n_errors;
    badge.style.background = 'var(--red)';
  } else if (badge && s.n_warns > 0) {
    badge.style.display = '';
    badge.textContent   = s.n_warns;
    badge.style.background = 'var(--ora)';
  } else if (badge) {
    badge.style.display = 'none';
  }

  // Stat bar
  const statsEl = document.getElementById('isr-stats');
  if (statsEl) statsEl.innerHTML = `
    <div class="stat"><div class="snum" style="color:var(--acc)">${s.total_isrs}</div><div class="slbl">ISRs detected</div></div>
    <div class="stat"><div class="snum" style="color:var(--grn)">${s.with_su_data}</div><div class="slbl">With stack data</div></div>
    <div class="stat"><div class="snum" style="color:var(--ora)">${fz(s.max_total_stack)}</div><div class="slbl">Largest ISR budget</div></div>
    <div class="stat"><div class="snum" style="color:var(--red)">${s.n_errors}</div><div class="slbl">Hazard errors</div></div>
    <div class="stat"><div class="snum" style="color:var(--ora)">${s.n_warns}</div><div class="slbl">Hazard warnings</div></div>
    <div class="stat"><div class="snum" style="color:${s.not_in_fast_mem > 0 ? 'var(--red)' : 'var(--grn)'}">${s.not_in_fast_mem}</div><div class="slbl">Not in fast mem</div></div>
  `;

  // HW overhead card
  const hwBody = document.getElementById('isr-hw-body');
  if (hwBody) {
    hwBody.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
        <div class="isr-hw-chip">${fz(s.hw_overhead)}</div>
        <div style="flex:1">${s.hw_note||''}</div>
      </div>
      <div style="margin-top:8px;padding:8px 10px;background:var(--s2);border-radius:4px;font-size:11px">
        💡 This overhead is added to every ISR's stack budget shown in the table below.
        It is <em>not included</em> in .su frame sizes — .su only measures your code's own prologue.
      </div>`;
  }

  // Hazard summary
  const hazSum = document.getElementById('isr-hazard-summary');
  if (hazSum) {
    if (s.n_errors > 0)
      hazSum.innerHTML = `<span style="color:var(--red);font-weight:600">❌ ${s.n_errors} error${s.n_errors>1?'s':''} — ISR hazards detected</span>`;
    else if (s.n_warns > 0)
      hazSum.innerHTML = `<span style="color:var(--ora)">⚠ ${s.n_warns} warning${s.n_warns>1?'s':''}</span>`;
    else
      hazSum.innerHTML = `<span style="color:var(--grn)">✓ No hazards detected</span>`;
  }

  _isrFilt = d.isrs.slice();
  filterIsrs();
}

// ── Filter + sort ─────────────────────────────────────────────────────────────
function filterIsrs() {
  if (!_isrData) return;
  const q    = (document.getElementById('isr-q')?.value || '').toLowerCase();
  const cls  = document.getElementById('isr-arch-class')?.value || '';
  const hflt = document.getElementById('isr-hazard-filter')?.value || '';

  _isrFilt = _isrData.isrs.filter(r => {
    if (q  && !r.func_name.toLowerCase().includes(q))  return false;
    if (cls && r.priority_class !== cls)               return false;
    if (hflt === 'error' && !r.hazards.some(h => h.severity === 'error')) return false;
    if (hflt === 'any'   && !r.hazards.length)         return false;
    return true;
  });

  sortIsrs(_isrSort.col, false);
}

function sortIsrs(col, flip = true) {
  if (flip) {
    _isrSort.dir = (_isrSort.col === col) ? -_isrSort.dir : -1;
    _isrSort.col = col;
  }
  _isrFilt.sort((a, b) => {
    const va = a[col] ?? -1, vb = b[col] ?? -1;
    return (typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb))) * _isrSort.dir;
  });
  renderIsrTable();
}

// ── Table render ──────────────────────────────────────────────────────────────
function renderIsrTable() {
  const tbody = document.getElementById('isr-tbody');
  if (!tbody) return;
  document.getElementById('isr-cnt').textContent = `${_isrFilt.length} / ${_isrData?.isrs?.length ?? 0}`;

  const PRIORITY_COLORS = {
    fault: '#f85149', nmi: '#bc8cff', system: '#d29922',
    peripheral: '#58a6ff', unknown: '#6e7681',
  };
  const PRIORITY_LABELS = {
    fault: '⚠ FAULT', nmi: '🚨 NMI', system: '⚙ SYS',
    peripheral: '📡 IRQ', unknown: '? UNK',
  };

  tbody.innerHTML = _isrFilt.map(r => {
    const hasErr  = r.hazards.some(h => h.severity === 'error');
    const hasWarn = r.hazards.some(h => h.severity === 'warn');
    const hazIcon = hasErr ? '❌' : hasWarn ? '⚠' : '✓';
    const hazColor= hasErr ? 'var(--red)' : hasWarn ? 'var(--ora)' : 'var(--grn)';
    const pc = r.priority_class;
    const pcColor = PRIORITY_COLORS[pc] || '#6e7681';
    const pcLabel = PRIORITY_LABELS[pc] || pc;

    const stackBar = (v, max, color) => {
      if (v == null || !max) return '—';
      const pct = Math.min(100, Math.round(v/max*100));
      return `<div style="display:flex;align-items:center;gap:6px">
        <div style="flex:1;min-width:50px;background:var(--s3);border-radius:3px;height:5px">
          <div style="width:${pct}%;background:${color};height:5px;border-radius:3px"></div>
        </div>
        <span style="font-size:11px;color:${color};min-width:36px">${fz(v)}</span>
      </div>`;
    };

    const maxTotal = Math.max(..._isrData.isrs.map(x => x.total_stack_budget || 0), 1);
    const notInFast = !r.in_fast_mem
      ? '<span style="color:var(--red);font-size:10px" title="ISR code not in IRAM/ITCM — high latency risk">⚡ SLOW</span>'
      : '<span style="color:var(--grn);font-size:10px">✓ FAST</span>';

    const ownFr = r.own_frame != null ? fz(r.own_frame) : '<span style="color:var(--dim)">no .su</span>';
    const chain = r.worst_case_chain != null ? fz(r.worst_case_chain) : '<span style="color:var(--dim)">no .ci</span>';
    const depth = r.call_chain_depth != null ? r.call_chain_depth : '<span style="color:var(--dim)">—</span>';
    const cycl  = r.est_cycles != null ? `~${r.est_cycles.toLocaleString()}` : '—';

    return `<tr onclick="showIsrHazard('${r.func_name.replace(/'/g,"\\'")}')">
      <td>
        <div style="font-weight:500;color:var(--txt);font-size:11px">${r.func_name}</div>
        <div style="font-size:9px;color:var(--dim);margin-top:1px">${r.section||'—'} · ${r.detection_reason}</div>
      </td>
      <td style="color:var(--acc)">${r.code_size ? fz(r.code_size) : '—'}</td>
      <td style="color:var(--dim)">${fz(r.hw_overhead)}</td>
      <td>${ownFr}</td>
      <td>${chain}</td>
      <td>${stackBar(r.total_stack_budget, maxTotal, r.total_stack_budget > 256 ? 'var(--red)' : r.total_stack_budget > 128 ? 'var(--ora)' : 'var(--grn)')}</td>
      <td style="color:${(r.call_chain_depth||0) > 5 ? 'var(--red)' : 'var(--txt)'}">${depth}</td>
      <td style="color:var(--dim);font-size:11px">${cycl}</td>
      <td>${notInFast}</td>
      <td style="color:${hazColor}" title="${r.hazards.length} hazard${r.hazards.length!==1?'s':''}">
        ${hazIcon}${r.hazards.length > 0 ? ` <span style="font-size:10px">${r.hazards.length}</span>` : ''}
      </td>
    </tr>`;
  }).join('');
}

// ── Hazard detail popup (inline below table) ──────────────────────────────────
function showIsrHazard(funcName) {
  if (!_isrData) return;
  const isr  = _isrData.isrs.find(r => r.func_name === funcName);
  if (!isr)  return;

  const card = document.getElementById('isr-hazard-card');
  const body = document.getElementById('isr-hazard-body');
  const title= document.getElementById('isr-hazard-title');
  if (!card || !body) return;

  if (title) title.textContent = funcName;

  const SEV_COLORS = { error: 'var(--red)', warn: 'var(--ora)', info: 'var(--acc)' };
  const SEV_ICONS  = { error: '❌', warn: '⚠', info: 'ℹ' };
  const CAT_LABELS = { heap:'Heap', rtos:'RTOS blocking', io:'I/O', delay:'Delay',
                       tls:'Thread-local', stack:'Stack type', depth:'Call depth' };

  // Info grid
  const info = [
    ['Function',       isr.func_name],
    ['Address',        isr.addr ? hx(isr.addr) : '—'],
    ['Section',        isr.section || '—'],
    ['Priority class', isr.priority_class],
    ['Code size',      isr.code_size ? fz(isr.code_size) : '—'],
    ['HW context save',fz(isr.hw_overhead)],
    ['Own frame (.su)',isr.own_frame != null ? fz(isr.own_frame) : 'no .su data'],
    ['Call chain (.ci)',isr.worst_case_chain != null ? fz(isr.worst_case_chain) : 'no .ci data'],
    ['Total budget',   isr.total_stack_budget != null ? fz(isr.total_stack_budget) : '—'],
    ['Call depth',     isr.call_chain_depth != null ? isr.call_chain_depth : '—'],
    ['Est. cycles',    isr.est_cycles != null ? '~' + isr.est_cycles.toLocaleString() : '—'],
    ['Fast memory',    isr.in_fast_mem ? '✓ Yes' : '⚠ No — place in IRAM/ITCM'],
    ['Detection',      isr.detection_reason],
  ];

  const infoGrid = `<div class="info-grid">${info.map(([k,v]) =>
    `<div class="info-card"><div class="info-label">${k}</div><div class="info-value">${v}</div></div>`
  ).join('')}</div>`;

  const hazardHtml = isr.hazards.length === 0
    ? `<div style="padding:12px 14px;color:var(--grn)">✓ No hazards detected for this ISR.</div>`
    : isr.hazards.map(h => `
        <div class="isr-hazard-row" style="border-left:3px solid ${SEV_COLORS[h.severity]||'var(--bdr)'}">
          <div class="isr-haz-icon">${SEV_ICONS[h.severity]||'ℹ'}</div>
          <div>
            <div class="isr-haz-title">
              <code style="color:var(--acc)">${h.func}</code>
              <span class="isr-haz-cat">${CAT_LABELS[h.category]||h.category}</span>
              ${h.direct ? '' : '<span class="isr-haz-indirect">via call tree</span>'}
            </div>
            <div class="isr-haz-msg">${h.msg}</div>
          </div>
        </div>`).join('');

  body.innerHTML = infoGrid + `
    <div style="padding:8px 14px;font-size:11px;font-weight:600;color:var(--dim);
      text-transform:uppercase;letter-spacing:.06em;border-top:1px solid var(--bdr)">
      Hazards (${isr.hazards.length})
    </div>` + hazardHtml;

  card.style.display = '';
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeIsrHazard() {
  const card = document.getElementById('isr-hazard-card');
  if (card) card.style.display = 'none';
}

// ── Export ────────────────────────────────────────────────────────────────────
function exportIsrCSV() {
  if (!_isrData || !_isrData.isrs.length) return;
  const hdrs = ['ISR Name','Section','Code Size','HW Overhead','Own Frame','Call Chain','Total Budget','Call Depth','Est Cycles','Fast Mem','Priority','Hazards'];
  const rows = _isrData.isrs.map(r => [
    r.func_name, r.section||'', r.code_size||'', r.hw_overhead,
    r.own_frame!=null?r.own_frame:'', r.worst_case_chain!=null?r.worst_case_chain:'',
    r.total_stack_budget!=null?r.total_stack_budget:'',
    r.call_chain_depth!=null?r.call_chain_depth:'',
    r.est_cycles!=null?r.est_cycles:'',
    r.in_fast_mem?'Yes':'No', r.priority_class,
    r.hazards.map(h=>h.severity+':'+h.func).join('; '),
  ]);
  const csv = [hdrs, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = 'isr_health.csv';
  a.click();
}

// ── Hook into existing file load events to refresh data bar ──────────────────
// (Called when the ISR tab is switched to, keeping the status bar current)
const _origTabForISR = typeof tab === 'function' ? tab : null;
