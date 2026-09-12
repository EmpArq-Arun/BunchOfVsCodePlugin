import Parser from 'web-tree-sitter';
import * as path from 'node:path';

let initialized = false;
let cLanguage: Parser.Language | null = null;

export async function parseCFunction(source: string): Promise<Parser.SyntaxNode> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
  if (!cLanguage) {
    const wasmPath = path.join(
      __dirname,
      '..',
      'node_modules',
      'tree-sitter-wasms',
      'out',
      'tree-sitter-c.wasm'
    );
    cLanguage = await Parser.Language.load(wasmPath);
  }
  const parser = new Parser();
  parser.setLanguage(cLanguage);
  const tree = parser.parse(source);
  const fn = tree.rootNode.descendantsOfType('function_definition')[0];
  if (!fn) {
    throw new Error('No function_definition found in test source');
  }
  return fn;
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
