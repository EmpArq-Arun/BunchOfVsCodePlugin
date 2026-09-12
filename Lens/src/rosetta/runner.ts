import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseAstDump, AstParseError, type AstNode } from '../core/ast.js';
import { asIsystemFlags, includeProbeArgs, parseIncludeSearchList } from '../core/sysinclude.js';
import {
  buildAstCommand,
  databaseCandidates,
  entryFor,
  languageOf,
  parseCompilationDatabase,
  CompDbError,
  type CompileEntry,
  type SourceLanguage,
} from '../core/compdb.js';

/**
 * Runs clang to dump the AST of one declaration.
 *
 * Every external tool is a configured path with a typed failure, following the
 * same rule as clang-uml: a missing binary is an expected first-run state that
 * must produce an actionable sentence, not a stack trace, and must never stop
 * the lenses that do not need it.
 *
 * The flags come from the project's own compile_commands.json rather than being
 * synthesised. That is not convenience — dumping an AST with host defaults for
 * code built for a Cortex-M produces an AST for a program that does not exist.
 */

export type AstFailure =
  | { kind: 'no-clang'; hint: string }
  | { kind: 'no-database'; hint: string }
  | { kind: 'no-entry'; file: string }
  | { kind: 'clang-failed'; exitCode: number | null; stderr: string }
  | { kind: 'timeout'; seconds: number }
  | { kind: 'no-match'; decl: string }
  | { kind: 'bad-output'; message: string };

export type AstResult =
  | { ok: true; roots: AstNode[]; mainFile: string; language: SourceLanguage }
  | { ok: false; failure: AstFailure };

export interface AstRunOptions {
  clangPath: string;
  workspaceRoot: string;
  databaseDir?: string;
  sourceFile: string;
  declName: string;
  timeoutSeconds: number;
}

function exec(
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

/** Resolve to the database *file*, which the setting may name directly. */
export async function findDatabaseFile(root: string, configured?: string): Promise<string | undefined> {
  for (const candidate of databaseCandidates(root, configured, path.join)) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return undefined;
}

const includeCache = new Map<string, string[]>();

/**
 * Ask the database's own compiler where it looks for headers, and cache it.
 *
 * Failure is silent and returns nothing: on a machine where the cross compiler
 * is not installed, the analysis should still run and fail later with a specific
 * missing-header message rather than refusing up front.
 */
async function probeSystemIncludes(
  compiler: string,
  language: SourceLanguage,
  cwd: string,
): Promise<string[]> {
  const key = `${compiler}|${language}`;
  const hit = includeCache.get(key);
  if (hit) {
    return hit;
  }
  const probe = await exec(compiler, includeProbeArgs(language === 'c' ? 'c' : 'c++'), cwd, 30);
  const dirs = probe.spawnError ? [] : parseIncludeSearchList(`${probe.stderr}\n${probe.stdout}`);
  const flags = asIsystemFlags(dirs);
  includeCache.set(key, flags);
  return flags;
}

export async function dumpAst(opts: AstRunOptions): Promise<AstResult> {
  const probe = await exec(opts.clangPath, ['--version'], opts.workspaceRoot, 15);
  if (probe.spawnError) {
    return {
      ok: false,
      failure: {
        kind: 'no-clang',
        hint:
          `Could not run "${opts.clangPath}". Set lens.clang.path to a clang or clang++ binary. ` +
          'Any recent clang works — it does not need to be the compiler you build with, though it does need to ' +
          'understand your build flags.',
      },
    };
  }

  const dbFile = await findDatabaseFile(opts.workspaceRoot, opts.databaseDir);
  if (!dbFile) {
    return {
      ok: false,
      failure: {
        kind: 'no-database',
        hint:
          'No compilation database found. Generate one with CMAKE_EXPORT_COMPILE_COMMANDS=ON, bear, or compiledb. ' +
          'If yours is not called compile_commands.json, set lens.compilationDatabase to the file itself — the ' +
          'setting takes a path to the .json as well as a directory.',
      },
    };
  }

  let entries: CompileEntry[];
  try {
    entries = parseCompilationDatabase(await fs.readFile(dbFile, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'bad-output', message: err instanceof CompDbError ? err.message : String(err) },
    };
  }

  const entry = entryFor(entries, opts.sourceFile);
  if (!entry) {
    return { ok: false, failure: { kind: 'no-entry', file: opts.sourceFile } };
  }

  let command;
  try {
    command = buildAstCommand(entry, opts.declName);
  } catch (err) {
    return { ok: false, failure: { kind: 'bad-output', message: String(err) } };
  }

  // The same missing-standard-library problem applies here: a cross toolchain's
  // own headers appear nowhere in the database, so clang has to be told.
  const argv0 = (entry.arguments ?? [])[0];
  const systemIncludes = argv0 ? await probeSystemIncludes(argv0, command.language, entry.directory) : [];
  const run = await exec(
    opts.clangPath,
    [...command.args.slice(0, 1), ...systemIncludes, ...command.args.slice(1)],
    command.cwd,
    opts.timeoutSeconds,
  );
  if (run.timedOut) {
    return { ok: false, failure: { kind: 'timeout', seconds: opts.timeoutSeconds } };
  }

  // clang exits non-zero on any diagnostic, but still emits the AST it managed
  // to build. A codebase mid-edit is the normal case for a reading tool, so a
  // usable dump is preferred over an exit status.
  if (run.stdout.trim().length === 0) {
    if (run.spawnError || run.code !== 0) {
      return {
        ok: false,
        failure: {
          kind: 'clang-failed',
          exitCode: run.code,
          stderr: (run.stderr || run.spawnError?.message || '').trim().slice(0, 2000),
        },
      };
    }
    return { ok: false, failure: { kind: 'no-match', decl: opts.declName } };
  }

  try {
    return {
      ok: true,
      roots: parseAstDump(run.stdout),
      mainFile: path.basename(entry.file),
      language: languageOf(entry),
    };
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'bad-output', message: err instanceof AstParseError ? err.message : String(err) },
    };
  }
}

export function describeAstFailure(f: AstFailure): string {
  switch (f.kind) {
    case 'no-clang':
    case 'no-database':
      return f.hint;
    case 'no-entry':
      return (
        `${path.basename(f.file)} is not in the compilation database. Headers usually are not — put the cursor ` +
        'in a .c or .cpp file that is, or rebuild the database after adding this file.'
      );
    case 'timeout':
      return `clang did not finish within ${f.seconds}s. Raise lens.clang.timeoutSeconds.`;
    case 'clang-failed':
      return (
        `clang exited with ${f.exitCode ?? 'no status'} and produced no AST.\n${f.stderr}` +
        (/not allowed with 'C\+\+'|invalid argument/.test(f.stderr)
          ? '\n\nThis usually means the driver language was wrong for the file. Lens picks it from the ' +
            'compilation database entry; if that entry is missing its -std or -x flag, add one.'
          : '')
      );
    case 'no-match':
      return `clang parsed the file but found no declaration named "${f.decl}".`;
    case 'bad-output':
      return f.message;
  }
}
