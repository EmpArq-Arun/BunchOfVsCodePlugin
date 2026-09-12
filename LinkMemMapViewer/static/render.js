// ═══════════════════════════════════════════════════════════════════════════
// RERENDER — called whenever state changes
// ═══════════════════════════════════════════════════════════════════════════
function rerender(){
  updateFeatureAvailability();
  buildFeaturesPanel();
  enrichSymbolsFromMap();
  if(S.ld||Object.keys(S.elfSecs).length>0) renderMap();
  renderSections();
  renderSymbols();
  renderWarnings();
  renderBloat();
  renderStartup();
  renderMapFile();
  renderDeadCode();
}

// ═══════════════════════════════════════════════════════════════════════════
// ENRICH — cross-reference map data into symbols
// ═══════════════════════════════════════════════════════════════════════════
function enrichSymbolsFromMap(){
  if(!S.mapData||!S.syms.length)return;
  // Build addr→file index from map units
  const addrFile={};
  S.mapData.sections.forEach(sec=>{
    sec.units.forEach(u=>{
      // Map address range → file
      for(let a=u.addr;a<u.addr+u.size;a+=4)addrFile[a]=u.file;
    });
  });
  S.syms.forEach(sym=>{
    if(!sym.file&&addrFile[sym.addr])sym.file=addrFile[sym.addr];
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
const hx=n=>'0x'+n.toString(16).toUpperCase().padStart(8,'0');
function fz(n){if(n>=1048576)return(n/1048576).toFixed(2)+' MB';if(n>=1024)return(n/1024).toFixed(1)+' KB';return n+' B';}
function mkEl(p,tag,attrs){const e=document.createElementNS(NS,tag);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,String(v)));p.appendChild(e);return e;}
function svgT(p,text,attrs){const e=mkEl(p,'text',{...attrs,'font-family':'JetBrains Mono,monospace','pointer-events':'none'});e.textContent=text;return e;}
/** Return a CSS variable string so SVG text uses theme colors */
function svgFill(darkHex){
  // Map hardcoded hex to CSS variables; SVG supports var() in presentation attrs
  const map={'#fff':'var(--txt)','white':'var(--txt)','#6e7681':'var(--dim2)',
             '#8b949e':'var(--dim)','#58a6ff':'var(--acc)','#555':'var(--dim2)',
             '#e6edf3':'var(--txt)'};
  return map[darkHex]||darkHex;
}
function showApp(){
  $('welcome').style.display='none';
  const a=$('app');
  a.style.setProperty('display','block','important');
}
function toggleSidebar(){const s=$('sidebar');s.style.display=s.style.display==='none'?'':'none';}

function tab(el){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('act'));
  document.querySelectorAll('.pane').forEach(p=>p.classList.remove('act'));
  el.classList.add('act');$('pane-'+el.dataset.pane).classList.add('act');
}
function switchTab(name){
  const el=document.querySelector(`.tab[data-pane="${name}"]`);
  if(el){document.querySelectorAll('.tab').forEach(t=>t.classList.remove('act'));
    document.querySelectorAll('.pane').forEach(p=>p.classList.remove('act'));
    el.classList.add('act');$('pane-'+name).classList.add('act');}
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY MAP SVG
// ═══════════════════════════════════════════════════════════════════════════
function renderMap(){
  const svg=$('map-svg');svg.innerHTML='';
  const regs=(S.ld?.regions||[]).filter(r=>r.length>0);
  if(!regs.length){
    svgT(svg,'No MEMORY regions (load a .ld file)',{x:10,y:24,fill:'#555','font-size':12});
    svg.setAttribute('width',400);svg.setAttribute('height',36);
    renderRegionTable([]);return;
  }
  const AW=95,BW=196,LW=240,PAD_T=40,PAD_B=28,MIN_H=28,GAP=4;
  const totalLog=regs.reduce((s,r)=>s+Math.log2(Math.max(r.length,256)),0);
  const CH=Math.max(480,regs.length*100);
  const rh=r=>Math.max(MIN_H,(Math.log2(Math.max(r.length,256))/totalLog)*CH);
  const totalH=regs.reduce((s,r)=>s+rh(r)+GAP,0)+PAD_T+PAD_B;
  svg.setAttribute('width',AW+BW+LW);svg.setAttribute('height',totalH);
  svg.setAttribute('viewBox',`0 0 ${AW+BW+LW} ${totalH}`);
  svgT(svg,'ADDRESS',{x:AW/2,y:26,fill:svgFill('#6e7681'),'font-size':9,'text-anchor':'middle','letter-spacing':'0.1em'});
  svgT(svg,'REGION / SECTIONS',{x:AW+BW/2,y:26,fill:svgFill('#6e7681'),'font-size':9,'text-anchor':'middle','letter-spacing':'0.1em'});

  let y=PAD_T;const RTBL=[];
  for(const reg of regs){
    const h=rh(reg);
    const usedBytes=reg.sections.reduce((s,sec)=>s+(S.elfSecs[sec.name]?.size||0),0);
    const usedPct=reg.length>0?Math.min(1,usedBytes/reg.length):0;
    RTBL.push({...reg,usedBytes,usedPct,freeBytes:Math.max(0,reg.length-usedBytes)});

    const rb=mkEl(svg,'rect',{x:AW,y,width:BW,height:h,fill:reg.color,rx:4,
      stroke:'#2a3548','stroke-width':1,cursor:'pointer'});
    rb.addEventListener('click',()=>openRegionPopup(reg,usedBytes,usedPct));
    addTip(rb,{name:reg.name,rows:[
      ['Start',hx(reg.origin)],['End',hx(reg.end)],['Size',fz(reg.length)],
      ['Type',reg.type],['Used',usedBytes?fz(usedBytes)+' ('+Math.round(usedPct*100)+'%)':'load ELF'],
      ['Free',usedBytes?fz(Math.max(0,reg.length-usedBytes)):'—'],
    ],desc:'Click for detailed region view'});

    svgT(svg,hx(reg.origin),{x:AW-5,y:y+12,fill:svgFill('#58a6ff'),'font-size':9,'text-anchor':'end'});
    svgT(svg,hx(reg.end),{x:AW-5,y:y+h,fill:svgFill('#8b949e'),'font-size':9,'text-anchor':'end'});
    mkEl(svg,'line',{x1:AW-4,y1:y,x2:AW,y2:y,stroke:'#444','stroke-width':1});
    mkEl(svg,'line',{x1:AW-4,y1:y+h,x2:AW,y2:y+h,stroke:'#333','stroke-width':1});
    svgT(svg,reg.name,{x:AW+BW+10,y:y+14,fill:svgFill('#fff'),'font-size':12,'font-weight':600,'font-family':'Syne,sans-serif','pointer-events':'none'});
    svgT(svg,fz(reg.length),{x:AW+BW+10,y:y+27,fill:svgFill('#6e7681'),'font-size':10});
    if(usedBytes>0&&feat('f_fillbars')){
      const col=usedPct>0.95?'#f85149':usedPct>0.8?'#d29922':'#3fb950';
      svgT(svg,Math.round(usedPct*100)+'% used',{x:AW+BW+10,y:y+40,fill:col,'font-size':10});
    }

    const secs=reg.sections;
    if(secs.length){
      const sh=Math.max(10,(h-4)/secs.length);
      secs.forEach((sec,i)=>{
        const sy=y+2+i*sh,sH=Math.min(sh,(h-4)-i*sh)-1;
        if(sH<3)return;
        const secSz=S.elfSecs[sec.name]?.size||0;
        // LMA arrow if section has VMA≠LMA
        const isLMA=sec.lma&&feat('f_lmavma');
        const sr=mkEl(svg,'rect',{x:AW+2,y:sy,width:BW-4,height:sH,
          fill:sec.color,rx:2,opacity:isLMA?0.95:0.85,cursor:'pointer'});
        if(isLMA){
          // Small arrow indicator
          mkEl(svg,'text',{x:AW+BW-8,y:sy+sH/2+4,fill:svgFill('#fff'),'font-size':8,
            'text-anchor':'end','pointer-events':'none'}).textContent='↗';
        }
        sr.addEventListener('click',()=>openSectionPopup(sec));
        // Largest symbol in hover
        let tipDesc=sec.desc;
        if(feat('f_symhover')&&S.syms.length){
          const sn=sec.name;
          const largest=S.syms.filter(s=>s.section===sn&&s.size>0).sort((a,b)=>b.size-a.size)[0];
          if(largest)tipDesc=`Largest: ${largest.name} (${fz(largest.size)}). ${sec.desc}`;
        }
        addTip(sr,{name:sec.name,rows:[
          ['Type',sec.type],['→ VMA',sec.vma||'—'],
          ['← LMA',sec.lma||'—'],['NOLOAD',sec.noload?'Yes':'No'],
          ['Size',secSz?fz(secSz):'load ELF'],
        ],desc:tipDesc+' — click for details'});
        if(sH>14)svgT(svg,sec.name,{x:AW+7,y:sy+sH/2+4,fill:svgFill('#fff'),'font-size':Math.min(10,sH-2)});
      });
    }
    y+=h+GAP;
  }

  // Legend
  // Legend removed: color swatches shown in section cards instead
  if($('leg')) $('leg').innerHTML='';

  renderRegionTable(RTBL);
}

function renderRegionTable(rtbl){
  const rtb=$('rtb');rtb.innerHTML='';
  rtbl.forEach(r=>{
    const p=r.usedPct,col=p>0.95?'#f85149':p>0.8?'#d29922':'#3fb950';
    const bar=r.usedBytes&&feat('f_fillbars')?`<div class="fill-bg" style="width:80px"><div class="fill-bar" style="width:${Math.round(p*78)}px;background:${col}"></div></div>`:'—';
    const tr=document.createElement('tr');tr.className='clickable';
    tr.innerHTML=`<td><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${r.color};margin-right:6px;vertical-align:middle"></span>${r.name}</td>
      <td class="hx">${hx(r.origin)}</td><td class="hx">${hx(r.end)}</td>
      <td class="sz">${fz(r.length)}</td><td class="dim">${r.type}</td>
      <td>${r.usedBytes?fz(r.usedBytes):'—'}</td><td>${r.usedBytes?fz(r.freeBytes):'—'}</td>
      <td>${bar}</td>
      <td style="max-width:200px">${r.sections.map(s=>`<span style="color:${s.color};font-size:10px;cursor:pointer;margin-right:4px" data-sec-name="${s.name}">${s.name}</span>`).join('')}</td>`;
    tr.addEventListener('click', e=>{
      const secName=e.target.dataset.secName;
      if(secName){e.stopPropagation();const sec=findSection(secName);if(sec)openSectionPopup(sec);return;}
      openRegionPopup(r,r.usedBytes,r.usedPct);
    });
    rtb.appendChild(tr);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTIONS
// ═══════════════════════════════════════════════════════════════════════════
function renderSections(){
  const secs=S.ld?.sections||[];
  // Populate type filter
  const tf=$('sec-type');const prev=tf.value;
  tf.innerHTML='<option value="">All types</option>';
  [...new Set(secs.map(s=>s.type))].sort().forEach(t=>{
    const o=document.createElement('option');o.value=t;o.textContent=t;tf.appendChild(o);
  });
  tf.value=prev;
  filterSecs();
}
function filterSecs(){
  const q=($('sec-q')?.value||'').toLowerCase();
  const t=$('sec-type')?.value||'';
  const secs=(S.ld?.sections||[]).filter(s=>{
    if(q&&!s.name.toLowerCase().includes(q))return false;
    if(t&&s.type!==t)return false;
    return true;
  });
  $('sec-cnt').textContent=`${secs.length} sections`;
  const g=$('sec-grid');g.innerHTML='';
  secs.forEach(s=>{
    const elfSec=S.elfSecs[s.name];
    const sz=elfSec?.size||0;
    const mapSec=S.mapData?.sections.find(ms=>ms.name===s.name);
    const contribCount=mapSec?.units.length||0;
    const d=document.createElement('div');d.className='sec-card';
    d.innerHTML=`
      <div class="sc-dot" style="background:${s.color}"></div>
      <div style="flex:1;min-width:0">
        <div class="sc-name">${s.name}
          ${s.noload?'<span class="badge nb">NOLOAD</span>':''}
          ${s.vma?`<span class="badge vb">→ ${s.vma}</span>`:''}
          ${s.lma?`<span class="badge">LMA:${s.lma}</span>`:''}
          ${s.dma_safe?'<span class="badge gb">DMA-safe</span>':''}
          ${s.cacheable?'<span class="badge cb">cached</span>':''}
        </div>
        <div class="sc-type">${s.type}</div>
        <div class="sc-desc">${s.desc}</div>
        ${sz&&feat('f_secsize')?`<div class="sc-size">${fz(sz)}</div>`:''}
        ${contribCount&&feat('f_seccontrib')?`<div style="font-size:10px;color:var(--dim);margin-top:3px">${contribCount} contributor${contribCount>1?'s':''}</div>`:''}
        ${elfSec&&feat('f_secflags')?`<div class="tag-row"><span class="tag">${elfSec.flags||'no flags'}</span><span class="tag">${elfSec.type}</span></div>`:''}
      </div>`;
    d.addEventListener('click',()=>openSectionPopup(s));
    g.appendChild(d);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SYMBOLS
// ═══════════════════════════════════════════════════════════════════════════
const TCOL={function:'#3b82f6',variable:'#f97316',constant:'#10b981',
  weak:'#6366f1',undefined:'#6e7681',absolute:'#f59e0b',other:'#374151'};

function renderSymbols(){
  if(!S.syms.length){$('sym-empty').style.display='';$('sym-content').style.display='none';return;}
  $('sym-empty').style.display='none';$('sym-content').style.display='';
  // Populate filters
  const ss=$('sym-s');ss.innerHTML='<option value="">All sections</option>';
  [...new Set(S.syms.map(s=>s.section).filter(Boolean))].sort()
    .forEach(n=>{const o=document.createElement('option');o.value=n;o.textContent=n;ss.appendChild(o);});
  // File filter from map
  const sf=$('sym-f');sf.innerHTML='<option value="">All files</option>';
  if(feat('f_symfilt')){
    [...new Set(S.syms.map(s=>s.file).filter(Boolean))].sort()
      .forEach(n=>{const o=document.createElement('option');o.value=n;o.textContent=n;sf.appendChild(o);});
  }
  filterSyms();
}
function filterSyms(){
  const q=($('sym-q')?.value||'').toLowerCase();
  const t=$('sym-t')?.value||'';
  const sec=$('sym-s')?.value||'';
  const fil=$('sym-f')?.value||'';
  const g=$('sym-g')?.value||'';
  S.fSyms=S.syms.filter(s=>{
    if(q&&!s.name.toLowerCase().includes(q))return false;
    if(t&&s.type!==t)return false;
    if(sec&&s.section!==sec)return false;
    if(fil&&s.file!==fil)return false;
    if(g==='1'&&!s.global)return false;
    if(g==='0'&&s.global)return false;
    return true;
  });
  sortAndRenderSyms();
}
function sortSym(col){
  if(S.symSort===col)S.symDir*=-1;else{S.symSort=col;S.symDir=-1;}
  document.querySelectorAll('#sym-tbl th').forEach((th,i)=>{
    th.classList.remove('sa','sd');
    if(['name','addr','size','type','section','file'][i]===col)th.classList.add(S.symDir>0?'sa':'sd');
  });
  sortAndRenderSyms();
}
function sortAndRenderSyms(){
  const {symSort:col,symDir:dir}=S;
  const sorted=[...S.fSyms].sort((a,b)=>{
    const va=a[col]??'',vb=b[col]??'';
    return(typeof va==='number'?va-vb:va.toString().localeCompare(vb.toString()))*dir;
  });
  $('sym-cnt').textContent=`${sorted.length} / ${S.syms.length}`;
  const tbody=$('sym-body');tbody.innerHTML='';
  sorted.slice(0,3000).forEach(s=>{
    const c=TCOL[s.type]||TCOL.other;
    // Weak highlighting
    const nameStyle=feat('f_symweak')&&s.type==='weak'?'color:#bc8cff':s.global?'color:var(--txt)':'color:var(--dim)';
    const tr=document.createElement('tr');tr.className='clickable';
    const fileCell=feat('f_symprov')&&s.file?s.file:'—';
    const endAddr=s.size?hx(s.addr+s.size-1):'';
    // Show demangled C++ name when available (set after C++ tab analysis runs);
    // mangled name stays in the tooltip so it's still searchable/copyable.
    const dispName = s.demangled && s.demangled !== s.name ? s.demangled : s.name;
    const mangledTip = s.demangled && s.demangled !== s.name ? `${s.name}` : '';
    tr.innerHTML=`
      <td style="${nameStyle};font-size:11px" title="${mangledTip}">${dispName}</td>
      <td class="hx">${hx(s.addr)}</td>
      <td class="hx" style="color:var(--dim);font-size:10px">${endAddr}</td>
      <td class="sz">${s.size?fz(s.size):'—'}</td>
      <td><span class="tb" style="color:${c};border-color:${c}33;background:${c}11">${s.type}</span></td>
      <td class="dim">${s.section||'—'}</td>
      <td class="dim" style="font-size:10px" title="${s.file||''}">${fileCell}</td>`;
    tr.addEventListener('click',()=>openSymbolPopup(s));
    tbody.appendChild(tr);
  });
  if(sorted.length>3000){
    const tr=document.createElement('tr');
    tr.innerHTML=`<td colspan="6" style="text-align:center;color:var(--dim);padding:10px">${sorted.length-3000} more — refine filter</td>`;
    tbody.appendChild(tr);
  }
}
function exportSymbols(){
  if(!S.syms.length)return;
  const lines=['Name,Address,Size,Type,Section,File'];
  S.fSyms.forEach(s=>lines.push(`"${s.name}","${hx(s.addr)}","${s.size}","${s.type}","${s.section||''}","${s.file||''}"`));
  download('symbols.csv',lines.join('\n'));
}

// ═══════════════════════════════════════════════════════════════════════════
// WARNINGS
// ═══════════════════════════════════════════════════════════════════════════
function renderWarnings(){
  // Generate extra warnings based on enabled features
  const extra=[];
  if(feat('f_wprintf')&&S.syms.length){
    const printfSyms=S.syms.filter(s=>['printf','fprintf','sprintf','snprintf','vprintf','puts'].some(p=>s.name===p||s.name.endsWith('_'+p)));
    if(printfSyms.length)extra.push({level:'warn',category:'Printf/malloc',
      message:`printf family detected: ${printfSyms.map(s=>s.name).join(', ')}`,
      detail:'printf brings in ~40KB of formatting code. Consider lighter alternatives (itoa, custom print) for embedded.',
      symbols:printfSyms});
    const mallocSym=S.syms.filter(s=>['malloc','free','calloc','realloc','_malloc_r'].includes(s.name));
    if(mallocSym.length)extra.push({level:'info',category:'Dynamic Memory',
      message:`Dynamic memory allocator linked: ${mallocSym.map(s=>s.name).join(', ')}`,
      detail:'malloc/free can cause fragmentation and non-deterministic timing. Consider static allocation in ASIL-B context.',
      symbols:mallocSym});
  }
  if(feat('f_woverlap')&&S.ld&&Object.keys(S.elfSecs).length){
    const ranges=[];
    S.ld.regions.forEach(r=>{
      if(r.length>0)ranges.push({name:r.name,start:r.origin,end:r.end});
    });
    for(let i=0;i<ranges.length;i++)for(let j=i+1;j<ranges.length;j++){
      if(ranges[i].start<ranges[j].end&&ranges[j].start<ranges[i].end)
        extra.push({level:'error',category:'Region Overlap',
          message:`Regions ${ranges[i].name} and ${ranges[j].name} overlap!`,
          detail:`${ranges[i].name}: ${hx(ranges[i].start)}–${hx(ranges[i].end)} | ${ranges[j].name}: ${hx(ranges[j].start)}–${hx(ranges[j].end)}`});
    }
  }
  if(feat('f_wunplaced')&&S.ld&&S.syms.length){
    const allRanges=[];
    S.ld.regions.forEach(r=>{if(r.length>0)allRanges.push([r.origin,r.end]);});
    const orphans=S.syms.filter(s=>s.addr>0&&s.type!=='undefined'&&s.size>0&&
      !allRanges.some(([a,b])=>s.addr>=a&&s.addr<b));
    if(orphans.length)extra.push({level:'warn',category:'Unplaced Symbols',
      message:`${orphans.length} symbol(s) outside all memory regions`,
      detail:'These symbols have addresses that fall outside the linker script MEMORY map. Possible orphan section or missing region.',
      symbols:orphans.slice(0,20)});
  }

  S.allWarns=[...(S.warns||[]),...extra];
  // Populate category filter
  const cats=[...new Set(S.allWarns.map(w=>w.category))].sort();
  const wc=$('warn-cat');const prev=wc.value;
  wc.innerHTML='<option value="">All categories</option>';
  cats.forEach(c=>{const o=document.createElement('option');o.value=c;o.textContent=c;wc.appendChild(o);});
  wc.value=prev;
  const badge=$('warn-badge');
  const errCount=S.allWarns.filter(w=>w.level==='error').length;
  badge.textContent=errCount||S.allWarns.length;
  badge.style.display=S.allWarns.length?'':'none';
  badge.style.background=errCount?'var(--red)':'var(--ora)';
  filterWarns();
}
function filterWarns(){
  const lvl=$('warn-lvl').value,cat=$('warn-cat').value;
  const filtered=S.allWarns.filter(w=>{
    if(lvl&&w.level!==lvl)return false;
    if(cat&&w.category!==cat)return false;
    return true;
  });
  $('warn-cnt').textContent=`${filtered.length} of ${S.allWarns.length}`;
  const ICONS={error:'🔴',warn:'🟡',info:'🔵'};
  const wl=$('warn-list');wl.innerHTML='';
  if(!filtered.length){
    wl.innerHTML='<div class="empty"><div class="eico">✅</div><h3>No warnings match filter</h3></div>';return;
  }
  filtered.forEach(w=>{
    const d=document.createElement('div');d.className=`wcard ${w.level}`;
    d.innerHTML=`<div class="wico">${ICONS[w.level]||'ℹ'}</div>
      <div style="flex:1"><div class="wcat">${w.category}</div>
      <div class="wtitle">${w.message}</div>
      <div class="wdet">${w.detail}</div></div>`;
    d.addEventListener('click',()=>openWarningPopup(w));
    wl.appendChild(d);
  });
}

// ═══════════════════════════════════════════════════════════════════════════