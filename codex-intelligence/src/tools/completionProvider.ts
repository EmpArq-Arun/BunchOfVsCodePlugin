import * as vscode from 'vscode';
import { CodexDB } from '../db/codexDB';

type AutocompFn = (prefix: string, file: string) => Promise<string[]>;
type GetDbFn    = () => CodexDB | null;

const TRIGGER_CHARS  = ['(', '.', '_'];
const MIN_PREFIX_LEN = 3;
const TIMEOUT_MS     = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, fb: T): Promise<T> {
  return Promise.race([p, new Promise<T>(r => setTimeout(() => r(fb), ms))]);
}

export function registerCompletionProvider(
  context: vscode.ExtensionContext,
  autocompFn: AutocompFn,
  getDb: GetDbFn
): void {
  const langs = [{ language:'c', scheme:'file' }, { language:'cpp', scheme:'file' }];

  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(langs, {
      async provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): Promise<vscode.CompletionItem[]> {
        const db = getDb();
        if (!db || db.listFunctions().length === 0) { return []; }
        const prefix = doc.lineAt(pos).text.slice(0, pos.character).match(/[\w_]+$/)?.[0] ?? '';
        if (prefix.length < MIN_PREFIX_LEN) { return []; }
        const codeCtx = doc.getText(new vscode.Range(Math.max(0, pos.line - 5), 0, pos.line, pos.character));
        try {
          const suggestions = await withTimeout(autocompFn(codeCtx, doc.uri.fsPath), TIMEOUT_MS, []);
          return suggestions.map((text, i) => {
            const item = new vscode.CompletionItem(text, vscode.CompletionItemKind.Function);
            item.detail = 'Codex'; item.sortText = `z_codex_${String(i).padStart(3,'0')}`;
            item.insertText = text; item.range = new vscode.Range(pos, pos);
            return item;
          });
        } catch { return []; }
      }
    }, ...TRIGGER_CHARS)
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(langs, {
      provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
        const db = getDb();
        if (!db) { return undefined; }
        const wordRange = doc.getWordRangeAtPosition(pos, /[\w_]+/);
        if (!wordRange) { return undefined; }
        const entry = db.readFunction(doc.getText(wordRange));
        if (!entry) { return undefined; }
        const md = new vscode.MarkdownString();
        md.appendCodeblock(entry.signature, 'c');
        md.appendMarkdown(`\n**Purpose:** ${entry.purpose}\n\n*${entry.file}* — line ${entry.line}`);
        if (entry.callees.length) { md.appendMarkdown(`\n\n**Calls:** ${entry.callees.map(c=>`\`${c}\``).join(', ')}`); }
        if (entry.sideEffects)   { md.appendMarkdown(`\n\n**Side effects:** ${entry.sideEffects}`); }
        md.isTrusted = true;
        return new vscode.Hover(md, wordRange);
      }
    })
  );
}
