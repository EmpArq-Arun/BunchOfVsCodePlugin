import * as fs from 'fs';
import * as path from 'path';
import { PathVarMap, substituteVars } from './pathVarResolver';

export interface EclipseProjectInfo {
  includes:     string[];   // may still contain unresolved ${VAR} if not in pathVars
  defines:      string[];
  sources:      string[];
}

/**
 * Parse Eclipse CDT .cproject and .project files to extract
 * include paths, preprocessor defines, and source file lists.
 * pathVars is the merged set of known variable definitions; any remaining
 * ${VAR} references after substitution are left intact for the caller to report.
 */
export function parseEclipseProject(
  projectRoot: string,
  pathVars:    PathVarMap = {},
  missing:     Set<string> = new Set()
): EclipseProjectInfo {
  const result: EclipseProjectInfo = { includes: [], defines: [], sources: [] };

  const cprojectPath = path.join(projectRoot, '.cproject');
  if (!fs.existsSync(cprojectPath)) return result;

  const xml = fs.readFileSync(cprojectPath, 'utf8');

  extractIncludePaths(xml, projectRoot, pathVars, missing, result);
  extractDefines(xml, result);
  collectSourceFiles(projectRoot, result);

  return result;
}

function extractIncludePaths(
  xml:        string,
  projectRoot: string,
  pathVars:   PathVarMap,
  missing:    Set<string>,
  result:     EclipseProjectInfo
) {
  const includeBlockRe = /superClass="[^"]*(?:include\.path|includePath|c\.include)[^"]*"[^>]*>([\s\S]*?)<\/option>/gi;
  const valueRe = /listOptionValue[^>]+value="([^"]+)"/g;

  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = includeBlockRe.exec(xml)) !== null) {
    const block = blockMatch[1];
    let valueMatch: RegExpExecArray | null;
    while ((valueMatch = valueRe.exec(block)) !== null) {
      let val = valueMatch[1];
      val = val.replace(/&quot;/g, '').replace(/&amp;/g, '&').trim();

      // Step 1: substitute user/workspace path variables first
      // (e.g. ${FREEMASTER_S32K312_1.4.2_PATH} → C:/FreeMASTER/...)
      val = substituteVars(val, pathVars, missing);

      // Step 2: resolve built-in Eclipse variables
      val = resolveEclipseVar(val, projectRoot);

      if (val && !result.includes.includes(val)) {
        result.includes.push(val);
      }
    }
  }

  // Simpler pattern for older CDT versions
  const simpleRe = /value="(?:&quot;)?\$\{workspace_loc:([^}"]+)\}(?:&quot;)?"/g;
  let m: RegExpExecArray | null;
  while ((m = simpleRe.exec(xml)) !== null) {
    const rel = m[1].replace(/^\/[^/]+/, '');
    const abs = path.join(projectRoot, rel);
    if (!result.includes.includes(abs)) result.includes.push(abs);
  }
}

function extractDefines(xml: string, result: EclipseProjectInfo) {
  const defineBlockRe = /superClass="[^"]*(?:defined\.symbols?|preprocessor\.def|c\.symbols)[^"]*"[^>]*>([\s\S]*?)<\/option>/gi;
  const valueRe = /listOptionValue[^>]+value="([^"]+)"/g;

  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = defineBlockRe.exec(xml)) !== null) {
    const block = blockMatch[1];
    let valueMatch: RegExpExecArray | null;
    while ((valueMatch = valueRe.exec(block)) !== null) {
      const val = valueMatch[1].trim();
      if (val && !result.defines.includes(val)) result.defines.push(val);
    }
  }
}

function collectSourceFiles(projectRoot: string, result: EclipseProjectInfo) {
  const SKIP = ['node_modules', 'out', 'Debug', 'Release', 'Debug_FLASH', 'Debug_RAM', 'Release_FLASH'];
  const walk = (dir: string) => {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(c|cpp|cc|cxx)$/i.test(entry.name)) result.sources.push(full);
      }
    } catch { /* skip inaccessible */ }
  };
  walk(projectRoot);
}

export function resolveEclipseVar(val: string, projectRoot: string): string {
  // ${workspace_loc:/ProjectName/sub/path} -> projectRoot/sub/path
  // The first regex previously replaced only "${workspace_loc:/Name/" leaving
  // the rest of the path AND the closing "}" in the string, producing paths
  // like "f:\root\Application}" with a stray brace.
  // Fix: capture the full subpath and closing brace in one match.
  val = val.replace(
    /\$\{workspace_loc:\/[^/}]+\/([^}]*)\}/g,
    (_, subpath) => path.join(projectRoot, subpath.replace(/\//g, path.sep))
  );
  // ${workspace_loc:/ProjectName} -> projectRoot (no subpath, just the root)
  val = val.replace(/\$\{workspace_loc:\/[^}]+\}/g, projectRoot);
  val = val.replace(/\$\{ProjDirPath\}/g, projectRoot);
  val = val.replace(/\$\{ProjName\}/g, path.basename(projectRoot));
  return path.normalize(val);
}

// ─── MPLAB X project parser ───────────────────────────────────────────────────

export interface MplabProjectInfo {
  includes: string[];
  defines:  string[];
  sources:  string[];
}

export function parseMplabProject(projectRoot: string): MplabProjectInfo {
  const result: MplabProjectInfo = { includes: [], defines: [], sources: [] };

  const configXmlPath = path.join(projectRoot, 'nbproject', 'configurations.xml');
  if (fs.existsSync(configXmlPath)) {
    parseMplabConfigXml(fs.readFileSync(configXmlPath, 'utf8'), projectRoot, result);
  }

  const nbDir = path.join(projectRoot, 'nbproject');
  if (fs.existsSync(nbDir)) {
    for (const f of fs.readdirSync(nbDir)) {
      if (/^Makefile-.+\.mk$/.test(f)) {
        parseMplabMakefile(fs.readFileSync(path.join(nbDir, f), 'utf8'), projectRoot, result);
      }
    }
  }

  collectSourceFiles(projectRoot, result as EclipseProjectInfo);
  return result;
}

function parseMplabConfigXml(xml: string, projectRoot: string, result: MplabProjectInfo) {
  const includeRe = /<(?:CCIncPath|c-include-path)[^>]*value="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = includeRe.exec(xml)) !== null) {
    for (const raw of m[1].split(/[:;]/)) {
      const p = raw.trim().replace(/\$\{ProjectDir\}/g, projectRoot).replace(/\\/g, path.sep);
      if (p && !result.includes.includes(p)) result.includes.push(p);
    }
  }
  const defineRe = /<(?:CCSymbols|c-preprocessor-macro-def)[^>]*value="([^"]+)"/gi;
  while ((m = defineRe.exec(xml)) !== null) {
    for (const d of m[1].split(',')) {
      const def = d.trim();
      if (def && !result.defines.includes(def)) result.defines.push(def);
    }
  }
}

function parseMplabMakefile(content: string, projectRoot: string, result: MplabProjectInfo) {
  const iRe = /-I"?([^"\s]+)"?/g;
  const dRe = /-D(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = iRe.exec(content)) !== null) {
    const p = path.resolve(projectRoot, m[1]);
    if (!result.includes.includes(p)) result.includes.push(p);
  }
  while ((m = dRe.exec(content)) !== null) {
    if (!result.defines.includes(m[1])) result.defines.push(m[1]);
  }
}
