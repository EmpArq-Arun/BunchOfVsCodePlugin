import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseClangUml, ClangUmlParseError } from '../core/clanguml.js';
import {
  languageOf,
  parseCompilationDatabase,
  shellSplit,
  stripNonArguments,
  type CompileEntry,
} from '../core/compdb.js';
import {
  asIsystemFlags,
  classifyMissingHeader,
  includeProbeArgs,
  missingHeaderFrom,
  parseIncludeSearchList,
} from '../core/sysinclude.js';
import type { StructureModel } from '../core/structure.js';

/**
 * clang-uml invocation.
 *
 * Every failure mode is a value rather than an exception, because "clang-uml is
 * not installed" and "there is no compilation database" are the two most likely
 * outcomes on a first run and both need an actionable message rather than a
 * stack trace. The Structure lens is expected to be unavailable on a fresh
 * checkout and must say why.
 */

export type RunFailure =
  | { kind: 'no-binary'; hint: string }
  | { kind: 'no-database'; hint: string }
  | { kind: 'no-matching-files'; scope: string; total: number; sample?: string }
  | { kind: 'failed'; exitCode: number | null; stderr: string }
  | { kind: 'timeout'; seconds: number }
  | { kind: 'bad-output'; message: string };

export type RunResult = { ok: true; model: StructureModel } | { ok: false; failure: RunFailure };

export interface RunOptions {
  workspaceRoot: string;
  /** Path or bare command name. */
  binary: string;
  /** Resolved path to the compilation database *file*. */
  databaseFile?: string;
  /**
   * Workspace-relative directory to scope the diagram to; empty means everything.
   * Resolved against the database rather than turned into a glob pattern — see
   * `selectSources`.
   */
  scopeDir: string;
  /** True to include translation units in subdirectories of `scopeDir`. */
  recursive: boolean;
  /** Namespaces to include; empty means no namespace filter. */
  namespaces: string[];
  /** Namespaces to exclude — vendor SDKs, almost always. */
  excludeNamespaces: string[];
  title: string;
  cacheDir: string;
  timeoutSeconds: number;
  /** clang binary, asked for its resource directory so builtin headers resolve. */
  clangPath: string;
  /** User-supplied flags, typically the vendor device macro. */
  extraFlags: string[];
  /** Work around clang-uml versions that require a git repository. */
  gitWorkaround: boolean;
}

const DIAGRAM_NAME = 'lens_structure';

/**
 * Give clang-uml a working directory inside a git repository.
 *
 * Some clang-uml versions query git at startup to populate the `git` Jinja
 * context and treat its failure as fatal, so running against a project that is
 * not under version control fails with nothing but `fatal: not a git
 * repository`. 0.6.3 does not do this; older ones do.
 *
 * When the workspace is not in a work tree, Lens initialises a scratch repository
 * under `.lens/cache` and runs clang-uml from there. Verified against 0.6.3 that
 * this changes nothing about the output: every path Lens writes into the config
 * is absolute and `relative_to` is set explicitly, so the working directory does
 * not participate in path resolution.
 *
 * The repository must contain a commit. `git init` alone leaves `HEAD` pointing
 * at an unborn branch, and a version that queries `git rev-parse HEAD` fails
 * with "ambiguous argument 'HEAD'" — trading one fatal git error for another.
 *
 * The commit is made with identity and signing supplied on the command line
 * rather than read from configuration, because a machine with no `user.email`
 * set, or with `commit.gpgsign` on and no key available, is common and would
 * otherwise fail here for reasons that have nothing to do with C++.
 *
 * Nothing is written outside `.lens/`, and the project is never touched.
 */
export async function gitWorkingDirectory(
  workspaceRoot: string,
  cacheDir: string,
  enabled: boolean,
): Promise<{ cwd: string; scratch: boolean }> {
  if (!enabled) {
    return { cwd: workspaceRoot, scratch: false };
  }
  const inTree = await run('git', ['rev-parse', '--is-inside-work-tree'], workspaceRoot, 15);
  if (!inTree.spawnError && inTree.code === 0 && inTree.stdout.trim() === 'true') {
    return { cwd: workspaceRoot, scratch: false };
  }
  if (inTree.spawnError) {
    // No git at all. Nothing to work around with.
    return { cwd: workspaceRoot, scratch: false };
  }

  const scratchDir = path.join(cacheDir, 'gitscratch');
  await fs.mkdir(scratchDir, { recursive: true });

  // Reuse the scratch repository only once it has a resolvable HEAD; a
  // half-created one from an interrupted run must be finished, not trusted.
  const head = await run('git', ['rev-parse', '--verify', 'HEAD'], scratchDir, 15);
  if (!head.spawnError && head.code === 0) {
    return { cwd: scratchDir, scratch: true };
  }

  const init = await run('git', ['init', '--quiet', '.'], scratchDir, 20);
  if (init.spawnError || init.code !== 0) {
    return { cwd: workspaceRoot, scratch: false };
  }
  const commit = await run(
    'git',
    [
      '-c',
      'user.email=lens@localhost',
      '-c',
      'user.name=Lens',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'Lens scratch repository — created so clang-uml can query git. Not your project.',
    ],
    scratchDir,
    20,
  );
  if (commit.spawnError || commit.code !== 0) {
    return { cwd: workspaceRoot, scratch: false };
  }
  return { cwd: scratchDir, scratch: true };
}

/**
 * Give clang-uml a directory containing a file called `compile_commands.json`.
 *
 * clang-uml takes `compilation_database_dir` and requires that exact filename,
 * which the other lenses do not. Rather than make the user maintain a symlink,
 * Lens stages a copy into its own cache directory — a place it already creates
 * and owns — and points clang-uml there. Nothing is written outside `.lens/`.
 *
 * Staging is safe because compilation database entries carry an absolute
 * `directory` per entry, so relocating the file does not change how any command
 * resolves.
 */
/**
 * Ask the compiler named in a database entry where it looks for headers.
 *
 * A cross toolchain's own headers — libstdc++ for C++, newlib for C — are found
 * by the GCC driver from paths compiled into it, and appear nowhere in the
 * database. clang cannot guess them, so the first `#include <limits>` fails.
 * Results are cached per compiler and language; a probe costs a subprocess.
 */
export function makeIncludeResolver(
  runner: (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string; failed: boolean }>,
): (compiler: string, language: 'c' | 'c++') => Promise<string[]> {
  const cache = new Map<string, string[]>();
  return async (compiler, language) => {
    const key = `${compiler}|${language}`;
    const hit = cache.get(key);
    if (hit) {
      return hit;
    }
    const result = await runner(compiler, includeProbeArgs(language));
    // GCC prints the search list on stderr; be indifferent to which stream.
    const dirs = result.failed ? [] : parseIncludeSearchList(`${result.stderr}\n${result.stdout}`);
    cache.set(key, dirs);
    return dirs;
  };
}

export async function stageCompilationDatabase(
  databaseFile: string,
  cacheDir: string,
  extraFlags: string[] = [],
  resolveIncludes?: (compiler: string, language: 'c' | 'c++') => Promise<string[]>,
): Promise<{ dir: string; staged: boolean; probed: number }> {
  await fs.mkdir(cacheDir, { recursive: true });
  const entries = parseCompilationDatabase(await fs.readFile(databaseFile, 'utf8'));

  // Always rewrite rather than copy. clang-uml reads the database itself, so
  // anything wrong with it — comment lines carried over from compile_flags.txt,
  // a missing builtin include path — has to be corrected here or not at all.
  let probed = 0;
  const cleaned: CompileEntry[] = [];
  for (const e of entries) {
    const argv = stripNonArguments(e.arguments ?? shellSplit(e.command ?? ''));
    const compiler = argv.slice(0, 1);
    const rest = argv.slice(1);

    let systemIncludes: string[] = [];
    if (resolveIncludes && compiler[0]) {
      const dirs = await resolveIncludes(compiler[0], languageOf(e) === 'c' ? 'c' : 'c++');
      if (dirs.length > 0) {
        probed += 1;
        systemIncludes = asIsystemFlags(dirs);
      }
    }

    cleaned.push({
      directory: e.directory,
      file: e.file,
      arguments: [...compiler, ...extraFlags, ...systemIncludes, ...rest],
      ...(e.output ? { output: e.output } : {}),
    });
  }

  await fs.writeFile(path.join(cacheDir, 'compile_commands.json'), JSON.stringify(cleaned, null, 2), 'utf8');
  return { dir: cacheDir, staged: true, probed };
}

/**
 * Choose which translation units the diagram covers, by consulting the database
 * rather than by writing a glob pattern.
 *
 * clang-uml resolves relative globs against the config file's own directory, and
 * Lens writes its config into `.lens/cache`, so a workspace-relative pattern like
 * `Application/*.cpp` silently matches nothing and clang-uml exits successfully
 * having produced no output. Selecting the exact absolute paths from the database
 * removes the guesswork: if nothing matches, Lens knows before running anything
 * and can say how many entries it looked at.
 */
export function selectSources(
  entries: { file: string }[],
  workspaceRoot: string,
  scopeDir: string,
  recursive: boolean,
): string[] {
  const normalise = (v: string) => v.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  const root = normalise(workspaceRoot).replace(/\/$/, '');
  const scope = normalise(scopeDir).replace(/^\.$|^\/+|\/+$/g, '');
  const prefix = scope.length > 0 ? `${root}/${scope}/` : `${root}/`;

  return entries
    .map((e) => e.file)
    .filter((file) => {
      const f = normalise(file);
      if (!f.startsWith(prefix)) {
        return false;
      }
      return recursive || !f.slice(prefix.length).includes('/');
    });
}

/**
 * Emit a minimal .clang-uml config.
 *
 * Written by hand rather than with a YAML library: the document is small, fixed
 * in shape, and entirely machine-generated, and it is worth keeping the
 * extension free of a YAML dependency it needs in exactly one place. Values are
 * quoted defensively because Windows paths and glob patterns both contain
 * characters YAML treats specially.
 */
export function buildConfig(opts: RunOptions, databaseDir: string, sources: string[]): string {
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const list = (items: string[], indent: string) => items.map((i) => `${indent}- ${q(i)}`).join('\n');

  const lines = [
    `compilation_database_dir: ${q(databaseDir.split(path.sep).join('/'))}`,
    `output_directory: ${q(opts.cacheDir.split(path.sep).join('/'))}`,
    // Anchor any remaining relative path to the workspace, not to wherever this
    // generated config happens to live.
    `relative_to: ${q(opts.workspaceRoot.split(path.sep).join('/'))}`,
    'diagrams:',
    `  ${DIAGRAM_NAME}:`,
    '    type: class',
    `    title: ${q(opts.title)}`,
    '    generate_packages: false',
    // Dependency edges dominate real diagrams and say little about structure;
    // inheritance and ownership are what a newcomer needs first.
    '    exclude:',
    '      relationships:',
    '        - dependency',
  ];

  if (opts.excludeNamespaces.length > 0) {
    lines.push('      namespaces:', list(opts.excludeNamespaces, '        '));
  }
  if (sources.length > 0) {
    // Absolute paths straight from the database: no pattern semantics involved.
    lines.push('    glob:', list(sources, '      '));
  }
  if (opts.namespaces.length > 0) {
    lines.push('    include:', '      namespaces:', list(opts.namespaces, '        '));
  }

  return `${lines.join('\n')}\n`;
}

function run(
  binary: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: Error }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { cwd, shell: false });
    // Close stdin immediately. The include-path probe compiles from `-`, so a
    // driver left with an open stdin waits for input until the timeout kills it
    // — a hang rather than an error, and invisible to any test that mocks the
    // subprocess. Harmless for every other tool Lens spawns.
    child.stdin?.end();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutSeconds * 1000);

    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (spawnError) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export async function checkBinary(binary: string): Promise<string | undefined> {
  const r = await run(binary, ['--version'], process.cwd(), 15);
  if (r.spawnError) {
    return undefined;
  }
  return (r.stdout + r.stderr).trim().split('\n')[0] || 'unknown version';
}

export async function generateStructure(opts: RunOptions): Promise<RunResult> {
  const version = await checkBinary(opts.binary);
  if (version === undefined) {
    return {
      ok: false,
      failure: {
        kind: 'no-binary',
        hint:
          `Could not run "${opts.binary}". Install clang-uml (apt/brew/conda, or a release build) ` +
          'and set lens.clangUml.path if it is not on PATH.',
      },
    };
  }

  if (!opts.databaseFile) {
    return {
      ok: false,
      failure: {
        kind: 'no-database',
        hint:
          'No compilation database found. Generate one with CMAKE_EXPORT_COMPILE_COMMANDS=ON, bear, or compiledb. ' +
          'If yours is not called compile_commands.json, set lens.compilationDatabase to the file itself — Lens ' +
          'stages a copy under .lens/cache/ for clang-uml, which requires that exact name.',
      },
    };
  }

  await fs.mkdir(opts.cacheDir, { recursive: true });

  // clang-uml bundles its own LLVM, and on Windows it does not always locate the
  // builtin headers — stdbool.h, stdint.h and friends live in clang's resource
  // directory, not in any system include path. Asking the configured clang where
  // its resource directory is and adding it explicitly resolves that without
  // assuming anything about how clang-uml was installed.
  const resource = await run(opts.clangPath, ['-print-resource-dir'], opts.workspaceRoot, 20);
  const extraFlags: string[] =
    !resource.spawnError && resource.code === 0 && resource.stdout.trim().length > 0
      ? ['-isystem', path.join(resource.stdout.trim(), 'include').split(path.sep).join('/')]
      : [];
  extraFlags.push(...opts.extraFlags.filter((f) => f.trim().length > 0));

  let databaseDir: string;
  try {
    const resolver = makeIncludeResolver(async (bin, args) => {
      const r = await run(bin, args, opts.workspaceRoot, 30);
      return { stdout: r.stdout, stderr: r.stderr, failed: Boolean(r.spawnError) };
    });
    ({ dir: databaseDir } = await stageCompilationDatabase(
      opts.databaseFile,
      opts.cacheDir,
      extraFlags,
      resolver,
    ));
  } catch (err) {
    return { ok: false, failure: { kind: 'bad-output', message: String(err) } };
  }

  let entries: { file: string }[] = [];
  try {
    entries = parseCompilationDatabase(await fs.readFile(opts.databaseFile, 'utf8'));
  } catch (err) {
    return { ok: false, failure: { kind: 'bad-output', message: String(err) } };
  }
  const sources = selectSources(entries, opts.workspaceRoot, opts.scopeDir, opts.recursive);
  if (sources.length === 0) {
    return {
      ok: false,
      failure: {
        kind: 'no-matching-files',
        scope: opts.scopeDir || '(whole workspace)',
        total: entries.length,
        ...(entries[0] ? { sample: entries[0].file } : {}),
      },
    };
  }

  const configPath = path.join(opts.cacheDir, 'clang-uml.yml');
  await fs.writeFile(configPath, buildConfig(opts, databaseDir, sources), 'utf8');

  const { cwd } = await gitWorkingDirectory(opts.workspaceRoot, opts.cacheDir, opts.gitWorkaround);
  const result = await run(
    opts.binary,
    // No --progress: it is a boolean flag in clang-uml, and passing it a value
    // makes the argument parser reject the run outright with exit 109.
    ['-c', configPath, '-n', DIAGRAM_NAME, '-g', 'json'],
    cwd,
    opts.timeoutSeconds,
  );

  if (result.timedOut) {
    return { ok: false, failure: { kind: 'timeout', seconds: opts.timeoutSeconds } };
  }
  if (result.spawnError || result.code !== 0) {
    return {
      ok: false,
      failure: {
        kind: 'failed',
        exitCode: result.code,
        stderr: (result.stderr || result.stdout || result.spawnError?.message || '').trim().slice(0, 2000),
      },
    };
  }

  const outputPath = path.join(opts.cacheDir, `${DIAGRAM_NAME}.json`);
  let text: string;
  try {
    text = await fs.readFile(outputPath, 'utf8');
  } catch {
    return {
      ok: false,
      failure: {
        kind: 'bad-output',
        message:
          `clang-uml reported success but wrote no JSON to ${outputPath}. ` +
          'This usually means the glob matched no translation units in the compilation database.',
      },
    };
  }

  try {
    return { ok: true, model: parseClangUml(text) };
  } catch (err) {
    return {
      ok: false,
      failure: {
        kind: 'bad-output',
        message: err instanceof ClangUmlParseError ? err.message : String(err),
      },
    };
  }
}

/**
 * A missing header has three quite different causes, and the fix depends on
 * which. `stdbool.h` lives in clang's resource directory; `<limits>` belongs to
 * the standard library that came with the cross compiler; anything else is a
 * project include path. Naming the wrong one sends people to the wrong setting —
 * which this message previously did.
 */
function describeMissingHeader(stderr: string): string {
  const header = missingHeaderFrom(stderr);
  if (!header) {
    return '';
  }
  switch (classifyMissingHeader(header)) {
    case 'builtin':
      return (
        `\n\n'${header}' is one of clang's own builtin headers, so clang-uml could not find its resource ` +
        'directory. Lens supplies one from lens.clang.path — check that setting points at a working clang.'
      );
    case 'standard-library':
      return (
        `\n\n'${header}' belongs to the standard library that shipped with your cross compiler, not to clang. ` +
        'Lens asks the compiler named in your compilation database where it looks for headers and passes those ' +
        'paths on, so this means that compiler could not be run — check it is on PATH under the exact name the ' +
        'database records, or add its include directories to lens.extraCompileFlags as -isystem entries.'
      );
    case 'project':
      return (
        `\n\n'${header}' is a project header. Its directory is missing from the -I flags in your compilation ` +
        'database, or the database records paths from a different machine.'
      );
  }
}

export function describeFailure(f: RunFailure): string {
  switch (f.kind) {
    case 'no-binary':
    case 'no-database':
      return f.hint;
    case 'no-matching-files':
      return (
        `None of the ${f.total} entries in your compilation database are under ${f.scope}.` +
        (f.sample
          ? `\n\nThe database records paths like ${f.sample}. If that root does not match your open workspace ` +
            `folder — a database generated on a different machine or a different drive letter, for instance — ` +
            `clang-uml cannot match anything against it.`
          : '')
      );
    case 'timeout':
      return `clang-uml did not finish within ${f.seconds}s. Narrow the diagram scope, or raise lens.clangUml.timeoutSeconds.`;
    case 'failed':
      return (
        `clang-uml exited with ${f.exitCode ?? 'no status'}.\n${f.stderr}` +
        describeMissingHeader(f.stderr) +
        (/not a git repository|ambiguous argument 'HEAD'|Not a valid object name/.test(f.stderr)
          ? '\n\nThis clang-uml version queries git at startup and treats its failure as fatal. Lens works ' +
            'around it by running from a scratch repository under .lens/cache, which needs git on PATH and a ' +
            'commit it can resolve. If this persists, delete .lens/cache/gitscratch and try again, or upgrade ' +
            'clang-uml — 0.6.3 needs no repository at all.'
          : '')
      );
    case 'bad-output':
      return f.message;
  }
}
