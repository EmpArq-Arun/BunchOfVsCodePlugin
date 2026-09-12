import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { CompileCommandsDb } from './compileCommands';
import { SemanticEngineConfig } from './semanticEnrichment';
import * as diag from '../diagnostics';

const COMMON_SUBDIRS = [
  '',
  'build',
  'out',
  'cmake-build-debug',
  'cmake-build-release',
  'cmake-build-relwithdebinfo',
  '_build',
  'release',
  'debug',
];

function findClangVersion(binary: string): string {
  try {
    const out = execFileSync(binary, ['--version'], {
      timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.split('\n')[0]?.trim() ?? 'unknown';
  } catch {
    return 'not found';
  }
}

/** Normalise all path separators to forward slashes. */
const norm = (p: string) => p.replace(/\\/g, '/');

/** Return true when `p` exists and is a directory. */
function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Append compile_commands.json when `p` is a directory path. */
function resolveToFile(p: string): string {
  return (p.endsWith('/') || isDir(p))
    ? norm(path.join(p, 'compile_commands.json'))
    : p;
}

export function resolveSemanticConfig(): SemanticEngineConfig | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  const workspaceRoot = norm(folders[0].uri.fsPath);

  const cfg = vscode.workspace.getConfiguration('callgraph');

  // ── 0. Resolve the clang binary first so we know whether the user has set one ──

  let clangBinaryRaw = cfg.get<string>('clangBinaryPath', '').trim();
  if (clangBinaryRaw) {
    clangBinaryRaw = norm(clangBinaryRaw);
    // If the user gave a directory ending with / or \, append the binary name
    if (clangBinaryRaw.endsWith('/') || isDir(clangBinaryRaw)) {
      const exeName = process.platform === 'win32' ? 'clang++.exe' : 'clang++';
      clangBinaryRaw = norm(path.join(clangBinaryRaw, exeName));
      diag.logInfo(`clangBinaryPath was a directory — resolved to: ${clangBinaryRaw}`);
    }
  }
  const userSetClang = clangBinaryRaw.length > 0;
  const clangBinary = clangBinaryRaw || 'clang++';

  // ── 1. Locate compile_commands.json ──────────────────────────────────────────

  let ccPath = '';

  // 1a. Explicit compileCommandsPath setting
  const explicitCc = norm(cfg.get<string>('compileCommandsPath', '').trim());
  if (explicitCc) {
    let r = path.isAbsolute(explicitCc) ? explicitCc : path.join(workspaceRoot, explicitCc);
    ccPath = resolveToFile(norm(r));
  }

  // 1b. buildDirectory — now supports a comma-separated list of directories
  //     e.g. "objects, listings, build, Debug_FLASH"
  if (!ccPath) {
    const buildDirRaw = cfg.get<string>('buildDirectory', '').trim();
    if (buildDirRaw) {
      const buildDirs = buildDirRaw.split(',').map(d => d.trim()).filter(Boolean);
      const tried: string[] = [];
      for (const dir of buildDirs) {
        const base = path.isAbsolute(dir) ? dir : path.join(workspaceRoot, dir);
        const candidate = norm(path.join(base, 'compile_commands.json'));
        tried.push(candidate);
        if (fs.existsSync(candidate)) {
          ccPath = candidate;
          diag.logInfo(`compile_commands.json found via buildDirectory "${dir}"`);
          break;
        }
      }
      if (!ccPath && buildDirs.length > 0) {
        diag.logWarn(`None of the buildDirectory entries contained compile_commands.json.`);
        diag.logWarn(`Tried: ${tried.join(', ')}`);
        // Don't return early — fall through to auto-detect
      }
    }
  }

  // 1c. Auto-detect common locations
  if (!ccPath) {
    for (const sub of COMMON_SUBDIRS) {
      const candidate = norm(path.join(workspaceRoot, sub, 'compile_commands.json'));
      if (fs.existsSync(candidate)) {
        ccPath = candidate;
        diag.logInfo(`Auto-detected compile_commands.json at: ${candidate}`);
        break;
      }
    }
  }

  if (!ccPath || !fs.existsSync(ccPath)) {
    diag.logInfo('No compile_commands.json found — running in pure heuristic mode');
    diag.logInfo('To enable clang verification: set callgraph.buildDirectory (comma-separated, e.g. "build, Debug_FLASH") or callgraph.compileCommandsPath');
    return undefined;
  }

  // Directory guard — user might have set path to a folder
  if (isDir(ccPath)) {
    const withFile = norm(path.join(ccPath, 'compile_commands.json'));
    if (fs.existsSync(withFile)) {
      diag.logInfo(`Path was a directory — using compile_commands.json inside: ${withFile}`);
      ccPath = withFile;
    } else {
      diag.logWarn(`"${ccPath}" is a directory but contains no compile_commands.json`);
      return undefined;
    }
  }

  // ── 2. Parse compile_commands.json ───────────────────────────────────────────

  const db = CompileCommandsDb.load(ccPath);
  if (!db || !db.hasAnyEntries()) {
    diag.logWarn(`Failed to parse compile_commands.json at: ${ccPath}`);
    try {
      const raw = fs.readFileSync(ccPath, 'utf8').trim();
      diag.logWarn(raw.startsWith('[')
        ? 'JSON parsed but contained 0 entries — check "file" and "arguments"/"command" fields'
        : 'File does not start with "[" — expected a JSON array');
    } catch (e: any) {
      diag.logWarn(`Could not read file: ${e?.message ?? e}`);
    }
    return undefined;
  }
  diag.logOk(`compile_commands.json: ${ccPath} (${db.entryCount()} entries)`);

  // ── 3. Cross-compiler check ───────────────────────────────────────────────────
  //
  // If the compile_commands.json uses a cross-compiler (arm-none-eabi-gcc, avr-gcc…)
  // we normally can't run native clang++ on those files.
  //
  // HOWEVER: if the user has EXPLICITLY set callgraph.clangBinaryPath to something,
  // we trust them — they likely have an ARM clang (LLVM Embedded Toolchain) installed.
  // In that case we skip the bail-out and let clang try; it will fail gracefully per-query
  // if the flags aren't compatible.

  const firstCompiler = db.firstCompiler() ?? '';
  const CROSS_RE = /arm-none-eabi|arm-linux|avr-gcc|msp430|xtensa|riscv|m68k|powerpc|aarch64-linux/i;
  const isCrossCompiler = CROSS_RE.test(firstCompiler);

  if (isCrossCompiler) {
    if (userSetClang) {
      diag.logInfo(`compile_commands.json uses cross-compiler "${firstCompiler}".`);
      diag.logInfo(`You have set callgraph.clangBinaryPath — will attempt clang AST queries.`);
      diag.logInfo(`Make sure your clang supports the same target (e.g. arm-none-eabi via LLVM Embedded Toolchain).`);
    } else {
      diag.logWarn(`Compiler "${firstCompiler}" is a cross-compiler. Clang AST verification is disabled.`);
      diag.logInfo(`To enable it: set callgraph.clangBinaryPath to an ARM-capable clang++ binary`);
      diag.logInfo(`(e.g. LLVM Embedded Toolchain: ...\\LLVM-ET-Arm-XX\\bin\\clang++.exe)`);
      return undefined;
    }
  }

  // ── 4. Verify the clang binary ────────────────────────────────────────────────

  const clangVersion = findClangVersion(clangBinary);
  if (clangVersion === 'not found') {
    diag.logError(`clang binary not found: "${clangBinary}"`);
    if (clangBinary.endsWith('clang++.exe') || clangBinary.endsWith('clang++')) {
      diag.logError('Check that the path exists and the binary is executable.');
    }
    return undefined;
  }
  diag.logOk(`clang binary: ${clangBinary}`);
  diag.logOk(`clang version: ${clangVersion}`);

  // Warn if the clang version doesn't mention ARM and we're cross-compiling
  if (isCrossCompiler && !/arm|embedded|ET/i.test(clangVersion)) {
    diag.logWarn(`clang version string doesn't mention ARM — if this is a native x86 clang it cannot compile ARM code.`);
    diag.logWarn(`Expected something like "LLVM Embedded Toolchain for Arm" or "Target: arm-none-eabi".`);
  }

  return {
    clangBinary,
    compileCommandsDb: db,
    workspaceRoot,
    maxCallerConfirmations: cfg.get<number>('maxCallerConfirmations', 15),
    timeoutMs: 8000,
  };
}
