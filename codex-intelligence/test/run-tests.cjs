'use strict';
/**
 * run-tests.cjs
 *
 * Automated test suite for Codex Intelligence. Run with: npm test
 * (which first runs `tsc -p .` then executes this file against out/).
 *
 * Covers two categories:
 *   1. LIVE NETWORK TESTS — the compiled adapter classes (openaiCompatible,
 *      anthropic, gemini) are require()'d directly (they have zero vscode
 *      dependency) and exercised against local mock model servers that
 *      mimic each provider's real response shape. This validates the
 *      actual request/response cycle: correct URL, correct auth headers,
 *      correct body shape, correct response parsing, correct error
 *      handling — exactly what would happen against a real model, just
 *      with a stand-in server since this sandbox cannot reach external
 *      LLM APIs or a locally-running LM Studio instance.
 *   2. PURE LOGIC TESTS — call graph extraction, vendor path matching,
 *      and the .codex markdown DB read/write round-trip. All pure
 *      fs/string logic, no network involved.
 *
 * For true end-to-end testing against a real model (e.g. LM Studio +
 * Qwen running on your machine), see TEST_PLAN.md Part 2.
 */

const assert = require('node:assert/strict');
const path   = require('node:path');
const os     = require('node:os');
const fs     = require('node:fs');
const Module = require('node:module');

// Intercept require('vscode') so compiled files that import it at module
// scope (vendorProfile.js, extension.js, etc.) can be require()'d in plain
// Node. We only test pure exports from these files (e.g. matchesAnyPattern),
// never the vscode-dependent methods — see the stub's doc comment.
const vscodeStubPath = path.join(__dirname, 'mocks', 'vscode.cjs');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') { return vscodeStubPath; }
  return originalResolve.call(this, request, ...rest);
};

const { startOpenAIServer, startAnthropicServer, startGeminiServer } = require('./mockModelServers.cjs');

const OUT = path.join(__dirname, '..', 'out');

let pass = 0, fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    ${err.message}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function main() {
  console.log('Codex Intelligence — automated test suite');
  console.log('==========================================');

  // ════════════════════════════════════════════════════════════════
  section('1. OpenAI-compatible adapter (covers LM Studio, Ollama, vLLM, OpenRouter, OpenAI, Groq, Together, Perplexity, Mistral, DeepSeek, custom)');
  // ════════════════════════════════════════════════════════════════
  {
    const { OpenAICompatibleAdapter } = require(path.join(OUT, 'agent', 'providers', 'openaiCompatible.js'));
    const adapter = new OpenAICompatibleAdapter();

    await test('LM Studio: no model field sent when blank, no Authorization header', async () => {
      const { server, port, requests } = await startOpenAIServer();
      try {
        const cfg = { id: 'lmstudio', label: 'LM Studio', baseUrl: `http://127.0.0.1:${port}`, apiKey: '', model: '', adapter: 'openai' };
        const text = await adapter.complete(cfg, { messages: [{ role: 'user', content: 'hello' }], maxTokens: 50 });
        assert.equal(requests.length, 1);
        assert.equal(requests[0].url, '/v1/chat/completions');
        assert.equal('model' in requests[0].body, false, 'model key should be OMITTED when blank');
        assert.equal(requests[0].headers['authorization'], undefined, 'no auth header expected for LM Studio');
        assert.match(text, /^ok /);
      } finally { server.close(); }
    });

    await test('OpenRouter: sends Bearer auth + HTTP-Referer/X-Title headers, includes model', async () => {
      const { server, port, requests } = await startOpenAIServer();
      try {
        const cfg = { id: 'openrouter', label: 'OpenRouter', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-or-test123', model: 'anthropic/claude-sonnet-4-5', adapter: 'openai' };
        await adapter.complete(cfg, { system: 'You are helpful.', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
        const r = requests[0];
        assert.equal(r.headers['authorization'], 'Bearer sk-or-test123');
        assert.equal(r.headers['http-referer'], 'vscode://codex-intelligence');
        assert.equal(r.headers['x-title'], 'Codex Intelligence');
        assert.equal(r.body.model, 'anthropic/claude-sonnet-4-5');
        assert.equal(r.body.messages[0].role, 'system');
        assert.equal(r.body.messages[0].content, 'You are helpful.');
        assert.equal(r.body.messages[1].role, 'user');
      } finally { server.close(); }
    });

    await test('Azure OpenAI: uses api-key header (not Bearer), deployment in URL path, no model in body', async () => {
      const { server, port, requests } = await startOpenAIServer();
      try {
        const cfg = {
          id: 'azure-openai', label: 'Azure OpenAI', baseUrl: `http://127.0.0.1:${port}`,
          apiKey: 'azure-key-xyz', model: '', adapter: 'openai',
          extra: { deployment: 'my-gpt4-deployment', apiVersion: '2024-06-01' }
        };
        await adapter.complete(cfg, { messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 });
        const r = requests[0];
        assert.equal(r.headers['api-key'], 'azure-key-xyz');
        assert.equal(r.headers['authorization'], undefined, 'Azure should NOT use Authorization Bearer');
        assert.match(r.url, /^\/openai\/deployments\/my-gpt4-deployment\/chat\/completions\?api-version=2024-06-01$/);
        assert.equal('model' in r.body, false, 'Azure should not send "model" — it is implied by the deployment path');
      } finally { server.close(); }
    });

    await test('Handles HTTP error response (e.g. 401 invalid key) with a clear message', async () => {
      const { server, port } = await startOpenAIServer({ failWith: { status: 401, message: 'Invalid API key' } });
      try {
        const cfg = { id: 'openai', label: 'OpenAI', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'bad-key', model: 'gpt-4o', adapter: 'openai' };
        await assert.rejects(
          () => adapter.complete(cfg, { messages: [{ role: 'user', content: 'hi' }] }),
          /HTTP 401/
        );
      } finally { server.close(); }
    });

    await test('Handles unreachable server (connection refused) with a descriptive LM Studio message', async () => {
      const cfg = { id: 'lmstudio', label: 'LM Studio', baseUrl: 'http://127.0.0.1:1', apiKey: '', model: '', adapter: 'openai' };
      await assert.rejects(
        () => adapter.complete(cfg, { messages: [{ role: 'user', content: 'hi' }] }),
        /Cannot reach LM Studio/
      );
    });

    await test('Custom provider with blank baseUrl path still hits /v1/chat/completions', async () => {
      const { server, port, requests } = await startOpenAIServer();
      try {
        const cfg = { id: 'custom', label: 'Custom', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', model: 'local-model', adapter: 'openai' };
        await adapter.complete(cfg, { messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(requests[0].url, '/v1/chat/completions', 'should not double up /v1/v1');
      } finally { server.close(); }
    });
  }

  // ════════════════════════════════════════════════════════════════
  section('2. Anthropic adapter (native /v1/messages)');
  // ════════════════════════════════════════════════════════════════
  {
    const { AnthropicAdapter } = require(path.join(OUT, 'agent', 'providers', 'anthropicAdapter.js'));
    const adapter = new AnthropicAdapter();

    await test('Sends x-api-key + anthropic-version headers, system as top-level field', async () => {
      const { server, port, requests } = await startAnthropicServer();
      try {
        const cfg = { id: 'anthropic', label: 'Anthropic', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'sk-ant-test', model: 'claude-sonnet-4-5', adapter: 'anthropic' };
        const text = await adapter.complete(cfg, { system: 'Be concise.', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
        const r = requests[0];
        assert.equal(r.url, '/v1/messages');
        assert.equal(r.headers['x-api-key'], 'sk-ant-test');
        assert.equal(r.headers['anthropic-version'], '2023-06-01');
        assert.equal(r.body.system, 'Be concise.');
        assert.equal(r.body.messages.length, 1);
        assert.equal(r.body.messages[0].role, 'user');
        assert.match(text, /system=true/);
      } finally { server.close(); }
    });

    await test('Filters stray system-role messages out of the messages array', async () => {
      const { server, port, requests } = await startAnthropicServer();
      try {
        const cfg = { id: 'anthropic', label: 'Anthropic', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'claude-sonnet-4-5', adapter: 'anthropic' };
        await adapter.complete(cfg, { messages: [{ role: 'system', content: 'leaked system' }, { role: 'user', content: 'hi' }] });
        const r = requests[0];
        assert.equal(r.body.messages.length, 1, 'system-role message should have been filtered out');
        assert.equal(r.body.messages[0].role, 'user');
      } finally { server.close(); }
    });

    await test('Rejects immediately when no API key is set (no network call made)', async () => {
      const cfg = { id: 'anthropic', label: 'Anthropic', baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'claude-sonnet-4-5', adapter: 'anthropic' };
      await assert.rejects(
        () => adapter.complete(cfg, { messages: [{ role: 'user', content: 'hi' }] }),
        /requires an API key/
      );
    });

    await test('Defaults to claude-sonnet-4-5 when cfg.model is blank', async () => {
      const { server, port, requests } = await startAnthropicServer();
      try {
        const cfg = { id: 'anthropic', label: 'Anthropic', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: '', adapter: 'anthropic' };
        await adapter.complete(cfg, { messages: [{ role: 'user', content: 'hi' }] });
        assert.equal(requests[0].body.model, 'claude-sonnet-4-5');
      } finally { server.close(); }
    });
  }

  // ════════════════════════════════════════════════════════════════
  section('3. Gemini adapter (model in URL path, key as query param)');
  // ════════════════════════════════════════════════════════════════
  {
    const { GeminiAdapter } = require(path.join(OUT, 'agent', 'providers', 'geminiAdapter.js'));
    const adapter = new GeminiAdapter();

    await test('Sends API key as query param, model in URL path, contents/parts shape', async () => {
      const { server, port, requests } = await startGeminiServer();
      try {
        const cfg = { id: 'google-gemini', label: 'Gemini', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'gem-key-1', model: 'gemini-2.0-flash-001', adapter: 'gemini' };
        const text = await adapter.complete(cfg, { system: 'Be terse.', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] });
        const r = requests[0];
        assert.match(r.url, /^\/v1beta\/models\/gemini-2\.0-flash-001:generateContent\?key=gem-key-1$/);
        assert.equal(r.body.systemInstruction.parts[0].text, 'Be terse.');
        assert.equal(r.body.contents.length, 2);
        assert.equal(r.body.contents[1].role, 'model', 'assistant role should be remapped to "model" for Gemini');
        assert.match(text, /key=true/);
      } finally { server.close(); }
    });

    await test('Rejects when no API key is set', async () => {
      const cfg = { id: 'google-gemini', label: 'Gemini', baseUrl: 'http://127.0.0.1:1', apiKey: '', model: 'gemini-2.0-flash-001', adapter: 'gemini' };
      await assert.rejects(
        () => adapter.complete(cfg, { messages: [{ role: 'user', content: 'hi' }] }),
        /requires an API key/
      );
    });
  }

  // ════════════════════════════════════════════════════════════════
  section('4. Pure logic — call graph extraction (no fs, no network)');
  // ════════════════════════════════════════════════════════════════
  {
    const { extractCallGraphFromSource } = require(path.join(OUT, 'tools', 'callGraphFallback.js'));

    await test('Extracts direct function calls from a simple C source', () => {
      const src = `
        void HAL_GPIO_WritePin(int pin, int state) {}
        void led_on(void) {
          HAL_GPIO_WritePin(13, 1);
        }
        void app_main(void) {
          led_on();
        }
      `;
      const { calls } = extractCallGraphFromSource(src, ['HAL_']);
      const pairs = calls.map(c => `${c.caller}->${c.callee}`);
      assert.ok(pairs.includes('led_on->HAL_GPIO_WritePin'));
      assert.ok(pairs.includes('app_main->led_on'));
    });

    await test('Marks vendor-prefixed calls as extern leaves with dashed styling in .dot output', () => {
      const src = `
        void uart_send(char* buf) {
          HAL_UART_Transmit(buf);
        }
      `;
      const { dotSource } = extractCallGraphFromSource(src, ['HAL_']);
      assert.match(dotSource, /\[extern\]/);
      assert.match(dotSource, /style=dashed/);
    });

    await test('Ignores C control-flow keywords (if/for/while) — not treated as function calls', () => {
      const src = `
        void loop(void) {
          if (x) { do_thing(); }
          for (int i=0;i<10;i++) { step(); }
        }
      `;
      const { calls } = extractCallGraphFromSource(src, []);
      const callees = calls.map(c => c.callee);
      assert.ok(!callees.includes('if'));
      assert.ok(!callees.includes('for'));
    });

    await test('Strips comments before parsing (commented-out calls are ignored)', () => {
      const src = `
        void real_fn(void) {
          // fake_call();
          /* another_fake(); */
          actual_call();
        }
        void actual_call(void) {}
      `;
      const { calls } = extractCallGraphFromSource(src, []);
      const callees = calls.map(c => c.callee);
      assert.ok(!callees.includes('fake_call'));
      assert.ok(!callees.includes('another_fake'));
      assert.ok(callees.includes('actual_call'));
    });
  }

  // ════════════════════════════════════════════════════════════════
  section('5. Pure logic — vendor path matching');
  // ════════════════════════════════════════════════════════════════
  {
    const { matchesAnyPattern } = require(path.join(OUT, 'vendor', 'vendorProfile.js'));

    await test('STM32 HAL driver path matches Drivers/STM32*/** exclusion', () => {
      assert.equal(matchesAnyPattern('Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal.c', ['Drivers/STM32*/**']), true);
    });

    await test('User application code does NOT match vendor exclusion patterns', () => {
      assert.equal(matchesAnyPattern('Core/Src/main.c', ['Drivers/STM32*/**', 'Middlewares/**']), false);
    });

    await test('Handles Windows-style backslash paths the same as forward slashes', () => {
      assert.equal(matchesAnyPattern('Drivers\\STM32F4xx_HAL_Driver\\Src\\stm32f4xx_hal.c', ['Drivers/STM32*/**']), true);
    });
  }

  // ════════════════════════════════════════════════════════════════
  section('6. Pure logic — .codex markdown DB round-trip');
  // ════════════════════════════════════════════════════════════════
  {
    const { CodexDB } = require(path.join(OUT, 'db', 'codexDB.js'));
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));

    await test('init() creates the .codex directory structure', async () => {
      const db = new CodexDB(tmpRoot);
      await db.init();
      for (const d of ['functions', 'flows', 'states', 'sequences', 'behaviour', 'callgraph']) {
        assert.ok(fs.existsSync(path.join(tmpRoot, '.codex', d)), `missing .codex/${d}`);
      }
    });

    await test('writeFunction() then readFunction() round-trips all fields correctly', async () => {
      const db = new CodexDB(tmpRoot);
      await db.init();
      const entry = {
        name: 'UART_Transmit', file: '/proj/uart.c', line: 47,
        signature: 'HAL_StatusTypeDef UART_Transmit(UART_HandleTypeDef *h)',
        purpose: 'Sends a buffer over UART with a blocking timeout.',
        callers: ['LOG_Write', 'CLI_SendPrompt'],
        callees: ['HAL_UART_Transmit', 'UART_ValidateBuffer'],
        sideEffects: 'Blocks on UART peripheral.',
        sourceHash: 'abc123def456'
      };
      db.writeFunction(entry);
      const read = db.readFunction('UART_Transmit');
      assert.deepEqual(read, entry);
    });

    await test('isFunctionStale() detects a hash mismatch', async () => {
      const db = new CodexDB(tmpRoot);
      await db.init();
      db.writeFunction({ name: 'foo', file: 'f.c', line: 1, signature: 'void foo()', purpose: '', callers: [], callees: [], sideEffects: '', sourceHash: 'hash-old' });
      assert.equal(db.isFunctionStale('foo', 'hash-old'), false);
      assert.equal(db.isFunctionStale('foo', 'hash-new'), true);
      assert.equal(db.isFunctionStale('never-written', 'anything'), true);
    });

    await test('buildContext() assembles readable summaries for multiple functions', async () => {
      const db = new CodexDB(tmpRoot);
      await db.init();
      db.writeFunction({ name: 'fn_a', file: 'a.c', line: 1, signature: 'void fn_a()', purpose: 'Does A.', callers: [], callees: ['fn_b'], sideEffects: '', sourceHash: 'h1' });
      db.writeFunction({ name: 'fn_b', file: 'a.c', line: 10, signature: 'void fn_b()', purpose: 'Does B.', callers: ['fn_a'], callees: [], sideEffects: '', sourceHash: 'h2' });
      const ctx = db.buildContext(['fn_a', 'fn_b']);
      assert.match(ctx, /fn_a/);
      assert.match(ctx, /Does A\./);
      assert.match(ctx, /fn_b/);
      assert.match(ctx, /Called by:.*fn_a/);
    });

    await test('getStats() reports correct function and stale counts', async () => {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-stats-'));
      const db = new CodexDB(tmp2);
      await db.init();
      const realFile = path.join(tmp2, 'src.c');
      fs.writeFileSync(realFile, 'void x(){}');
      const hash = db.hashFile(realFile);
      db.writeFunction({ name: 'x', file: realFile, line: 1, signature: 'void x()', purpose: '', callers: [], callees: [], sideEffects: '', sourceHash: hash });
      db.writeFunction({ name: 'y', file: realFile, line: 2, signature: 'void y()', purpose: '', callers: [], callees: [], sideEffects: '', sourceHash: 'stale-hash' });
      const stats = db.getStats();
      assert.equal(stats.functionCount, 2);
      assert.equal(stats.staleCount, 1, 'y should be stale (hash does not match current file content)');
    });

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ════════════════════════════════════════════════════════════════
  // ════════════════════════════════════════════════════════════════
  section('7. Pure logic — deterministic flow/sequence PlantUML generation (dot2puml.ts)');
  // ════════════════════════════════════════════════════════════════
  {
    const { generateFlowPuml, generateSequencePuml } = require(path.join(OUT, 'tools', 'dot2puml.js'));

    const symbols = [
      { name: 'UART_Init', line: 5 },
      { name: 'UART_Transmit', line: 20 },
      { name: 'UART_HandleError', line: 40 }
    ];
    const calls = [
      { caller: 'UART_Init', callee: 'HAL_UART_Init' },
      { caller: 'UART_Transmit', callee: 'UART_ValidateBuffer' },
      { caller: 'UART_Transmit', callee: 'HAL_UART_Transmit' }
    ];

    await test('generateFlowPuml lists functions in declaration order with callee notes', () => {
      const puml = generateFlowPuml('uart_driver.c', symbols, calls, ['HAL_']);
      assert.match(puml, /@startuml/);
      assert.match(puml, /@enduml/);
      const initIdx = puml.indexOf(':UART_Init;');
      const txIdx   = puml.indexOf(':UART_Transmit;');
      assert.ok(initIdx > -1 && txIdx > -1 && initIdx < txIdx, 'should preserve declaration order');
      assert.match(puml, /calls HAL_UART_Init \[extern\]/);
    });

    await test('generateFlowPuml never fabricates if/else branches (no control-flow data available)', () => {
      const puml = generateFlowPuml('uart_driver.c', symbols, calls, ['HAL_']);
      assert.equal(/\bif\s*\(/.test(puml), false, 'must not claim branch structure it cannot know');
    });

    await test('generateSequencePuml marks extern participants with <<extern>> stereotype', () => {
      const puml = generateSequencePuml('uart_driver.c', symbols, calls, ['HAL_']);
      assert.match(puml, /participant HAL_UART_Init <<extern>>/);
      assert.match(puml, /participant UART_Init(?!\s*<<extern>>)/);
    });

    await test('generateSequencePuml emits one arrow per call edge, in order', () => {
      const puml = generateSequencePuml('uart_driver.c', symbols, calls, ['HAL_']);
      const arrowLines = puml.split('\n').filter(l => l.includes(' -> '));
      assert.equal(arrowLines.length, calls.length);
      assert.match(arrowLines[0], /UART_Init -> HAL_UART_Init: HAL_UART_Init\(\)/);
    });

    await test('Both generators are pure — same input always produces identical output', () => {
      const a = generateSequencePuml('x.c', symbols, calls, ['HAL_']);
      const b = generateSequencePuml('x.c', symbols, calls, ['HAL_']);
      assert.equal(a, b);
    });
  }

  // ════════════════════════════════════════════════════════════════
  section('8. Pure logic — folder tree walking (folderTree.ts)');
  // ════════════════════════════════════════════════════════════════
  {
    const { walkFoldersPostOrder, ancestorFolders } = require(path.join(OUT, 'tools', 'folderTree.js'));

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-folder-test-'));
    fs.mkdirSync(path.join(tmpRoot, 'Core', 'Src'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'Core', 'Inc'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'Drivers', 'STM32'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'Core', 'Src', 'main.c'), 'void main(){}');
    fs.writeFileSync(path.join(tmpRoot, 'Core', 'Src', 'uart.c'), 'void uart(){}');
    fs.writeFileSync(path.join(tmpRoot, 'Core', 'Inc', 'uart.h'), '');
    fs.writeFileSync(path.join(tmpRoot, 'Drivers', 'STM32', 'hal.c'), 'void hal(){}');
    // empty folder with no matching files anywhere in its subtree
    fs.mkdirSync(path.join(tmpRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'docs', 'README.txt'), 'not a source file');

    const isExcluded = (relPath) => relPath.startsWith('Drivers/');

    await test('walkFoldersPostOrder returns deepest folders before their parents', () => {
      const nodes = walkFoldersPostOrder(tmpRoot, { isExcluded, includeExtensions: ['.c', '.h'] });
      const relPaths = nodes.map(n => n.relPath);
      const srcIdx  = relPaths.indexOf('Core/Src');
      const coreIdx = relPaths.indexOf('Core');
      assert.ok(srcIdx > -1 && coreIdx > -1);
      assert.ok(srcIdx < coreIdx, 'Core/Src must come before Core (post-order = children first)');
    });

    await test('walkFoldersPostOrder excludes vendor-matched folders entirely', () => {
      const nodes = walkFoldersPostOrder(tmpRoot, { isExcluded, includeExtensions: ['.c', '.h'] });
      assert.ok(!nodes.some(n => n.relPath.startsWith('Drivers')), 'Drivers/** should be fully excluded');
    });

    await test('walkFoldersPostOrder skips folders with no matching files anywhere in their subtree', () => {
      const nodes = walkFoldersPostOrder(tmpRoot, { isExcluded, includeExtensions: ['.c', '.h'] });
      assert.ok(!nodes.some(n => n.relPath === 'docs'), 'docs/ has no .c/.h files and should be skipped');
    });

    await test('walkFoldersPostOrder includes the workspace root last, with relPath ""', () => {
      const nodes = walkFoldersPostOrder(tmpRoot, { isExcluded, includeExtensions: ['.c', '.h'] });
      assert.equal(nodes[nodes.length - 1].relPath, '');
    });

    await test('ancestorFolders walks from immediate parent up to root, root last', () => {
      const chain = ancestorFolders(tmpRoot, path.join(tmpRoot, 'Core', 'Src', 'main.c'));
      assert.deepEqual(chain, ['Core/Src', 'Core', '']);
    });

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ════════════════════════════════════════════════════════════════
  section('9. Pure logic — module & folder docs in CodexDB (file-level and every-depth)');
  // ════════════════════════════════════════════════════════════════
  {
    const { CodexDB } = require(path.join(OUT, 'db', 'codexDB.js'));
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-module-test-'));
    const db = new CodexDB(tmpRoot);
    await db.init();

    await test('writeModule() then readModule() round-trips via the mirrored tree path', async () => {
      const entry = {
        file: 'Core/Src/uart_driver.c', sourceHash: 'abc123',
        purpose: 'Implements the UART driver layer.',
        publicApi:   [{ name: 'UART_Transmit', purpose: 'Sends a buffer over UART.' }],
        internalApi: [{ name: 'UART_ValidateBuffer', purpose: 'Checks buffer bounds.' }],
        dependencies: ['HAL_UART_Transmit'],
        functionCount: 2
      };
      db.writeModule(entry);
      const expectedPath = path.join(tmpRoot, '.codex', 'tree', 'Core', 'Src', 'uart_driver.c.md');
      assert.ok(fs.existsSync(expectedPath), 'module doc should mirror the real directory structure');
      const read = db.readModule('Core/Src/uart_driver.c');
      assert.deepEqual(read, entry);
    });

    await test('isModuleStale() detects a source hash mismatch', async () => {
      assert.equal(db.isModuleStale('Core/Src/uart_driver.c', 'abc123'), false);
      assert.equal(db.isModuleStale('Core/Src/uart_driver.c', 'different-hash'), true);
      assert.equal(db.isModuleStale('never/written.c', 'anything'), true);
    });

    await test('writeFolder() at every depth creates a _folder.md next to its children', async () => {
      const srcEntry = {
        folder: 'Core/Src', purpose: 'Implements the application layer.',
        files: [{ name: 'uart_driver.c', purpose: 'UART driver.' }],
        subfolders: [], childrenFingerprint: 'fp-src'
      };
      const coreEntry = {
        folder: 'Core', purpose: 'Top-level application code.',
        files: [], subfolders: [{ name: 'Src', purpose: 'Implements the application layer.' }],
        childrenFingerprint: 'fp-core'
      };
      const rootEntry = {
        folder: '', purpose: 'Whole embedded project.',
        files: [], subfolders: [{ name: 'Core', purpose: 'Top-level application code.' }],
        childrenFingerprint: 'fp-root'
      };
      db.writeFolder(srcEntry);
      db.writeFolder(coreEntry);
      db.writeFolder(rootEntry);

      assert.ok(fs.existsSync(path.join(tmpRoot, '.codex', 'tree', 'Core', 'Src', '_folder.md')));
      assert.ok(fs.existsSync(path.join(tmpRoot, '.codex', 'tree', 'Core', '_folder.md')));
      assert.ok(fs.existsSync(path.join(tmpRoot, '.codex', 'tree', '_folder.md')), 'root folder doc at .codex/tree/_folder.md');

      assert.deepEqual(db.readFolder('Core/Src'), srcEntry);
      assert.deepEqual(db.readFolder('Core'), coreEntry);
      assert.deepEqual(db.readFolder(''), rootEntry);
    });

    await test('fingerprintOf() is deterministic and order-independent', () => {
      const a = db.fingerprintOf([{ name: 'b.c', hash: '2' }, { name: 'a.c', hash: '1' }]);
      const b = db.fingerprintOf([{ name: 'a.c', hash: '1' }, { name: 'b.c', hash: '2' }]);
      assert.equal(a, b, 'fingerprint must not depend on input order — sorted internally');
    });

    await test('fingerprintOf() changes when any child hash changes (Merkle-style propagation)', () => {
      const before = db.fingerprintOf([{ name: 'a.c', hash: 'hash1' }]);
      const after  = db.fingerprintOf([{ name: 'a.c', hash: 'hash2' }]);
      assert.notEqual(before, after);
    });

    await test('isFolderStale() compares against the stored fingerprint, enabling bubble-up short-circuit', async () => {
      assert.equal(db.isFolderStale('Core/Src', 'fp-src'), false);
      assert.equal(db.isFolderStale('Core/Src', 'fp-changed'), true);
    });

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // ════════════════════════════════════════════════════════════════
  section('10. R1 — Mermaid / PlantUML dual format (diagramFormat.ts)');
  // ════════════════════════════════════════════════════════════════
  {
    const { generateFlow, generateSequence, promptSpecFor, extractDiagram, fileExtensionFor } =
      require(path.join(OUT, 'tools', 'diagramFormat.js'));

    const symbols = [{ name: 'UART_Init', line: 5 }, { name: 'UART_Transmit', line: 20 }];
    const calls = [
      { caller: 'UART_Init', callee: 'HAL_UART_Init' },
      { caller: 'UART_Transmit', callee: 'HAL_UART_Transmit' }
    ];

    await test('fileExtensionFor maps formats to the right extension', () => {
      assert.equal(fileExtensionFor('mermaid'), '.mmd');
      assert.equal(fileExtensionFor('plantuml'), '.puml');
    });

    await test('generateFlow emits valid Mermaid flowchart when format=mermaid', () => {
      const out = generateFlow('mermaid', 'uart.c', symbols, calls, ['HAL_']);
      assert.match(out, /```mermaid/);
      assert.match(out, /flowchart TD/);
      assert.match(out, /HAL_UART_Init \[extern\]/);
      assert.equal(out.includes('@startuml'), false);
    });

    await test('generateFlow emits valid PlantUML when format=plantuml', () => {
      const out = generateFlow('plantuml', 'uart.c', symbols, calls, ['HAL_']);
      assert.match(out, /@startuml/);
      assert.match(out, /@enduml/);
      assert.equal(out.includes('```mermaid'), false);
    });

    await test('generateSequence emits Mermaid sequenceDiagram with extern participants', () => {
      const out = generateSequence('mermaid', 'uart.c', symbols, calls, ['HAL_']);
      assert.match(out, /sequenceDiagram/);
      assert.match(out, /HAL_UART_Init \[extern\]/);
      assert.match(out, /->>/);
    });

    await test('Both formats produce the same number of call arrows', () => {
      const mmd = generateSequence('mermaid', 'x.c', symbols, calls, ['HAL_']);
      const puml = generateSequence('plantuml', 'x.c', symbols, calls, ['HAL_']);
      assert.equal(mmd.split('\n').filter(l => l.includes('->>')).length, calls.length);
      assert.equal(puml.split('\n').filter(l => l.includes(' -> ')).length, calls.length);
    });

    await test('promptSpecFor returns format-correct tokens and examples', () => {
      assert.equal(promptSpecFor('mermaid').openToken, '```mermaid');
      assert.equal(promptSpecFor('plantuml').openToken, '@startuml');
      assert.match(promptSpecFor('mermaid').stateExample, /stateDiagram-v2/);
    });

    await test('extractDiagram strips model prose around a PlantUML block', () => {
      const raw = 'Sure! Here is the diagram:\n@startuml\n[*] --> IDLE\n@enduml\nHope that helps!';
      const out = extractDiagram(raw, 'plantuml');
      assert.equal(out.startsWith('@startuml'), true);
      assert.equal(out.endsWith('@enduml'), true);
      assert.equal(out.includes('Hope that helps'), false);
    });

    await test('extractDiagram normalises a Mermaid fence even when model adds prose', () => {
      const raw = 'Here you go:\n```mermaid\nstateDiagram-v2\n  [*] --> IDLE\n```\nDone.';
      const out = extractDiagram(raw, 'mermaid');
      assert.equal(out.startsWith('```mermaid'), true);
      assert.equal(out.trim().endsWith('```'), true);
      assert.equal(out.includes('Done.'), false);
    });
  }

  // ════════════════════════════════════════════════════════════════
  section('11. R6 — user feedback loop: edits survive and feed back (userSections.ts)');
  // ════════════════════════════════════════════════════════════════
  {
    const { extractPreserved, renderUserBlock, applyCorrection, isCorrected,
            stripMarker, feedbackContext, USER_START, USER_END } =
      require(path.join(OUT, 'tools', 'userSections.js'));

    await test('extractPreserved returns empty structure for missing/blank input', () => {
      const p = extractPreserved(null);
      assert.deepEqual(p, { userNotes: '', corrections: {} });
    });

    await test('extractPreserved recovers text inside the protected user block', () => {
      const md = `# Fn\n\n## Notes\n${USER_START}\nThis ISR must stay under 20us.\n${USER_END}\n`;
      const p = extractPreserved(md);
      assert.equal(p.userNotes, 'This ISR must stay under 20us.');
    });

    await test('extractPreserved detects [corrected] field overrides', () => {
      const md = '**Purpose:** [corrected] Drives the motor, not the LED.\n';
      const p = extractPreserved(md);
      assert.equal(p.corrections['purpose'], 'Drives the motor, not the LED.');
    });

    await test('applyCorrection keeps the user value and preserves the lock marker', () => {
      const p = extractPreserved('**Purpose:** [corrected] Real description.');
      const out = applyCorrection('Purpose', 'Agent guess that is wrong', p);
      assert.match(out, /\[corrected\] Real description\./);
      assert.equal(out.includes('Agent guess'), false);
    });

    await test('applyCorrection falls through to the agent value when uncorrected', () => {
      const p = extractPreserved('**Purpose:** normal agent text');
      assert.equal(applyCorrection('Purpose', 'agent value', p), 'agent value');
    });

    await test('isCorrected / stripMarker behave correctly', () => {
      const p = extractPreserved('**Purpose:** [corrected] X');
      assert.equal(isCorrected('Purpose', p), true);
      assert.equal(isCorrected('Side effects', p), false);
      assert.equal(stripMarker('[corrected] X'), 'X');
    });

    await test('Round-trip: rendered user block is re-extractable (edits survive regeneration)', () => {
      const original = 'Timing critical — do not add logging here.';
      const rendered = renderUserBlock(original);
      const recovered = extractPreserved(`# Doc\n\n## Notes\n${rendered}\n`);
      assert.equal(recovered.userNotes, original);
    });

    await test('feedbackContext marks user input as authoritative for the prompt', () => {
      const p = extractPreserved(`**Purpose:** [corrected] Motor driver.\n${USER_START}\nRuns in ISR context.\n${USER_END}`);
      const ctx = feedbackContext('motor.c', p);
      assert.match(ctx, /authoritative/i);
      assert.match(ctx, /Motor driver\./);
      assert.match(ctx, /Runs in ISR context\./);
    });

    await test('feedbackContext returns empty string when user contributed nothing', () => {
      const p = extractPreserved('**Purpose:** plain agent text');
      assert.equal(feedbackContext('x.c', p), '');
    });

    await test('Placeholder text in an untouched block is not treated as user input', () => {
      const rendered = renderUserBlock('');
      const p = extractPreserved(`## Notes\n${rendered}`);
      assert.equal(feedbackContext('x.c', p), '', 'placeholder must not pollute agent context');
    });
  }

  // ════════════════════════════════════════════════════════════════
  section('12. R7/R8/R9 — machine index + architecture entry point (codexIndex.ts)');
  // ════════════════════════════════════════════════════════════════
  {
    const { buildIndex, neighbourhood, renderArchitectureMd, INDEX_VERSION } =
      require(path.join(OUT, 'tools', 'codexIndex.js'));

    const functions = [
      { n: 'main', f: 'Core/Src/main.c', l: 1, p: 'Entry point.', cr: [], ce: ['UART_Transmit'], x: false },
      { n: 'UART_Transmit', f: 'Core/Src/uart.c', l: 20, p: 'Sends bytes.', cr: ['main'], ce: ['HAL_UART_Transmit'], x: false },
      { n: 'unrelated', f: 'Core/Src/other.c', l: 5, p: 'Nothing to do with UART.', cr: [], ce: [], x: false }
    ];
    const modules = [
      { f: 'Core/Src/uart.c', p: 'UART driver layer.', pub: ['UART_Transmit'], dep: ['HAL_UART_Transmit'], x: false }
    ];
    const folders = [
      { d: '', p: 'Embedded motor controller firmware.', files: [], subs: ['Core'], x: false },
      { d: 'Core', p: 'Application code.', files: [], subs: ['Src'], x: false }
    ];

    const index = buildIndex({ diagramFormat: 'mermaid', functions, modules, folders, externs: ['HAL_UART_Transmit'] });

    await test('buildIndex produces a versioned index with correct counts', () => {
      assert.equal(index.version, INDEX_VERSION);
      assert.equal(index.counts.functions, 3);
      assert.equal(index.counts.modules, 1);
      assert.equal(index.counts.folders, 2);
    });

    await test('buildIndex builds a flat callGraph adjacency map for O(1) walks', () => {
      assert.deepEqual(index.callGraph['main'], ['UART_Transmit']);
      assert.equal(index.callGraph['unrelated'], undefined, 'leaf with no callees omitted to keep index small');
    });

    await test('neighbourhood walks N hops in BOTH directions (callers and callees)', () => {
      const oneHop = neighbourhood(index, 'UART_Transmit', 1);
      assert.ok(oneHop.includes('main'), 'should reach caller');
      assert.ok(oneHop.includes('HAL_UART_Transmit'), 'should reach callee');
      assert.ok(!oneHop.includes('unrelated'), 'must not pull in disconnected functions — this is the context minimisation');
    });

    await test('neighbourhood with 0 hops returns only the seed', () => {
      assert.deepEqual(neighbourhood(index, 'main', 0), ['main']);
    });

    await test('renderArchitectureMd produces a navigable entry point with module links', () => {
      const md = renderArchitectureMd(index, '.mmd');
      assert.match(md, /# Architecture Overview/);
      assert.match(md, /Embedded motor controller firmware\./);
      assert.match(md, /\[`Core\/Src\/uart\.c`\]\(tree\/Core\/Src\/uart\.c\.md\)/, 'module table must link to the module doc');
      assert.match(md, /behaviour\/system_behaviour\.mmd/, 'must use the active diagram extension');
    });

    await test('renderArchitectureMd documents the vendor boundary explicitly', () => {
      const md = renderArchitectureMd(index, '.mmd');
      assert.match(md, /Vendor \/ external boundary/);
      assert.match(md, /HAL_UART_Transmit/);
      assert.match(md, /not\*\* part of it|deliberately not analysed/);
    });

    await test('renderArchitectureMd explains how the user corrects the docs (R6 discoverability)', () => {
      const md = renderArchitectureMd(index, '.puml');
      assert.match(md, /codex:user-start/);
      assert.match(md, /\[corrected\]/);
    });
  }

  // ════════════════════════════════════════════════════════════════
  console.log('\n==========================================');
  console.log(`${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.name}`);
      console.log(`    ${f.err.stack.split('\n').slice(0, 3).join('\n    ')}`);
    }
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.');
  }
}

main().catch(err => {
  console.error('Test runner crashed:', err);
  process.exitCode = 1;
});
