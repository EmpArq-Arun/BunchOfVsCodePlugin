/**
 * folderTree.ts
 *
 * Walks the workspace directory tree to discover folders that contain
 * (directly or transitively) at least one user source file — used to
 * generate folder-level overview docs at every depth.
 *
 * Deliberately takes plain predicates (isExcluded, includeExtensions)
 * rather than a VendorProfile instance, so this stays pure and directly
 * unit-testable without a vscode stub.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface FolderNode {
  /** '' for the workspace root, otherwise a forward-slash relative path */
  relPath: string;
  /** Relative file paths directly in this folder (not recursive) */
  files: string[];
  /** Relative subfolder paths directly in this folder (not recursive) */
  subfolders: string[];
}

export interface WalkOptions {
  isExcluded: (relPath: string) => boolean;
  includeExtensions: string[];
  /** Directory names skipped everywhere, regardless of vendor rules */
  alwaysSkip?: string[];
}

const DEFAULT_ALWAYS_SKIP = new Set(['.codex', '.git', 'node_modules', '.vscode']);

function toRelPosix(workspaceRoot: string, absPath: string): string {
  return path.relative(workspaceRoot, absPath).split(path.sep).join('/');
}

/** Returns every folder (relative path) that contains at least one
 *  matching, non-excluded file somewhere in its subtree — deepest
 *  folders first (post-order), suitable for bottom-up doc generation.
 *  The workspace root itself is included last, as relPath === ''. */
export function walkFoldersPostOrder(workspaceRoot: string, opts: WalkOptions): FolderNode[] {
  const alwaysSkip = new Set([...DEFAULT_ALWAYS_SKIP, ...(opts.alwaysSkip ?? [])]);
  const result: FolderNode[] = [];

  function visit(absDir: string): boolean {
    const relDir = toRelPosix(workspaceRoot, absDir);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch { return false; }

    const files: string[] = [];
    const subfolders: string[] = [];
    let hasRelevantContent = false;

    for (const entry of entries) {
      if (alwaysSkip.has(entry.name)) { continue; }
      const absChild = path.join(absDir, entry.name);
      const relChild = toRelPosix(workspaceRoot, absChild);

      if (entry.isDirectory()) {
        if (opts.isExcluded(relChild)) { continue; }
        const childHasContent = visit(absChild);
        if (childHasContent) {
          subfolders.push(relChild);
          hasRelevantContent = true;
        }
      } else if (entry.isFile()) {
        if (opts.isExcluded(relChild)) { continue; }
        const ext = path.extname(entry.name).toLowerCase();
        if (opts.includeExtensions.includes(ext)) {
          files.push(relChild);
          hasRelevantContent = true;
        }
      }
    }

    if (hasRelevantContent) {
      result.push({ relPath: relDir, files, subfolders });
    }
    return hasRelevantContent;
  }

  visit(workspaceRoot);
  return result;
}

/** Just the ancestor chain for a single file, from its immediate parent
 *  up to (and including) the workspace root — used for the cheap
 *  per-save bubble-up rather than a full tree walk. */
export function ancestorFolders(workspaceRoot: string, absFilePath: string): string[] {
  const relFile = toRelPosix(workspaceRoot, absFilePath);
  const parts = relFile.split('/').slice(0, -1); // drop the filename
  const chain: string[] = [];
  for (let i = parts.length; i >= 0; i--) {
    chain.push(parts.slice(0, i).join('/'));
  }
  return chain; // immediate parent first, '' (root) last
}
