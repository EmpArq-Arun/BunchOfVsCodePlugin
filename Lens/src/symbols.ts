import * as vscode from 'vscode';
import { fingerprintAnchor, qualify, symbolAnchor } from './core/anchor.js';
import type { SymbolPath } from './core/model.js';

/**
 * Symbol resolution via whatever language server is active.
 *
 * Lens deliberately does not spawn or own a clangd instance in P0. Asking VS
 * Code for document symbols routes to clangd or cpptools, whichever the user has
 * configured, and works identically for both. That keeps P0 free of any
 * toolchain setup: if the codebase already has working IntelliSense, Lens works.
 * P2 adds a direct index for the things LSP cannot answer.
 */

export interface AnchoredSymbol {
  anchor: string;
  sym: SymbolPath;
  /** Full body range, used for containment tests. */
  range: vscode.Range;
  /** Just the name, used for gutter placement and navigation. */
  selection: vscode.Range;
}

interface CacheSlot {
  version: number;
  symbols: AnchoredSymbol[];
}

const cache = new Map<string, CacheSlot>();

export function invalidate(uri: vscode.Uri): void {
  cache.delete(uri.toString());
  outcomes.delete(uri.toString());
}

export function invalidateAll(): void {
  cache.clear();
}

function isHierarchical(v: unknown[]): v is vscode.DocumentSymbol[] {
  return v.length > 0 && (v[0] as vscode.DocumentSymbol).children !== undefined;
}

function flattenHierarchical(
  nodes: vscode.DocumentSymbol[],
  containers: string[],
  out: AnchoredSymbol[],
): void {
  for (const node of nodes) {
    const qualifiedName = qualify(containers, node.name.replace(/\(.*$/, '').trim());
    const sym: SymbolPath = {
      qualifiedName,
      symbolKind: vscode.SymbolKind[node.kind],
      detail: node.detail || undefined,
    };
    out.push({
      anchor: symbolAnchor(sym),
      sym,
      range: node.range,
      selection: node.selectionRange,
    });
    if (node.children && node.children.length > 0) {
      // Namespaces, classes and structs contribute a scope segment; a function
      // containing a lambda does not, so nested lambdas stay attributable to
      // their enclosing function rather than inventing a scope that does not
      // exist in the language.
      const opens =
        node.kind === vscode.SymbolKind.Namespace ||
        node.kind === vscode.SymbolKind.Class ||
        node.kind === vscode.SymbolKind.Struct ||
        node.kind === vscode.SymbolKind.Interface ||
        node.kind === vscode.SymbolKind.Enum ||
        node.kind === vscode.SymbolKind.Module;
      flattenHierarchical(node.children, opens ? [...containers, node.name] : containers, out);
    }
  }
}

function flattenFlat(nodes: vscode.SymbolInformation[], out: AnchoredSymbol[]): void {
  for (const node of nodes) {
    const sym: SymbolPath = {
      qualifiedName: qualify(node.containerName ? [node.containerName] : [], node.name),
      symbolKind: vscode.SymbolKind[node.kind],
      detail: undefined,
    };
    out.push({
      anchor: symbolAnchor(sym),
      sym,
      range: node.location.range,
      selection: node.location.range,
    });
  }
}

/**
 * How the last symbol request for a document ended.
 *
 * Four outcomes that look identical to a user and have unrelated fixes:
 *
 * - `ok` — symbols came back.
 * - `timeout` — the server never answered. Normal on the first request for a
 *   large translation unit, while clangd parses it and every header it includes.
 * - `no-provider` — the command resolved to `undefined`, meaning no extension
 *   has registered a document symbol provider for this language yet. Usually a
 *   language server that has not finished activating, or is not installed.
 * - `empty` — a provider answered and the file genuinely has no symbols.
 *
 * Collapsing these into "no symbols" sends people hunting for configuration
 * problems that do not exist.
 */
export type SymbolOutcome = 'ok' | 'timeout' | 'no-provider' | 'empty';

const outcomes = new Map<string, SymbolOutcome>();

export function lastSymbolOutcome(doc: vscode.TextDocument): SymbolOutcome {
  return outcomes.get(doc.uri.toString()) ?? 'empty';
}

export function lastRequestTimedOut(doc: vscode.TextDocument): boolean {
  return lastSymbolOutcome(doc) === 'timeout';
}

export async function symbolsFor(
  doc: vscode.TextDocument,
  timeoutMs: number,
): Promise<AnchoredSymbol[]> {
  const key = doc.uri.toString();
  const hit = cache.get(key);
  if (hit && hit.version === doc.version) {
    return hit.symbols;
  }

  // Poll rather than ask once.
  //
  // A single request loses to two different races: the language server may not
  // have registered its provider yet, in which case the command resolves to
  // `undefined` immediately, or it may be mid-parse and answer with an empty
  // array. Both are transient and both previously surfaced as "this file is not
  // being parsed", which is a conclusion about the project rather than about
  // timing.
  const deadline = Date.now() + timeoutMs;
  let raw: vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined;
  let sawProvider = false;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    const TIMEOUT = Symbol('timeout');
    const answer = await Promise.race([
      vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined>(
        'vscode.executeDocumentSymbolProvider',
        doc.uri,
      ),
      new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), remaining)),
    ]);
    if (answer === TIMEOUT) {
      break;
    }
    if (Array.isArray(answer)) {
      sawProvider = true;
      if (answer.length > 0) {
        raw = answer;
        break;
      }
    }
    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  outcomes.set(
    key,
    raw !== undefined ? 'ok' : Date.now() >= deadline ? (sawProvider ? 'empty' : 'no-provider') : sawProvider ? 'empty' : 'no-provider',
  );

  const out: AnchoredSymbol[] = [];
  if (Array.isArray(raw) && raw.length > 0) {
    if (isHierarchical(raw)) {
      flattenHierarchical(raw, [], out);
    } else {
      flattenFlat(raw as vscode.SymbolInformation[], out);
    }
    // Only cache a real answer. Caching an empty one would leave the document
    // permanently unanchorable for the session.
    cache.set(key, { version: doc.version, symbols: out });
  }
  return out;
}

/** Innermost symbol containing the position, or undefined. */
export function symbolAt(symbols: AnchoredSymbol[], pos: vscode.Position): AnchoredSymbol | undefined {
  let best: AnchoredSymbol | undefined;
  for (const s of symbols) {
    if (!s.range.contains(pos)) {
      continue;
    }
    if (!best || (best.range.contains(s.range.start) && best.range.contains(s.range.end))) {
      best = s;
    }
  }
  return best;
}

export interface ResolvedTarget {
  anchor: string;
  sym: SymbolPath;
  mode: 'symbol' | 'fingerprint';
  line: number;
  /** Human-facing label for the anchor site. */
  label: string;
}

/**
 * Resolve the annotation target at a position, falling back to a content
 * fingerprint when the language server cannot name it. The fallback is what
 * makes the tool usable inside macro bodies, `#ifdef` blocks and raw statements
 * — exactly the places a C engineer reading unfamiliar firmware wants to leave
 * a note.
 */
export async function resolveTarget(
  doc: vscode.TextDocument,
  pos: vscode.Position,
  relPath: string,
  timeoutMs: number,
): Promise<ResolvedTarget> {
  const symbols = await symbolsFor(doc, timeoutMs);
  const found = symbolAt(symbols, pos);
  if (found) {
    return {
      anchor: found.anchor,
      sym: found.sym,
      mode: 'symbol',
      line: found.selection.start.line + 1,
      label: found.sym.qualifiedName,
    };
  }

  const first = Math.max(0, pos.line - 1);
  const last = Math.min(doc.lineCount - 1, pos.line + 1);
  const context: string[] = [];
  for (let i = first; i <= last; i++) {
    context.push(doc.lineAt(i).text);
  }
  const snippet = doc.lineAt(pos.line).text.trim().slice(0, 48) || '(blank line)';

  return {
    anchor: fingerprintAnchor(relPath, context),
    sym: { qualifiedName: snippet, symbolKind: 'Snippet' },
    mode: 'fingerprint',
    line: pos.line + 1,
    label: snippet,
  };
}
