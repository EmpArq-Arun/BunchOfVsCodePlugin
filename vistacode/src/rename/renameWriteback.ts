import * as vscode from 'vscode';
import { formatDoxygenComment } from '../annotations/doxygen';
import type { SourceRange } from '../parser/cfgTypes';

export async function writeAnnotationComment(
  document: vscode.TextDocument,
  anchorRange: SourceRange,
  newLabel: string
): Promise<void> {
  const maxWidth = vscode.workspace.getConfiguration('vistacode').get<number>('annotationMaxLineWidth', 80);
  const anchorLine = anchorRange.start.row;
  const indentMatch = document.lineAt(anchorLine).text.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : '';
  const commentText = formatDoxygenComment(newLabel, maxWidth, indent);

  const edit = new vscode.WorkspaceEdit();

  // #2 — always write a LEADING block comment. Also delete any trailing comment
  //       on the anchor line so there are never two competing annotations.
  const trailingRange = findTrailingCommentRange(document, anchorLine);
  if (trailingRange) {
    edit.delete(document.uri, trailingRange);
  }

  const leadingRange = findLeadingCommentRange(document, anchorLine);
  if (leadingRange) {
    edit.replace(document.uri, leadingRange, commentText);
  } else {
    edit.insert(document.uri, new vscode.Position(anchorLine, 0), `${commentText}\n`);
  }

  await vscode.workspace.applyEdit(edit);
}

/**
 * Looks for a trailing comment on the anchor line itself — either /* ... *\/ or //.
 * Returns the range of just the comment (from the /* or // to end-of-line).
 */
function findTrailingCommentRange(document: vscode.TextDocument, anchorLine: number): vscode.Range | null {
  const lineText = document.lineAt(anchorLine).text;

  // Inline block comment: /* ... */ at or near end of line
  const blockIdx = lineText.lastIndexOf('/*');
  if (blockIdx !== -1) {
    const closeIdx = lineText.indexOf('*/', blockIdx);
    if (closeIdx !== -1) {
      return new vscode.Range(
        new vscode.Position(anchorLine, blockIdx),
        new vscode.Position(anchorLine, lineText.length)
      );
    }
  }
  // Line comment: //...
  const lineCommentIdx = lineText.indexOf('//');
  if (lineCommentIdx !== -1) {
    return new vscode.Range(
      new vscode.Position(anchorLine, lineCommentIdx),
      new vscode.Position(anchorLine, lineText.length)
    );
  }
  return null;
}

/**
 * Scans upward from the line immediately above `anchorLine` looking for an existing
 * comment block (/* ... *\/ or stacked //). Returns null if there's a blank line
 * between the comment and the anchor statement.
 */
function findLeadingCommentRange(document: vscode.TextDocument, anchorLine: number): vscode.Range | null {
  if (anchorLine === 0) return null;
  const lineAbove = anchorLine - 1;
  const textAbove = document.lineAt(lineAbove).text.trim();
  if (textAbove.length === 0) return null; // blank line = gap, no leading comment

  // Case A: line above ends with */ — could be the tail of a multi-line block comment
  if (textAbove.endsWith('*/')) {
    let startLine = lineAbove;
    if (!textAbove.startsWith('/*')) {
      // Multi-line: scan upward for the opening /*
      let cur = lineAbove - 1;
      while (cur >= 0) {
        const t = document.lineAt(cur).text.trim();
        if (t.length === 0) return null; // blank line hit before finding /*
        startLine = cur;
        if (t.startsWith('/*')) break;
        cur--;
        if (cur < 0) return null;
      }
    }
    if (!document.lineAt(startLine).text.trim().startsWith('/*')) return null;
    return new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(lineAbove, document.lineAt(lineAbove).text.length)
    );
  }

  // Case B: stacked // line comments
  if (textAbove.startsWith('//')) {
    let startLine = lineAbove;
    let cur = lineAbove - 1;
    while (cur >= 0) {
      const t = document.lineAt(cur).text.trim();
      if (!t.startsWith('//')) break;
      startLine = cur;
      cur--;
    }
    return new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(lineAbove, document.lineAt(lineAbove).text.length)
    );
  }

  return null;
}
