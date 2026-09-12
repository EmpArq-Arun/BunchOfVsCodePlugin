/**
 * Optional ctags-based cross-reference backend.
 * When `callgraph.ctagsPath` is set, runs ctags and parses its output to
 * find type references across files that the regex parser can miss:
 * - Which files #include a header defining a class (transitively "use" it)
 * - Function parameter/return type references across TUs
 *
 * Runs ctags lazily (once per workspace open), result is kept in memory.
 */
import { spawn } from 'child_process';
import * as path from 'path';
import * as diag from '../diagnostics';

export interface CTagEntry {
  name: string;          // symbol name
  file: string;          // relative path
  kind: string;          // c=class, f=function, m=member, p=prototype, etc.
  scope?: string;        // class/namespace scope
  inherits?: string;     // value of "inherits:" field
  typeref?: string;      // value of "typeref:" field
  signature?: string;    // function signature
  access?: string;       // public/private/protected
}

/** Run ctags and return parsed entries.  Resolves to [] on any failure. */
export async function runCtags(
  ctagsBinary: string,
  workspaceRoot: string,
  timeoutMs = 20_000,
): Promise<CTagEntry[]> {
  const args = [
    '-R',
    '--output-format=u-ctags',
    '--fields=+a+i+K+S+z',
    '--c++-kinds=+pc',
    '--extras=+q',   // fully-qualified names as additional tags
    '-f', '-',       // output to stdout
    '.',
  ];

  diag.logInfo(`ctags: running "${ctagsBinary} ${args.join(' ')}" in ${workspaceRoot}`);

  return new Promise((resolve) => {
    const proc = spawn(ctagsBinary, args, { cwd: workspaceRoot });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      diag.logWarn(`ctags timed out after ${timeoutMs}ms`);
      resolve([]);
    }, timeoutMs);

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      diag.logError(`ctags spawn failed: ${e.message}`);
      resolve([]);
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        diag.logWarn(`ctags exited with code ${code}: ${stderr.slice(0, 200)}`);
      }
      const entries = parseUCtagsOutput(stdout);
      diag.logOk(`ctags: ${entries.length} entries`);
      resolve(entries);
    });
  });
}

/** Parse universal-ctags `--output-format=u-ctags` output. */
function parseUCtagsOutput(output: string): CTagEntry[] {
  const entries: CTagEntry[] = [];
  for (const line of output.split('\n')) {
    if (!line || line.startsWith('!')) continue; // header/comment lines
    const parts = line.split('\t');
    if (parts.length < 4) continue;

    const name = parts[0];
    const file = parts[1];
    // parts[2] = ex-command (line number or pattern), parts[3] = kind char
    const kindChar = parts[3];

    const extra: Record<string, string> = {};
    for (let i = 4; i < parts.length; i++) {
      const sep = parts[i].indexOf(':');
      if (sep > 0) extra[parts[i].slice(0, sep)] = parts[i].slice(sep + 1);
    }

    entries.push({
      name,
      file: file.replace(/^\.\//, ''),
      kind: extra['kind'] ?? kindChar,
      scope: extra['class'] ?? extra['namespace'] ?? extra['scope'],
      inherits: extra['inherits'],
      typeref: extra['typeref'],
      signature: extra['signature'],
      access: extra['access'],
    });
  }
  return entries;
}

/**
 * From a ctags output, build a map of className → set of file-relative paths
 * that contain references to that class (as member type, parameter, or return type).
 */
export function buildTypeUsageMap(entries: CTagEntry[]): Map<string, Set<string>> {
  const usageMap = new Map<string, Set<string>>();

  const addClass = (className: string, filePath: string) => {
    const s = usageMap.get(className) ?? new Set();
    s.add(filePath);
    usageMap.set(className, s);
  };

  for (const e of entries) {
    // Inheritance: class A inherits B → B is used in A's file
    if (e.inherits) {
      for (const base of e.inherits.split(',').map(s => s.trim())) {
        if (base) addClass(base, e.file);
      }
    }
    // Member types and typeref fields
    if (e.typeref) {
      const match = e.typeref.match(/\b([A-Za-z_]\w*)\b/);
      if (match) addClass(match[1], e.file);
    }
    // Parameter/return types from signature
    if (e.signature) {
      for (const [, cn] of e.signature.matchAll(/\b([A-Z][A-Za-z_]\w*)\b/g)) {
        addClass(cn, e.file);
      }
    }
  }

  return usageMap;
}
