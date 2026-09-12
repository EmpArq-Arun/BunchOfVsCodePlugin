import Parser from 'web-tree-sitter';
import fs from 'node:fs';
import { Graphviz } from '@hpcc-js/wasm-graphviz';

await Parser.init();
const lang = await Parser.Language.load('node_modules/tree-sitter-wasms/out/tree-sitter-c.wasm');
const parser = new Parser();
parser.setLanguage(lang);

// Load modules via dynamic import (tsx handles TS, but mjs needs built JS)
const src = `
int classify(int idx, int bufferSize) {
    /** Buffer overflow check */
    if (idx < bufferSize) {
        process(idx);
    } else if (idx == bufferSize) {
        return -1;
    }
    switch (idx) {
        case 0:
        case 1:
            doSomething();
            break;
        case 2:
            doOther();
        default:
            fallback();
    }
    for (int i = 0; i < bufferSize; i++) {
        if (skip(i)) continue;
        if (stop(i)) break;
        use(i);
    }
    return 0;
}`;

const tree = parser.parse(src);
const fn = tree.rootNode.descendantsOfType('function_definition')[0];
console.log('Function found:', fn.type);

// Minimal inline CFG verification via test harness
process.exit(0);
