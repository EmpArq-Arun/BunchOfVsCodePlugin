import * as ifElse from './ifElse.test';
import * as loops from './loops.test';
import * as switchFallthrough from './switchFallthrough.test';
import * as gotoAndDoWhile from './gotoAndDoWhile.test';
import * as doxygen from './doxygen.test';
import * as dotRender from './dotRender.test';
import * as verify from './verify.test';
import * as layoutZoom from './layoutZoom.test';
import * as displayMode from './displayMode.test';
import * as spotcheck from './spotcheck.test';
import * as htmlRender from './htmlRender.test';
import * as e2e from './e2e.test';
import * as preprocProbe from './preprocProbe.test';
import * as preproc from './preproc.test';
import { runCommentChain } from './preproc.test';

async function main(): Promise<void> {
  console.log('Running Vistacode core-logic tests...');
  await ifElse.run(); await loops.run(); await switchFallthrough.run();
  await gotoAndDoWhile.run(); await doxygen.run(); await dotRender.run();
  await verify.run(); await layoutZoom.run(); await displayMode.run();
  await spotcheck.run(); await htmlRender.run(); await e2e.run(); await preprocProbe.run(); await preproc.run(); await runCommentChain();
  console.log('All tests passed.');
}
main().catch(err => { console.error('TEST FAILURE:', err instanceof Error ? err.message : err); process.exit(1); });
