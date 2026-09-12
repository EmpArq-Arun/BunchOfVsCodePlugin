import { WorkspaceIndex } from '../src/parser/workspaceIndex';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ok  - ${label}`);
  else {
    console.log(`FAIL  - ${label}`);
    failures++;
  }
}

async function main() {
  (global as any).__mockFiles = {
    'handlers.c': `
void on_event() {
    log_event();
}

void log_event() {
}

HandlerFn g_handler;

void register_handler() {
    g_handler = on_event;
}
`,
    'dispatch.c': `
void dispatch() {
    g_handler();
}
`,
    'callback.cpp': `
#include <functional>

void helper() {
}

std::function<void()> cb;

void setup() {
    cb = [](){
        helper();
    };
}

void run() {
    cb();
}
`,
  };

  const index = new WorkspaceIndex();
  await index.ensureFresh();
  const allFns = index.getAllFunctions();
  const byName = (n: string) => allFns.filter((f) => f.name === n);

  // ---------------------------------------------------------------------
  console.log('\n[1] Cross-file pointer binding: bound in handlers.c, called from dispatch.c');
  {
    const dispatchFn = byName('dispatch')[0];
    const onEventFn = byName('on_event')[0];
    check('dispatch() found', !!dispatchFn);
    check('on_event() found', !!onEventFn);

    if (dispatchFn && onEventFn) {
      const outgoing = index.getOutgoing(dispatchFn.id);
      const edge = outgoing.find((e) => e.calleeId === onEventFn.id);
      check('dispatch() -> on_event() edge resolved across files via g_handler', !!edge);
      check('edge kind is "pointer"', edge?.kind === 'pointer');
      check('edge records "via g_handler"', edge?.via === 'g_handler');
    }
  }

  // ---------------------------------------------------------------------
  console.log('\n[2] Lambda tracing: cb = [](){ helper(); }; ... cb();');
  {
    const runFn = byName('run')[0];
    const helperFn = byName('helper')[0];
    check('run() found', !!runFn);
    check('helper() found', !!helperFn);

    if (runFn) {
      const outgoing = index.getOutgoing(runFn.id);
      check('run() has exactly one outgoing edge (to the lambda)', outgoing.length === 1);
      const lambdaEdge = outgoing[0];
      check('run()->lambda edge is kind=pointer via cb', lambdaEdge?.kind === 'pointer' && lambdaEdge?.via === 'cb');

      const lambdaNode = lambdaEdge ? index.getFunction(lambdaEdge.calleeId) : undefined;
      check('lambda node was registered as a real function node', !!lambdaNode && lambdaNode.name === '<lambda>');

      if (lambdaNode && helperFn) {
        const lambdaOutgoing = index.getOutgoing(lambdaNode.id);
        check('lambda node has an outgoing edge to helper()', lambdaOutgoing.some((e) => e.calleeId === helperFn.id));
      }
    }
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
