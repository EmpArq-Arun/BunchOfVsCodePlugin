import { parseCFunction } from './helpers';
export async function run() {
  const fn = await parseCFunction(`
  void test_preproc() {
      EXTI->PR1 = EXTI->PR1;
  #ifdef MAG_CODE_SIMULATION
      A();
  #else
      B();
      #ifdef DIAG
          C();
      #endif
  #endif
      D();
  }
  `);
  const body = fn.childForFieldName('body');
  for (const child of body!.namedChildren) {
    console.log(`type=${child.type}`);
    if (child.type.startsWith('preproc')) {
      const name = child.childForFieldName('name')?.text;
      const cond = child.childForFieldName('condition')?.text;
      console.log(`  name=${name} cond=${cond}`);
      const namedKids = child.namedChildren.map(c=>c.type);
      console.log(`  namedChildren: [${namedKids.join(', ')}]`);
      const elseNode = child.namedChildren.find(c=>c.type==='preproc_else');
      if (elseNode) {
        const ekids = elseNode.namedChildren.map(c=>c.type);
        console.log(`  else.namedChildren: [${ekids.join(', ')}]`);
      }
    }
  }
}
