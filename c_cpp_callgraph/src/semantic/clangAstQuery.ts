import { spawn } from 'child_process';
import * as path from 'path';
import * as diag from '../diagnostics';

export interface AstNode {
  id?: string;
  kind?: string;
  name?: string;
  loc?: any;
  range?: any;
  type?: { qualType?: string };
  virtual?: boolean;
  bases?: { access?: string; type?: { qualType?: string } }[];
  definitionData?: { isPolymorphic?: boolean };
  referencedDecl?: { id?: string; kind?: string; name?: string; type?: { qualType?: string } };
  inner?: AstNode[];
  [key: string]: any;
}

export interface ClangQueryOptions {
  clangBinary: string; // resolved path or bare "clang++" to rely on PATH
  filePath: string;
  compilerArgs: string[];
  filterName: string; // matched against declaration names by clang's -ast-dump-filter (substring/regex-ish match on qualified name)
  cwd?: string;
  timeoutMs?: number;
}

export interface ClangQueryResult {
  ok: boolean;
  roots: AstNode[]; // clang emits one top-level TranslationUnitDecl per dump; .inner holds the filtered matches
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 8000;

export function queryClangAst(opts: ClangQueryOptions): Promise<ClangQueryResult> {
  const { clangBinary, filePath, compilerArgs, filterName, cwd, timeoutMs } = opts;

  const args = [
    '-Xclang', '-ast-dump=json',
    '-Xclang', `-ast-dump-filter=${filterName}`,
    '-fsyntax-only',
    ...compilerArgs,
    filePath,
  ];

  return new Promise((resolve) => {
    const proc = spawn(clangBinary, args, { cwd });
    let stdout = '';
    let stderrTail = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      resolve({ ok: false, roots: [], error: `clang query timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` });
    }, timeoutMs ?? DEFAULT_TIMEOUT_MS);

    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, roots: [], error: `failed to spawn ${clangBinary}: ${err.message}` });
    });

    proc.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (!stdout.trim()) {
        const msg = stderrTail || 'clang produced no output';
        diag.logWarn(`clang query [${filterName}] in ${path.basename(filePath)}: no output — ${msg.slice(0, 120)}`);
        resolve({ ok: false, roots: [], error: msg });
        return;
      }
      const roots = splitConcatenatedJson(stdout);
      if (roots.length === 0) {
        diag.logWarn(`clang query [${filterName}] in ${path.basename(filePath)}: JSON parse failed`);
        resolve({ ok: false, roots: [], error: 'could not parse clang JSON output' });
        return;
      }
      diag.logOk(`clang query [${filterName}] in ${path.basename(filePath)}: ${roots.length} match(es)`);
      resolve({ ok: true, roots });
    });
  });
}

/**
 * `-ast-dump-filter` makes clang print one standalone JSON object per
 * matching top-level declaration, concatenated back to back with no
 * separator — NOT a single JSON document and NOT newline-delimited. This
 * does a brace-depth scan to split them, tolerating braces inside string
 * literals, and parses each independently (skipping any that fail).
 */
function splitConcatenatedJson(text: string): AstNode[] {
  const results: AstNode[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const chunk = text.slice(start, i + 1);
        try {
          results.push(JSON.parse(chunk));
        } catch {
          // skip a malformed chunk rather than failing the whole batch
        }
        start = -1;
      }
    }
  }

  return results;
}

export function findNodes(node: AstNode | AstNode[], kind: string, out: AstNode[] = []): AstNode[] {
  const nodes = Array.isArray(node) ? node : [node];
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    if (n.kind === kind) out.push(n);
    if (Array.isArray(n.inner)) findNodes(n.inner, kind, out);
  }
  return out;
}

/** All CallExpr / CXXMemberCallExpr nodes within a subtree, each paired with the resolved callee name if one was found. */
export function findCallSites(node: AstNode): { call: AstNode; calleeName: string; calleeType?: string; calleeKind?: string }[] {
  const directCalls = findNodes(node, 'CallExpr');
  const memberCalls = findNodes(node, 'CXXMemberCallExpr');
  const results: { call: AstNode; calleeName: string; calleeType?: string; calleeKind?: string }[] = [];

  for (const call of directCalls) {
    const refs = findNodes(call, 'DeclRefExpr');
    // The callee is the first DeclRefExpr in source order within the CallExpr
    // (subsequent ones belong to the arguments) — DFS over `inner` follows
    // the AST's left-to-right layout, so .find() naturally lands on it,
    // even when an argument is itself a nested call.
    const calleeRef = refs.find((r) => r.referencedDecl)?.referencedDecl;
    if (calleeRef && (calleeRef.kind === 'FunctionDecl' || calleeRef.kind === 'CXXMethodDecl')) {
      results.push({ call, calleeName: calleeRef.name ?? '', calleeType: calleeRef.type?.qualType, calleeKind: calleeRef.kind });
    }
    // else: callee is a variable/parameter (function pointer, std::function, etc.)
    // — not a clang-resolvable direct call; left for the heuristic pointer tracker.
  }

  for (const call of memberCalls) {
    const memberExpr = findNodes(call, 'MemberExpr')[0];
    if (memberExpr?.name) {
      results.push({ call, calleeName: memberExpr.name, calleeKind: 'CXXMethodDecl' });
    }
  }

  return results;
}
