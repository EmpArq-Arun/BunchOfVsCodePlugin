import type Parser from 'web-tree-sitter';
import { parseDoxygenComment } from './doxygen';

/**
 * Returns the annotation comment for a statement node, or null if none.
 *
 * Priority:
 *  1. Same-line trailing comment on the statement end row.
 *  2. A chain of consecutive leading comments directly above (no blank-line gap).
 *     Multiple single-line comments are joined with newlines.
 *     A block comment terminates the upward search.
 */
export function findAnnotationFor(statementNode: Parser.SyntaxNode): string | null {
  // 1. Trailing same-line comment
  const trailing = statementNode.nextNamedSibling;
  if (
    trailing?.type === 'comment' &&
    trailing.startPosition.row === statementNode.endPosition.row
  ) {
    return parseDoxygenComment(trailing.text);
  }

  // 2. Chain of consecutive leading comments (no blank-line gaps)
  const collected: string[] = [];
  let checkRow = statementNode.startPosition.row;
  let node = statementNode.previousNamedSibling;

  while (node?.type === 'comment') {
    const gap = checkRow - node.endPosition.row;
    if (gap > 1) break;                    // blank line between items

    collected.unshift(node.text);          // prepend to keep top→bottom order
    checkRow = node.startPosition.row;

    if (node.text.trim().startsWith('/*')) break; // block comment: stop here

    node = node.previousNamedSibling;
  }

  if (collected.length === 0) return null;

  const lines = collected.map(t => parseDoxygenComment(t)).filter(l => l.length > 0);
  return lines.length > 0 ? lines.join('\n') : null;
}
