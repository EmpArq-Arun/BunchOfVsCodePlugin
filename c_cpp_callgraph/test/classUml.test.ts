import { extractNamespaceRanges, namespaceAt, qualifyName } from '../src/parser/namespaceTracker';
import { extractFunctionSpans } from '../src/parser/functionExtractor';
import { extractClassSpans } from '../src/parser/classExtractor';
import { stripCommentsAndLiterals, stripCompilerAnnotations } from '../src/parser/textUtils';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ok  - ${label}`);
  else { console.log(`FAIL  - ${label}`); failures++; }
}

// ---------------------------------------------------------------------------
console.log('\n[1] Namespace tracking');
{
  const src = `
namespace MyApp {
  void init() {}
  namespace UI {
    void draw() {}
  }
}
void global_fn() {}
`;
  const cleaned = stripCompilerAnnotations(stripCommentsAndLiterals(src));
  const nsRanges = extractNamespaceRanges(cleaned);
  check('found 2 namespace ranges', nsRanges.length === 2);

  const initPos = cleaned.indexOf('void init()');
  const drawPos = cleaned.indexOf('void draw()');
  const globalPos = cleaned.indexOf('void global_fn()');

  check('init() is in MyApp namespace', namespaceAt(initPos, nsRanges) === 'MyApp');
  check('draw() is in MyApp::UI namespace', namespaceAt(drawPos, nsRanges) === 'MyApp::UI');
  check('global_fn() is in no namespace', namespaceAt(globalPos, nsRanges) === undefined);
  check('qualifyName works', qualifyName('Widget', 'MyApp::UI') === 'MyApp::UI::Widget');
}

// ---------------------------------------------------------------------------
console.log('\n[2] Constructor and destructor extraction');
{
  const src = `
class Circle {
public:
    Circle(double r) : radius_(r), count_(0) {}
    Circle(const Circle& other) : radius_(other.radius_), count_(0) {}
    ~Circle() { --count_; }
    double area() const { return 3.14159 * radius_ * radius_; }
private:
    double radius_;
    static int count_;
};

double Circle::area() { return 3.14 * radius_ * radius_; }
`;
  const raw = stripCommentsAndLiterals(src);
  const cleaned = stripCompilerAnnotations(raw);
  const spans = extractFunctionSpans(cleaned, [], raw);
  const names = spans.map(s => s.name);

  check('constructor Circle(double r) found', names.includes('Circle'));
  check('copy constructor found', names.filter(n => n === 'Circle').length >= 2);
  check('destructor ~Circle found', names.includes('~Circle'));
  check('area() found', names.includes('area'));
}

// ---------------------------------------------------------------------------
console.log('\n[3] Namespace attributed to functions and classes');
{
  const src = `
namespace Engine {
  class Actor {
  public:
    void update() {}
    Actor() {}
  };
  void tick() {}
}
`;
  const raw = stripCommentsAndLiterals(src);
  const cleaned = stripCompilerAnnotations(raw);
  const nsRanges = extractNamespaceRanges(cleaned);

  const classSpans = extractClassSpans(cleaned, nsRanges);
  const actor = classSpans.find(c => c.name === 'Actor');
  check('Actor class found', !!actor);
  check('Actor has namespace Engine', actor?.namespace === 'Engine');
  check('Actor qualifiedName is Engine::Actor', actor?.qualifiedName === 'Engine::Actor');

  const fnSpans = extractFunctionSpans(cleaned, [], raw, nsRanges);
  const tick = fnSpans.find(s => s.name === 'tick');
  check('tick() found', !!tick);
  check('tick() attributed to Engine namespace', tick?.namespace === 'Engine');

  const update = fnSpans.find(s => s.name === 'update');
  check('update() found (in-class method)', !!update);
}

// ---------------------------------------------------------------------------
console.log('\n[4] Member variable extraction and relationship detection');
{
  const knownClasses = new Set(['Engine', 'Renderer', 'Config', 'Logger']);
  const src = `
class Game {
public:
    Game(Engine* e, const Config& cfg) : engine_(e), config_(cfg) {}
    void run();
private:
    Engine* engine_;             // aggregation - pointer
    Renderer renderer_;          // composition - value
    const Config& config_;       // aggregation - reference
    std::unique_ptr<Logger> log_;// composition - unique_ptr
    int score_;
    static int instance_count_;
};
`;
  const raw = stripCommentsAndLiterals(src);
  const cleaned = stripCompilerAnnotations(raw);
  const classSpans = extractClassSpans(cleaned, [], knownClasses);
  const game = classSpans.find(c => c.name === 'Game');
  check('Game class found', !!game);

  const memberNames = (game?.members ?? []).map(m => m.name);
  check('engine_ member found', memberNames.includes('engine_'));
  check('renderer_ member found', memberNames.includes('renderer_'));
  check('score_ member found', memberNames.includes('score_'));

  const engineMember = game?.members.find(m => m.name === 'engine_');
  check('engine_ is a pointer member', engineMember?.isPointer === true);

  const rendererMember = game?.members.find(m => m.name === 'renderer_');
  check('renderer_ is NOT a pointer member', rendererMember?.isPointer === false);

  const rels = game?.relationships ?? [];
  const relTargets = rels.map(r => r.targetClass);
  check('Engine relationship detected', relTargets.includes('Engine'));
  check('Renderer relationship detected', relTargets.includes('Renderer'));

  const engineRel = rels.find(r => r.targetClass === 'Engine');
  check('Engine→Game is aggregation (pointer)', engineRel?.kind === 'aggregation');

  const rendererRel = rels.find(r => r.targetClass === 'Renderer');
  check('Renderer→Game is composition (value)', rendererRel?.kind === 'composition');
}

// ---------------------------------------------------------------------------
console.log('\n[5] Inheritance relationships');
{
  const src = `
class Shape {
public:
    virtual double area() = 0;
    virtual ~Shape() {}
};

class Circle : public Shape {
public:
    double area() override { return 3.14 * r_ * r_; }
private:
    double r_;
};

class ColoredCircle : public Circle {
public:
    int color;
};
`;
  const raw = stripCommentsAndLiterals(src);
  const cleaned = stripCompilerAnnotations(raw);
  const spans = extractClassSpans(cleaned);

  const circle = spans.find(c => c.name === 'Circle');
  const colored = spans.find(c => c.name === 'ColoredCircle');

  check('Circle found with Shape as base', circle?.bases.includes('Shape') === true);
  check('ColoredCircle found with Circle as base', colored?.bases.includes('Circle') === true);

  const circleInheritance = circle?.relationships.find(r => r.kind === 'inheritance');
  check('Circle has inheritance relationship to Shape', circleInheritance?.targetClass === 'Shape');

  // Destructors
  const fnSpans = extractFunctionSpans(cleaned, [], raw);
  const destructors = fnSpans.filter(s => s.name.startsWith('~'));
  check('virtual destructor ~Shape found', destructors.some(d => d.name === '~Shape'));
}

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
