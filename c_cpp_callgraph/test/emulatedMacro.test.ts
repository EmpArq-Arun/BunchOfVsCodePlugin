import { WorkspaceIndex } from '../src/parser/workspaceIndex';

let failures = 0;
const check = (l: string, c: boolean) => { if (c) console.log(`  ok  - ${l}`); else { console.log(`FAIL  - ${l}`); failures++; } };

async function main() {
  (global as any).__mockFiles = {
    'mot_if.h': `
/* Interface layer */
#define MOT_IF_emulatedCommStart(speed_rpm) COM_emulatedCommStart(speed_rpm)
#define MOT_IF_CommutationTask(mag)         COM_CommutationTask(mag)
`,
    'com_motor.c': `
void COM_emulatedCommStart(int speed_rpm) {}
void COM_CommutationTask(int mag) {}
`,
    'mot_task.c': `
#include "mot_if.h"
void MotorInit(int speed) {
    MOT_IF_emulatedCommStart(speed);
    MOT_IF_CommutationTask(speed);
}
`,
  };

  const idx = new WorkspaceIndex();
  await idx.ensureFresh();
  const all = idx.getAllFunctions();
  const byName = (n: string) => all.find(f => f.name === n);

  console.log('\n[emulatedCommStart macro alias]');
  const init  = byName('MotorInit');
  const emuCS = byName('COM_emulatedCommStart');
  const commT = byName('COM_CommutationTask');

  check('MotorInit found',             !!init);
  check('COM_emulatedCommStart found', !!emuCS);
  check('COM_CommutationTask found',   !!commT);

  if (init && emuCS) {
    const out = idx.getOutgoing(init.id);
    check('MotorInit → COM_emulatedCommStart via MOT_IF_emulatedCommStart macro', out.some(e => e.calleeId === emuCS.id));
  }
  if (init && commT) {
    const out = idx.getOutgoing(init.id);
    check('MotorInit → COM_CommutationTask via MOT_IF_CommutationTask macro', out.some(e => e.calleeId === commT.id));
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' FAILED'}\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
