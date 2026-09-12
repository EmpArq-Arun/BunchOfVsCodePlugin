'use strict';
/**
 * mockModelServers.cjs
 *
 * Three tiny local HTTP servers that mimic the response shapes of:
 *   - An OpenAI-compatible /v1/chat/completions endpoint (covers
 *     LM Studio, Ollama, OpenRouter, Groq, etc. — they all share this shape)
 *   - Anthropic's /v1/messages endpoint
 *   - Google Gemini's /v1beta/models/{model}:generateContent endpoint
 *
 * These stand in for a real model so the adapter code's request building,
 * header construction, and response parsing can be exercised end-to-end
 * without needing network egress to an external provider (this sandbox's
 * egress allowlist does not include LM Studio's localhost port, nor
 * api.openai.com / api.anthropic.com / openrouter.ai).
 *
 * Each server inspects the inbound request and echoes back enough detail
 * (in the reply text) for the test runner to assert on it.
 */

const http = require('node:http');

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

/** Starts an OpenAI-compatible server. Returns { server, port, requests } */
function startOpenAIServer(opts = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    if (opts.failWith) {
      res.writeHead(opts.failWith.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: opts.failWith.message } }));
      return;
    }
    if (opts.networkDrop) {
      req.socket.destroy();
      return;
    }

    const sawAuth  = !!req.headers['authorization'];
    const modelSent = body.model ?? '(omitted)';
    const replyText = opts.replyText ?? `ok model=${modelSent} auth=${sawAuth} msgs=${(body.messages||[]).length}`;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'mock-openai-1',
      choices: [{ message: { role: 'assistant', content: replyText }, finish_reason: 'stop' }]
    }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

/** Starts an Anthropic-shaped server. */
function startAnthropicServer(opts = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    if (opts.failWith) {
      res.writeHead(opts.failWith.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'error', message: opts.failWith.message } }));
      return;
    }

    const sawKey = !!req.headers['x-api-key'];
    const sawVersion = req.headers['anthropic-version'];
    const hasSystem = typeof body.system === 'string' && body.system.length > 0;
    const replyText = `ok model=${body.model} key=${sawKey} version=${sawVersion} system=${hasSystem} msgs=${(body.messages||[]).length}`;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: replyText }] }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

/** Starts a Gemini-shaped server. */
function startGeminiServer(opts = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req).catch(() => ({}));
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });

    if (opts.failWith) {
      res.writeHead(opts.failWith.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: opts.failWith.message } }));
      return;
    }

    const url = new URL(req.url, `http://localhost`);
    const sawKey = url.searchParams.get('key');
    const hasSysInstr = !!body.systemInstruction;
    const replyText = `ok key=${!!sawKey} sysInstr=${hasSysInstr} contents=${(body.contents||[]).length}`;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: replyText }] }, finishReason: 'STOP' }] }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

module.exports = { startOpenAIServer, startAnthropicServer, startGeminiServer };
