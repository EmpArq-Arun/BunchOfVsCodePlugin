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
    'engine.h': `
class Shape {
public:
    virtual double area();
};

class Circle : public Shape {
public:
    double area() override;
};
`,
    'engine.cpp': `
#include "engine.h"

double Circle::area() {
    return compute_pi() * radius_sq();
}

double compute_pi() {
    return 3.14159;
}

double radius_sq() {
    return helper_square(2);
}

double helper_square(int x) {
    return x * x;
}

typedef double (*AreaFn)();
AreaFn areaTable[] = { compute_pi };

void run_dispatch() {
    AreaFn f;
    f = compute_pi;
    f();
}

#if 0
double unused_legacy_area() {
    return 0;
}
#endif
`,
    'main.cpp': `
#include "engine.h"

void render() {
    Circle c;
    c.area();
    compute_pi();
}
`,
  };

  const index = new WorkspaceIndex();
  await index.ensureFresh();

  const allFns = index.getAllFunctions();
  const byName = (n: string) => allFns.filter((f) => f.name === n);

  // ---- classes & inheritance ----
  const classes = index.getAllClasses();
  const circle = classes.find((c) => c.name === 'Circle');
  check('Circle class found', !!circle);
  check('Circle inherits from Shape', !!circle && circle.bases.includes('Shape'));
  check('Circle::area attached as a method', !!circle && circle.methods.some((m) => m.name === 'area'));

  // ---- function discovery sanity ----
  check('found compute_pi, radius_sq, helper_square, run_dispatch, render, area, unused_legacy_area', [
    'compute_pi', 'radius_sq', 'helper_square', 'run_dispatch', 'render', 'area', 'unused_legacy_area',
  ].every((n) => byName(n).length >= 1));

  // ---- #if 0 inactive function ----
  const legacy = byName('unused_legacy_area')[0];
  check('unused_legacy_area (#if 0 block) is marked inactive', !!legacy && legacy.active === false);
  const computePi = byName('compute_pi')[0];
  check('compute_pi (normal code) is marked active', !!computePi && computePi.active === true);

  // ---- direct cross-file & qualified-method calls ----
  const areaFn = byName('area').find((f) => f.className === 'Circle');
  check('Circle::area resolved as a qualified method node', !!areaFn);

  if (areaFn) {
    const outNames = index.getOutgoing(areaFn.id).map((e) => index.getFunction(e.calleeId)?.name);
    check('Circle::area() calls compute_pi()', outNames.includes('compute_pi'));
    check('Circle::area() calls radius_sq()', outNames.includes('radius_sq'));
  }

  const radiusSqFn = byName('radius_sq')[0];
  if (radiusSqFn) {
    const outNames = index.getOutgoing(radiusSqFn.id).map((e) => index.getFunction(e.calleeId)?.name);
    check('radius_sq() calls helper_square() (transitive chain)', outNames.includes('helper_square'));
  }

  if (computePi) {
    const callerNames = index.getIncoming(computePi.id).map((e) => index.getFunction(e.callerId)?.name);
    check('compute_pi() callers include Circle::area (same file)', callerNames.includes('area'));
    check('compute_pi() callers include render() (cross-file, main.cpp)', callerNames.includes('render'));
  }

  // ---- function pointer / dispatch table tracing (1C) ----
  if (computePi) {
    const incoming = index.getIncoming(computePi.id);
    const pointerEdge = incoming.find((e) => e.kind === 'pointer');
    check('compute_pi() has a pointer-kind incoming edge (f = compute_pi; f();)', !!pointerEdge);
    if (pointerEdge) check('pointer edge records "via f"', pointerEdge.via === 'f');
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
