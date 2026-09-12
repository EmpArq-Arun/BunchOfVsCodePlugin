import cytoscape from 'cytoscape';
// @ts-ignore
import cytoscapeDagre from 'cytoscape-dagre';
cytoscape.use(cytoscapeDagre);

import type { NodeMetadata, EdgeMetadata, DisplayMode, LayoutMode } from '../dot/dotGenerator';
import type { NodePosition } from '../layout/positionParser';

declare function acquireVsCodeApi(): {
  postMessage(m: unknown): void; setState(s: unknown): void; getState(): unknown;
};
const vscode = acquireVsCodeApi();

type InMsg =
  | { type:'render'; dot:string; functionKey:string;
      nodeData:Record<string,NodeMetadata>; edgeData:EdgeMetadata[];
      positions:Record<string,NodePosition>; layout:LayoutMode }
  | { type:'highlight'; nodeId:string|null }
  | { type:'requestPng' };

const L = {
  preprocFill:'#fef9e7',preprocStroke:'#e67e22',preprocText:'#784212',
  entryFill:'#d4edda',exitFill:'#f8d7da',decisionFill:'#fff3cd',switchFill:'#e8d5f5',
  loopFill:'#cce5ff',processFill:'#f8f9fa',labelFill:'#e2e3e5',
  entryStroke:'#28a745',exitStroke:'#dc3545',decisionStroke:'#856404',switchStroke:'#6f42c1',
  loopStroke:'#004085',processStroke:'#495057',labelStroke:'#6c757d',
  entryText:'#155724',exitText:'#721c24',decisionText:'#533f03',switchText:'#3d1f6a',
  loopText:'#002752',processText:'#212529',labelText:'#383d41',bg:'#ffffff',edgeBg:'rgba(255,255,255,0.9)'
};
const D = {
  preprocFill:'#3d2800',preprocStroke:'#e67e22',preprocText:'#f0a050',
  entryFill:'#1a3d26',exitFill:'#3d1a1a',decisionFill:'#3d3800',switchFill:'#2d1a40',
  loopFill:'#1a3050',processFill:'#252526',labelFill:'#2d2d2d',
  entryStroke:'#4caf70',exitStroke:'#e07070',decisionStroke:'#ddc600',switchStroke:'#b07ee0',
  loopStroke:'#60a0e0',processStroke:'#707070',labelStroke:'#909090',
  entryText:'#6ddb8a',exitText:'#f0a0a0',decisionText:'#ffec4f',switchText:'#d4aaff',
  loopText:'#8bc8ff',processText:'#cccccc',labelText:'#aaaaaa',bg:'#1e1e1e',edgeBg:'rgba(30,30,30,0.9)'
};
const isDark=()=>document.body.classList.contains('vscode-dark')||document.body.classList.contains('vscode-high-contrast');
const C=()=>isDark()?D:L;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStyle():any[]{
  const c=C();
  const eBase={
    'font-family':'"Helvetica Neue",Arial,sans-serif','font-size':'9px',
    'text-background-color':c.edgeBg,'text-background-opacity':1,
    'text-background-padding':'2px','text-background-shape':'roundrectangle'
  } as const;
  return [
    {selector:'node',style:{label:'data(label)','text-wrap':'wrap','text-max-width':'180px',
      'font-family':'"Consolas","Courier New",monospace','font-size':'10px',
      'text-valign':'center','text-halign':'center',padding:'10px','border-width':1.5}},
    {selector:'node[kind="entry"]',style:{shape:'ellipse','background-color':c.entryFill,
      'border-color':c.entryStroke,'border-width':2.5,color:c.entryText,'font-weight':'bold',
      'min-width':'110px','min-height':'44px'}},
    {selector:'node[kind="exit"]',style:{shape:'ellipse','background-color':c.exitFill,
      'border-color':c.exitStroke,'border-width':2.5,color:c.exitText,'min-width':'90px','min-height':'40px'}},
    {selector:'node[kind="decision"]',style:{shape:'diamond','background-color':c.decisionFill,
      'border-color':c.decisionStroke,'border-width':2.0,color:c.decisionText,padding:'28px','text-max-width':'150px'}},
    {selector:'node[kind="switch"]',style:{shape:'diamond','background-color':c.switchFill,
      'border-color':c.switchStroke,'border-width':2.0,color:c.switchText,padding:'28px','text-max-width':'150px'}},
    {selector:'node[kind="loop"]',style:{shape:'hexagon','background-color':c.loopFill,
      'border-color':c.loopStroke,'border-width':2.0,color:c.loopText,padding:'20px','text-max-width':'160px'}},
    {selector:'node[kind="process"]',style:{shape:'round-rectangle','background-color':c.processFill,
      'border-color':c.processStroke,'border-width':1.5,color:c.processText,
      'text-halign':'left','text-margin-x':'4px','min-width':'100px','min-height':'36px'}},
    {selector:'node[kind="preproc"]',style:{shape:'diamond','background-color':c.preprocFill,
      'border-color':c.preprocStroke,'border-width':2,'border-style':'dashed',
      color:c.preprocText,padding:'28px','text-max-width':'160px'}},
    {selector:'node[kind="label"]',style:{shape:'round-rectangle','background-color':c.labelFill,
      'border-color':c.labelStroke,'border-width':1.5,'border-style':'dashed',
      color:c.labelText,'font-size':'9px'}},
    {selector:'node[kind="entry"][isISR="true"]',style:{'border-color':'#e74c3c','border-width':3.5,
      color:c.entryText,'font-style':'italic'}},
    {selector:'node.vc-dim',      style:{opacity:0.1}},
    {selector:'node.vc-debug',    style:{'border-color':'#ff9800','border-width':3}},
    {selector:'node.vc-highlight',style:{'border-color':'#4daafc','border-width':3}},

    {selector:'edge',style:{'curve-style':'bezier','target-arrow-shape':'triangle',
      'arrow-scale':1.1,width:1.4,...eBase,color:'inherit'}},
    {selector:'edge[kind="flow"]',       style:{'line-color':'#495057','target-arrow-color':'#495057',color:'#495057'}},
    {selector:'edge[kind="true"]',       style:{'line-color':'#28a745','target-arrow-color':'#28a745',color:'#28a745',
      'source-label':'Yes','source-text-offset':32}},
    {selector:'edge[kind="false"]',      style:{'line-color':'#dc3545','target-arrow-color':'#dc3545',color:'#dc3545',
      'source-label':'No','source-text-offset':32}},
    {selector:'edge[kind="case"]',       style:{'line-color':'#0056b3','target-arrow-color':'#0056b3',color:'#0056b3',
      label:'data(edgeLabel)'}},
    {selector:'edge[kind="fallthrough"]',style:{'line-color':'#c06000','target-arrow-color':'#c06000',
      'line-style':'dashed',label:'ft',color:'#c06000'}},
    {selector:'edge[kind="break"]',      style:{'line-color':'#dc3545','target-arrow-color':'#dc3545',
      'line-style':'dashed',color:'#dc3545'}},
    {selector:'edge[kind="continue"]',   style:{'line-color':'#0056b3','target-arrow-color':'#0056b3',
      'line-style':'dashed',color:'#0056b3'}},
    {selector:'edge[kind="goto"]',       style:{'line-color':'#6f42c1','target-arrow-color':'#6f42c1',
      'line-style':'dotted',label:'→',color:'#6f42c1'}},
    {selector:'edge[kind="loop-back"]',  style:{'line-color':'#138496','target-arrow-color':'#138496',width:3,color:'#138496'}},
    {selector:'edge.vc-dim',             style:{opacity:0.06}},
    {selector:'edge.vc-highlight',       style:{width:3}},
  ];
}

function displayLabel(meta:NodeMetadata,mode:DisplayMode):string{
  if(meta.kind==='entry'||meta.kind==='exit') return meta.fullLabel;
  if(meta.kind==='preproc') return meta.fullLabel; // always show #ifdef / #if text
  switch(mode){
    case 'code':return(meta.codeLines??[]).join('\n')||meta.fullLabel;
    case 'both':{const code=(meta.codeLines??[]).join('\n');
      return meta.annotation?`${meta.annotation}\n────\n${code}`:code;}
    // comment mode: annotation text wins; fall back to code; never empty
    default:{const code=(meta.codeLines??[]).join('\n');return meta.annotation??(code||meta.fullLabel);}
  }
}

let cy:cytoscape.Core|null=null;
let currentNodeData:Record<string,NodeMetadata>={};
let currentFunctionKey='';
let currentDisplayMode:DisplayMode='comment';
let currentLayout:LayoutMode='vertical';
const positionStore:Record<string,Record<string,{x:number,y:number}>>={};
let activeFilter:string|null=null;

const cyContainer  = document.getElementById('cy')           as HTMLDivElement;
const funcNameEl   = document.getElementById('function-name')as HTMLSpanElement;
const zoomLabelEl  = document.getElementById('zoom-label')   as HTMLSpanElement;
const layoutGroup  = document.getElementById('layout-group') as HTMLDivElement;
const displayGroup = document.getElementById('display-group')as HTMLDivElement;
const legendEl     = document.getElementById('legend')       as HTMLDivElement;
const legendClear  = document.getElementById('legend-clear') as HTMLElement;
const btnZoomIn    = document.getElementById('btn-zoom-in')  as HTMLButtonElement;
const btnZoomOut   = document.getElementById('btn-zoom-out') as HTMLButtonElement;
const btnFit       = document.getElementById('btn-fit')      as HTMLButtonElement;
const btnReset     = document.getElementById('btn-reset')    as HTMLButtonElement;
const tooltipEl    = document.getElementById('vc-tooltip')   as HTMLDivElement;

function showTooltip(e:MouseEvent,lines:string[]){
  const c=C();
  Object.assign(tooltipEl.style,{background:c.bg,color:c.processText,
    border:`1px solid ${isDark()?'#555':'#ccc'}`});
  tooltipEl.textContent=lines.join('\n');
  tooltipEl.style.display='block';
  positionTooltip(e);
}
function positionTooltip(e:MouseEvent){
  const pad=14;
  let x=e.clientX+pad,y=e.clientY+pad;
  if(x+tooltipEl.offsetWidth >window.innerWidth) x=e.clientX-tooltipEl.offsetWidth -pad;
  if(y+tooltipEl.offsetHeight>window.innerHeight)y=e.clientY-tooltipEl.offsetHeight-pad;
  tooltipEl.style.left=`${x}px`;tooltipEl.style.top=`${y}px`;
}
function hideTooltip(){tooltipEl.style.display='none';}

function applyFilter(kind:string|null){
  activeFilter=kind;
  legendClear.style.display=kind?'block':'none';
  legendEl.querySelectorAll<HTMLElement>('.legend-row').forEach(r=>
    r.classList.toggle('active-filter',r.dataset.edgeKind===kind||r.dataset.nodeKind===kind));
  if(!cy) return;
  if(!kind){cy.elements().removeClass('vc-dim vc-highlight');return;}
  cy.elements().addClass('vc-dim').removeClass('vc-highlight');
  const edgeKinds=['flow','true','false','case','fallthrough','break','continue','goto','loop-back'];
  if(edgeKinds.includes(kind)){
    const edges=cy.edges(`[kind="${kind}"]`);
    edges.removeClass('vc-dim').addClass('vc-highlight');
    edges.connectedNodes().removeClass('vc-dim');
  } else {
    const nodes=cy.nodes(`[kind="${kind}"]`);
    nodes.removeClass('vc-dim').addClass('vc-highlight');
    nodes.connectedEdges().removeClass('vc-dim');
  }
}

function initCy(
  nodeData:Record<string,NodeMetadata>,edgeData:EdgeMetadata[],
  positions:Record<string,NodePosition>,functionKey:string,
  mode:DisplayMode,preserveView:boolean
){
  currentNodeData=nodeData;
  const saved=positionStore[functionKey]??{};
  const TRUNC=24;
  const nodes=Object.entries(nodeData).map(([id,meta])=>{
    const pos=saved[id]??positions[id]??{x:0,y:0};
    return{data:{id,label:displayLabel(meta,mode),kind:meta.kind,anchorRow:meta.anchorRow,isISR:String(meta.isISR)},
           position:{x:pos.x,y:pos.y}};
  });
  const edges=edgeData.map((e,i)=>{
    const raw=e.label??'';
    return{data:{id:`e${i}`,source:e.from,target:e.to,kind:e.kind,
      edgeLabel:raw.length>TRUNC?raw.slice(0,TRUNC)+'…':raw}};
  });
  const prevZoom=cy?.zoom(),prevPan=cy?.pan();
  if(cy){cy.destroy();cy=null;}
  cy=cytoscape({container:cyContainer,elements:{nodes,edges},style:makeStyle(),
    layout: Object.keys(positions).length > 0 ? {name:'preset'} :
      // Fallback to dagre when positions not yet computed (first load race condition)
      ({name:'dagre','rankDir':'TB','nodeSep':60,'rankSep':80,'padding':40} as any),
    minZoom:0.05,maxZoom:8,boxSelectionEnabled:false,selectionType:'single'});
  cy.on('zoom',()=>{zoomLabelEl.textContent=`${Math.round(cy!.zoom()*100)}%`;});
  cy.on('dragfree','node',()=>{
    positionStore[functionKey]={};
    cy!.nodes().forEach(n=>{positionStore[functionKey][n.id()]={...n.position()};});
  });
  cy.on('tap','node',e=>{
    const id=e.target.id();const meta=currentNodeData[id];if(!meta)return;
    const oe=e.originalEvent as MouseEvent;
    if(oe?.ctrlKey||oe?.metaKey){
      vscode.postMessage({type:'renameRequest',nodeId:id,currentLabel:e.target.data('label')});
    } else {
      vscode.postMessage({type:'navigateToLine',row:meta.anchorRow});
    }
  });
  cy.on('mouseover','node',e=>{
    const meta=currentNodeData[e.target.id()];if(!meta)return;
    const lines:string[]=[];
    if(meta.annotation) lines.push(meta.annotation,'────');
    if(meta.codeLines?.length) lines.push(...meta.codeLines);
    else if(!meta.annotation) lines.push(meta.fullLabel);
    showTooltip(e.originalEvent as MouseEvent,lines.length?lines:[meta.fullLabel]);
  });
  cy.on('mousemove','node',e=>{positionTooltip(e.originalEvent as MouseEvent);});
  cy.on('mouseout','node',()=>hideTooltip());
  cy.on('grab',()=>cyContainer.classList.add('grabbing'));
  cy.on('ungrab',()=>cyContainer.classList.remove('grabbing'));
  cy.on('tap',e=>{if(e.target===cy)hideTooltip();});
  // Suppress any native browser tooltips (canvas title attr) (#2)
  const suppressTitles=()=>{
    cyContainer.querySelectorAll('[title]').forEach(el=>el.removeAttribute('title'));
    if(cyContainer.title)cyContainer.title='';
  };
  cy.on('render',suppressTitles);
  requestAnimationFrame(suppressTitles);

  if(preserveView&&prevZoom&&prevPan){
    cy.viewport({zoom:prevZoom,pan:prevPan});
  } else {
    requestAnimationFrame(()=>cy?.fit(undefined,60));
  }
  if(activeFilter){const f=activeFilter;activeFilter=null;applyFilter(f);}
}

function applyDisplayMode(mode:DisplayMode){
  currentDisplayMode=mode;
  if(!cy)return;
  cy.nodes().forEach(n=>{const meta=currentNodeData[n.id()];if(meta)n.data('label',displayLabel(meta,mode));});
}

displayGroup.addEventListener('click',e=>{
  const btn=(e.target as HTMLElement).closest<HTMLElement>('[data-display]');if(!btn)return;
  const mode=btn.dataset.display as DisplayMode;
  displayGroup.querySelectorAll('.tb-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  applyDisplayMode(mode);
  vscode.postMessage({type:'changeDisplayMode',mode});
});
layoutGroup.addEventListener('click',e=>{
  const btn=(e.target as HTMLElement).closest<HTMLElement>('[data-layout]');if(!btn)return;
  const layout=btn.dataset.layout as LayoutMode;
  currentLayout=layout;
  layoutGroup.querySelectorAll('.tb-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  vscode.postMessage({type:'changeLayout',layout});
});
btnReset.addEventListener('click',()=>{
  delete positionStore[currentFunctionKey];
  vscode.postMessage({type:'changeLayout',layout:currentLayout});
});
btnZoomIn.addEventListener('click',()=>{
  if(!cy)return;
  const ctr={x:cyContainer.offsetWidth/2,y:cyContainer.offsetHeight/2};
  cy.zoom({level:Math.min(8,cy.zoom()*1.2),renderedPosition:ctr});
});
btnZoomOut.addEventListener('click',()=>{
  if(!cy)return;
  const ctr={x:cyContainer.offsetWidth/2,y:cyContainer.offsetHeight/2};
  cy.zoom({level:Math.max(0.05,cy.zoom()/1.2),renderedPosition:ctr});
});
btnFit.addEventListener('click',()=>cy?.fit(undefined,60));

legendEl.addEventListener('click',e=>{
  const row=(e.target as HTMLElement).closest<HTMLElement>('.legend-row');
  if(row){const kind=row.dataset.edgeKind??row.dataset.nodeKind??null;
    applyFilter(activeFilter===kind?null:kind);return;}
  if((e.target as HTMLElement).id==='legend-clear')applyFilter(null);
});

new MutationObserver(()=>{cy?.style(makeStyle() as Parameters<typeof cy.style>[0]);})
  .observe(document.body,{attributeFilter:['class']});
window.addEventListener('resize',()=>cy?.resize());

window.addEventListener('message',(ev:MessageEvent<InMsg>)=>{
  const msg=ev.data;
  switch(msg.type){
    case 'render':{
      try{
      const same=msg.functionKey===currentFunctionKey;
      currentFunctionKey=msg.functionKey;currentLayout=msg.layout;
      layoutGroup.querySelectorAll<HTMLElement>('[data-layout]').forEach(b=>
        b.classList.toggle('active',b.dataset.layout===msg.layout));
      funcNameEl.textContent=msg.functionKey.replace(/@[0-9a-f]+$/,'');
      initCy(msg.nodeData,msg.edgeData,msg.positions,msg.functionKey,currentDisplayMode,same);
      }catch(err){
        console.error('Vistacode render error:',err);
        cyContainer.innerHTML=`<div style="color:var(--vscode-errorForeground,#f48771);padding:30px;font-family:monospace">
          <b>Vistacode render error</b><br><pre>${String(err)}</pre>
          <small>Open DevTools (Help → Toggle Developer Tools) for details</small></div>`;
      }
      break;
    }
    case 'highlight':{
      cy?.nodes().removeClass('vc-debug');
      if(msg.nodeId)cy?.nodes(`#${msg.nodeId}`).addClass('vc-debug');break;
    }
    case 'requestPng':{
      if(!cy){vscode.postMessage({type:'pngData',data:''});return;}
      const data=cy.png({output:'base64uri',scale:2,full:true,bg:C().bg});
      vscode.postMessage({type:'pngData',data});break;
    }
  }
});
vscode.postMessage({type:'ready'});
