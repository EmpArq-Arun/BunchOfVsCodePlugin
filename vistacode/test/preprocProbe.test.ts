import { parseCFunction } from './helpers';
export async function run(): Promise<void> {
  const fn = await parseCFunction(`
  void test_preproc() {
      EXTI->PR1 = 1;
  #ifdef MAG_CODE
      A();
  #else
      B();
      #ifdef DIAG
          C();
      #endif
  #endif
      D();
  }`);
  const body = fn.childForFieldName('body');
  for (const child of body!.namedChildren) {
    if (!child.type.startsWith('preproc')) continue;
    const name = child.childForFieldName('name')?.text;
    console.log(`  preproc: ${child.type} name=${name}`);
    const elseNode = child.namedChildren.find(c=>c.type==='preproc_else');
    const bodyKids = child.namedChildren
      .filter(c=>c.type!=='preproc_else' && c.type!=='identifier' && c.isNamed)
      .map(c=>c.type);
    console.log(`    body kids: [${bodyKids.join(', ')}]`);
    if (elseNode) console.log(`    else kids: [${elseNode.namedChildren.map(c=>c.type).join(', ')}]`);
  }
  console.log('  preproc AST probe: OK');
}
