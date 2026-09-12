import { extractMacroAliases, buildMergedAliasMap, resolveAlias } from '../src/parser/macroAliasTracker';
import { WorkspaceIndex } from '../src/parser/workspaceIndex';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ok  - ${label}`);
  else { console.log(`FAIL  - ${label}`); failures++; }
}

// ---------------------------------------------------------------------------
console.log('\n[1] Macro alias extraction');
{
  const src = `
/* Motor interface layer — wraps the implementation behind compile-time aliases */
#define MOT_IF_CommutationTask(mag)   COM_CommutationTask(mag)
#define MOT_IF_SetSpeed(rpm)          COM_SetMotorSpeed(rpm)
#define MOT_IF_Brake()                COM_ApplyBrake()

/* No-arg alias */
#define UART_SEND                     UART_SendByte

/* Not an alias — maps to a non-identifier token */
#define TIMEOUT_MS                    100
`;
  const aliases = extractMacroAliases(src);
  check('MOT_IF_CommutationTask → COM_CommutationTask', aliases.get('MOT_IF_CommutationTask') === 'COM_CommutationTask');
  check('MOT_IF_SetSpeed → COM_SetMotorSpeed',           aliases.get('MOT_IF_SetSpeed')         === 'COM_SetMotorSpeed');
  check('MOT_IF_Brake → COM_ApplyBrake',                 aliases.get('MOT_IF_Brake')            === 'COM_ApplyBrake');
  check('UART_SEND (no-arg) → UART_SendByte',            aliases.get('UART_SEND')               === 'UART_SendByte');
  check('TIMEOUT_MS is NOT extracted (numeric value)',   !aliases.has('TIMEOUT_MS'));
}

// ---------------------------------------------------------------------------
console.log('\n[2] Alias chain resolution');
{
  const a = new Map([['FOO','BAR'],['BAR','BAZ']]);
  const b = new Map([['BAZ','REAL_FUNC']]);
  const merged = buildMergedAliasMap([a, b]);
  // After chain resolution: FOO→BAZ→REAL_FUNC, BAR→BAZ→REAL_FUNC
  check('FOO resolves through 3-hop chain to REAL_FUNC', merged.get('FOO') === 'REAL_FUNC');
  check('BAR resolves through 2-hop chain to REAL_FUNC', merged.get('BAR') === 'REAL_FUNC');
  check('BAZ resolves to REAL_FUNC',                     merged.get('BAZ') === 'REAL_FUNC');
  // No cycle
  const cycle = new Map([['A','B'],['B','A']]);
  const cresolved = buildMergedAliasMap([cycle]);
  check('Cycle is broken (no infinite loop)', cresolved.get('A') === 'B' || cresolved.get('A') === 'A');

  check('resolveAlias returns target', resolveAlias('MOT_IF_CommutationTask', new Map([['MOT_IF_CommutationTask','COM_CommutationTask']])) === 'COM_CommutationTask');
  check('resolveAlias returns name unchanged when no match', resolveAlias('unknown', new Map()) === 'unknown');
}

// ---------------------------------------------------------------------------
async function asyncTests() {

console.log('\n[3] Macro alias → real function edge created in WorkspaceIndex');
{
  (global as any).__mockFiles = {
    'mot_if.h': `
/* Interface layer — all motor calls go through these aliases */
#define MOT_IF_CommutationTask(mag)   COM_CommutationTask(mag)
#define MOT_IF_SetSpeed(rpm)          COM_SetSpeed(rpm)
`,
    'com.c': `
void COM_CommutationTask(int mag) {
    /* real motor commutation */
}
void COM_SetSpeed(int rpm) {}
`,
    'mot_task.c': `
#include "mot_if.h"
void MotorTask(void) {
    int speed = 1000;
    MOT_IF_CommutationTask(speed);
    MOT_IF_SetSpeed(speed);
}
`,
  };

  const index = new WorkspaceIndex();
  await index.ensureFresh();
  const allFns = index.getAllFunctions();
  const byName = (n: string) => allFns.find(f => f.name === n);

  const motorTask     = byName('MotorTask');
  const commutation   = byName('COM_CommutationTask');
  const setSpeed      = byName('COM_SetSpeed');

  check('MotorTask found',           !!motorTask);
  check('COM_CommutationTask found', !!commutation);
  check('COM_SetSpeed found',        !!setSpeed);

  if (motorTask && commutation) {
    const outgoing = index.getOutgoing(motorTask.id);
    const toComm = outgoing.find(e => e.calleeId === commutation.id);
    check('MotorTask → COM_CommutationTask edge via macro alias', !!toComm);
  }
  if (motorTask && setSpeed) {
    const outgoing = index.getOutgoing(motorTask.id);
    const toSpeed = outgoing.find(e => e.calleeId === setSpeed.id);
    check('MotorTask → COM_SetSpeed edge via macro alias', !!toSpeed);
  }
}

// ---------------------------------------------------------------------------
console.log('\n[4] Designated-initializer field name → struct function pointer call');
{
  (global as any).__mockFiles = {
    'driver.h': `
typedef struct {
    void (*CommutationTask)(int);
    void (*SetSpeed)(int);
} MotorOps_t;
`,
    'com_motor.c': `
void COM_CommutationTask(int mag) {}
void COM_SetSpeed(int rpm) {}
`,
    'motor_init.c': `
#include "driver.h"
#include "com_motor.h"

MotorOps_t g_motor_ops = {
    .CommutationTask = COM_CommutationTask,
    .SetSpeed        = COM_SetSpeed,
};
`,
    'motor_task.c': `
#include "driver.h"
extern MotorOps_t g_motor_ops;
extern MotorOps_t *p_ops;

void MotorTaskViaStruct(int mag) {
    /* Call through struct ops table - field name CommutationTask should resolve */
    g_motor_ops.CommutationTask(mag);
    p_ops->CommutationTask(mag);
}
`,
  };

  const index2 = new WorkspaceIndex();
  await index2.ensureFresh();
  const allFns2 = index2.getAllFunctions();
  const byName2 = (n: string) => allFns2.find(f => f.name === n);

  const task2 = byName2('MotorTaskViaStruct');
  const comm2 = byName2('COM_CommutationTask');

  check('MotorTaskViaStruct found',  !!task2);
  check('COM_CommutationTask found', !!comm2);

  if (task2 && comm2) {
    const outgoing = index2.getOutgoing(task2.id);
    const toComm = outgoing.find(e => e.calleeId === comm2.id);
    check('MotorTaskViaStruct → COM_CommutationTask via struct ops field', !!toComm);
    if (toComm) check('edge kind is pointer', toComm.kind === 'pointer');
  }
}

// ---------------------------------------------------------------------------
} // end asyncTests

asyncTests().then(() => {
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}).catch(err => { console.error(err); process.exit(1); });
