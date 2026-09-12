import { WorkspaceIndex } from '../src/parser/workspaceIndex';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ok  - ${label}`);
  else { console.log(`FAIL  - ${label}`); failures++; }
}

async function main() {
  (global as any).__mockFiles = {
    'firmware.c': `
#include <stdint.h>

/* ARM CMSIS naming convention — detected by name pattern */
void TIM2_IRQHandler(void) {
    tick();
}

/* GCC __attribute__((interrupt)) — detected by attribute in preceding code */
__attribute__((interrupt)) void UART_ISR(void) {
    process_uart();
}

/* AVR-style ISR_ prefix — detected by name pattern */
void ISR_adc_complete(void) {
    read_adc();
}

/* FreeRTOS common ISR naming — detected by name pattern */
void TIMER_FromISR(void) {
    notify_task();
}

/* Keil __irq — detected by keyword in preceding code */
__irq void SPI_Handler(void) {
    transfer_done();
}

/* REGULAR functions — must NOT be flagged */
void regular_init(void) { tick(); }
void process_uart(void) {}
void read_adc(void) {}
void tick(void) {}
void notify_task(void) {}
void transfer_done(void) {}
`,
  };

  const index = new WorkspaceIndex();
  await index.ensureFresh();
  const allFns = index.getAllFunctions();
  const byName = (n: string) => allFns.find(f => f.name === n);

  console.log('\n[1] ARM CMSIS _IRQHandler naming');
  {
    const fn = byName('TIM2_IRQHandler');
    check('TIM2_IRQHandler found in index', !!fn);
    check('TIM2_IRQHandler flagged as ISR', fn?.isIsr === true);
    check('TIM2_IRQHandler has ARM CMSIS label', fn?.isrAttribute?.includes('ARM CMSIS') ?? false);
  }

  console.log('\n[2] GCC __attribute__((interrupt))');
  {
    const fn = byName('UART_ISR');
    check('UART_ISR found in index', !!fn);
    check('UART_ISR flagged as ISR', fn?.isIsr === true);
    check('UART_ISR attribute label mentions interrupt', fn?.isrAttribute?.includes('interrupt') ?? false);
  }

  console.log('\n[3] ISR_ prefix naming');
  {
    const fn = byName('ISR_adc_complete');
    check('ISR_adc_complete found in index', !!fn);
    check('ISR_adc_complete flagged as ISR', fn?.isIsr === true);
    check('ISR_adc_complete attribute label mentions ISR_', fn?.isrAttribute?.includes('ISR_') ?? false);
  }

  console.log('\n[4] FreeRTOS FromISR naming');
  {
    const fn = byName('TIMER_FromISR');
    check('TIMER_FromISR found in index', !!fn);
    check('TIMER_FromISR flagged as ISR', fn?.isIsr === true);
    check('TIMER_FromISR attribute label mentions FromISR', fn?.isrAttribute?.includes('FromISR') ?? false);
  }

  console.log('\n[5] Keil __irq qualifier');
  {
    const fn = byName('SPI_Handler');
    check('SPI_Handler found in index', !!fn);
    check('SPI_Handler flagged as ISR (__irq)', fn?.isIsr === true);
  }

  console.log('\n[6] Regular functions must NOT be flagged');
  {
    for (const name of ['regular_init', 'process_uart', 'read_adc', 'tick', 'notify_task', 'transfer_done']) {
      const fn = byName(name);
      check(`${name} NOT flagged as ISR`, fn?.isIsr !== true);
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
