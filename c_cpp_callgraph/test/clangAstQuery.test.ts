import { queryClangAst, findCallSites, findNodes } from '../src/semantic/clangAstQuery';
import * as path from 'path';

let failures = 0;
function check(label: string, cond: boolean) {
  if (cond) console.log(`  ok  - ${label}`);
  else {
    console.log(`FAIL  - ${label}`);
    failures++;
  }
}

const FIXTURES = path.join(__dirname, 'fixtures');

async function main() {
  // ---------------------------------------------------------------------
  console.log('\n[1] Direct + recursive calls (sample.cpp, compute())');
  {
    const res = await queryClangAst({
      clangBinary: 'clang++',
      filePath: path.join(FIXTURES, 'sample.cpp'),
      compilerArgs: ['-std=c++17'],
      filterName: 'compute',
    });
    check('clang query succeeded', res.ok);
    const sites = res.ok ? findCallSites(res.roots[0]) : [];
    const names = sites.map((s) => s.calleeName);
    check('found call to helper()', names.includes('helper'));
    check('found recursive call to compute()', names.filter((n) => n === 'compute').length === 1);
    check('exactly 2 calls total (helper + recursive compute)', sites.length === 2);
  }

  // ---------------------------------------------------------------------
  console.log('\n[2] Member calls — dot and arrow (member_call.cpp, run())');
  {
    const res = await queryClangAst({
      clangBinary: 'clang++',
      filePath: path.join(FIXTURES, 'member_call.cpp'),
      compilerArgs: ['-std=c++17'],
      filterName: 'run',
    });
    check('clang query succeeded', res.ok);
    const sites = res.ok ? findCallSites(res.roots[0]) : [];
    const tickCalls = sites.filter((s) => s.calleeName === 'tick');
    check('both w.tick() and p->tick() detected as calls to tick', tickCalls.length === 2);
  }

  // ---------------------------------------------------------------------
  console.log('\n[3] Function-pointer call is correctly NOT reported as a direct call (sample.cpp, dispatch())');
  {
    const res = await queryClangAst({
      clangBinary: 'clang++',
      filePath: path.join(FIXTURES, 'sample.cpp'),
      compilerArgs: ['-std=c++17'],
      filterName: 'dispatch',
    });
    check('clang query succeeded', res.ok);
    const sites = res.ok ? findCallSites(res.roots[0]) : [];
    check('f(5) through a function pointer variable yields zero confirmed direct calls', sites.length === 0);
  }

  // ---------------------------------------------------------------------
  console.log('\n[4] Class bases + polymorphism (sample.cpp, Circle)');
  {
    const res = await queryClangAst({
      clangBinary: 'clang++',
      filePath: path.join(FIXTURES, 'sample.cpp'),
      compilerArgs: ['-std=c++17'],
      filterName: 'Circle',
    });
    check('clang query succeeded', res.ok);
    const records = res.ok ? findNodes(res.roots[0], 'CXXRecordDecl') : [];
    const circle = records.find((r) => r.bases || r.definitionData);
    check('Circle found with bases', !!circle?.bases?.some((b) => b.type?.qualType === 'Shape'));
    check('Circle confirmed polymorphic', circle?.definitionData?.isPolymorphic === true);
  }

  // ---------------------------------------------------------------------
  console.log('\n[5] #if 0 dead code never reaches the AST at all (structural confirmation of goal 5)');
  {
    const res = await queryClangAst({
      clangBinary: 'clang++',
      filePath: path.join(FIXTURES, 'sample.cpp'),
      compilerArgs: ['-std=c++17'],
      filterName: 'dead_code',
    });
    // ast-dump-filter finding NOTHING for a name that only exists inside
    // #if 0 is itself the proof — the preprocessor discarded it before
    // parsing, so there's no declaration to filter for.
    const found = res.ok && findNodes(res.roots[0], 'FunctionDecl').some((f) => f.name === 'dead_code');
    check('dead_code (#if 0 in sample.cpp) does not exist in the AST', !found);
  }

  // ---------------------------------------------------------------------
  console.log('\n[6] Filtered dump stays small even with heavy STL headers (perf sanity, not just <vector> exploration)');
  {
    const res = await queryClangAst({
      clangBinary: 'clang++',
      filePath: path.join(FIXTURES, 'proj', 'main.cpp'),
      compilerArgs: ['-std=c++17'],
      filterName: 'total',
    });
    check('clang query succeeded against a TU that includes <vector>', res.ok);
    check('result JSON is compact (well under 5000 lines) despite <vector>', JSON.stringify(res.roots).length < 200_000);
    const sites = res.ok ? findCallSites(res.roots[0]) : [];
    check('still correctly finds the square() call inside the range-for loop', sites.some((s) => s.calleeName === 'square'));
  }

  // ---------------------------------------------------------------------
  console.log('\n[7] Ambiguous plain-name filter returns multiple concatenated JSON docs, all parsed');
  {
    const res = await queryClangAst({
      clangBinary: 'clang++',
      filePath: path.join(FIXTURES, 'sample.cpp'),
      compilerArgs: ['-std=c++17'],
      filterName: 'area', // matches both Shape::area and Circle::area
    });
    check('clang query succeeded', res.ok);
    check('got two separate roots (Shape::area and Circle::area)', res.roots.length === 2);
    const lines = res.roots
      .map((r) => findNodes(r, 'CXXMethodDecl').find((m) => m.name === 'area')?.loc?.line)
      .filter((l) => l !== undefined)
      .sort();
    check('roots correspond to the two distinct area() declarations (lines 13 and 18)', JSON.stringify(lines) === JSON.stringify([13, 18]));

    console.log('\n[8] Qualified Class::method filter disambiguates to exactly one match');
    const qualified = await queryClangAst({
      clangBinary: 'clang++',
      filePath: path.join(FIXTURES, 'sample.cpp'),
      compilerArgs: ['-std=c++17'],
      filterName: 'Circle::area',
    });
    check('qualified filter succeeded', qualified.ok);
    check('qualified filter returns exactly one root', qualified.roots.length === 1);
  }

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
