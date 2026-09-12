import * as path from 'path';
import * as fs from 'fs';

import { GeneratorConfig, GeneratorResult, CompileEntry } from './types';
import { IDE_PRESETS } from './idePresets';
import { runCompiledb } from './makeRunner';
import { parseEclipseProject, parseMplabProject } from './eclipseParser';
import { parseKeilProject, findKeilProjectFile } from './keilParser';
import { collectPathVars, findUnresolvedVars, buildPathVarsTemplate } from './pathVarResolver';
import { probeToolchainIncludes } from './compilerProbe';
import { scanHeaderDirs, deduplicateIncludes } from './headerScanner';
import { processEntries, extractRepresentativeFlags } from './flagProcessor';
import {
  writeCompileCommands, writeClangd, writeCompileFlags,
  writeCCppProperties, writeVscodeSettings,
} from './writers';

export async function generateAll(
  config: GeneratorConfig,
  report: (msg: string) => void
): Promise<GeneratorResult> {

  const filesWritten: string[] = [];
  let cfg = { ...config };
  const preset = IDE_PRESETS[cfg.ideType];

  // ── Step 1: Collect Eclipse path variable definitions ─────────────────────
  report('Collecting Eclipse path variable definitions...');
  const pathVars   = collectPathVars(cfg.projectRoot, cfg.pathVariables);
  const missingSet = new Set<string>();
  const known      = Object.keys(pathVars).length;
  if (known > 0) report(`Found ${known} path variable definition(s).`);

  // ── Step 2: Probe compiler sysroot for system include paths ───────────────
  // Derive stdint.h / string.h / GCC built-in paths structurally from the
  // compiler binary location — no need to execute the compiler.
  let sysrootIncludes: string[] = [];
  if (cfg.compilerPath) {
    report(`Probing toolchain sysroot from: ${cfg.compilerPath}`);
    const probe = probeToolchainIncludes(cfg.compilerPath);
    sysrootIncludes = probe.systemIncludes;
    if (sysrootIncludes.length > 0) {
      report(`  Found ${sysrootIncludes.length} sysroot include dir(s)` +
        (probe.gccVersion ? ` (GCC ${probe.gccVersion})` : ''));
    } else {
      report('  ⚠ No sysroot include dirs found — check compilerPath setting.');
    }
  } else {
    report('⚠ compilerPath not set — stdint.h / string.h may not resolve.');
    report('  Set embeddedClangd.compilerPath to your arm-none-eabi-gcc.exe path.');
  }

  // ── Step 3: Run compiledb / make -n (skip for Keil) ──────────────────────
  let rawEntries: CompileEntry[] = [];
  let usedFolder: string | null  = null;

  if (cfg.ideType !== 'keil') {
    report('Searching for Makefiles...');
    const makeResult = await runCompiledb(cfg, report);
    rawEntries = makeResult.entries;
    usedFolder = makeResult.usedFolder;
  } else {
    report('Keil project — reading .uvprojx directly...');
  }

  let projectIncludes: string[] = [];
  let defines:         string[] = [];
  let entries:         CompileEntry[] = [];

  if (rawEntries.length > 0) {
    report(`Processing ${rawEntries.length} compile entries...`);
    entries         = processEntries(rawEntries, cfg);
    const rep       = extractRepresentativeFlags(entries, cfg);
    projectIncludes = rep.includes;
    defines         = rep.defines;

    // Substitute any ${VAR} that survived into the make output
    const { substituteVars } = require('./pathVarResolver') as typeof import('./pathVarResolver');
    projectIncludes = projectIncludes.map(f => {
      if (!f.startsWith('-I') || !f.includes('${')) return f;
      return `-I${substituteVars(f.slice(2), pathVars, missingSet)}`;
    });

  } else {
    // Fallback — parse IDE project files directly
    const fallback = preset.fallbackParser;

    if (fallback === 'eclipse') {
      report('No Makefile output. Parsing .cproject...');
      const proj = parseEclipseProject(cfg.projectRoot, pathVars, missingSet);
      projectIncludes = [
        ...proj.includes.map(i => `-I${i}`),
        ...cfg.extraIncludes.map(i => `-I${i}`),
      ];
      defines = [
        ...proj.defines.map(d => d.startsWith('-D') ? d : `-D${d}`),
        ...cfg.extraDefines.map(d => d.startsWith('-D') ? d : `-D${d}`),
      ];
      entries = buildFallbackEntries(proj.sources, cfg, projectIncludes, defines);

    } else if (fallback === 'mplab') {
      report('No Makefile output. Parsing nbproject/configurations.xml...');
      const proj = parseMplabProject(cfg.projectRoot);
      projectIncludes = [...proj.includes.map(i => `-I${i}`), ...cfg.extraIncludes.map(i => `-I${i}`)];
      defines = [...proj.defines.map(d => d.startsWith('-D') ? d : `-D${d}`), ...cfg.extraDefines.map(d => d.startsWith('-D') ? d : `-D${d}`)];
      entries = buildFallbackEntries(proj.sources, cfg, projectIncludes, defines);

    } else if (fallback === 'keil') {
      const projFile = findKeilProjectFile(cfg.projectRoot);
      report(`Parsing Keil project: ${projFile ? path.basename(projFile) : '(scanning sources)'}...`);
      const proj = parseKeilProject(cfg.projectRoot);
      if (proj.cpuFlags.length > 0)    cfg = { ...cfg, cpuFlags: proj.cpuFlags };
      if (proj.cStandard && !cfg.cStandard) cfg = { ...cfg, cStandard: proj.cStandard };
      report(`Device: ${proj.deviceName || '(unknown)'}  Compiler: ${proj.compiler}`);
      projectIncludes = [...proj.includes.map(i => `-I${i}`), ...cfg.extraIncludes.map(i => `-I${i}`)];
      defines = [...proj.defines.map(d => d.startsWith('-D') ? d : `-D${d}`), ...cfg.extraDefines.map(d => d.startsWith('-D') ? d : `-D${d}`)];
      entries = buildFallbackEntries(proj.sources, cfg, projectIncludes, defines);

    } else {
      report('No Makefile output. Scanning source files...');
      projectIncludes = cfg.extraIncludes.map(i => `-I${i}`);
      defines         = cfg.extraDefines.map(d => d.startsWith('-D') ? d : `-D${d}`);
      entries         = buildFallbackEntries(collectSources(cfg.projectRoot), cfg, projectIncludes, defines);
    }

    report(`Built ${entries.length} entries from fallback parser.`);
  }

  // ── Step 4: Auto-discover project header directories ──────────────────────
  let discoveredDirs: string[] = [];
  if (cfg.autoDiscoverHeaders) {
    report('Scanning project tree for header directories...');
    const scan = scanHeaderDirs(cfg.projectRoot, cfg.scanSkipFolders);
    const existingRaw = projectIncludes
      .filter(f => f.startsWith('-I'))
      .map(f => f.slice(2));
    discoveredDirs = deduplicateIncludes(scan.headerDirs, existingRaw);
    report(`  Found ${scan.headerCount} header files across ${scan.dirCount} dirs; ` +
           `added ${discoveredDirs.length} new include dir(s).`);
  }

  // ── Step 5: Report unresolved path variables ──────────────────────────────
  const allPaths = projectIncludes.map(f => f.startsWith('-I') ? f.slice(2) : f);
  const fromScan = findUnresolvedVars(allPaths);
  for (const v of missingSet) fromScan.push(v);
  const unresolvedVars = [...new Set(fromScan)].sort();

  if (unresolvedVars.length > 0) {
    report(`⚠ ${unresolvedVars.length} path variable(s) unresolved: ${unresolvedVars.join(', ')}`);
    report('  Add them to embeddedClangd.pathVariables in .vscode/settings.json');
  }

  // ── Step 6: Assemble canonical include list ───────────────────────────────
  // Resolve all relative -I paths to absolute before writing anything.
  // Relative paths like -I..\\Core\\Inc are unresolvable by clangd when the
  // directory field is the project root (not the build subdirectory).
  const resolvedProjectIncludes = projectIncludes.map(f => {
    if (!f.startsWith('-I')) return f;
    const p = f.slice(2);
    if (path.isAbsolute(p)) return f;
    return `-I${path.resolve(cfg.projectRoot, p)}`;
  });

  const fullIncludes = [
    ...resolvedProjectIncludes,
    ...discoveredDirs.map(d => `-I${d}`),
    ...sysrootIncludes.map(i => `-isystem${i}`),
    ...cfg.extraSystemIncludes.map(i => `-isystem${i}`),
  ];

  // ── Step 7: Build final compile_commands entries ──────────────────────────
  // Rebuild every entry from scratch with the canonical include + define set.
  // De-duplicate by normalised file path so each TU appears exactly once —
  // duplicate entries cause clangd to index TUs multiple times, producing
  // incorrect call-graph cross-references in Lens / Call Graph Visualizer.
  const seenFiles = new Map<string, CompileEntry>();

  for (const e of entries) {
    const normFile = path.normalize(e.file).toLowerCase();
    const clean    = assembleEntry(e, fullIncludes, defines, cfg);
    // Keep the last entry for a given file (later entries from compiledb are
    // typically more complete than earlier fallback-generated ones)
    seenFiles.set(normFile, clean);
  }

  const finalEntries = [...seenFiles.values()];
  report(`compile_commands.json: ${finalEntries.length} unique TU(s) ` +
    (entries.length !== finalEntries.length
      ? `(${entries.length - finalEntries.length} duplicate(s) removed)`
      : '(no duplicates)'));

  // ── Step 8: Write files ───────────────────────────────────────────────────
  const ccJsonPath = path.join(cfg.projectRoot, 'compile_commands.json');
  report('Writing compile_commands.json...');
  writeCompileCommands(ccJsonPath, finalEntries);
  filesWritten.push('compile_commands.json');

  const clangdPath = path.join(cfg.projectRoot, '.clangd');
  report('Writing .clangd...');
  writeClangd(clangdPath, cfg, resolvedProjectIncludes, defines,
              usedFolder ?? null, sysrootIncludes, discoveredDirs);
  filesWritten.push('.clangd');

  if (cfg.generateCompileFlags) {
    const cfPath = path.join(cfg.projectRoot, 'compile_flags.txt');
    report('Writing compile_flags.txt...');
    writeCompileFlags(cfPath, cfg, resolvedProjectIncludes, defines, sysrootIncludes, discoveredDirs);
    filesWritten.push('compile_flags.txt');
  }

  const vscodeDir = path.join(cfg.projectRoot, '.vscode');
  if (!fs.existsSync(vscodeDir)) fs.mkdirSync(vscodeDir, { recursive: true });

  report('Writing .vscode/c_cpp_properties.json...');
  writeCCppProperties(path.join(vscodeDir, 'c_cpp_properties.json'),
    cfg, resolvedProjectIncludes, defines, sysrootIncludes, discoveredDirs);
  filesWritten.push('.vscode/c_cpp_properties.json');

  report('Writing .vscode/settings.json...');
  writeVscodeSettings(path.join(vscodeDir, 'settings.json'), cfg);
  filesWritten.push('.vscode/settings.json');

  return {
    filesWritten,
    buildFolder:     usedFolder,
    entryCount:      finalEntries.length,
    detectedIde:     preset.displayName,
    unresolvedVars,
    discoveredDirs:  discoveredDirs.length,
    sysrootIncludes: sysrootIncludes.length,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildFallbackEntries(
  sources:  string[], config: GeneratorConfig,
  includes: string[], defines: string[]
): CompileEntry[] {
  // Always use absolute paths so clangd can resolve them from any directory field.
  const absIncludes = includes.map(f => {
    if (!f.startsWith('-I')) return f;
    const p = f.slice(2);
    return path.isAbsolute(p) ? f : `-I${path.resolve(config.projectRoot, p)}`;
  });
  const args = [
    `--target=${config.targetTriple}`, `-std=${config.cStandard}`,
    ...config.cpuFlags, ...absIncludes, ...defines,
  ];
  const compiler = config.compilerPath || 'arm-none-eabi-gcc';
  return sources.map(src => {
    const absSrc = path.isAbsolute(src) ? src : path.resolve(config.projectRoot, src);
    return {
      directory: config.projectRoot, file: absSrc,
      arguments: [compiler, ...args, '-c', absSrc],
    };
  });
}

/**
 * Build a clean CompileEntry from an existing one with a canonical include set.
 *
 * Keeps: compiler binary, std/target/cpu/warning flags from the original.
 * Replaces: all -I, -isystem, -D flags with the provided canonical sets.
 * Fixes: resolves the source file to an absolute path.
 *
 * This replaces the old rebuildArgs() which left relative -I flags in place
 * and produced stray '}' characters from unresolved Eclipse variable remnants.
 */
function assembleEntry(
  e:            CompileEntry,
  fullIncludes: string[],
  defines:      string[],
  config:       GeneratorConfig
): CompileEntry {
  const args     = e.arguments;
  const compiler = args[0] ?? (config.compilerPath || 'arm-none-eabi-gcc');

  // Absolute path for the source file
  const absFile = path.isAbsolute(e.file)
    ? e.file
    : path.resolve(e.directory, e.file);

  // Keep non-include, non-define, non-io flags (std, target, cpu, warnings, opt)
  const keepFlags: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-I')       ||
        a.startsWith('-isystem') ||
        a.startsWith('-D')       ||
        a === '-c' || a === '-o') {
      if (a === '-o') i++;
      continue;
    }
    // Skip the source file positional arg — we re-add as absFile
    const normA = path.normalize(a).toLowerCase();
    const normF = path.normalize(absFile).toLowerCase();
    if (normA === normF) continue;
    keepFlags.push(a);
  }

  return {
    directory: e.directory,
    file:      absFile,
    arguments: [compiler, ...keepFlags, ...fullIncludes, ...defines, '-c', absFile],
  };
}

function collectSources(projectRoot: string): string[] {
  const sources: string[] = [];
  const SKIP = new Set(['node_modules','out','dist','.git',
    'Debug','Release','Debug_FLASH','Debug_RAM','Release_FLASH','build']);
  const walk = (dir: string) => {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(c|cpp|cc|cxx)$/i.test(e.name)) sources.push(full);
      }
    } catch { /* skip */ }
  };
  walk(projectRoot);
  return sources;
}
