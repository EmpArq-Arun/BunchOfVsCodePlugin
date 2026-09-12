import { parseCFunction, assert } from './helpers';
import { buildCFG } from '../src/parser/cfgBuilder';
import { cfgToDot, extractNodeMetadata, extractEdgeMetadata } from '../src/dot/dotGenerator';
import { renderSvgWithEngine } from '../src/export/svgRenderer';
import { parsePositionsFromSvg } from '../src/layout/positionParser';

export async function run(): Promise<void> {
  // ── Test 1: #ifdef creates decision node
  const fn1 = await parseCFunction(`
  void EXTI3_IRQHandler() {
      EXTI->PR1 = EXTI->PR1 & FLAG;
  #ifdef MAG_CODE_SIMULATION
      MagCode = GetSimulatedMagCode();
  #else
      NVIC_ClearPendingIRQ(EXTI3_IRQn);
      MagCode = (U16)(GPIOE->IDR & MASK);
      #ifdef COMMUTATE_DIAG
          SerialPrintf("[c5 %u]", MagCode);
      #endif
  #endif
      MotorCommutate();
  }`);
  const g1 = buildCFG(fn1);
  const preprocNodes = [...g1.nodes.values()].filter(n => n.kind === 'preproc');
  assert(preprocNodes.length >= 1, `Expected at least 1 preproc node, got ${preprocNodes.length}`);
  assert(preprocNodes[0].label.includes('#ifdef') && preprocNodes[0].label.includes('MAG_CODE_SIMULATION'),
    `preproc label wrong: "${preprocNodes[0].label}"`);
  console.log(`  #ifdef creates ${preprocNodes.length} preproc decision node(s): OK`);
  console.log(`    labels: ${preprocNodes.map(n=>n.label).join(', ')}`);

  // ── Test 2: ISR detection
  const entryNode = [...g1.nodes.values()].find(n => n.kind === 'entry');
  assert(entryNode?.isISR === true, 'EXTI3_IRQHandler should be marked as ISR');
  console.log('  ISR detection (IRQHandler naming): OK');

  // ── Test 3: preproc edges (true/false branches)
  const preprocId = preprocNodes[0].id;
  const trueEdge  = g1.edges.find(e => e.from === preprocId && e.kind === 'true');
  const falseEdge = g1.edges.find(e => e.from === preprocId && e.kind === 'false');
  assert(!!trueEdge,  'preproc node must have a true edge');
  assert(!!falseEdge, 'preproc node must have a false edge');
  console.log('  preproc true/false edges: OK');

  // ── Test 4: non-ISR function has isISR=false
  const fn2 = await parseCFunction(`void MotorCommutate(void) { run(); }`);
  const g2 = buildCFG(fn2);
  const e2 = [...g2.nodes.values()].find(n => n.kind === 'entry');
  assert(e2?.isISR !== true, 'regular function should not be marked ISR');
  console.log('  non-ISR function correctly unmarked: OK');

  // ── Test 5: dot generation and SVG render with preproc nodes
  const dot = cfgToDot(g1, 'comment');
  // preproc nodes show in dot as node ids — verify count
  const preprocCount = (dot.match(/fillcolor/g) ?? []).length;
  assert(preprocCount >= g1.nodes.size - 2, 'dot should have fillcolor for most nodes'); // entry and exit counted
  const svg = await renderSvgWithEngine(dot, 'dot');
  const pos = parsePositionsFromSvg(svg);
  assert(Object.keys(pos).length === g1.nodes.size,
    `Expected ${g1.nodes.size} positions, got ${Object.keys(pos).length}`);
  console.log(`  preproc full pipeline (${g1.nodes.size} nodes, ${g1.edges.length} edges): OK`);

  // ── Test 6: NodeMetadata.isISR flows through extractNodeMetadata
  const nodeData = extractNodeMetadata(g1);
  const entryMeta = Object.values(nodeData).find(m => m.kind === 'entry');
  assert(entryMeta?.isISR === true, 'isISR must flow to NodeMetadata');
  const preprocMeta = Object.values(nodeData).find(m => m.kind === 'preproc');
  assert(preprocMeta !== undefined, 'preproc NodeMetadata must exist');
  console.log('  NodeMetadata.isISR flows correctly: OK');

  console.log('  All preproc + ISR tests passed');
}

export async function runCommentChain(): Promise<void> {
  // Test multiline // comment chain
  const fn1 = await parseCFunction(`
  void test_comments() {
      // Clear the external pending flag
      // Must be done before re-enabling interrupts
      EXTI->PR1 = EXTI->PR1 & EXTI_PR1_PIF3;

      /* Block comment
       * spanning multiple lines
       * gives rich context */
      MotorCommutate();
  }`);
  const g1 = buildCFG(fn1);
  const { findAnnotationFor } = require('../src/annotations/commentExtractor');
  const nodeData = extractNodeMetadata(g1);

  // Process nodes should pick up adjacent comments
  const processNodes = Object.values(nodeData).filter(m => m.kind === 'process');
  console.log('  Process node annotations:');
  processNodes.forEach(n => {
    if (n.annotation) console.log(`    "${n.annotation}"`);
  });
  const annotated = processNodes.filter(m => m.annotation !== null);
  assert(annotated.length >= 1, 'At least one process node should have an annotation');

  // First node (EXTI clear) should have both // lines joined
  const extiNode = processNodes.find(n => n.codeLines[0]?.includes('EXTI'));
  if (extiNode?.annotation) {
    assert(extiNode.annotation.includes('Clear') || extiNode.annotation.includes('Must'),
      `Annotation should contain the comment text, got: "${extiNode.annotation}"`);
    const hasMultiLine = extiNode.annotation.includes('\n');
    console.log(`    Chain of // comments collected: ${hasMultiLine ? 'YES (multiline)' : 'single line'}`);
  }

  // Block comment node
  const motorNode = processNodes.find(n => n.codeLines[0]?.includes('MotorCommutate'));
  if (motorNode?.annotation) {
    assert(motorNode.annotation.includes('Block') || motorNode.annotation.includes('spanning'),
      `Block comment not captured: "${motorNode.annotation}"`);
    const hasLines = motorNode.annotation.includes('\n');
    console.log(`    Block comment (multiline): ${hasLines ? 'YES' : 'single line'}`);
  }
  console.log('  multiline comment chain: OK');
}
