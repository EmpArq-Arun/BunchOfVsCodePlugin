
// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════
const $=id=>document.getElementById(id);
const NS='http://www.w3.org/2000/svg';

const S={
  ld:null, elfFile:null, mapData:null,
  syms:[], fSyms:[], elfSecs:{},
  warns:[], startup:null,
  symSort:'size', symDir:-1,
  mapSort:'total', mapDir:-1,
  deadSort:'count', deadDir:-1,
  bloatFnSort:'size', bloatFnDir:-1,
  bloatVarSort:'size', bloatVarDir:-1,
  allWarns:[],
  a2lHistory:[],
};

// Feature registry — each entry: {id, name, desc, requires, group, default}
// requires: array of 'ld','elf','map'
const FEATURES=[
  // Memory Map
  {id:'f_fillbars',  name:'Region fill bars',       desc:'Shows % used with colour-coded fill bars',   req:['ld','elf'], group:'Memory Map', def:true},
  {id:'f_lmavma',    name:'LMA→VMA arrows',          desc:'Visualise flash→RAM copy sections',           req:['ld'],       group:'Memory Map', def:true},
  {id:'f_symhover',  name:'Largest symbol in hover', desc:'Tooltip shows biggest symbol per section',    req:['ld','elf'], group:'Memory Map', def:true},
  // Sections
  {id:'f_secsize',   name:'Exact section sizes',     desc:'Real sizes from ELF section headers',         req:['elf'],      group:'Sections',   def:true},
  {id:'f_secflags',  name:'Section flags decoded',   desc:'AX/WA flags with warning on odd combos',      req:['elf'],      group:'Sections',   def:true},
  {id:'f_seccontrib',name:'Contributor list',        desc:'Which .o files fill each section',            req:['map'],      group:'Sections',   def:true},
  {id:'f_secfill',   name:'Fill/padding bytes',      desc:'Wasted bytes between symbols per section',    req:['map'],      group:'Sections',   def:true},
  // Symbols
  {id:'f_symprov',   name:'File provenance',         desc:'Which .o file each symbol came from',         req:['map'],      group:'Symbols',    def:true},
  {id:'f_symfilt',   name:'Filter by .o file',       desc:'Dropdown to show symbols from one file only', req:['map','elf'],group:'Symbols',    def:true},
  {id:'f_symweak',   name:'Weak symbol highlight',   desc:'Colour-code weak vs strong definitions',      req:['elf'],      group:'Symbols',    def:true},
  {id:'f_symdup',    name:'Duplicate detection',     desc:'Same name in multiple object files',          req:['elf'],      group:'Symbols',    def:true},
  // Map File tab
  {id:'f_mapsym',    name:'Symbols per file',        desc:'Click file row to filter symbols table',      req:['map','elf'],group:'Map File',   def:true},
  {id:'f_mapregion', name:'Colour by region',        desc:'Colour-code files by memory region type',     req:['map','ld'], group:'Map File',   def:true},
  {id:'f_mapdma',    name:'DMA hazard per file',     desc:'Flag files contributing to cacheable+DMA secs',req:['map','ld','elf'],group:'Map File',def:true},
  {id:'f_maplib',    name:'Library grouping',        desc:'Group and subtotal by .a archive',            req:['map'],      group:'Map File',   def:true},
  // Warnings
  {id:'f_wdma',      name:'DMA buffer in cached RAM',desc:'Variables likely used with DMA in cached RAM',req:['ld','elf'], group:'Warnings',  def:true},
  {id:'f_wunplaced', name:'Unplaced symbols',        desc:'Symbols outside all known LD sections',       req:['ld','elf'], group:'Warnings',  def:true},
  {id:'f_wprintf',   name:'printf/malloc detection', desc:'Flag if printf family appears in symbols',    req:['elf'],      group:'Warnings',  def:true},
  {id:'f_woverlap',  name:'Section overlap check',   desc:'Detects overlapping address ranges',          req:['ld','elf'], group:'Warnings',  def:true},
  {id:'f_walign',    name:'Alignment waste',         desc:'Large alignment with small content',          req:['elf'],      group:'Warnings',  def:false},
  // Bloat
  {id:'f_bloatfn',   name:'Largest functions',       desc:'Ranked list of biggest code symbols',         req:['elf'],      group:'Bloat',     def:true},
  {id:'f_bloatvar',  name:'Largest variables',       desc:'Ranked list of biggest data symbols',         req:['elf'],      group:'Bloat',     def:true},
  {id:'f_bloattree', name:'Library treemap',         desc:'Visual breakdown by .a/.o file contribution', req:['map'],      group:'Bloat',     def:true},
  {id:'f_bloatdup',  name:'Duplicate symbols',       desc:'Same function name from multiple .o files',   req:['elf'],      group:'Bloat',     def:true},
  // Dead Code
  {id:'f_deadlist',  name:'GC\'d sections list',     desc:'Sections removed by --gc-sections',           req:['map'],      group:'Dead Code', def:true},
  {id:'f_deadfile',  name:'By-file GC summary',      desc:'Which files had most dead code removed',      req:['map'],      group:'Dead Code', def:true},
  // Startup
  {id:'f_startexact',name:'Exact copy sizes',        desc:'Real startup copy table from ELF',            req:['ld','elf'], group:'Startup',   def:true},
  {id:'f_startfile', name:'Per-file copy contrib',   desc:'Which .o contributes most to startup copy',   req:['ld','map'], group:'Startup',   def:false},
];

// Load saved feature state
function loadFeatureState(){
  try{
    const saved=JSON.parse(localStorage.getItem('lmv_features')||'{}');
    FEATURES.forEach(f=>{
      f.enabled = f.id in saved ? saved[f.id] : f.def;
    });
  }catch(e){
    FEATURES.forEach(f=>f.enabled=f.def);
  }
}
function saveFeatureState(){
  const state={};
  FEATURES.forEach(f=>state[f.id]=f.enabled);
  localStorage.setItem('lmv_features',JSON.stringify(state));
}
function feat(id){
  const f=FEATURES.find(x=>x.id===id);
  return f&&f.enabled&&f.available;
}
function updateFeatureAvailability(){
  FEATURES.forEach(f=>{
    f.available=f.req.every(r=>(r==='ld'&&!!S.ld)||(r==='elf'&&S.syms.length>0)||(r==='map'&&!!S.mapData));
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// FEATURES PANEL
// ═══════════════════════════════════════════════════════════════════════════
function buildFeaturesPanel(){
  updateFeatureAvailability();
  const container=$('feat-groups');
  container.innerHTML='';
  const groups=[...new Set(FEATURES.map(f=>f.group))];
  groups.forEach(g=>{
    const feats=FEATURES.filter(f=>f.group===g);
    const allAvail=feats.every(f=>f.available);
    const anyEnabled=feats.some(f=>f.enabled&&f.available);
    const div=document.createElement('div');
    div.className='feat-group';
    div.innerHTML=`
      <div class="feat-group-hdr open" onclick="toggleGroup(this)">
        <span class="arrow">▶</span>
        <span style="flex:1;font-family:var(--ui);font-size:11px;font-weight:600">${g}</span>
        <span style="font-size:10px;color:${allAvail?'var(--grn)':'var(--ora)'}">
          ${feats.filter(f=>f.available).length}/${feats.length}
        </span>
      </div>
      <div class="feat-group-body open">
        ${feats.map(f=>featItemHTML(f)).join('')}
      </div>`;
    container.appendChild(div);
  });
  // Bind checkboxes
  container.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.addEventListener('change',e=>{
      const f=FEATURES.find(x=>x.id===e.target.dataset.id);
      if(f&&f.available){f.enabled=e.target.checked;saveFeatureState();rerender();}
      else e.target.checked=!e.target.checked;
    });
  });
}

function featItemHTML(f){
  const reqDots=(['ld','elf','map']).map(r=>{
    const needed=f.req.includes(r);
    const have=(r==='ld'&&!!S.ld)||(r==='elf'&&S.syms.length>0)||(r==='map'&&!!S.mapData);
    const cls=needed?(have?r:'off'):'';
    const label=r.toUpperCase();
    return `<span class="req-dot ${cls}" title="${needed?r+' required':r+' not needed'}">${label}</span>`;
  }).join('');
  const disabled=!f.available;
  const title=disabled?`Requires: ${f.req.join(', ')} file${f.req.length>1?'s':''}`:'';
  return `<div class="feat-item ${disabled?'disabled':''}" title="${title}">
    <input type="checkbox" data-id="${f.id}" ${f.enabled&&!disabled?'checked':''} ${disabled?'disabled':''}>
    <div class="feat-label">
      <div class="feat-name">${f.name}</div>
      <div class="feat-desc">${f.desc}</div>
      <div class="feat-reqs">${reqDots}</div>
    </div>
  </div>`;
}

function toggleGroup(hdr){
  hdr.classList.toggle('open');
  hdr.nextElementSibling.classList.toggle('open');
}
function toggleFeatures(){
  const p=$('feat-panel');
  const btn=$('feat-toggle-btn');
  const showing=p.style.display!=='none';
  p.style.display=showing?'none':'';
  btn.classList.toggle('act',!showing);
}
