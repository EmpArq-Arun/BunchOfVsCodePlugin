import { stripCommentsAndLiterals, LineIndex } from '../src/parser/textUtils';
import { extractFunctionSpans } from '../src/parser/functionExtractor';
import { extractCallSites } from '../src/parser/callSiteExtractor';
import { trackConditionals, isOffsetInactive } from '../src/parser/conditionalTracker';
import { extractClassSpans } from '../src/parser/classExtractor';
import { findPointerBindings, resolveBindingAt } from '../src/parser/functionPointerTracker';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    console.log(`  ok  - ${label}`);
  } else {
    console.log(`FAIL  - ${label}`);
    failures++;
  }
}

// ---------------------------------------------------------------------------
console.log('\n[1] Plain C functions + direct calls + recursion');
{
  const src = `
#include <stdio.h>

int helper(int x) {
    return x * 2;
}

int compute(int n) {
    if (n <= 1) return 1;
    int h = helper(n);
    return h + compute(n - 1); // recursive call
}

static void log_value(int v) {
    printf("%d\\n", v);
}
`;
  const cleaned = stripCommentsAndLiterals(src);
  const spans = extractFunctionSpans(cleaned);
  const names = spans.map((s) => s.name).sort();
  check('finds helper, compute, log_value', JSON.stringify(names) === JSON.stringify(['compute', 'helper', 'log_value']));

  const computeSpan = spans.find((s) => s.name === 'compute')!;
  const body = cleaned.slice(computeSpan.bodyStart, computeSpan.bodyEnd);
  const calls = extractCallSites(body).map((c) => c.name);
  check('compute() calls helper', calls.includes('helper'));
  check('compute() calls itself (recursion)', calls.includes('compute'));
  check('compute() does NOT misfire on "if" as a call', !calls.includes('if'));
}

// ---------------------------------------------------------------------------
console.log('\n[2] #if 0 / #ifdef active-vs-inactive tracking');
{
  const src = `
void active_fn() {}

#if 0
void dead_fn() {}
#endif

#define FEATURE_X
#ifdef FEATURE_X
void enabled_fn() {}
#else
void disabled_fn() {}
#endif

#ifdef UNKNOWN_EXTERNAL_FLAG
void unresolved_fn() {}
#endif
`;
  const cleaned = stripCommentsAndLiterals(src);
  const spans = extractFunctionSpans(cleaned);
  const info = trackConditionals(cleaned);

  const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
  check('found all 5 functions despite preprocessor noise', spans.length === 5);
  check('active_fn is active', !isOffsetInactive(byName['active_fn'].headerStart, info));
  check('dead_fn (#if 0) is inactive', isOffsetInactive(byName['dead_fn'].headerStart, info));
  check('enabled_fn (#ifdef FEATURE_X, locally #defined) is active', !isOffsetInactive(byName['enabled_fn'].headerStart, info));
  check('disabled_fn (#else of a locally-resolved #ifdef) is inactive', isOffsetInactive(byName['disabled_fn'].headerStart, info));
  check(
    'unresolved_fn (#ifdef on an externally-defined macro) is NOT marked inactive (left active+unresolved, not silently hidden)',
    !isOffsetInactive(byName['unresolved_fn'].headerStart, info),
  );
}

// ---------------------------------------------------------------------------
console.log('\n[3] Function-pointer / dispatch-table tracing (1C)');
{
  const src = `
void OnIdle() { tick(); }
void OnRun() { tick(); }
void OnError() { tick(); }

typedef void (*HandlerFn)();
HandlerFn table[] = { OnIdle, OnRun, OnError };

void direct_bind() {
    HandlerFn cb;
    cb = OnRun;
    cb();
}
`;
  const cleaned = stripCommentsAndLiterals(src);
  const spans = extractFunctionSpans(cleaned);
  const known = new Set(spans.map((s) => s.name));
  const { bindings } = findPointerBindings(cleaned, known);

  check('dispatch table picks up OnIdle/OnRun/OnError', bindings.filter((b) => b.variable === '<dispatch-table>').length === 3);

  const directBind = bindings.find((b) => b.variable === 'cb' && b.functionName === 'OnRun');
  check('cb = OnRun; is tracked as a pointer binding', !!directBind);

  const directBindFn = spans.find((s) => s.name === 'direct_bind')!;
  const body = cleaned.slice(directBindFn.bodyStart, directBindFn.bodyEnd);
  const callSites = extractCallSites(body);
  const cbCall = callSites.find((c) => c.name === 'cb');
  check('cb() call site is detected in direct_bind body', !!cbCall);
  if (cbCall) {
    const resolved = resolveBindingAt('cb', directBindFn.bodyStart + cbCall.offset, bindings);
    check('cb() resolves back to OnRun via the binding', resolved?.functionName === 'OnRun');
  }
}

// ---------------------------------------------------------------------------
console.log('\n[4] C++ classes, inheritance, virtual methods, qualified definitions');
{
  const src = `
class Animal {
public:
    virtual void speak();
    void breathe() {}
};

class Dog : public Animal {
public:
    void speak() override;
};

void Dog::speak() {
    bark();
}

void Animal::breathe2() {
}
`;
  const cleaned = stripCommentsAndLiterals(src);
  const classSpans = extractClassSpans(cleaned);
  const funcSpans = extractFunctionSpans(cleaned);

  check('finds Animal and Dog classes', classSpans.map((c) => c.name).sort().join(',') === 'Animal,Dog');
  const dog = classSpans.find((c) => c.name === 'Dog')!;
  check('Dog inherits from Animal', dog.bases.includes('Animal'));

  const breathe = funcSpans.find((s) => s.name === 'breathe' && !s.className);
  check('Animal::breathe() in-class definition found', !!breathe);

  const dogSpeak = funcSpans.find((s) => s.name === 'speak' && s.className === 'Dog');
  check('out-of-line Dog::speak() definition found with className=Dog', !!dogSpeak);

  const breathe2 = funcSpans.find((s) => s.name === 'breathe2' && s.className === 'Animal');
  check('out-of-line Animal::breathe2() definition found', !!breathe2);
}

// ---------------------------------------------------------------------------
console.log('\n[5] LineIndex offset -> line/column round-trip');
{
  const src = 'line1\nline2\nline3 here';
  const cleaned = stripCommentsAndLiterals(src);
  const idx = new LineIndex(cleaned);
  const offsetOfHere = cleaned.indexOf('here');
  const loc = idx.toLineCol(offsetOfHere);
  check('finds "here" on line 3', loc.line === 3);
  check(`column of "here" is correct (got col ${loc.column})`, loc.column === 7);
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
