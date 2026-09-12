import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parseClangUml } from '../core/clanguml.js';
import type { StructureModel } from '../core/structure.js';

/**
 * Cached structure model.
 *
 * The Flow lens needs a class hierarchy to expand virtual calls, but forcing a
 * clang-uml run every time someone opens a call tree would make the lens slow
 * and would fail on machines where clang-uml is not installed. Instead the JSON
 * clang-uml already writes to .lens/cache is reused, with an in-memory copy for
 * the common case.
 *
 * A stale hierarchy is the acceptable failure here: the candidate set may be
 * missing a class added since the last Structure run, which is visible and
 * fixable, whereas a lens that refuses to open is simply not used.
 */

let memo: { model: StructureModel; mtimeMs: number } | undefined;

export function cachedStructurePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.lens', 'cache', 'lens_structure.json');
}

export function rememberStructure(model: StructureModel): void {
  memo = { model, mtimeMs: Date.now() };
}

export async function loadCachedStructure(workspaceRoot: string): Promise<StructureModel | undefined> {
  const file = cachedStructurePath(workspaceRoot);
  try {
    const stat = await fs.stat(file);
    if (memo && memo.mtimeMs >= stat.mtimeMs) {
      return memo.model;
    }
    const model = parseClangUml(await fs.readFile(file, 'utf8'));
    memo = { model, mtimeMs: stat.mtimeMs };
    return model;
  } catch {
    return memo?.model;
  }
}
