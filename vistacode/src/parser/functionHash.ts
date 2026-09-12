import * as crypto from 'node:crypto';
import type Parser from 'web-tree-sitter';
import { getFunctionName } from './cfgBuilder';

/** Full-content hash (code + comments) — drives both the in-memory and on-disk cache invalidation. */
export function hashFunctionText(functionNode: Parser.SyntaxNode): string {
  return crypto.createHash('sha256').update(functionNode.text).digest('hex').slice(0, 12);
}

/** Short hash of just the declarator, used to disambiguate same-named C++ overloads in cache filenames. */
export function signatureHash(functionNode: Parser.SyntaxNode): string {
  const declarator = functionNode.childForFieldName('declarator');
  const text = declarator ? declarator.text : functionNode.text.slice(0, 40);
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}

export const functionDisplayName = getFunctionName;

