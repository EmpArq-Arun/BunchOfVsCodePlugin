import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAstDump, splitJsonObjects, walk, AstParseError, bareTypeName } from '../out-test/core/ast.js';
import { detectRosetta, rosettaByLine } from '../out-test/core/rosetta.js';
import { parseClangUml } from '../out-test/core/clanguml.js';
import {
  buildAstCommand,
  entryFor,
  parseCompilationDatabase,
  sanitiseFlags,
  shellSplit,
  databaseCandidates,
  languageOf,
  buildRecordLayoutCommand,
  stripNonArguments,
  setExtraCompileFlags,
  CompDbError,
} from '../out-test/core/compdb.js';
import { spawn } from 'node:child_process';
import { findDeviceSelection, looksLikeDeviceSelection, commonMissingDefines } from '../out-test/core/devicemacros.js';
import { stageCompilationDatabase, selectSources, gitWorkingDirectory, makeIncludeResolver } from '../out-test/clanguml/runner.js';
import { parseIncludeSearchList, asIsystemFlags, includeProbeArgs, classifyMissingHeader, missingHeaderFrom } from '../out-test/core/sysinclude.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAIN = 'rosetta.cpp';

let cachedAst;
async function ast() {
  cachedAst ??= parseAstDump(await fs.readFile(path.join(here, 'fixtures', 'ast-process.json'), 'utf8'));
  return cachedAst;
}
async function findings(structure) {
  return detectRosetta(await ast(), { mainFile: MAIN, structure });
}
const of = (list, construct) => list.filter((f) => f.construct === construct);

describe('AST dump parsing', () => {
  test('parses a single top-level object', async () => {
    const roots = await ast();
    assert.equal(roots.length, 1);
    assert.equal(roots[0].kind, 'FunctionDecl');
    assert.equal(roots[0].name, 'process');
  });

  test('captures the mangled name, which is the join key to the binary', async () => {
    const roots = await ast();
    assert.match(roots[0].mangledName, /^_ZN2fw7process/);
  });

  test('splits several concatenated top-level objects', () => {
    const parts = splitJsonObjects('{"a":1}\n{"b":2}\n{"c":3}');
    assert.equal(parts.length, 3);
    assert.deepEqual(JSON.parse(parts[1]), { b: 2 });
  });

  test('ignores braces inside string literals', () => {
    const parts = splitJsonObjects('{"name":"operator{}","x":1}{"y":2}');
    assert.equal(parts.length, 2);
    assert.equal(JSON.parse(parts[0]).name, 'operator{}');
  });

  test('ignores escaped quotes inside strings', () => {
    const parts = splitJsonObjects('{"s":"a\\"}\\"b"}{"t":1}');
    assert.equal(parts.length, 2);
  });

  test('rejects a truncated dump rather than parsing half of it', () => {
    assert.throws(() => parseAstDump('{"a": {"b": 1}'), AstParseError);
  });

  test('an empty dump is empty, not an error', () => {
    assert.deepEqual(parseAstDump('   \n'), []);
  });
});

describe('differential source locations', () => {
  test('resolves lines for nodes that omit them', async () => {
    const located = walk(await ast(), MAIN);
    // clang omits `line` whenever it repeats, so most nodes carry only a column.
    const withoutLine = located.filter((l) => l.node.range?.begin && l.node.range.begin.line === undefined);
    assert.ok(withoutLine.length > 20, 'fixture should exercise line inheritance');
    assert.ok(withoutLine.every((l) => l.span.beginLine > 0));
  });

  test('every located node lands inside the fixture file', async () => {
    const located = walk(await ast(), MAIN);
    const lines = located.map((l) => l.span.beginLine);
    assert.ok(Math.min(...lines) >= 1);
    assert.ok(Math.max(...lines) <= 80, 'no line beyond the fixture length');
  });

  test('the function declaration resolves to its real line', async () => {
    const located = walk(await ast(), MAIN);
    const fn = located.find((l) => l.node.kind === 'FunctionDecl' && l.node.name === 'process');
    assert.equal(fn.span.beginLine, 36);
  });

  test('ancestors are recorded outermost first', async () => {
    const located = walk(await ast(), MAIN);
    const lambda = located.find((l) => l.node.kind === 'LambdaExpr');
    assert.equal(lambda.ancestors[0].kind, 'FunctionDecl');
    assert.ok(lambda.ancestors.length > 1);
  });

  test('bare type names drop qualifiers and indirection', () => {
    assert.equal(bareTypeName('const fw::Buffer &'), 'fw::Buffer');
    assert.equal(bareTypeName('uint8_t *'), 'uint8_t');
  });
});

describe('Rosetta detection against real clang output', () => {
  test('finds the RAII lock construction', async () => {
    const f = of(await findings(), 'object_construction');
    assert.ok(f.some((x) => x.title.includes('Lock')));
    assert.equal(f[0].span.beginLine, 37);
  });

  test('explains RAII in terms of every exit path, which is the whole point', async () => {
    const [f] = of(await findings(), 'object_construction');
    assert.match(f.emits, /every early return/);
    assert.match(f.cEquivalent, /cannot forget one/);
  });

  test('flags the statement where a temporary is destroyed', async () => {
    const f = of(await findings(), 'temporary_destroyed');
    assert.ok(f.length > 0);
    assert.equal(f[0].severity, 'trap');
    assert.match(f[0].cEquivalent, /dangling/);
  });

  test('finds the function-local static and its guard variable', async () => {
    const [f] = of(await findings(), 'function_local_static');
    assert.match(f.title, /counter/);
    assert.match(f.emits, /__cxa_guard_acquire/);
    assert.match(f.emits, /-fno-threadsafe-statics/);
  });

  test('carries the local-scope mangled name through to the finding', async () => {
    const [f] = of(await findings(), 'function_local_static');
    // _ZZ...E is the Itanium mangling for a function-local entity: the direct
    // join to the guard variable in the ELF at P5.
    assert.match(f.mangled, /^_ZZN2fw7process.*counter$/);
  });

  test('does not mistake a namespace-scope static for a function-local one', async () => {
    const roots = [
      {
        kind: 'VarDecl',
        name: 'g_count',
        storageClass: 'static',
        mangledName: '_ZN2fw7g_countE',
        range: { begin: { file: MAIN, line: 3, col: 1 }, end: { col: 20 } },
      },
    ];
    assert.equal(of(detectRosetta(roots, { mainFile: MAIN }), 'function_local_static').length, 0);
  });

  test('finds the lambda and names its captures by variable name', async () => {
    // clang leaves capture FieldDecls unnamed; the names live on the sibling
    // DeclRefExpr capture initialisers. Reading the fields alone would report
    // this as captureless, which is the opposite of the truth about lifetime.
    const [f] = of(await findings(), 'lambda');
    assert.match(f.title, /capturing out/);
    assert.match(f.emits, /out: Buffer &/);
  });

  test('a by-reference capture is a trap, not merely unfamiliar', async () => {
    const [f] = of(await findings(), 'lambda');
    assert.equal(f.severity, 'trap');
    assert.match(f.emits, /captured by reference/);
    assert.match(f.emits, /dangles/);
  });

  test('distinguishes a captureless lambda, which converts to a function pointer', async () => {
    const roots = [
      {
        kind: 'LambdaExpr',
        range: { begin: { file: MAIN, line: 5, col: 1 }, end: { col: 10 } },
        inner: [{ kind: 'CXXRecordDecl', inner: [] }],
      },
    ];
    const [f] = of(detectRosetta(roots, { mainFile: MAIN }), 'lambda');
    assert.match(f.title, /Captureless/);
    assert.match(f.emits, /plain function pointer/);
  });

  test('flags operator calls that look like indexing', async () => {
    const f = of(await findings(), 'operator_call');
    assert.ok(f.length > 0);
    assert.match(f[0].cEquivalent, /buffer_at/);
  });

  test('finds heap allocation and names the allocator', async () => {
    const [f] = of(await findings(), 'heap_allocation');
    assert.match(f.title, /operator new/);
    assert.equal(f.severity, 'trap');
    assert.match(f.cEquivalent, /static pool/);
  });

  test('finds the matching delete', async () => {
    assert.equal(of(await findings(), 'heap_release').length, 1);
  });

  test('finds the throw and names the unwind tables', async () => {
    const [f] = of(await findings(), 'throw');
    assert.match(f.emits, /ARM\.extab/);
  });

  test('finds the dynamic_cast and names what it drags in', async () => {
    const [f] = of(await findings(), 'rtti_use');
    assert.match(f.emits, /_ZTI/);
    assert.match(f.emits, /__dynamic_cast/);
  });

  test('marks range-for and structured bindings as familiar, not alien', async () => {
    const list = await findings();
    assert.equal(of(list, 'range_for')[0].severity, 'familiar');
    assert.equal(of(list, 'structured_binding')[0].severity, 'familiar');
  });

  test('every finding lands on a real line in the source file', async () => {
    for (const f of await findings()) {
      assert.equal(f.span.file, MAIN);
      assert.ok(f.span.beginLine >= 36 && f.span.beginLine <= 71, `${f.construct} at line ${f.span.beginLine}`);
    }
  });

  test('collapses repeated constructs on one line', async () => {
    const list = await findings();
    const keys = list.map((f) => `${f.construct}|${f.span.beginLine}`);
    assert.equal(new Set(keys).size, keys.length);
    // `out[0] = scratch[0]` really is two operator calls on one line.
    assert.equal(of(list, 'operator_call').filter((f) => f.span.beginLine === 55).length <= 1, true);
  });

  test('findings come back in source order', async () => {
    const lines = (await findings()).map((f) => f.span.beginLine);
    assert.deepEqual([...lines].sort((a, b) => a - b), lines);
  });

  test('groups by line for editor decoration', async () => {
    const byLine = rosettaByLine(await findings());
    assert.ok(byLine.size > 5);
    for (const [line, list] of byLine) {
      assert.ok(list.every((f) => f.span.beginLine === line));
    }
  });
});

describe('Rosetta with and without a structure model', () => {
  const structure = parseClangUml(
    JSON.stringify({
      diagram_type: 'class',
      elements: [
        {
          id: '1',
          name: 'ISpi',
          namespace: 'fw',
          is_abstract: true,
          methods: [{ name: 'transfer', is_virtual: true, is_pure_virtual: true }],
        },
        {
          id: '2',
          name: 'Buffer',
          namespace: 'fw',
          methods: [{ name: 'data' }, { name: 'size' }, { name: '~Buffer' }],
        },
        { id: '3', name: 'Sensor', namespace: 'fw', members: [{ name: 'id', type: 'uint32_t' }] },
      ],
    }),
  );

  test('a virtual member call is only identified when the hierarchy is known', async () => {
    assert.equal(of(await findings(undefined), 'virtual_call_site').length, 0);
    const withModel = of(await findings(structure), 'virtual_call_site');
    assert.equal(withModel.length, 1);
    assert.match(withModel[0].title, /ISpi::transfer/);
  });

  test('a non-virtual member call is not reported as dispatch', async () => {
    const f = of(await findings(structure), 'virtual_call_site');
    assert.equal(f.some((x) => /data|size/.test(x.title)), false);
  });

  test('destructor claims are hedged when no model is loaded and firm when one is', async () => {
    const without = of(await findings(undefined), 'object_construction');
    assert.ok(without.some((f) => /not confirmed/.test(f.emits)));
    const withModel = of(await findings(structure), 'object_construction');
    const buffer = withModel.find((f) => f.title.includes('Buffer'));
    assert.doesNotMatch(buffer.emits, /not confirmed/);
  });

  test('a type with no destructor says construction is the only cost', async () => {
    const roots = [
      {
        kind: 'CXXConstructExpr',
        type: { qualType: 'Sensor' },
        range: { begin: { file: MAIN, line: 40, col: 5 }, end: { col: 20 } },
      },
    ];
    const [f] = of(detectRosetta(roots, { mainFile: MAIN, structure }), 'object_construction');
    assert.match(f.emits, /only cost/);
  });
});

describe('compilation database', () => {
  const db = JSON.stringify([
    {
      directory: '/build',
      file: '/src/motor/controller.cpp',
      command:
        'arm-none-eabi-g++ --target=arm-none-eabi -mcpu=cortex-m7 -DNDEBUG -DBOARD="my board" ' +
        '-I/src/include -std=c++20 -c -o CMakeFiles/x.dir/controller.cpp.o -MD -MF dep.d /src/motor/controller.cpp',
    },
    { directory: '/build', file: '/src/hal/spi.cpp', arguments: ['clang++', '-std=c++17', '-c', '/src/hal/spi.cpp'] },
  ]);

  test('parses both command and arguments forms', () => {
    const entries = parseCompilationDatabase(db);
    assert.equal(entries.length, 2);
    assert.ok(entries[0].command);
    assert.ok(entries[1].arguments);
  });

  test('rejects a non-array database', () => {
    assert.throws(() => parseCompilationDatabase('{}'), CompDbError);
  });

  test('skips malformed entries without losing valid ones', () => {
    const entries = parseCompilationDatabase(JSON.stringify([{ nope: 1 }, { directory: '/b', file: '/a.cpp' }]));
    assert.equal(entries.length, 1);
  });

  test('shell splitting honours quotes', () => {
    assert.deepEqual(shellSplit('g++ -DNAME="a b" -I/x/y file.cpp'), [
      'g++',
      '-DNAME=a b',
      '-I/x/y',
      'file.cpp',
    ]);
  });

  test('shell splitting handles an empty quoted argument', () => {
    assert.deepEqual(shellSplit('g++ -D"" x.cpp'), ['g++', '-D', 'x.cpp']);
  });

  test('matches an entry by exact path and by basename', () => {
    const entries = parseCompilationDatabase(db);
    assert.ok(entryFor(entries, '/src/hal/spi.cpp'));
    assert.ok(entryFor(entries, 'C:/checkout/src/hal/spi.cpp'));
    assert.equal(entryFor(entries, '/src/none.cpp'), undefined);
  });

  test('keeps target, cpu and defines — the flags that change the AST', () => {
    const entries = parseCompilationDatabase(db);
    const flags = sanitiseFlags(shellSplit(entries[0].command), entries[0].file);
    for (const keep of ['--target=arm-none-eabi', '-mcpu=cortex-m7', '-DNDEBUG', '-I/src/include', '-std=c++20']) {
      assert.ok(flags.includes(keep), `dropped ${keep}`);
    }
    assert.ok(flags.includes('-DBOARD=my board'));
  });

  test('drops output, dependency and codegen flags', () => {
    const entries = parseCompilationDatabase(db);
    const flags = sanitiseFlags(shellSplit(entries[0].command), entries[0].file);
    for (const gone of ['-c', '-o', 'CMakeFiles/x.dir/controller.cpp.o', '-MD', '-MF', 'dep.d']) {
      assert.equal(flags.includes(gone), false, `kept ${gone}`);
    }
  });

  test('drops the compiler and the source file, keeping everything unrecognised', () => {
    const flags = sanitiseFlags(
      ['g++', '-fsome-vendor-flag', '-Wall', '/src/a.cpp'],
      '/src/a.cpp',
    );
    assert.deepEqual(flags, ['-fsome-vendor-flag', '-Wall']);
  });

  test('builds an AST command with the filter, which is what makes this viable', () => {
    const entries = parseCompilationDatabase(db);
    const cmd = buildAstCommand(entries[1], 'process');
    assert.equal(cmd.cwd, '/build');
    assert.ok(cmd.args.includes('-fsyntax-only'));
    assert.ok(cmd.args.includes('-ast-dump=json'));
    assert.ok(cmd.args.includes('-ast-dump-filter=process'));
    assert.equal(cmd.args[cmd.args.length - 1], '/src/hal/spi.cpp');
  });

  test('an entry with neither command nor arguments fails loudly', () => {
    assert.throws(() => buildAstCommand({ directory: '/b', file: '/a.cpp' }, 'f'), CompDbError);
  });
});

describe('compilation database resolution and driver mode', () => {
  const cEntry = {
    directory: 'f:/Projects/WindingWheel',
    file: 'f:/Projects/WindingWheel/Application/App.c',
    arguments: ['arm-none-eabi-gcc', '--target=arm-none-eabi', '-std=c11', '-mcpu=cortex-m4', '-c', 'f:/Projects/WindingWheel/Application/App.c'],
  };
  const cppEntry = { directory: '/b', file: '/src/a.cpp', arguments: ['clang++', '-std=c++20', '-c', '/src/a.cpp'] };

  test('the setting accepts a differently named database file', () => {
    assert.deepEqual(databaseCandidates('/ws', 'compile_commands_fixed.json'), ['/ws/compile_commands_fixed.json']);
    assert.deepEqual(databaseCandidates('/ws', 'build/db.json'), ['/ws/build/db.json']);
  });

  test('a directory setting still resolves to the standard filename inside it', () => {
    assert.deepEqual(databaseCandidates('/ws', 'build'), ['/ws/build/compile_commands.json']);
  });

  test('an absolute Windows path is not joined to the workspace root', () => {
    assert.deepEqual(databaseCandidates('/ws', 'F:/proj/compile_commands_fixed.json'), [
      'F:/proj/compile_commands_fixed.json',
    ]);
  });

  test('with no setting, the standard locations are searched in order', () => {
    const c = databaseCandidates('/ws');
    assert.equal(c[0], '/ws/compile_commands.json');
    assert.ok(c.some((x) => x.endsWith('build/compile_commands.json')));
    assert.ok(c.every((x) => x.endsWith('compile_commands.json')));
  });

  test('language comes from -std, which outranks the extension', () => {
    assert.equal(languageOf(cEntry), 'c');
    assert.equal(languageOf(cppEntry), 'c++');
    assert.equal(languageOf({ directory: '/b', file: '/a.cpp', arguments: ['gcc', '-std=gnu11', '/a.cpp'] }), 'c');
  });

  test('an explicit -x outranks everything', () => {
    assert.equal(languageOf({ directory: '/b', file: '/a.c', arguments: ['clang', '-x', 'c++', '/a.c'] }), 'c++');
  });

  test('with neither flag, the extension decides', () => {
    assert.equal(languageOf({ directory: '/b', file: '/a.c', arguments: ['gcc', '/a.c'] }), 'c');
    assert.equal(languageOf({ directory: '/b', file: '/a.cc', arguments: ['g++', '/a.cc'] }), 'c++');
  });

  test('a C entry forces gcc driver mode, without which clang++ refuses to run', () => {
    const cmd = buildAstCommand(cEntry, 'App_Init');
    assert.equal(cmd.language, 'c');
    assert.equal(cmd.args[0], '--driver-mode=gcc');
    assert.ok(cmd.args.includes('-std=c11'));
    assert.ok(cmd.args.includes('--target=arm-none-eabi'));
    assert.ok(cmd.args.includes('-mcpu=cortex-m4'));
  });

  test('a C++ entry uses g++ driver mode', () => {
    assert.equal(buildAstCommand(cppEntry, 'main').args[0], '--driver-mode=g++');
  });

  test('the record layout command carries the same driver mode and target flags', () => {
    const cmd = buildRecordLayoutCommand(cEntry);
    assert.equal(cmd.args[0], '--driver-mode=gcc');
    assert.ok(cmd.args.includes('-fdump-record-layouts'));
    assert.ok(cmd.args.includes('--target=arm-none-eabi'));
    assert.equal(cmd.args[cmd.args.length - 1], cEntry.file);
  });

  test('parses the real STM32 database from a firmware project', async () => {
    const text = await fs.readFile(path.join(here, 'fixtures', 'compile_commands_stm32.json'), 'utf8');
    const entries = parseCompilationDatabase(text);
    assert.equal(entries.length, 50);
    assert.ok(entries.every((e) => languageOf(e) === 'c'));
    const entry = entryFor(entries, 'f:\\Projects\\WindingWheel\\Application\\App.c');
    assert.ok(entry, 'a Windows-style path should match a forward-slash entry');
    assert.equal(buildAstCommand(entry, 'App_Init').language, 'c');
  });
});

describe('staging a differently named database for clang-uml', () => {
  test('an already correctly named database is still rewritten, not used in place', async () => {
    // clang-uml reads the database itself, so this is the only opportunity to
    // correct anything wrong with it. Using the original in place would mean
    // comment lines and missing include paths reach clang-uml untouched.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lens-db-'));
    const file = path.join(dir, 'compile_commands.json');
    const cache = path.join(dir, 'cache');
    await fs.writeFile(file, '[{"directory":"/b","file":"/a.c","arguments":["gcc","# junk","/a.c"]}]', 'utf8');

    const staged = await stageCompilationDatabase(file, cache);
    assert.equal(staged.dir, cache);
    const [entry] = parseCompilationDatabase(await fs.readFile(path.join(cache, 'compile_commands.json'), 'utf8'));
    assert.deepEqual(entry.arguments, ['gcc', '/a.c']);
  });

  test('a differently named database is written into the cache under the standard name', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lens-db-'));
    const file = path.join(dir, 'compile_commands_fixed.json');
    const cache = path.join(dir, '.lens', 'cache');
    await fs.writeFile(file, '[{"directory":"/b","file":"/a.c","arguments":["gcc","/a.c"]}]', 'utf8');

    const staged = await stageCompilationDatabase(file, cache);
    assert.equal(staged.staged, true);
    assert.equal(staged.dir, cache);

    const copied = parseCompilationDatabase(await fs.readFile(path.join(cache, 'compile_commands.json'), 'utf8'));
    assert.equal(copied.length, 1);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['.lens', 'compile_commands_fixed.json']);
  });

  test('comment lines carried over from compile_flags.txt are removed', async () => {
    // A generator that folds compile_flags.txt into arguments brings its comments
    // along, and a compiler reports those as missing input files — which reads
    // like a missing header rather than a malformed database.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lens-db-'));
    const file = path.join(dir, 'compile_commands.json');
    const cache = path.join(dir, 'cache');
    await fs.writeFile(
      file,
      JSON.stringify([
        {
          directory: '/b',
          file: '/a.c',
          arguments: [
            'arm-none-eabi-gcc',
            '# compile_flags.txt - generated by Embedded clangd Generator',
            '-std=c11',
            '   ',
            '# Re-run "Embedded: Generate clangd Config Files" to refresh.',
            '-I/inc',
            '/a.c',
          ],
        },
      ]),
      'utf8',
    );

    await stageCompilationDatabase(file, cache);
    const [entry] = parseCompilationDatabase(await fs.readFile(path.join(cache, 'compile_commands.json'), 'utf8'));
    assert.deepEqual(entry.arguments, ['arm-none-eabi-gcc', '-std=c11', '-I/inc', '/a.c']);
  });

  test('extra flags land after the compiler, not before it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lens-db-'));
    const file = path.join(dir, 'compile_commands.json');
    const cache = path.join(dir, 'cache');
    await fs.writeFile(file, '[{"directory":"/b","file":"/a.c","arguments":["gcc","-std=c11","/a.c"]}]', 'utf8');
    await stageCompilationDatabase(file, cache, ['-isystem', '/res/include']);
    const [entry] = parseCompilationDatabase(await fs.readFile(path.join(cache, 'compile_commands.json'), 'utf8'));
    assert.deepEqual(entry.arguments, ['gcc', '-isystem', '/res/include', '-std=c11', '/a.c']);
  });

  test('sanitiseFlags drops comment lines too, for the AST and layout paths', () => {
    assert.deepEqual(
      sanitiseFlags(['gcc', '# a comment', '-DX', '', '/a.c'], '/a.c'),
      ['-DX'],
    );
    assert.deepEqual(stripNonArguments(['-Wall', '# x', '  ', '// y', '-O2']), ['-Wall', '-O2']);
  });

  test('staging the real STM32 database preserves every entry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lens-db-'));
    const file = path.join(dir, 'compile_commands_fixed.json');
    await fs.copyFile(path.join(here, 'fixtures', 'compile_commands_stm32.json'), file);
    const cache = path.join(dir, 'cache');
    await stageCompilationDatabase(file, cache);
    const copied = parseCompilationDatabase(await fs.readFile(path.join(cache, 'compile_commands.json'), 'utf8'));
    assert.equal(copied.length, 50);
    // Entries carry their own absolute directory, which is why relocating is safe.
    assert.ok(copied.every((e) => /^[a-z]:\//i.test(e.directory)));
  });
});

describe('selecting translation units for a structure diagram', () => {
  const entries = [
    { file: 'F:/Proj/App/App.c' },
    { file: 'F:/Proj/App/Tasks/Motor.cpp' },
    { file: 'F:/Proj/Drivers/Spi.cpp' },
    { file: 'F:/Proj/Main.cpp' },
  ];

  test('a non-recursive scope takes only that folder', () => {
    assert.deepEqual(selectSources(entries, 'F:/Proj', 'App', false), ['F:/Proj/App/App.c']);
  });

  test('a recursive scope reaches subdirectories', () => {
    assert.deepEqual(selectSources(entries, 'F:/Proj', 'App', true), [
      'F:/Proj/App/App.c',
      'F:/Proj/App/Tasks/Motor.cpp',
    ]);
  });

  test('an empty scope means the whole workspace', () => {
    assert.equal(selectSources(entries, 'F:/Proj', '', true).length, 4);
  });

  test('"." is treated as the workspace root, not a literal directory', () => {
    assert.equal(selectSources(entries, 'F:/Proj', '.', false).length, 1);
    assert.deepEqual(selectSources(entries, 'F:/Proj', '.', false), ['F:/Proj/Main.cpp']);
  });

  test('matching is case- and separator-insensitive, as Windows requires', () => {
    assert.equal(selectSources(entries, 'f:\\Proj', 'app', true).length, 2);
  });

  test('a database rooted somewhere else matches nothing, which is worth saying out loud', () => {
    // The failure clang-uml gives for this is "success, no output". Detecting it
    // before running is the difference between a diagnosis and a mystery.
    assert.deepEqual(selectSources(entries, 'F:/OtherCheckout', '', true), []);
  });

  test('selects real entries from the STM32 database', async () => {
    const db = parseCompilationDatabase(
      await fs.readFile(path.join(here, 'fixtures', 'compile_commands_stm32.json'), 'utf8'),
    );
    const all = selectSources(db, 'f:/Projects/WindingWheel', '', true);
    assert.equal(all.length, 50);
    const app = selectSources(db, 'f:/Projects/WindingWheel', 'Application', false);
    assert.ok(app.length > 0 && app.length < 50);
    assert.ok(app.every((f) => /\/Application\/[^/]+$/.test(f)));
  });
});

describe('scratch git repository for clang-uml', () => {
  async function tempWorkspace() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lens-git-'));
    return { root, cache: path.join(root, '.lens', 'cache') };
  }

  test('is skipped entirely when disabled', async () => {
    const { root, cache } = await tempWorkspace();
    const r = await gitWorkingDirectory(root, cache, false);
    assert.deepEqual(r, { cwd: root, scratch: false });
    await assert.rejects(fs.access(path.join(cache, 'gitscratch')));
  });

  test('creates a scratch repository whose HEAD actually resolves', async () => {
    // `git init` alone leaves HEAD on an unborn branch, which trades one fatal
    // git error for another. The commit is the whole point.
    const { root, cache } = await tempWorkspace();
    const r = await gitWorkingDirectory(root, cache, true);
    assert.equal(r.scratch, true);
    assert.equal(r.cwd, path.join(cache, 'gitscratch'));

    const head = await new Promise((resolve) => {
      const c = spawn('git', ['rev-parse', '--verify', 'HEAD'], { cwd: r.cwd });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('close', (code) => resolve({ code, out: out.trim() }));
    });
    assert.equal(head.code, 0, 'HEAD must resolve or clang-uml fails again');
    assert.match(head.out, /^[0-9a-f]{40}$/);
  });

  test('reuses an existing scratch repository instead of reinitialising', async () => {
    const { root, cache } = await tempWorkspace();
    const first = await gitWorkingDirectory(root, cache, true);
    const marker = path.join(first.cwd, 'marker');
    await fs.writeFile(marker, 'x', 'utf8');
    const second = await gitWorkingDirectory(root, cache, true);
    assert.equal(second.cwd, first.cwd);
    await fs.access(marker);
  });

  test('nothing is written outside .lens', async () => {
    const { root, cache } = await tempWorkspace();
    await gitWorkingDirectory(root, cache, true);
    assert.deepEqual(await fs.readdir(root), ['.lens']);
  });

  test('uses the workspace itself when it is already a repository', async () => {
    const { root, cache } = await tempWorkspace();
    await new Promise((resolve) => spawn('git', ['init', '--quiet', '.'], { cwd: root }).on('close', resolve));
    await new Promise((resolve) =>
      spawn('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-q', '-m', 'x'], {
        cwd: root,
      }).on('close', resolve),
    );
    const r = await gitWorkingDirectory(root, cache, true);
    assert.deepEqual(r, { cwd: root, scratch: false });
  });
});

describe('vendor device macro discovery', () => {
  let header;
  before(async () => {
    header = await fs.readFile(path.join(here, 'fixtures', 'stm32g4xx-guard.h'), 'utf8');
  });

  test('finds every device macro the header will accept', () => {
    const found = findDeviceSelection(header);
    assert.ok(found);
    assert.deepEqual(found.candidates, [
      'STM32G431xx',
      'STM32G441xx',
      'STM32G471xx',
      'STM32G473xx',
      'STM32G474xx',
      'STM32G483xx',
      'STM32G484xx',
      'STM32G491xx',
      'STM32G4A1xx',
      'STM32GBK1CB',
    ]);
  });

  test('reads across the backslash line continuations ST uses', () => {
    // The guard spans four physical lines; stopping at the first would find
    // three macros and quietly omit the rest.
    assert.equal(findDeviceSelection(header).candidates.length, 10);
  });

  test('quotes are stripped from the error text', () => {
    assert.match(findDeviceSelection(header).message, /^Please select first the target/);
    assert.doesNotMatch(findDeviceSelection(header).message, /^"/);
  });

  test('an ordinary two-macro guard is not mistaken for a part selector', () => {
    const ordinary = `#if !defined(A) && !defined(B)\n  #error "define A or B"\n#endif\n`;
    assert.equal(findDeviceSelection(ordinary), undefined);
  });

  test('a header with no #error yields nothing', () => {
    assert.equal(findDeviceSelection('#ifndef X\n#define X\n#endif\n'), undefined);
  });

  test('recognises the failure from the compiler diagnostic', () => {
    assert.equal(
      looksLikeDeviceSelection(
        'stm32g4xx.h:137: "Please select first the target STM32G4xx device used in your application"',
      ),
      true,
    );
    assert.equal(looksLikeDeviceSelection("error: unknown type name 'GPIO_TypeDef'"), false);
  });

  test('suggests USE_HAL_DRIVER alongside the device macro for ST projects', () => {
    assert.deepEqual(commonMissingDefines(header), ['USE_HAL_DRIVER']);
    assert.deepEqual(commonMissingDefines('#error "pick a part"'), []);
  });

  test('extra flags reach every command Lens builds', () => {
    setExtraCompileFlags(['-DSTM32G474xx', '-DUSE_HAL_DRIVER', '   ']);
    const entry = {
      directory: '/b',
      file: '/a.c',
      arguments: ['arm-none-eabi-gcc', '-std=c11', '/a.c'],
    };
    const ast = buildAstCommand(entry, 'main');
    assert.deepEqual(ast.args.slice(0, 3), ['--driver-mode=gcc', '-DSTM32G474xx', '-DUSE_HAL_DRIVER']);
    assert.equal(buildRecordLayoutCommand(entry).args.includes('-DSTM32G474xx'), true);
    setExtraCompileFlags([]);
    assert.equal(buildAstCommand(entry, 'main').args.includes('-DSTM32G474xx'), false);
  });
});

describe('cross toolchain include paths', () => {
  let probeOutput;
  before(async () => {
    probeOutput = await fs.readFile(path.join(here, 'fixtures', 'gcc-include-search.txt'), 'utf8');
  });

  test('extracts the angle-bracket search list from real driver output', () => {
    const dirs = parseIncludeSearchList(probeOutput);
    assert.ok(dirs.length >= 4, `only found ${dirs.length}`);
    assert.ok(dirs.some((d) => /c\+\+/.test(d)), 'the C++ standard library path is the whole point');
    assert.ok(dirs.every((d) => d.startsWith('/')));
  });

  test('stops at the end marker and takes nothing after it', () => {
    const dirs = parseIncludeSearchList(probeOutput);
    assert.equal(dirs.some((d) => /End of search list/.test(d)), false);
    assert.equal(dirs.some((d) => d.includes('#')), false);
  });

  test('excludes the quoted-form directories, which the database already has', () => {
    const dirs = parseIncludeSearchList(
      ['#include "..." search starts here:', ' /project/inc', '#include <...> search starts here:', ' /sys/inc', 'End of search list.'].join('\n'),
    );
    assert.deepEqual(dirs, ['/sys/inc']);
  });

  test('strips the framework annotation macOS adds', () => {
    const dirs = parseIncludeSearchList(
      ['#include <...> search starts here:', ' /System/Library/Frameworks (framework directory)', 'End of search list.'].join('\n'),
    );
    assert.deepEqual(dirs, ['/System/Library/Frameworks']);
  });

  test('output without the markers yields nothing rather than garbage', () => {
    assert.deepEqual(parseIncludeSearchList('arm-none-eabi-g++: command not found'), []);
  });

  test('flags are deduplicated', () => {
    assert.deepEqual(asIsystemFlags(['/a', '/a', '/b']), ['-isystem', '/a', '-isystem', '/b']);
  });

  test('the probe asks for the right language', () => {
    assert.deepEqual(includeProbeArgs('c++'), ['-x', 'c++', '-E', '-Wp,-v', '-']);
    assert.deepEqual(includeProbeArgs('c'), ['-x', 'c', '-E', '-Wp,-v', '-']);
  });

  test('tells a builtin header apart from a standard library one', () => {
    // One character between them, and completely different fixes.
    assert.equal(classifyMissingHeader('limits.h'), 'builtin');
    assert.equal(classifyMissingHeader('limits'), 'standard-library');
    assert.equal(classifyMissingHeader('stdbool.h'), 'builtin');
    assert.equal(classifyMissingHeader('cstdint'), 'standard-library');
    assert.equal(classifyMissingHeader('vector'), 'standard-library');
    assert.equal(classifyMissingHeader('stm32g4xx.h'), 'project');
    assert.equal(classifyMissingHeader('Application/Buzzer.h'), 'project');
  });

  test('pulls the header name out of a compiler diagnostic', () => {
    assert.equal(
      missingHeaderFrom("modbus_callbacks.cpp:10: 'limits' file not found"),
      'limits',
    );
    assert.equal(missingHeaderFrom('unrelated error'), undefined);
  });

  test('the resolver caches per compiler and language', async () => {
    let calls = 0;
    const resolve = makeIncludeResolver(async () => {
      calls += 1;
      return { stdout: '', stderr: probeOutput, failed: false };
    });
    await resolve('arm-none-eabi-g++', 'c++');
    await resolve('arm-none-eabi-g++', 'c++');
    assert.equal(calls, 1, 'a repeated request must not spawn again');
    await resolve('arm-none-eabi-g++', 'c');
    assert.equal(calls, 2, 'a different language is a different answer');
  });

  test('a compiler that cannot be run yields nothing, and does not throw', async () => {
    const resolve = makeIncludeResolver(async () => ({ stdout: '', stderr: '', failed: true }));
    assert.deepEqual(await resolve('missing-gcc', 'c++'), []);
  });

  test('staging injects the harvested paths ahead of the project flags', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lens-inc-'));
    const file = path.join(dir, 'compile_commands.json');
    await fs.writeFile(
      file,
      '[{"directory":"/b","file":"/a.cpp","arguments":["arm-none-eabi-g++","-std=c++17","-I/proj","/a.cpp"]}]',
      'utf8',
    );
    const resolve = makeIncludeResolver(async () => ({ stdout: '', stderr: probeOutput, failed: false }));
    const staged = await stageCompilationDatabase(file, path.join(dir, 'cache'), [], resolve);
    assert.equal(staged.probed, 1);

    const [entry] = parseCompilationDatabase(
      await fs.readFile(path.join(dir, 'cache', 'compile_commands.json'), 'utf8'),
    );
    assert.equal(entry.arguments[0], 'arm-none-eabi-g++');
    assert.equal(entry.arguments[1], '-isystem');
    // The project's own flags must still come after, so they can override.
    assert.ok(entry.arguments.indexOf('-I/proj') > entry.arguments.indexOf('-isystem'));
  });
});
