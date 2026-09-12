// ═══════════════════════════════════════════════════════════════════════════
// POPUP SYSTEM
// ═══════════════════════════════════════════════════════════════════════════
function openModal(icon,title,subtitle,tabs,panes){
  $('modal-icon').textContent=icon;
  $('modal-title').textContent=title;
  $('modal-subtitle').textContent=subtitle;
  const mt=$('modal-tabs');mt.innerHTML='';
  const mb=$('modal-body');mb.innerHTML='';
  if(tabs.length<=1){
    // No tab bar for single-pane modals
    const p=document.createElement('div');p.className='modal-pane act';p.innerHTML=panes[0];
    mb.appendChild(p);
  } else {
    tabs.forEach((t,i)=>{
      const el=document.createElement('div');el.className='modal-tab'+(i===0?' act':'');
      el.textContent=t;el.onclick=()=>{
        mt.querySelectorAll('.modal-tab').forEach(x=>x.classList.remove('act'));
        mb.querySelectorAll('.modal-pane').forEach(x=>x.classList.remove('act'));
        el.classList.add('act');mb.querySelectorAll('.modal-pane')[i].classList.add('act');
      };
      mt.appendChild(el);
    });
    panes.forEach((html,i)=>{
      const p=document.createElement('div');p.className='modal-pane'+(i===0?' act':'');
      p.innerHTML=html;mb.appendChild(p);
    });
  }
  // Bind addr2line, filter, and sym-click buttons after render
  setTimeout(()=>{
    mb.querySelectorAll('[data-a2l]').forEach(btn=>{
      btn.addEventListener('click',()=>{switchTab('a2l');doA2L(btn.dataset.a2l);closeModalBtn();});
    });
    mb.querySelectorAll('[data-filter-sec]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        $('sym-s').value=btn.dataset.filterSec;
        filterSyms();switchTab('sym');closeModalBtn();
      });
    });
    mb.querySelectorAll('[data-filter-file]').forEach(btn=>{
      btn.addEventListener('click',()=>{
        $('sym-f').value=btn.dataset.filterFile;
        filterSyms();switchTab('sym');closeModalBtn();
      });
    });
  },50);
  $('modal-overlay').classList.add('open');
}
function closeModal(e){if(e.target===$('modal-overlay'))closeModalBtn();}
function closeModalBtn(){$('modal-overlay').classList.remove('open');}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModalBtn();});

// ── Region popup ──────────────────────────────────────────────────────────
function openRegionPopup(reg,usedBytes,usedPct){
  const free=Math.max(0,reg.length-usedBytes);
  const pct=Math.round(usedPct*100);
  const col=usedPct>0.95?'var(--red)':usedPct>0.8?'var(--ora)':'var(--grn)';
  // Doc comment extracted generically from nearest preceding block comment in .ld file
  const regDocBanner = reg.doc
    ? `<div style="padding:10px 14px;background:var(--surf);border-bottom:1px solid var(--bdr);
         border-left:3px solid var(--acc);font-size:11px;color:var(--dim);line-height:1.6">
         <span style="font-size:10px;color:var(--dim);display:block;margin-bottom:2px">
           📝 From linker script</span>
         ${reg.doc.replace(/</g,'&lt;').replace(/>/g,'&gt;')}
       </div>` : '';
  const secRows=reg.sections.map((s,idx)=>{
    const sz=S.elfSecs[s.name]?.size||0;
    return `<tr class="clickable" data-sec-name="${s.name}">
      <td><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${s.color};margin-right:6px"></span>${s.name}</td>
      <td class="dim">${s.type}</td>
      <td class="sz">${sz?fz(sz):'—'}</td>
      <td class="dim">${s.noload?'<span class="badge nb">NOLOAD</span>':''}${s.lma?'<span class="badge vb">LMA</span>':''}</td>
    </tr>`;}).join('');

  const overview=regDocBanner+`
    <div class="info-grid">
      <div class="info-card"><div class="info-label">Start address</div><div class="info-value hx">${hx(reg.origin)}</div></div>
      <div class="info-card"><div class="info-label">End address</div><div class="info-value hx">${hx(reg.end)}</div></div>
      <div class="info-card"><div class="info-label">Total size</div><div class="info-value sz">${fz(reg.length)}</div></div>
      <div class="info-card"><div class="info-label">Region type</div><div class="info-value">${reg.type}</div></div>
      ${usedBytes?`<div class="info-card"><div class="info-label">Used</div><div class="info-value" style="color:${col}">${fz(usedBytes)} (${pct}%)</div></div>
      <div class="info-card"><div class="info-label">Free</div><div class="info-value sz">${fz(free)}</div></div>`:''}
    </div>
    ${usedBytes?`<div style="background:var(--s2);border-radius:4px;height:10px;margin-bottom:14px">
      <div style="background:${col};width:${pct}%;height:10px;border-radius:4px;transition:width .5s"></div></div>`:''}
    <div class="card-wrap">
      <div class="tbl-hdr">Sections in this region</div>
      <table><thead><tr><th>Section</th><th>Type</th><th>Size</th><th>Flags</th></tr></thead>
      <tbody>${secRows}</tbody></table>
    </div>`;

  openModal('🗄',reg.name,`${reg.type} · ${hx(reg.origin)} → ${hx(reg.end)}`,['Overview'],[overview]);
  // Bind section row clicks after modal renders
  setTimeout(()=>{
    document.querySelectorAll('#modal-body tr[data-sec-name]').forEach(tr=>{
      tr.addEventListener('click',()=>{const sec=findSection(tr.dataset.secName);if(sec){closeModalBtn();openSectionPopup(sec);}});
    });
  },50);
}

// ── Section popup ─────────────────────────────────────────────────────────
function openSectionPopup(sec){
  const elfSec=S.elfSecs[sec.name];
  const sz=elfSec?.size||0;
  const mapSec=S.mapData?.sections.find(s=>s.name===sec.name);
  const symsInSec=S.syms.filter(s=>s.section===sec.name).sort((a,b)=>b.size-a.size);
  const maxSz=symsInSec[0]?.size||1;

  // Doc comment extracted from the linker script (generic — any .ld with block comments)
  const docBanner = sec.doc
    ? `<div style="padding:10px 14px;background:var(--surf);border-bottom:1px solid var(--bdr);
         border-left:3px solid var(--acc);font-size:11px;color:var(--dim);line-height:1.6">
         <span style="font-size:10px;color:var(--dim);display:block;margin-bottom:2px">
           📝 From linker script</span>
         ${sec.doc.replace(/</g,'&lt;').replace(/>/g,'&gt;')}
       </div>` : '';

  const overview=docBanner+`
    <div class="info-grid">
      <div class="info-card"><div class="info-label">Type</div><div class="info-value">${sec.type}</div></div>
      <div class="info-card"><div class="info-label">VMA region</div><div class="info-value">${sec.vma||'—'}</div></div>
      <div class="info-card"><div class="info-label">LMA region</div><div class="info-value">${sec.lma||'—'}</div></div>
      <div class="info-card"><div class="info-label">NOLOAD</div><div class="info-value">${sec.noload?'Yes — not in flash image':'No'}</div></div>
      ${sz?`<div class="info-card"><div class="info-label">Size</div><div class="info-value sz">${fz(sz)}</div></div>`:''}
      ${elfSec?`<div class="info-card"><div class="info-label">ELF flags</div><div class="info-value">${elfSec.flags||'none'} · ${elfSec.type}</div></div>`:''}
    </div>
    <div class="warn-details">${sec.desc}</div>
    <div class="tag-row">
      ${sec.dma_safe?'<span class="tag" style="color:var(--grn);border-color:#1a5c2a">✓ DMA-safe</span>':''}
      ${sec.cacheable?'<span class="tag" style="color:var(--ora);border-color:#5a3010">⚠ Cached</span>':''}
      ${sec.lma?'<span class="tag" style="color:var(--acc)">Copied from flash at startup</span>':''}
    </div>
    ${symsInSec.length?`<button class="hbtn" style="margin-top:12px" data-filter-sec="${sec.name}">🔍 Filter symbols by this section</button>`:''}`;

  // Contributors from map with flash/RAM classification
  const _arch = S.mapData?.arch || 'unknown';
  const _secCls = (() => {
    // Determine if this section is flash, ram, or both based on arch
    const n = sec.name;
    if (_arch === 'esp32') {
      if (['.flash.text','.flash.rodata','.flash.appdesc'].some(p=>n.startsWith(p))) return 'flash';
      if (['.iram0','.rtc.text','.rtc.force_fast','.rtc.data','.dram0.data','.iram0.data'].some(p=>n.startsWith(p))) return 'both';
      if (['.dram0.bss','.rtc.bss','.noinit','.rtc_noinit','.ext_ram','.rtc_reserved'].some(p=>n.startsWith(p))) return 'ram';
    } else {
      if (['.text','.rodata','.init','.fini','.mcal_const','.pflash'].some(p=>n.startsWith(p))) return 'flash';
      if (['.data','.mcal_data','.ramcode','.sram_data','.dtcm_data'].some(p=>n.startsWith(p))) return 'both';
      if (['.bss','.heap','.stack','.non_cacheable','.dtcm_bss','.sram_bss'].some(p=>n.startsWith(p))) return 'ram';
    }
    return null;
  })();
  const _clsLabel = _secCls === 'flash' ? '<span class="tag" style="color:#3b82f6;border-color:#1a3a6a">📦 Flash (XIP)</span>'
    : _secCls === 'both'  ? '<span class="tag" style="color:var(--acc);border-color:#1a3a6a">⚡ Flash→RAM at boot</span>'
    : _secCls === 'ram'   ? '<span class="tag" style="color:var(--ora);border-color:#5a3010">🗃 RAM only</span>' : '';
  const _archLabel = `<span style="font-size:10px;color:var(--dim);margin-left:8px">arch: ${_arch}</span>`;

  const contribHTML=mapSec?.units.length?`
    <div style="padding:8px 14px 4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      ${_clsLabel}${_archLabel}
      <span style="font-size:10px;color:var(--dim);margin-left:auto">${mapSec.units.length} object${mapSec.units.length!==1?'s':''}</span>
    </div>
    <div class="section-contributors">
      ${mapSec.units.slice().sort((a,b)=>b.size-a.size).map(u=>`
        <div class="contrib-bar">
          <div class="contrib-name" title="${u.file_full||u.file}">${u.file} <span style="color:var(--dim);font-size:10px">— ${u.subsection}</span></div>
          <div class="contrib-row">
            <div class="contrib-fill" style="background:${_secCls==='ram'?'#f9731688':'#3b82f688'};width:${Math.round(u.size/mapSec.size*260)}px"></div>
            <span class="contrib-sz">${fz(u.size)}</span>
          </div>
        </div>`).join('')}
    </div>` : (() => {
      // Distinguish: no map loaded vs section not present in binary
      if (!S.mapData) return '<p style="color:var(--dim);padding:12px">Load a .map file to see contributors</p>';
      // Map loaded but section not found — it may be zero-size or linker-generated
      const zeroSec = S.mapData.sections.find(s => s.name === sec.name);
      if (zeroSec && zeroSec.units && zeroSec.units.length === 0) {
        return `<div style="padding:12px;color:var(--dim);font-size:11px">
          <div>⚙ ${sec.name} has no object contributors.</div>
          <div style="margin-top:4px">This section is filled by the linker directly
            (e.g. alignment, vector table) or all code was inlined.</div>
          <div style="margin-top:4px">Size: ${fz(zeroSec.size)}</div>
        </div>`;
      }
      return `<div style="padding:12px;color:var(--dim);font-size:11px">
        <div style="margin-bottom:4px">📭 ${sec.name} was not placed in the binary.</div>
        <div>This section exists in the linker script but the map file shows no
          allocations here. It may be zero-size (NOLOAD, unused) or its size is 0.</div>
      </div>`;
    })();

  // Top symbols
  const symHTML=symsInSec.length?`
    <table class="sym-mini-table">
      <thead><tr><th>Symbol</th><th>Size</th><th>Type</th></tr></thead>
      <tbody>${symsInSec.slice(0,30).map(s=>`
        <tr class="clickable" data-sym-name="${s.name}" data-sym-addr="${s.addr}">
          <td style="color:var(--acc)">${s.name}</td>
          <td class="sz">${s.size?fz(s.size):'—'}</td>
          <td><span class="tb" style="color:${TCOL[s.type]||'#fff'};border-color:${TCOL[s.type]||'#fff'}33">${s.type}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>`:'<p style="color:var(--dim)">Load ELF to see symbols</p>';

  const tabs=['Overview','Contributors','Symbols'];
  const panes=[overview,contribHTML,symHTML];
  openModal(sec.dma_safe?'🔒':'📦',sec.name,`${sec.type} · ${sec.vma||'?'} region`,tabs,panes);
  setTimeout(()=>{
    document.querySelectorAll('#modal-body tr[data-sym-name]').forEach(tr=>{
      tr.addEventListener('click',()=>{
        const sym=findSymbol(tr.dataset.symName,parseInt(tr.dataset.symAddr));
        if(sym){closeModalBtn();openSymbolPopup(sym);}
      });
    });
  },50);
}

// ── Symbol popup ──────────────────────────────────────────────────────────
function openSymbolPopup(sym){
  const isFunc=sym.type==='function';
  const warnMatch=S.allWarns.filter(w=>w.symbols?.some&&w.symbols.some(s=>s.name===sym.name));
  const reg=S.ld?.regions.find(r=>sym.addr>=r.origin&&sym.addr<r.end);
  const sec=S.ld?.sections.find(s=>s.name===sym.section);

  const overview=`
    <div class="info-grid">
      <div class="info-card"><div class="info-label">Start address</div><div class="info-value hx">${hx(sym.addr)}</div></div>
      <div class="info-card"><div class="info-label">End address</div><div class="info-value hx">${sym.size?hx(sym.addr+sym.size-1):'—'}</div></div>
      <div class="info-card"><div class="info-label">Size</div><div class="info-value sz">${sym.size?fz(sym.size)+' ('+sym.size+' bytes)':'unknown'}</div></div>
      <div class="info-card"><div class="info-label">Type</div><div class="info-value">${sym.type} ${sym.global?'(global)':'(local)'}</div></div>
      <div class="info-card"><div class="info-label">Section</div><div class="info-value">${sym.section||'—'}</div></div>
      ${reg?`<div class="info-card"><div class="info-label">Memory region</div><div class="info-value">${reg.name} (${reg.type})</div></div>`:''}
      ${sec?`<div class="info-card"><div class="info-label">Cacheable</div><div class="info-value">${sec.cacheable?'<span style="color:var(--ora)">Yes — DMA-unsafe</span>':'<span style="color:var(--grn)">No</span>'}</div></div>`:''}
    </div>
    ${sym.file?`<div class="info-card" style="margin-bottom:12px"><div class="info-label">Source file</div><div class="info-value">${sym.file}</div></div>`:''}
    ${warnMatch.length?`<div style="background:#200d0d;border:1px solid #5a1a1a;border-radius:var(--rad);padding:10px 12px;margin-bottom:12px;font-size:11px;color:var(--red)">⚠ ${warnMatch.map(w=>w.message).join('<br>')}</div>`:''}
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="hbtn" data-a2l="${hx(sym.addr)}">📍 Addr→Line</button>
      ${sym.section?`<button class="hbtn" data-filter-sec="${sym.section}">🔍 Section symbols</button>`:''}
      ${sym.file?`<button class="hbtn" data-filter-file="${sym.file}">📂 File symbols</button>`:''}
    </div>`;

  const hexView=`
    <div class="code-block">${sym.name}:\n  Address: ${hx(sym.addr)}\n  Size:    ${sym.size?sym.size+' bytes ('+fz(sym.size)+')':'unknown'}\n  Type:    ${sym.type_raw||sym.type} (${sym.global?'global':'local'})\n  Section: ${sym.section||'?'}\n  File:    ${sym.file||'unknown'}</div>
    ${isFunc?`<p style="color:var(--dim);font-size:12px">To disassemble this function, run:<br>
      <code style="color:var(--acc)">arm-none-eabi-objdump -d --start-address=${hx(sym.addr)} --stop-address=${hx(sym.addr+sym.size)} your.elf</code></p>`:''}`;

  // Show demangled C++ name as the title when available; keep the
  // mangled symbol visible in the subtitle line for cross-referencing.
  const _popupTitle = sym.demangled && sym.demangled !== sym.name ? sym.demangled : sym.name;
  const _mangledSub = sym.demangled && sym.demangled !== sym.name ? `${sym.name} · ` : '';
  openModal(isFunc?'⚡':'📦',_popupTitle,`${_mangledSub}${sym.type} · ${hx(sym.addr)} · ${sym.size?fz(sym.size):'?'}`,
    ['Overview','Details'],[overview,hexView]);
}

// ── Warning popup ─────────────────────────────────────────────────────────
function openWarningPopup(w){
  const ICONS={error:'🔴',warn:'🟡',info:'🔵'};
  const symRows=(w.symbols||[]).slice(0,20).map(s=>`
    <tr class="clickable" data-sym-name="${s.name}" data-sym-addr="${s.addr}">
      <td style="color:var(--acc);font-size:11px">${s.name}</td>
      <td class="hx">${hx(s.addr)}</td>
      <td class="sz">${s.size?fz(s.size):'—'}</td>
    </tr>`).join('');

  const body=`
    <div class="warn-details" style="margin-bottom:12px">${w.detail}</div>
    ${symRows?`<div class="card-wrap"><div class="tbl-hdr">Related symbols</div>
      <table><thead><tr><th>Symbol</th><th>Address</th><th>Size</th></tr></thead>
      <tbody>${symRows}</tbody></table></div>`:''}`;

  openModal(ICONS[w.level]||'ℹ',w.message,w.category,[],[body]);
  setTimeout(()=>{
    document.querySelectorAll('#modal-body tr[data-sym-name]').forEach(tr=>{
      tr.addEventListener('click',()=>{
        const sym=findSymbol(tr.dataset.symName,parseInt(tr.dataset.symAddr));
        if(sym){closeModalBtn();openSymbolPopup(sym);}
      });
    });
  },50);
}

// ── File popup (from map) ─────────────────────────────────────────────────
function openFilePopup(row){
  const fileSections=(S.mapData?.sections||[]).filter(s=>s.units.some(u=>u.file===row.file));
  const fileSyms=S.syms.filter(s=>s.file===row.file).sort((a,b)=>b.size-a.size);

  const overview=`
    <div class="info-grid">
      <div class="info-card"><div class="info-label">Flash</div><div class="info-value sz">${fz(row.flash)}</div></div>
      <div class="info-card"><div class="info-label">RAM</div><div class="info-value" style="color:var(--ora)">${fz(row.ram)}</div></div>
      <div class="info-card"><div class="info-label">Total</div><div class="info-value">${fz(row.total)}</div></div>
      <div class="info-card"><div class="info-label">Sections</div><div class="info-value">${fileSections.length}</div></div>
    </div>
    ${fileSections.map(sec=>{
      const u=sec.units.find(u=>u.file===row.file);
      return u?`<div class="contrib-bar"><div class="contrib-name">${sec.name}</div>
        <div class="contrib-row">
          <div class="contrib-fill" style="background:${u.size>1024?'#ef444488':'#3b82f688'};width:${Math.min(260,u.size/row.total*260)}px"></div>
          <span class="contrib-sz">${fz(u.size)}</span>
        </div></div>`:''}).join('')}
    <div style="margin-top:12px;display:flex;gap:8px">
      <button class="hbtn" data-filter-file="${row.file}">🔍 Filter symbols by file</button>
    </div>`;

  const symHTML=fileSyms.length?`
    <table class="sym-mini-table">
      <thead><tr><th>Symbol</th><th>Size</th><th>Type</th><th>Section</th></tr></thead>
      <tbody>${fileSyms.slice(0,40).map(s=>`
        <tr class="clickable" data-sym-name="${s.name}" data-sym-addr="${s.addr}">
          <td style="color:var(--acc)">${s.name}</td>
          <td class="sz">${s.size?fz(s.size):'—'}</td>
          <td style="color:${TCOL[s.type]||'#fff'}">${s.type}</td>
          <td class="dim">${s.section||'—'}</td>
        </tr>`).join('')}
      </tbody>
    </table>`:'<p style="color:var(--dim)">Load ELF to see symbols from this file</p>';

  openModal('📂',row.file,`Flash: ${fz(row.flash)} · RAM: ${fz(row.ram)}`,['Overview','Symbols'],[overview,symHTML]);
  setTimeout(()=>{
    document.querySelectorAll('#modal-body tr[data-sym-name]').forEach(tr=>{
      tr.addEventListener('click',()=>{
        const sym=findSymbol(tr.dataset.symName,parseInt(tr.dataset.symAddr));
        if(sym){closeModalBtn();openSymbolPopup(sym);}
      });
    });
  },50);
}

// ── Section contributors popup ────────────────────────────────────────────
function openSectionContribPopup(secName,units){
  const sorted=[...units].sort((a,b)=>b.size-a.size);
  const total=units.reduce((s,u)=>s+u.size,0);
  const body=`
    <div style="margin-bottom:14px;color:var(--dim);font-size:12px">Total: <span style="color:var(--grn)">${fz(total)}</span> from ${units.length} object files</div>
    <div class="section-contributors">
      ${sorted.map(u=>`
        <div class="contrib-bar" style="cursor:pointer" onclick="closeModalBtn();$('map2-q').value='${u.file}';filterMapFiles();switchTab('map2')">
          <div class="contrib-name" title="${u.file_full}">${u.file} · <span style="color:var(--dim)">${u.subsection}</span></div>
          <div class="contrib-row">
            <div class="contrib-fill" style="background:#3b82f688;width:${Math.round(u.size/total*280)}px"></div>
            <span class="contrib-sz">${fz(u.size)}</span>
          </div>
        </div>`).join('')}
    </div>`;
  openModal('📂',secName,'Section contributors',[],[body]);
}

// ── Dead code file popup ──────────────────────────────────────────────────
function openDeadFilePopup(r){
  const body=`
    <p style="color:var(--dim);font-size:12px;margin-bottom:12px">${r.count} section(s) GC'd from this file by <code>--gc-sections</code></p>
    <div class="code-block">${r.sections.join('\n')}</div>
    <p style="color:var(--dim);font-size:11px;margin-top:8px">These functions/variables were compiled but never referenced — the linker removed them, saving flash space.</p>`;
  openModal('🗑',r.file,`${r.count} sections removed`,[],[body]);
}

// ── Duplicate symbol popup ────────────────────────────────────────────────
function openDuplicatePopup(name,syms){
  const body=`
    <p style="color:var(--ora);font-size:12px;margin-bottom:12px">Function '${name}' appears in ${syms.length} object files. This may indicate ODR violations or accidental duplication.</p>
    <table class="sym-mini-table">
      <thead><tr><th>Address</th><th>Size</th><th>File</th></tr></thead>
      <tbody>${syms.map(s=>`<tr class="clickable" data-sym-name="${s.name}" data-sym-addr="${s.addr}">
        <td class="hx">${hx(s.addr)}</td>
        <td class="sz">${fz(s.size)}</td>
        <td class="dim">${s.file||'—'}</td></tr>`).join('')}
      </tbody>
    </table>`;
  openModal('⚠',name,`Duplicate in ${syms.length} files`,[],[body]);
  setTimeout(()=>{
    document.querySelectorAll('#modal-body tr[data-sym-name]').forEach(tr=>{
      tr.addEventListener('click',()=>{
        const sym=findSymbol(tr.dataset.symName,parseInt(tr.dataset.symAddr));
        if(sym){closeModalBtn();openSymbolPopup(sym);}
      });
    });
  },50);
}

