import type Parser from 'web-tree-sitter';
import type { CFGNode, CFGNodeKind, CFGEdge, CFGEdgeKind, ControlFlowGraph, ExitPoint, SourceRange } from './cfgTypes';
import { findAnnotationFor } from '../annotations/commentExtractor';
import { heuristicLabelFor } from '../annotations/heuristics';

const CONTROL_TYPES = new Set([
  'if_statement','for_statement','while_statement','do_statement','switch_statement',
  'goto_statement','break_statement','continue_statement','return_statement',
  'labeled_statement','compound_statement',
  // Preprocessor conditionals treated as compile-time decision nodes
  'preproc_ifdef','preproc_ifndef','preproc_if','preproc_elif',
]);

interface HandlerResult { outgoing: ExitPoint[]; firstId: string; }

function oneLine(t: string): string { return t.replace(/\s+/g,' ').trim(); }
function truncate(t: string, max = 60): string { return t.length > max ? t.slice(0,max-1)+'\u2026' : t; }
function stripParens(t: string): string { return oneLine(t.replace(/^\(([\s\S]*)\)$/,'$1')); }

export function getFunctionName(fn: Parser.SyntaxNode): string {
  let d: Parser.SyntaxNode|null = fn.childForFieldName('declarator');
  while (d) {
    if (d.type==='identifier'||d.type==='field_identifier') return d.text;
    d = d.childForFieldName('declarator');
  }
  return 'function';
}

class CFGBuilderState {
  private counter = 0;
  private nodes  = new Map<string,CFGNode>();
  private edges: CFGEdge[] = [];
  private loopStack: { continueTargetId: string }[] = [];
  private breakStack: ExitPoint[][] = [];
  private labelTargets = new Map<string,string>();
  private entryId = '';
  private exitId  = '';

  build(fn: Parser.SyntaxNode): ControlFlowGraph {
    const functionName = getFunctionName(fn);
    this.entryId = this.nextId();
    this.exitId  = this.nextId();
    this.nodes.set(this.entryId, this.bareNode(this.entryId,'entry',`${functionName}\nEntry`,[`${functionName}\nEntry`],fn));
    this.nodes.set(this.exitId,  this.bareNode(this.exitId, 'exit', 'Exit', ['Exit'], fn));

    // Mark ISRs — ARM Cortex-M naming conventions
    const ISR_SUFFIXES = ['IRQHandler','_ISR','IT_Callback','_Callback','_IRQ'];
    if (ISR_SUFFIXES.some(s => functionName.includes(s))) {
      this.nodes.get(this.entryId)!.isISR = true;
    }

    const body = fn.childForFieldName('body');
    const stmts = this.getBodyStatements(body);
    if (body) {
      for (const lbl of body.descendantsOfType('labeled_statement')) {
        const lf = lbl.childForFieldName('label');
        if (lf && !this.labelTargets.has(lf.text)) this.labelTargets.set(lf.text, this.nextId());
      }
    }
    const result = this.buildSeqDetailed(stmts,[{id:this.entryId,kind:'flow'}]);
    this.connect(result.outgoing, this.exitId);
    return { functionName, entryId:this.entryId, exitId:this.exitId, nodes:this.nodes, edges:this.edges };
  }

  private nextId(): string { return `n${++this.counter}`; }
  private rangeOf(n: Parser.SyntaxNode): SourceRange {
    return { start:{row:n.startPosition.row,column:n.startPosition.column},
             end:  {row:n.endPosition.row,  column:n.endPosition.column  } };
  }

  private bareNode(id:string, kind:CFGNodeKind, text:string, lines:string[], anchor:Parser.SyntaxNode): CFGNode {
    return { id, kind, rawText:text, rawLines:lines, label:text, labelFromAnnotation:false, annotation:null, anchorRange:this.rangeOf(anchor) };
  }

  private addNode(id:string, kind:CFGNodeKind, anchor:Parser.SyntaxNode, rawLines:string[]): void {
    const rawText = rawLines.join('\n');
    const ann = findAnnotationFor(anchor);
    let label: string; let labelFromAnnotation = false;
    if (ann) { label = ann; labelFromAnnotation = true; }
    else {
      const h = (kind==='decision'||kind==='loop'||kind==='switch') ? heuristicLabelFor(rawLines[0]??rawText) : null;
      label = h ?? truncate(rawText);
    }
    this.nodes.set(id, { id, kind, rawText, rawLines, label, labelFromAnnotation,
                         annotation: labelFromAnnotation ? ann : null, anchorRange:this.rangeOf(anchor) });
  }

  private connect(eps:ExitPoint[], to:string, override?:CFGEdgeKind): void {
    for (const ep of eps) this.edges.push({from:ep.id,to,kind:override??ep.kind,label:ep.label});
  }

  private getBodyStatements(b:Parser.SyntaxNode|null): Parser.SyntaxNode[] {
    if (!b) return [];
    if (b.type==='compound_statement') return b.namedChildren.filter(c=>c.type!=='comment');
    return [b];
  }

  private buildSeqDetailed(stmts:Parser.SyntaxNode[], incoming:ExitPoint[]): {outgoing:ExitPoint[];entryId:string|null} {
    let cur = incoming;
    let entryId: string|null = null;
    let buffer: Parser.SyntaxNode[] = [];
    const note = (id:string) => { if (!entryId) entryId=id; };

    const flush = () => {
      if (!buffer.length) return;
      const id = this.nextId();
      // #2 — each statement on its own line instead of joined with "; "
      const lines = buffer.map(s => oneLine(s.text));
      this.addNode(id,'process',buffer[0],lines);
      this.connect(cur,id); note(id);
      cur = [{id,kind:'flow'}];
      buffer = [];
    };

    for (const s of stmts) {
      if (s.type==='comment') continue;
      if (CONTROL_TYPES.has(s.type)) { flush(); const r=this.dispatch(s,cur); note(r.firstId); cur=r.outgoing; }
      else buffer.push(s);
    }
    flush();
    return {outgoing:cur,entryId};
  }

  private buildSeq(stmts:Parser.SyntaxNode[], inc:ExitPoint[]): ExitPoint[] {
    return this.buildSeqDetailed(stmts,inc).outgoing;
  }

  private dispatch(s:Parser.SyntaxNode, inc:ExitPoint[]): HandlerResult {
    switch (s.type) {
      case 'if_statement':       return this.handleIf(s,inc);
      case 'for_statement':      return this.handleFor(s,inc);
      case 'while_statement':    return this.handleWhile(s,inc);
      case 'do_statement':       return this.handleDoWhile(s,inc);
      case 'switch_statement':   return this.handleSwitch(s,inc);
      case 'goto_statement':     return this.handleGoto(s,inc);
      case 'break_statement':    return this.handleBreak(inc);
      case 'continue_statement': return this.handleContinue(inc);
      case 'return_statement':   return this.handleReturn(s,inc);
      case 'labeled_statement':  return this.handleLabeled(s,inc);
      case 'compound_statement': {
        const inner = s.namedChildren.filter(c=>c.type!=='comment');
        const d = this.buildSeqDetailed(inner,inc);
        return {outgoing:d.outgoing,firstId:d.entryId??inc[0]?.id??this.entryId};
      }
      case 'preproc_ifdef':
      case 'preproc_ifndef': return this.handlePreprocIfdef(s,inc);
      case 'preproc_if':
      case 'preproc_elif':   return this.handlePreprocIf(s,inc);
      default: return this.handleSimple(s,inc);
    }
  }

  private handlePreprocIfdef(node: Parser.SyntaxNode, inc: ExitPoint[]): HandlerResult {
    const macroName = node.childForFieldName('name')?.text ?? 'MACRO';
    const directive  = node.type === 'preproc_ifndef' ? '#ifndef' : '#ifdef';
    const label = `${directive} ${macroName}`;

    const id = this.nextId();
    // Use 'preproc' kind for distinct visual style (compile-time condition)
    this.nodes.set(id, {
      id, kind: 'preproc', rawText: label, rawLines: [label], label,
      labelFromAnnotation: false, annotation: null,
      anchorRange: this.rangeOf(node)
    });
    this.connect(inc, id);

    // Body: namedChildren before preproc_else (exclude the name identifier)
    const SKIP = new Set(['identifier','preproc_else','preproc_elif','preproc_else_if']);
    const bodyKids = node.namedChildren.filter(c => !SKIP.has(c.type) && c.type !== 'comment');
    const elseNode  = node.namedChildren.find(c => c.type === 'preproc_else');

    const trueOut  = this.buildSeq(bodyKids, [{id, kind:'true'}]);
    let   falseOut: ExitPoint[];
    if (elseNode) {
      const elseKids = elseNode.namedChildren.filter(c => c.type !== 'comment');
      falseOut = this.buildSeq(elseKids, [{id, kind:'false'}]);
    } else {
      falseOut = [{id, kind:'false'}];
    }
    return {outgoing:[...trueOut,...falseOut], firstId:id};
  }

  private handlePreprocIf(node: Parser.SyntaxNode, inc: ExitPoint[]): HandlerResult {
    const cond = node.childForFieldName('condition')?.text ?? '?';
    const directive = node.type === 'preproc_elif' ? '#elif' : '#if';
    const label = `${directive} ${oneLine(cond)}`;

    const id = this.nextId();
    this.nodes.set(id, {
      id, kind: 'preproc', rawText: label, rawLines: [label], label,
      labelFromAnnotation: false, annotation: null,
      anchorRange: this.rangeOf(node)
    });
    this.connect(inc, id);

    const SKIP = new Set(['preproc_else','preproc_elif','preproc_else_if']);
    const bodyKids = node.namedChildren.filter(c => !SKIP.has(c.type) && c.type !== 'comment'
      && c.type !== 'string_literal' // avoid matching the condition expression node
    );
    // Actually, just take children that come before any preproc_else/elif
    const trueKids: Parser.SyntaxNode[] = [];
    let hitElse = false;
    for (const c of node.namedChildren) {
      if (c.type === 'preproc_else' || c.type === 'preproc_elif') { hitElse = true; break; }
      if (c.type !== 'comment') trueKids.push(c);
    }
    // skip the condition node itself (it's not a statement)
    const trueStmts = trueKids.filter(c => {
      const t = c.type;
      return t !== 'number_literal' && t !== 'identifier' && t !== 'binary_expression'
        && t !== 'unary_expression' && t !== 'parenthesized_expression' && t !== 'string_literal';
    });

    const elseNode = node.namedChildren.find(c => c.type === 'preproc_else');
    const trueOut  = this.buildSeq(trueStmts, [{id, kind:'true'}]);
    let falseOut: ExitPoint[];
    if (elseNode) {
      const elseKids = elseNode.namedChildren.filter(c => c.type !== 'comment');
      falseOut = this.buildSeq(elseKids, [{id, kind:'false'}]);
    } else {
      falseOut = [{id, kind:'false'}];
    }
    return {outgoing:[...trueOut,...falseOut], firstId:id};
  }

  private handleSimple(s:Parser.SyntaxNode, inc:ExitPoint[]): HandlerResult {
    const id = this.nextId();
    this.addNode(id,'process',s,[oneLine(s.text)]);
    this.connect(inc,id);
    return {outgoing:[{id,kind:'flow'}],firstId:id};
  }

  private handleIf(node:Parser.SyntaxNode, inc:ExitPoint[]): HandlerResult {
    const cond = node.childForFieldName('condition');
    const id = this.nextId();
    this.addNode(id,'decision',node,[cond ? stripParens(cond.text) : '?']);
    this.connect(inc,id);

    const cons = node.childForFieldName('consequence');
    const trueOut = cons ? this.buildSeq(this.getBodyStatements(cons),[{id,kind:'true'}]) : [{id,kind:'true' as CFGEdgeKind}];

    const alt = node.childForFieldName('alternative');
    let falseOut: ExitPoint[];
    if (alt) {
      const inner = alt.namedChild(0);
      if (inner?.type==='if_statement') falseOut = this.handleIf(inner,[{id,kind:'false'}]).outgoing;
      else if (inner) falseOut = this.buildSeq(this.getBodyStatements(inner),[{id,kind:'false'}]);
      else falseOut = [{id,kind:'false'}];
    } else falseOut = [{id,kind:'false'}];

    return {outgoing:[...trueOut,...falseOut],firstId:id};
  }

  private handleFor(node:Parser.SyntaxNode, inc:ExitPoint[]): HandlerResult {
    let cur = inc; let firstId:string|null = null;
    const init = node.childForFieldName('initializer');
    if (init) {
      const iid = this.nextId();
      this.addNode(iid,'process',init,[oneLine(init.text)]);
      this.connect(cur,iid); firstId=iid; cur=[{id:iid,kind:'flow'}];
    }
    const cond = node.childForFieldName('condition');
    const lid = this.nextId();
    this.addNode(lid,'loop',node,[cond ? stripParens(cond.text) : 'true']);
    this.connect(cur,lid); firstId=firstId??lid;
    const upd = node.childForFieldName('update');
    const ctId = upd ? this.nextId() : lid;
    const bCtx:ExitPoint[] = [];
    this.loopStack.push({continueTargetId:ctId}); this.breakStack.push(bCtx);
    const bodyOut = this.buildSeq(this.getBodyStatements(node.childForFieldName('body')),[{id:lid,kind:'true'}]);
    this.loopStack.pop(); this.breakStack.pop();
    if (upd) { this.addNode(ctId,'process',upd,[oneLine(upd.text)]); this.connect(bodyOut,ctId); this.connect([{id:ctId,kind:'flow'}],lid,'loop-back'); }
    else this.connect(bodyOut,lid,'loop-back');
    return {outgoing:[{id:lid,kind:'false'},...bCtx],firstId};
  }

  private handleWhile(node:Parser.SyntaxNode, inc:ExitPoint[]): HandlerResult {
    const cond = node.childForFieldName('condition');
    const id = this.nextId();
    this.addNode(id,'loop',node,[cond ? stripParens(cond.text) : '?']);
    this.connect(inc,id);
    const bCtx:ExitPoint[] = [];
    this.loopStack.push({continueTargetId:id}); this.breakStack.push(bCtx);
    const bodyOut = this.buildSeq(this.getBodyStatements(node.childForFieldName('body')),[{id,kind:'true'}]);
    this.loopStack.pop(); this.breakStack.pop();
    this.connect(bodyOut,id,'loop-back');
    return {outgoing:[{id,kind:'false'},...bCtx],firstId:id};
  }

  private handleDoWhile(node:Parser.SyntaxNode, inc:ExitPoint[]): HandlerResult {
    const cond = node.childForFieldName('condition');
    const condId = this.nextId();
    const bCtx:ExitPoint[] = [];
    this.loopStack.push({continueTargetId:condId}); this.breakStack.push(bCtx);
    const bd = this.buildSeqDetailed(this.getBodyStatements(node.childForFieldName('body')),inc);
    this.loopStack.pop(); this.breakStack.pop();
    this.addNode(condId,'loop',node,[cond ? stripParens(cond.text) : '?']);
    this.connect(bd.outgoing,condId);
    this.edges.push({from:condId,to:bd.entryId??condId,kind:'loop-back'});
    return {outgoing:[{id:condId,kind:'false'},...bCtx],firstId:bd.entryId??condId};
  }

  private handleSwitch(node:Parser.SyntaxNode, inc:ExitPoint[]): HandlerResult {
    const cond = node.childForFieldName('condition');
    const id = this.nextId();
    this.addNode(id,'switch',node,[cond ? stripParens(cond.text) : '?']);
    this.connect(inc,id);
    const bCtx:ExitPoint[] = [];
    this.breakStack.push(bCtx);
    const body = node.childForFieldName('body');
    const cases = body ? body.namedChildren.filter(c=>c.type==='case_statement') : [];
    let pending:ExitPoint[] = [], ftOut:ExitPoint[] = [], hasDefault=false;
    for (const cs of cases) {
      const val = cs.childForFieldName('value');
      if (!val) hasDefault=true;
      const lbl = val ? stripParens(val.text) : 'default';
      const stmts = cs.namedChildren.filter(c=>c.id!==val?.id && c.type!=='comment');
      const entry:ExitPoint = {id,kind:'case',label:lbl};
      if (!stmts.length) { pending.push(entry); continue; }
      const incForCase:ExitPoint[] = [...pending,entry,...ftOut.map(ep=>({...ep,kind:'fallthrough' as CFGEdgeKind}))];
      pending=[];
      ftOut = this.buildSeq(stmts,incForCase);
    }
    this.breakStack.pop();
    const noMatch = hasDefault ? [] : [{id,kind:'case' as CFGEdgeKind,label:'no match'}];
    return {outgoing:[...pending,...ftOut,...bCtx,...noMatch],firstId:id};
  }

  private handleGoto(node:Parser.SyntaxNode, inc:ExitPoint[]): HandlerResult {
    const id=this.nextId(), lf=node.childForFieldName('label'), ln=lf?.text??'?';
    this.addNode(id,'process',node,[`goto ${ln}`]);
    this.connect(inc,id);
    const t=this.labelTargets.get(ln);
    if (t) this.edges.push({from:id,to:t,kind:'goto'});
    return {outgoing:[],firstId:id};
  }

  private handleBreak(inc:ExitPoint[]): HandlerResult {
    const ctx=this.breakStack[this.breakStack.length-1];
    if (ctx) for (const ep of inc) ctx.push({id:ep.id,kind:'break'});
    return {outgoing:[],firstId:inc[0]?.id??this.entryId};
  }

  private handleContinue(inc:ExitPoint[]): HandlerResult {
    const ctx=this.loopStack[this.loopStack.length-1];
    if (ctx) for (const ep of inc) this.edges.push({from:ep.id,to:ctx.continueTargetId,kind:'continue'});
    return {outgoing:[],firstId:inc[0]?.id??this.entryId};
  }

  private handleReturn(node:Parser.SyntaxNode, inc:ExitPoint[]): HandlerResult {
    const id=this.nextId();
    this.addNode(id,'process',node,[oneLine(node.text)]);
    this.connect(inc,id);
    this.edges.push({from:id,to:this.exitId,kind:'flow'});
    return {outgoing:[],firstId:id};
  }

  private handleLabeled(node:Parser.SyntaxNode, inc:ExitPoint[]): HandlerResult {
    const lf=node.childForFieldName('label'), ln=lf?.text??'?';
    const id=this.labelTargets.get(ln)??this.nextId();
    this.addNode(id,'label',node,[`${ln}:`]);
    this.connect(inc,id);
    const inner=node.namedChild(node.namedChildCount-1);
    if (inner && inner.id!==lf?.id) {
      const r=CONTROL_TYPES.has(inner.type)?this.dispatch(inner,[{id,kind:'flow'}]):this.handleSimple(inner,[{id,kind:'flow'}]);
      return {outgoing:r.outgoing,firstId:id};
    }
    return {outgoing:[{id,kind:'flow'}],firstId:id};
  }
}

export function buildCFG(fn:Parser.SyntaxNode): ControlFlowGraph {
  return new CFGBuilderState().build(fn);
}
