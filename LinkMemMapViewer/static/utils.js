// ═══════════════════════════════════════════════════════════════════════════
// LOOKUP HELPERS — safe alternatives to JSON-in-HTML
// ═══════════════════════════════════════════════════════════════════════════
function findSection(name){
  return S.ld?.sections.find(s=>s.name===name)||null;
}
function findSymbol(name,addr){
  return S.syms.find(s=>s.name===name&&s.addr===addr)||S.syms.find(s=>s.name===name)||null;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOLTIP
// ═══════════════════════════════════════════════════════════════════════════
// tip element accessed lazily via getTip()
function getTip(){return document.getElementById('tip');}
function addTip(el,info){
  el.addEventListener('mouseenter',e=>{
    let h=`<div class="tn">${info.name}</div>`;
    (info.rows||[]).forEach(([k,v])=>h+=`<div class="tr2"><span>${k}</span><span class="tv">${v}</span></div>`);
    if(info.desc)h+=`<div class="tdesc">${info.desc}</div>`;
    getTip().innerHTML=h;getTip().classList.add('on');tipPos(e);
  });
  el.addEventListener('mousemove',tipPos);
  el.addEventListener('mouseleave',()=>getTip().classList.remove('on'));
}
function tipPos(e){
  const x=e.clientX+14,y=e.clientY+10;
  const w=tip.offsetWidth||260,h=tip.offsetHeight||100;
  getTip().style.left=Math.min(x,innerWidth-w-8)+'px';
  getTip().style.top=Math.min(y,innerHeight-h-8)+'px';
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
function download(name,content){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([content],{type:'text/csv'}));
  a.download=name;a.click();
}

// ── Init moved to DOMContentLoaded in index.html ──────────────────────────
// (loadFeatureState and buildFeaturesPanel called there, after all scripts load)