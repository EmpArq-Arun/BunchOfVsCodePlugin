import { WorkspaceIndex } from '../src/parser/workspaceIndex';

let failures = 0;
const check = (l: string, c: boolean) => {
  if (c) console.log(`  ok  - ${l}`);
  else { console.log(`FAIL  - ${l}`); failures++; }
};

async function main() {
  // ── Fixtures mirror the user's exact PWM structure ─────────────────────────
  (global as any).__mockFiles = {
    // Header: struct with function pointer fields
    'pwm/pwm_interface.h': `
struct PWM_INTERFACE {
    void (*Enable)(void);
    void (*SoftwareTriggerSet)(void);
    void (*PeriodSet)(unsigned int periodCount);
    void (*DutyCycleSet)(unsigned int dutyCycleCount);
    void (*Initialize)(void);
};
`,
    // HAL generated: struct initialized with &funcName (address-of)
    'sccp1.c': `
#include "pwm/pwm_interface.h"

void SCCP1_PWM_Initialize(void) {}
void SCCP1_PWM_Enable(void) {}
void SCCP1_PWM_SoftwareTriggerSet(void) {}
void SCCP1_PWM_PeriodSet(unsigned int p) {}
void SCCP1_PWM_DutyCycleSet(unsigned int d) {}

const struct PWM_INTERFACE PWM_OUT1 = {
    .Initialize          = &SCCP1_PWM_Initialize,
    .Enable              = &SCCP1_PWM_Enable,
    .SoftwareTriggerSet  = &SCCP1_PWM_SoftwareTriggerSet,
    .PeriodSet           = &SCCP1_PWM_PeriodSet,
    .DutyCycleSet        = &SCCP1_PWM_DutyCycleSet,
};
`,
    // Second HAL instance
    'sccp2.c': `
#include "pwm/pwm_interface.h"

void SCCP2_PWM_Initialize(void) {}
void SCCP2_PWM_Enable(void) {}
void SCCP2_PWM_SoftwareTriggerSet(void) {}
void SCCP2_PWM_PeriodSet(unsigned int p) {}
void SCCP2_PWM_DutyCycleSet(unsigned int d) {}

const struct PWM_INTERFACE PWM_OUT2 = {
    .Initialize          = &SCCP2_PWM_Initialize,
    .Enable              = &SCCP2_PWM_Enable,
    .SoftwareTriggerSet  = &SCCP2_PWM_SoftwareTriggerSet,
    .PeriodSet           = &SCCP2_PWM_PeriodSet,
    .DutyCycleSet        = &SCCP2_PWM_DutyCycleSet,
};
`,
    // User code: calls through struct pointer field
    'pwm.c': `
#include "pwm/pwm_interface.h"

typedef struct {
    unsigned int channel;
    int enable;
    const struct PWM_INTERFACE* interface;
} PWM_Module_t;

static PWM_Module_t PwmModules[] = {
    {0, 1, &PWM_OUT1},
    {1, 1, &PWM_OUT2},
};

void PWM_Task(int index) {
    if (PwmModules[index].enable) {
        PwmModules[index].interface->Enable();
        PwmModules[index].interface->SoftwareTriggerSet();
        PwmModules[index].interface->PeriodSet(1000);
    }
}
`,
  };

  const idx = new WorkspaceIndex();
  await idx.ensureFresh();
  const all = idx.getAllFunctions();
  const byName = (n: string) => all.filter(f => f.name === n);

  console.log('\n[1] Functions found in index');
  {
    for (const name of ['PWM_Task','SCCP1_PWM_Enable','SCCP1_PWM_SoftwareTriggerSet','SCCP2_PWM_Enable','SCCP2_PWM_PeriodSet']) {
      check(`${name} in index`, byName(name).length > 0);
    }
  }

  console.log('\n[2] Designated initializer with &address-of creates named field bindings');
  {
    const task = byName('PWM_Task')[0];
    const sccp1Enable = byName('SCCP1_PWM_Enable')[0];
    const sccp2Enable = byName('SCCP2_PWM_Enable')[0];
    const sccp1Soft   = byName('SCCP1_PWM_SoftwareTriggerSet')[0];
    const sccp1Period = byName('SCCP1_PWM_PeriodSet')[0];

    check('PWM_Task found', !!task);
    check('SCCP1_PWM_Enable found', !!sccp1Enable);
    check('SCCP2_PWM_Enable found', !!sccp2Enable);

    if (task && sccp1Enable) {
      const out = idx.getOutgoing(task.id);
      // Both SCCP1 and SCCP2 Enable should be reachable via "Enable" field binding
      const toSccp1Enable = out.find(e => e.calleeId === sccp1Enable.id);
      check('PWM_Task → SCCP1_PWM_Enable via Enable field', !!toSccp1Enable);
      if (toSccp1Enable) check('edge kind is pointer', toSccp1Enable.kind === 'pointer');
    }

    if (task && sccp2Enable) {
      const out = idx.getOutgoing(task.id);
      const toSccp2Enable = out.find(e => e.calleeId === sccp2Enable.id);
      check('PWM_Task → SCCP2_PWM_Enable via Enable field (fan-out)', !!toSccp2Enable);
    }

    if (task && sccp1Soft) {
      const out = idx.getOutgoing(task.id);
      check('PWM_Task → SCCP1_PWM_SoftwareTriggerSet via SoftwareTriggerSet field', out.some(e => e.calleeId === sccp1Soft.id));
    }

    if (task && sccp1Period) {
      const out = idx.getOutgoing(task.id);
      check('PWM_Task → SCCP1_PWM_PeriodSet via PeriodSet field', out.some(e => e.calleeId === sccp1Period.id));
    }
  }

  console.log('\n[3] Incoming edges on SCCP1 functions show PWM_Task as caller');
  {
    const task      = byName('PWM_Task')[0];
    const sccp1En   = byName('SCCP1_PWM_Enable')[0];
    if (task && sccp1En) {
      const incoming = idx.getIncoming(sccp1En.id);
      check('SCCP1_PWM_Enable has incoming edge from PWM_Task', incoming.some(e => e.callerId === task.id));
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
