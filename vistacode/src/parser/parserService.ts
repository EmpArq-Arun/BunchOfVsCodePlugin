import Parser from 'web-tree-sitter';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { buildCFG } from './cfgBuilder';
import type { ControlFlowGraph } from './cfgTypes';

type GrammarId = 'c' | 'cpp';

let initPromise: Promise<void> | null = null;
const languageCache = new Map<GrammarId, Parser.Language>();

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init();
  }
  return initPromise;
}

async function loadLanguage(extensionPath: string, grammar: GrammarId): Promise<Parser.Language> {
  await ensureInit();
  const cached = languageCache.get(grammar);
  if (cached) {
    return cached;
  }
  const wasmFile = grammar === 'cpp' ? 'tree-sitter-cpp.wasm' : 'tree-sitter-c.wasm';
  const wasmPath = path.join(extensionPath, 'dist', 'grammars', wasmFile);
  const lang = await Parser.Language.load(wasmPath);
  languageCache.set(grammar, lang);
  return lang;
}

export interface ParsedFunction {
  node: Parser.SyntaxNode;
  sourceText: string;
}

export class ParserService {
  constructor(private readonly extensionPath: string) {}

  private grammarFor(document: vscode.TextDocument): GrammarId {
    return document.languageId === 'cpp' ? 'cpp' : 'c';
  }

  /** Re-parses the whole document and walks up from `position` to the enclosing function_definition. */
  async findAllFunctions(document: vscode.TextDocument): Promise<ParsedFunction[]> {
    const lang = await loadLanguage(this.extensionPath, this.grammarFor(document));
    const parser = new Parser();
    parser.setLanguage(lang);

    const sourceText = document.getText();
    const tree = parser.parse(sourceText);
    return tree.rootNode.descendantsOfType('function_definition').map((node) => ({ node, sourceText }));
  }

  async findEnclosingFunction(document: vscode.TextDocument, position: vscode.Position): Promise<ParsedFunction | null> {
    const lang = await loadLanguage(this.extensionPath, this.grammarFor(document));
    const parser = new Parser();
    parser.setLanguage(lang);

    const sourceText = document.getText();
    const tree = parser.parse(sourceText);

    const point: Parser.Point = { row: position.line, column: position.character };
    let cur: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition(point);

    while (cur) {
      if (cur.type === 'function_definition') {
        return { node: cur, sourceText };
      }
      cur = cur.parent;
    }
    return null;
  }

  async buildGraphAt(document: vscode.TextDocument, position: vscode.Position): Promise<ControlFlowGraph | null> {
    const found = await this.findEnclosingFunction(document, position);
    return found ? buildCFG(found.node) : null;
  }
}
