// @ts-nocheck
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
cytoscape.use(dagre);

declare function acquireVsCodeApi(): { postMessage(msg: any): void };
const vscode = acquireVsCodeApi();

type CRK = 'include'|'call'|'extern'|'inherit'|'typedef';
interface FolderNode { id:string; label:string; path:string; fileCount:number; crossFolderEdges:number }
interface FileNode   { id:string; label:string; file:string; folderId:string; ext:string; degree:number; hasSM:boolean; smNames:string[]; pairedFile?:string; displayLabel?:string }
interface FileEdge   { from:string; to:string; kind:CRK; symbols:string[]; details:string[]; count:number }
interface CompPort   { name:string; kind:string; direction:'export'|'import'; defLine?:number; connections:{file:string;mechanism:CRK;line:number;detail?:string}[] }
interface FileDetail { file:string; label:string; components:CompPort[]; includes:string[]; includedBy:string[] }
interface Graph      { folders:FolderNode[]; files:FileNode[]; edges:FileEdge[]; details:Record<string,FileDetail> }

// ─── DOM ─────────────────────────────────────────────────────────────────────
const $ = (id:string) => document.getElementById(id)!;
const graphDiv = $('graph'), loadingEl=$('loading'), loadTxt=$('loading-text');
const tooltip=$('tooltip'), infoPanel=$('info-panel');
const infoTitle=$('info-title'), infoPath2=$('info-path'), infoBody=$('info-body'), infoActs=$('info-actions');
const backBtn=$('btn-back') as HTMLButtonElement, breadEl=$('breadcrumb'), statsEl=$('stats');
const sidebar=$('sidebar'), resizeH=$('resize-handle');

// ─── Constants ────────────────────────────────────────────────────────────────
const EC:Record<CRK,string>={call:'#4f8cff',include:'#6c7280',extern:'#ff6b6b',inherit:'#a855f7',typedef:'#f59e0b'};
const ELS:Record<CRK,string>={call:'solid',include:'dashed',extern:'solid',inherit:'solid',typedef:'dashed'};
const FC:Record<string,string>={'.h':'#f59e0b','.hpp':'#f59e0b','.c':'#4f8cff','.cpp':'#37b873','.cc':'#37b873','.cxx':'#37b873'};
const KL:Record<CRK,string>={call:'Function calls',include:'Includes',extern:'Extern vars',inherit:'Inheritance',typedef:'Type usage'};
const KI:Record<CRK,string>={call:'📞',include:'📁',extern:'🔗',inherit:'🧬',typedef:'📝'};

// ─── State ────────────────────────────────────────────────────────────────────
let graph:Graph|null=null, cy:any=null;
let expFolder:string|null=null, expFile:string|null=null;
let hidden=new Set<CRK>(), posSave=new Map<string,{x:number,y:number}>();
let curLayout='lr', focusFile:string|null=null;
let inFocus=false, sidebarW=220, sidebarOn=true;
let infoPanelH=250;                   // persisted sidebar info height
let multiSel=new Set<string>();       // multi-select set
let inSelView=false;                  // selection view active?

interface HS { expF:string|null; expFi:string|null; pos:Map<string,any>; selView:boolean }
let history:HS[]=[];
const pushHist=()=>{ history.push({expF:expFolder,expFi:expFile,pos:new Map(posSave),selView:inSelView}); backBtn.disabled=false; };
const popHist=()=>{ const s=history.pop(); if(!s)return; expFolder=s.expF; expFile=s.expFi; posSave=s.pos; inSelView=s.selView; backBtn.disabled=history.length===0; rebuild(false); };

// REQ-G3/G4: global tap tracker (survives cy rebuild) for single/double click detection
const lastTap:{id:string;time:number}={id:'',time:0};
function wasDblTap(id:string):boolean{
  const now=Date.now(), dbl=(lastTap.id===id&&now-lastTap.time<350);
  lastTap.id=id; lastTap.time=now;
  if(dbl){lastTap.id='';lastTap.time=0;} // reset so triple click = single
  return dbl;
}

// ─── Sidebar horizontal resize ────────────────────────────────────────────────
{
  let drag=false,sx=0,sw=0;
  resizeH.addEventListener('mousedown',e=>{drag=true;sx=e.clientX;sw=sidebar.offsetWidth;resizeH.classList.add('dragging');document.body.style.cssText+='cursor:col-resize;user-select:none';e.preventDefault();});
  document.addEventListener('mousemove',e=>{ if(!drag)return; const nw=Math.max(100,Math.min(500,sw+(sx-e.clientX))); sidebar.style.width=nw+'px';sidebarW=nw;cy?.resize(); });
  document.addEventListener('mouseup',()=>{ if(!drag)return;drag=false;resizeH.classList.remove('dragging');document.body.style.cursor='';document.body.style.userSelect=''; });
}
// Sidebar vertical resize (legend / info panel)
{
  const vr=$('vresize');
  let drag=false,sy=0,sh=0;
  vr.addEventListener('mousedown',e=>{drag=true;sy=e.clientY;sh=infoPanel.offsetHeight||infoPanelH;document.body.style.cssText+='cursor:row-resize;user-select:none';e.preventDefault();});
  document.addEventListener('mousemove',e=>{ if(!drag)return; const nh=Math.max(80,Math.min(600,sh+(sy-e.clientY))); infoPanelH=nh;infoPanel.style.maxHeight=nh+'px'; });
  document.addEventListener('mouseup',()=>{ if(!drag)return;drag=false;document.body.style.cursor='';document.body.style.userSelect=''; });
}

// ─── Toolbar ─────────────────────────────────────────────────────────────────
backBtn.addEventListener('click',popHist);
$('btn-refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));
$('btn-fit').addEventListener('click',()=>cy?.fit(cy.elements(':visible'),55));
$('btn-collapse-all').addEventListener('click',()=>{ pushHist();expFolder=null;expFile=null;inSelView=false;rebuild(true); });
$('btn-toggle-sidebar').addEventListener('click',()=>{ sidebarOn=!sidebarOn;sidebar.classList.toggle('collapsed',!sidebarOn);resizeH.style.display=sidebarOn?'':'none';$('btn-toggle-sidebar').textContent=sidebarOn?'◀ Panel':'▶ Panel';cy?.resize();setTimeout(()=>cy?.fit(cy.elements(':visible'),55),60); });
document.querySelectorAll<HTMLButtonElement>('.layout-btn').forEach(b=>{
  b.addEventListener('click',()=>{ document.querySelectorAll('.layout-btn').forEach(x=>x.classList.remove('active'));b.classList.add('active');curLayout=b.dataset.layout!;applyLayout(); });
});
document.querySelectorAll<HTMLDivElement>('.leg-item[data-kind]').forEach(item=>{
  const cb=item.querySelector('input') as HTMLInputElement, k=item.dataset.kind as CRK;
  cb.addEventListener('change',()=>{ if(cb.checked){hidden.delete(k);item.classList.remove('disabled');}else{hidden.add(k);item.classList.add('disabled');} if(cy)cy.elements(`.edge-${k}`).style('display',cb.checked?'element':'none'); });
});
// Multi-select button (shown when multiSel.size > 0)
const multiBtn=document.createElement('button');
multiBtn.id='btn-multi';multiBtn.style.display='none';multiBtn.style.cssText+='background:#a855f744;color:#a855f7;border:1px solid #a855f7;';
multiBtn.textContent='View selected (0)';
$('stats').before(multiBtn);
multiBtn.addEventListener('click',()=>{ if(multiSel.size===0)return; pushHist();inSelView=true;rebuild(false); });
const clearMulti=document.createElement('button');
clearMulti.textContent='✕ Clear';clearMulti.style.display='none';clearMulti.style.fontSize='10.5px';
$('stats').before(clearMulti);
clearMulti.addEventListener('click',()=>{ multiSel.clear();updateMultiBtn();if(cy)cy.elements().style('border-color','').style('border-width',''); });
function updateMultiBtn(){ const n=multiSel.size; multiBtn.style.display=n?'':'none';clearMulti.style.display=n?'':'none';multiBtn.textContent=`⊞ View ${n} selected`; }

// ─── Messages ─────────────────────────────────────────────────────────────────
window.addEventListener('message',e=>{
  const m=e.data;
  if(m.type==='loading'){showLoad('Scanning…');return;}
  if(m.type==='error'){showLoad('Error: '+m.message);return;}
  if(m.type==='loadGraph'){
    graph=m.graph;focusFile=m.focusFile??null;
    expFolder=null;expFile=null;posSave.clear();history=[];inFocus=false;inSelView=false;multiSel.clear();
    backBtn.disabled=true;updateMultiBtn();
    // Auto-expand only when opened from a specific file (REQ-G2)
    if(focusFile){const fn=graph!.files.find(f=>f.file===focusFile);if(fn)expFolder=fn.folderId;}
    rebuild(true);
  }
});

// ─── Utils ────────────────────────────────────────────────────────────────────
const showLoad=(msg:string)=>{ loadTxt.textContent=msg;loadingEl.style.display='flex';if(cy){cy.destroy();cy=null;}infoPanel.style.display='none';$('vresize').style.display='none'; };
const visId=(fid:string)=>{
  if(inSelView) return fid;  // selection view has no folder nodes — always use file ID
  const fn=graph!.files.find(f=>f.id===fid);if(!fn)return fid;
  return expFolder===fn.folderId?fid:fn.folderId;
};
const nodeLbl=(id:string)=>graph!.folders.find(f=>f.id===id)?.label||graph!.files.find(f=>f.id===id)?.displayLabel||graph!.files.find(f=>f.id===id)?.label||id.split('::comp')[0].split(/[/\\]/).pop()||id;

// ─── Element builder ──────────────────────────────────────────────────────────
function buildElems():any[]{
  if(!graph)return[];
  const E:any[]=[],seen=new Set<string>();
  const nodeIds=new Set<string>();          // every node actually created
  const compIndex=new Map<string,number>(); // "file::compName::dir" -> flat index

  const visFiles = inSelView
    ? graph.files.filter(f=>multiSel.has(f.id)||multiSel.has(f.folderId))
    : graph.files;
  const visFileIds=new Set(visFiles.map(f=>f.id));

  // A file may only be treated as "expanded" if it is actually rendered.
  const fileIsRendered=(id:string)=>{
    const fn=graph!.files.find(f=>f.id===id); if(!fn)return false;
    if(inSelView) return visFileIds.has(id);
    return expFolder===fn.folderId;
  };
  const realExpFile = (expFile && fileIsRendered(expFile)) ? expFile : null;

  // ── Folder nodes (never in selection view) ──────────────────────────────
  if(!inSelView){
    for(const folder of graph.folders){
      if(expFolder!==folder.id){
        const pos=posSave.get(folder.id);
        E.push({data:{id:folder.id,label:`📁 ${folder.label}\n${folder.fileCount} files`,nodeType:'folder'},classes:'folder-node',...(pos?{position:pos}:{})});
        nodeIds.add(folder.id);
      }
    }
  }

  // ── File nodes ───────────────────────────────────────────────────────────
  for(const fn of visFiles){
    if(!inSelView&&expFolder!==fn.folderId)continue;
    const isExp=(realExpFile===fn.id);
    const color=FC[fn.ext]??'#9aa3b2',size=Math.max(40,Math.min(90,40+fn.degree*6));
    const pos=posSave.get(fn.id);
    const mainLbl=(fn.displayLabel??fn.label)+(fn.pairedFile?' (.c+.h)':'')+(fn.hasSM?' ⊡':'');
    E.push({data:{id:fn.id,label:mainLbl,nodeType:'file',file:fn.file,hasSM:fn.hasSM,smNames:fn.smNames,fillColor:color,size,isExp,displayLabel:fn.displayLabel},
      classes:isExp?'file-node file-exp':'file-node file-col',...(pos?{position:pos}:{})});
    nodeIds.add(fn.id);

    // ── Component nodes: FLAT (no parent) so the layout spaces them out ───
    if(isExp){
      const det=graph.details[fn.file];
      const all=(det?.components??[]).filter(c=>c.connections.length>0);
      const exps=all.filter(c=>c.direction==='export'),imps=all.filter(c=>c.direction==='import');
      [...exps,...imps].forEach((c,i)=>{
        const cid=`${fn.id}::comp::${i}`;
        E.push({data:{id:cid,label:c.name,ownerFile:fn.id,direction:c.direction,
          compJson:JSON.stringify(c),filePath:fn.file,defLine:c.defLine??1},
          classes:`comp-node comp-${c.direction}`});
        nodeIds.add(cid);
        compIndex.set(`${fn.id}::${c.name}::${c.direction}`,i);
        // Thin membership edge: function ↔ its own file (REQ-I11)
        const mid=`m::${cid}`;
        if(c.direction==='export') E.push({data:{id:mid,source:fn.id,target:cid,color:'#37b87366',lineStyle:'solid',width:1,kind:'member'},classes:'member-edge'});
        else                       E.push({data:{id:mid,source:cid,target:fn.id,color:'#ff9d4f66',lineStyle:'solid',width:1,kind:'member'},classes:'member-edge'});
        seen.add(mid);
      });
    }
  }

  // ── Edge helper: only create if BOTH endpoints exist ─────────────────────
  const addE=(id:string,src:string,tgt:string,data:any)=>{
    if(seen.has(id))return;
    if(!nodeIds.has(src)||!nodeIds.has(tgt))return;   // guard (fixes crash)
    seen.add(id);
    E.push({data:{id,source:src,target:tgt,...data},classes:`edge-${data.kind}`});
  };
  // Resolve a file to the node that represents it right now
  const rep=(fileId:string):string|null=>{
    if(nodeIds.has(fileId))return fileId;             // file node is rendered
    if(inSelView)return null;                          // no folder fallback in selView
    const fn=graph!.files.find(f=>f.id===fileId);
    const fid=fn?.folderId;
    return (fid&&nodeIds.has(fid))?fid:null;
  };
  // Find the comp node for a symbol, if that file is expanded
  const compFor=(fileId:string,sym:string,dir:'export'|'import'):string|null=>{
    if(realExpFile!==fileId)return null;
    const idx=compIndex.get(`${fileId}::${sym}::${dir}`);
    if(idx===undefined)return null;
    const cid=`${fileId}::comp::${idx}`;
    return nodeIds.has(cid)?cid:null;
  };

  // ── Cross-file edges ─────────────────────────────────────────────────────
  for(const edge of graph.edges){
    if(hidden.has(edge.kind))continue;
    const ff=graph.files.find(f=>f.id===edge.from),tf=graph.files.find(f=>f.id===edge.to);
    if(!ff||!tf)continue;
    if(inSelView&&(!visFileIds.has(ff.id)||!visFileIds.has(tf.id)))continue;

    const color=EC[edge.kind],ls=ELS[edge.kind],w=Math.max(1,Math.min(4,1+edge.count*.3));
    const base={kind:edge.kind,symbols:edge.symbols,details:edge.details,
      fromFile:edge.from,toFile:edge.to,count:edge.count,color,lineStyle:ls,width:w};

    const srcFileNode=rep(edge.from), tgtFileNode=rep(edge.to);
    if(!srcFileNode||!tgtFileNode)continue;
    if(srcFileNode===tgtFileNode)continue;

    // Route each symbol through comp nodes where available (REQ-I10)
    let routedAny=false;
    for(const sym of edge.symbols){
      const sComp=compFor(edge.from,sym,'import');   // caller side
      const tComp=compFor(edge.to,  sym,'export');   // callee side
      if(!sComp&&!tComp)continue;
      const src=sComp??srcFileNode, tgt=tComp??tgtFileNode;
      if(src===tgt)continue;
      addE(`e::${edge.kind}::${src}::${tgt}`,src,tgt,{...base,symbols:[sym]});
      routedAny=true;
    }
    // Fall back to a plain file→file edge when nothing was routed via comps
    if(!routedAny) addE(`e::${edge.kind}::${srcFileNode}::${tgtFileNode}`,srcFileNode,tgtFileNode,base);
  }
  return E;
}

// ─── Component placement ─────────────────────────────────────────────────────
// Component nodes are now FLAT (not compound children), so the layout engine
// spaces them automatically.  This only nudges them into export-left /
// import-right (or top/bottom) bands relative to their owning file node.
function placeComponents(_useCurrent=false){
  if(!cy)return;
  cy.nodes('.file-exp').forEach((fileNode:any)=>{
    const fid=fileNode.data('id'), fpos=fileNode.position();
    const exN=cy.nodes(`.comp-export[ownerFile="${CSS.escape(fid)}"]`).toArray();
    const imN=cy.nodes(`.comp-import[ownerFile="${CSS.escape(fid)}"]`).toArray();
    const H=34, isLR=(curLayout!=='tb');
    if(isLR){
      exN.forEach((n:any,i:number)=>n.position({x:fpos.x-170,y:fpos.y+(i-(exN.length-1)/2)*H}));
      imN.forEach((n:any,i:number)=>n.position({x:fpos.x+170,y:fpos.y+(i-(imN.length-1)/2)*H}));
    }else{
      exN.forEach((n:any,i:number)=>n.position({x:fpos.x+(i-(exN.length-1)/2)*130,y:fpos.y-110}));
      imN.forEach((n:any,i:number)=>n.position({x:fpos.x+(i-(imN.length-1)/2)*130,y:fpos.y+110}));
    }
  });
}

// ─── Layout ───────────────────────────────────────────────────────────────────
const layoutCfg=()=>{
  if(curLayout==='lr')return{name:'dagre',rankDir:'LR',nodeSep:32,rankSep:120,animate:true,animationDuration:350,padding:55};
  if(curLayout==='tb')return{name:'dagre',rankDir:'TB',nodeSep:32,rankSep:100,animate:true,animationDuration:350,padding:55};
  return{name:'cose',animate:true,animationDuration:500,padding:65,nodeRepulsion:20000,idealEdgeLength:140,nodeOverlap:12,randomize:true};
};

function applyLayout(){
  if(!cy)return;
  // Flat comp nodes now take part in the layout, so dagre/cose space them out
  // and nothing overlaps.  placeComponents() then nudges them into bands.
  const L=cy.elements().layout(layoutCfg());
  L.on('layoutstop',()=>{ placeComponents(true); cy?.fit(cy.elements(':visible'),55); });
  L.run();
}

const savePosFromCy=()=>cy?.nodes('.folder-node,.file-node').forEach((n:any)=>posSave.set(n.data('id'),{...n.position()}));

// ─── Rebuild ──────────────────────────────────────────────────────────────────
function rebuild(doLayout:boolean){
  if(!graph)return;
  savePosFromCy();if(cy){cy.destroy();cy=null;}loadingEl.style.display='none';
  if(graphDiv.offsetWidth===0||graphDiv.offsetHeight===0){requestAnimationFrame(()=>rebuild(doLayout));return;}
  const elems=buildElems();
  const nodeCount=elems.filter((e:any)=>!e.data.source).length;
  if(nodeCount===0){loadTxt.textContent='No files found. Open a workspace and click ⟳';loadingEl.style.display='flex';return;}
  try{cy=cytoscape({container:graphDiv,elements:elems,style:buildStyle(),layout:{name:'preset'}});}
  catch(err:any){loadTxt.textContent='Graph error: '+err?.message;loadingEl.style.display='flex';return;}

  // Restore positions for top-level nodes (folders and files, NOT comp nodes)
  let hasNewFileNodes=false;
  cy.nodes('.folder-node,.file-node').forEach((n:any)=>{ const p=posSave.get(n.data('id'));if(p)n.position(p);else hasNewFileNodes=true; });
  // Explicitly set expanded file (compound parent) position from saved value

  if(doLayout||hasNewFileNodes||expFile!==null){
    applyLayout();
  } else {
    placeComponents(false);
    cy.fit(cy.elements(':visible'),55);
  }

  // Re-apply legend filters on fresh cy instance
  hidden.forEach(k=>cy.elements(`.edge-${k}`).style('display','none'));

  const ro=new ResizeObserver(()=>cy?.resize());ro.observe(graphDiv);cy.on('destroy',()=>ro.disconnect());

  // Breadcrumb / stats
  let bread='Workspace';
  if(inSelView)bread=`Selection (${multiSel.size} files)`;
  else if(expFolder)bread=graph!.folders.find(f=>f.id===expFolder)?.label??expFolder;
  breadEl.textContent=bread;
  // REQ-SB12: show live connection count — adapts in selection view
  const visEdges=inSelView
    ? graph!.edges.filter(e=>multiSel.has(e.from)&&multiSel.has(e.to))
    : graph!.edges;
  statsEl.textContent=`${graph!.folders.length}📁 ${graph!.files.length}📄 ${visEdges.length} links`;

  if(focusFile){const n=cy.$(`[file="${CSS.escape(focusFile)}"]`);if(n.length)showFileInfo(graph!.files.find(f=>f.file===focusFile)!);}
  wireEvents();
}

// ─── Focus mode (Ctrl+click) ──────────────────────────────────────────────────
const enterFocus=(node:any)=>{ inFocus=true;cy.elements().style('opacity',0.1);node.closedNeighborhood().style('opacity',1);node.style({'border-width':3,'border-color':'#fff'}); };
const exitFocus=()=>{ inFocus=false;cy.elements().style('opacity',''); };

// ─── Events ───────────────────────────────────────────────────────────────────
function wireEvents(){
  if(!cy)return;
  const native=(evt:any)=>evt.originalEvent as MouseEvent;

  // Folder: single tap = expand, double tap = collapse (REQ-G3)
  cy.on('tap','node.folder-node',(evt:any)=>{
    tooltip.style.display='none';
    const id=evt.target.data('id') as string, ne=native(evt);
    if(ne?.ctrlKey&&ne?.shiftKey){
      if(multiSel.has(id)){multiSel.delete(id);evt.target.style({'border-color':'','border-width':''});}
      else{multiSel.add(id);evt.target.style({'border-color':'#a855f7','border-width':3});}
      updateMultiBtn();return;
    }
    if(ne?.ctrlKey||ne?.metaKey){enterFocus(evt.target);return;}
    if(inFocus){exitFocus();return;}
    if(wasDblTap(id)){
      // Double tap → collapse
      if(expFolder===id){expFolder=null;expFile=null;rebuild(false);}
    } else {
      // Single tap → expand (only if not already expanded)
      if(expFolder!==id){pushHist();savePosFromCy();expFolder=id;rebuild(false);}
    }
  });

  // File: single tap = expand + info, double tap = collapse (REQ-G4)
  cy.on('tap','node.file-node',(evt:any)=>{
    tooltip.style.display='none';
    const d=evt.target.data(),fn=graph!.files.find(f=>f.id===d.id);if(!fn)return;
    const ne=native(evt);
    if(ne?.ctrlKey&&ne?.shiftKey){
      if(multiSel.has(d.id)){multiSel.delete(d.id);evt.target.style({'border-color':'','border-width':''});}
      else{multiSel.add(d.id);evt.target.style({'border-color':'#a855f7','border-width':3});}
      updateMultiBtn();return;
    }
    if(ne?.ctrlKey||ne?.metaKey){enterFocus(evt.target);showFileInfo(fn);return;}
    if(inFocus){exitFocus();return;}
    if(wasDblTap(d.id)){
      // Double tap → collapse
      if(expFile===d.id){expFile=null;rebuild(false);}
    } else {
      // Single tap → expand + show info panel
      showFileInfo(fn);
      if(expFile!==d.id){pushHist();savePosFromCy();expFile=d.id;rebuild(false);}
    }
  });

  // Comp tap: jump to definition
  cy.on('tap','node.comp-node',(evt:any)=>{
    tooltip.style.display='none';
    const d=evt.target.data();
    const c:CompPort=JSON.parse(d.compJson??'{}');
    if(d.direction==='export'){
      // Jump to definition in this file
      vscode.postMessage({type:'revealFile',file:d.filePath,line:d.defLine??1});
    }else{
      // Import: jump to definition in the other file
      const conn=c.connections?.[0];
      if(conn){
        // Look up the export component in the target file's detail
        const otherDet=graph!.details[conn.file];
        const expComp=otherDet?.components.find(x=>x.name===d.label&&x.direction==='export');
        vscode.postMessage({type:'revealFile',file:conn.file,line:expComp?.defLine??conn.line});
      }
    }
    showCompInfo(d);
  });

  // Edge tap: open usage in source
  cy.on('tap','edge',(evt:any)=>{
    tooltip.style.display='none';
    const d=evt.target.data();
    if(d.fromFile)vscode.postMessage({type:'revealFile',file:d.fromFile,line:1});
  });

  // Background tap
  cy.on('tap',(e:any)=>{
    if(e.target!==cy)return;
    if(inFocus){exitFocus();return;}
    // REQ-I8: clear selection, exit selection view, hide info panel
    if(inSelView){inSelView=false;rebuild(false);return;}
    if(multiSel.size>0){multiSel.clear();updateMultiBtn();cy.elements().style('border-color','').style('border-width','');}
    infoPanel.style.display='none';$('vresize').style.display='none';
  });

  // ── Hover tooltips ────────────────────────────────────────────────────────
  cy.on('mouseover','node.folder-node',(evt:any)=>{
    const d=evt.target.data(),f=graph!.folders.find(x=>x.id===d.id);
    tip([`📁 ${d.id}`,`${f?.fileCount} files · ${f?.crossFolderEdges} cross-folder links`,'Click to expand  |  Ctrl+Shift to multi-select'],evt);
  });
  cy.on('mouseout','node.folder-node',()=>{tooltip.style.display='none';});

  cy.on('mouseover','node.file-node',(evt:any)=>{
    const d=evt.target.data(),fn=graph!.files.find(f=>f.id===d.id);
    const det=graph!.details[d.file];
    const exC=det?.components.filter(c=>c.direction==='export').length??0;
    const imC=det?.components.filter(c=>c.direction==='import').length??0;
    tip([
      d.file.split(/[/\\]/).slice(-2).join('/'),
      fn?.pairedFile?`paired with ${fn.pairedFile.split(/[/\\]/).pop()}`:'',
      `${exC} exported · ${imC} imported · ${fn?.degree??0} connections`,
      fn?.hasSM?`⊡ ${fn.smNames.join(', ')}`:null,
      d.isExp?'Click to collapse  |  Ctrl+click to focus':'Click to expand functions',
      'Ctrl+Shift+click to multi-select',
    ],evt);
  });
  cy.on('mouseout','node.file-node',()=>{tooltip.style.display='none';});

  cy.on('mouseover','node.comp-node',(evt:any)=>{
    const d=evt.target.data(),c:CompPort=JSON.parse(d.compJson??'{}');
    const peers=(c.connections??[]).map(x=>graph!.files.find(f=>f.id===x.file)?.label??x.file).slice(0,5).join(', ');
    const lineInfo=d.direction==='export'&&d.defLine?`defined at line ${d.defLine}`:'';
    tip([`${d.direction==='export'?'▶':'◀'} ${d.label}`,lineInfo,`→ ${peers}`,'Click to jump to source'],evt);
  });
  cy.on('mouseout','node.comp-node',()=>{tooltip.style.display='none';});

  cy.on('mouseover','edge',(evt:any)=>edgeTip(evt.target.data(),evt));
  cy.on('mouseout','edge',()=>{tooltip.style.display='none';});
}

// ─── Tooltips ─────────────────────────────────────────────────────────────────
const posT=(pos:{x:number,y:number})=>{ const b=graphDiv.getBoundingClientRect();posTPx(b.left+pos.x,b.top+pos.y); };
const posTPx=(x:number,y:number)=>{ tooltip.style.display='block';tooltip.style.left=`${Math.min(x+14,window.innerWidth-370)}px`;tooltip.style.top=`${Math.min(y+14,window.innerHeight-300)}px`; };
const tip=(lines:(string|null)[],evt:any)=>{ tooltip.innerHTML=`<div style="padding:8px 10px;white-space:pre-wrap;line-height:1.6">${lines.filter(Boolean).join('\n')}</div>`;posT(evt.target.renderedPosition()); };
function edgeTip(d:any,evt:any){
  const fid=String(d.fromFile||d.source).split('::comp')[0];
  const tid=String(d.toFile||d.target).split('::comp')[0];
  const all=(graph?.edges??[]).filter(e=>(e.from===fid&&e.to===tid)||(e.from===tid&&e.to===fid));
  // REQ-T7: only show the kind matching the hovered edge (not all kinds)
  const k=d.kind as CRK;
  const ms=all.filter(e=>e.kind===k);
  let html=`<div class="tip-header">${nodeLbl(fid)} ↔ ${nodeLbl(tid)}</div>`;
  if(ms.length){
    const syms=[...new Set(ms.flatMap(e=>e.symbols))].slice(0,16);
    const dets=[...new Set(ms.flatMap(e=>e.details))].slice(0,16);
    html+=`<div class="tip-kind">${KI[k]} ${KL[k]} (${syms.length})</div><ul class="tip-list">`;
    syms.forEach((s,i)=>{html+=`<li>${dets[i]||s+(k==='call'?'()':'')}</li>`;});
    html+=`</ul>`;
  }
  tooltip.innerHTML=html;
  const mp=evt.target.midpoint(),pan=cy.pan(),z=cy.zoom(),b=graphDiv.getBoundingClientRect();
  posTPx(b.left+mp.x*z+pan.x,b.top+mp.y*z+pan.y);
}

// ─── Info panel ───────────────────────────────────────────────────────────────
let showAllExp=false,showAllImp=false,currentInfoFile:FileNode|null=null;
const makeBtn=(label:string,fn:()=>void,style='')=>{ const b=document.createElement('button');b.textContent=label;b.style.cssText='font-size:10.5px;'+style;b.addEventListener('click',fn);return b; };

function showFileInfo(fn:FileNode){ currentInfoFile=fn;showAllExp=false;showAllImp=false;renderFileInfo(fn); }

function renderFileInfo(fn:FileNode){
  const det=graph!.details[fn.file];
  const exps=(det?.components??[]).filter(c=>c.direction==='export');
  const imps=(det?.components??[]).filter(c=>c.direction==='import');
  const LIMIT=8;
  infoTitle.textContent=(fn.displayLabel??fn.label)+(fn.pairedFile?' [.c+.h module]':'');
  infoPath2.textContent=fn.file+(fn.pairedFile?'\n+ '+fn.pairedFile:'');
  infoBody.innerHTML='';
  infoPanel.style.maxHeight=infoPanelH+'px';

  if(fn.hasSM){const d=document.createElement('div');d.style.cssText='color:#37b873;margin-bottom:5px;font-size:11px';d.textContent=`⊡ ${fn.smNames.join(', ')}`;infoBody.appendChild(d);}

  const makeSection=(label:string,color:string,items:CompPort[],showAll:boolean,toggleFn:()=>void)=>{
    const wrap=document.createElement('div');wrap.style.cssText='margin-bottom:8px';
    const hdr=document.createElement('div');hdr.style.cssText=`font-weight:600;font-size:11px;margin-bottom:4px;color:${color}`;hdr.textContent=`${label} (${items.length})`;
    wrap.appendChild(hdr);
    const dir=label.startsWith('▶')?'export':'import';
    const shown=showAll?items:items.slice(0,LIMIT);
    shown.forEach(c=>{
      const chip=document.createElement('span');
      chip.style.cssText=`display:inline-flex;align-items:center;gap:3px;cursor:pointer;padding:2px 7px;margin:2px;border-radius:3px;font-size:10.5px;background:${color}22;border:1px solid ${color}55;color:${color}`;
      chip.textContent=c.name;
      chip.title='Ctrl+click → open definition in code';
      chip.addEventListener('click',ev=>{
        if((ev as MouseEvent).ctrlKey||(ev as MouseEvent).metaKey){
          if(dir==='export'){
            vscode.postMessage({type:'revealFile',file:fn.file,line:c.defLine??1});
          }else{
            const conn=c.connections?.[0];
            if(conn){
              const otherDet=graph!.details[conn.file];
              const expComp=otherDet?.components.find(x=>x.name===c.name&&x.direction==='export');
              vscode.postMessage({type:'revealFile',file:conn.file,line:expComp?.defLine??conn.line??1});
            }
          }
        }
      });
      wrap.appendChild(chip);
    });
    if(items.length>LIMIT){
      const more=document.createElement('button');
      more.style.cssText='font-size:9.5px;margin-top:3px;background:transparent;color:#888;border:1px solid #555;padding:1px 6px;display:block;margin-top:4px';
      more.textContent=showAll?'▲ Show less':`▼ Show ${items.length-LIMIT} more`;
      more.addEventListener('click',toggleFn);
      wrap.appendChild(more);
    }
    infoBody.appendChild(wrap);
  };
  makeSection('▶ Exported','#37b873',exps,showAllExp,()=>{showAllExp=!showAllExp;renderFileInfo(fn);});
  makeSection('◀ Imported','#ff9d4f',imps,showAllImp,()=>{showAllImp=!showAllImp;renderFileInfo(fn);});

  const hint=document.createElement('div');hint.style.cssText='font-size:9.5px;opacity:.5;margin-top:4px';hint.textContent='Ctrl+click chip → open definition in editor';
  infoBody.appendChild(hint);

  infoActs.innerHTML='';
  infoActs.appendChild(makeBtn('📄 Open file',()=>vscode.postMessage({type:'revealFile',file:fn.file,line:1})));
  if(fn.hasSM)infoActs.appendChild(makeBtn('⊡ State diagram',()=>vscode.postMessage({type:'openSM',file:fn.file}),'background:#37b87344;color:#37b873;'));
  infoPanel.style.display='block';
  $('vresize').style.display='block';
}

function showCompInfo(d:any){
  const c:CompPort=JSON.parse(d.compJson??'{}');
  infoTitle.textContent=`${d.direction==='export'?'▶':'◀'} ${d.label}`;
  infoPath2.textContent=`in ${d.filePath.split(/[/\\]/).pop()}`;
  infoBody.innerHTML=(c.connections??[]).slice(0,12).map(x=>`<div style="padding:2px 0;font-size:11px">${d.direction==='export'?'← used by':'→ calls into'} <b>${graph!.files.find(f=>f.id===x.file)?.label??x.file}</b> <span style="opacity:.5;font-size:10px">(${x.mechanism}${x.detail?': '+x.detail:''})</span></div>`).join('');
  infoActs.innerHTML='';
  const jumpLabel=d.direction==='export'?`📍 Jump to definition (line ${d.defLine??'?'})`:'📍 Jump to call site';
  infoActs.appendChild(makeBtn(jumpLabel,()=>{
    if(d.direction==='export'){vscode.postMessage({type:'revealFile',file:d.filePath,line:d.defLine??1});}
    else{const conn:CompPort['connections'][0]=JSON.parse(d.compJson??'{}').connections?.[0];if(conn)vscode.postMessage({type:'revealFile',file:conn.file,line:conn.line??1});}
  }));
  infoPanel.style.display='block';$('vresize').style.display='block';
}

// ─── Styles ───────────────────────────────────────────────────────────────────
function buildStyle():any[]{return[
  {selector:'node.folder-node',style:{shape:'round-rectangle','background-color':'#ffffff10','border-color':'#888','border-width':1.5,'border-style':'dashed',label:'data(label)','text-valign':'center','text-halign':'center','text-wrap':'wrap','font-size':11,'font-weight':'bold',color:'var(--vscode-foreground,#ddd)','text-max-width':120,width:130,height:52,padding:'10px'}},
  {selector:'node.file-col',style:{shape:'round-rectangle','background-color':'data(fillColor)','background-opacity':.35,'border-color':'data(fillColor)','border-width':2,label:'data(label)','text-valign':'center','text-halign':'center','font-size':11,'font-weight':'bold',color:'var(--vscode-foreground,#ddd)','text-wrap':'ellipsis',width:'data(size)',height:36,padding:'8px','text-max-width':'data(size)'}},
  {selector:'node.file-exp',style:{shape:'round-rectangle','background-color':'data(fillColor)','background-opacity':.45,'border-color':'data(fillColor)','border-width':3,label:'data(label)','text-valign':'center','text-halign':'center','font-size':11.5,'font-weight':'bold',color:'var(--vscode-foreground,#fff)',width:'data(size)',height:44,padding:'10px','text-wrap':'ellipsis','text-max-width':'data(size)'}},
  {selector:'node.comp-export',style:{shape:'round-rectangle','background-color':'#37b87333','border-color':'#37b873','border-width':1.5,label:'data(label)','text-valign':'center','text-halign':'center','font-size':10,color:'var(--vscode-foreground,#ddd)',width:'label',height:24,padding:'7px'}},
  {selector:'node.comp-import',style:{shape:'round-rectangle','background-color':'#ff9d4f33','border-color':'#ff9d4f','border-width':1.5,label:'data(label)','text-valign':'center','text-halign':'center','font-size':10,color:'var(--vscode-foreground,#ddd)',width:'label',height:24,padding:'7px'}},
  {selector:'node.multi-sel',style:{'border-color':'#a855f7','border-width':3}},
  {selector:'edge.member-edge',style:{width:1,'line-color':'data(color)','line-style':'dotted','target-arrow-shape':'none','curve-style':'bezier',opacity:.5}},
  {selector:'edge',style:{width:'data(width)','line-color':'data(color)','line-style':'data(lineStyle)','target-arrow-color':'data(color)','target-arrow-shape':'triangle','curve-style':'bezier',opacity:.8}},
  {selector:'edge:selected',style:{opacity:1,width:4}},
];}

vscode.postMessage({type:'ready'});
