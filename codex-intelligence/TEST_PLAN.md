# Codex Intelligence — Test Plan

Two layers of testing:

- **Part 1 — Automated suite** (`npm test`). Runs in seconds, no VS Code or
  real model required. Exercises the LLM adapters against local mock model
  servers, plus pure logic (call-graph extraction, vendor filtering, the
  `.codex` DB). Run this after any code change.
- **Part 2 — Manual end-to-end testing** against a real running model
  (e.g. LM Studio + Qwen). Confirms the whole pipeline works inside actual
  VS Code, which the automated suite cannot do (it has no `vscode` runtime).

Run Part 1 before every Part 2 session — if the automated suite is red,
fix that first.

---

## Part 1 — Automated Test Suite

### 1.1 Running it

```bash
cd codex-extension
npm install
npm test
```

`npm test` runs `tsc -p .` (type-check + compile) then `node test/run-tests.cjs`.
A clean run ends with:

```
==========================================
24 passed, 0 failed

All tests passed.
```

Any non-zero exit code means something broke — read the failure detail
printed above the summary line.

### 1.2 What's covered and why

| Section | What it tests | Why it matters |
|---|---|---|
| 1. OpenAI-compatible adapter | LM Studio (no auth, omitted model), OpenRouter (Bearer + attribution headers), Azure (api-key header, deployment-in-path, no model field), HTTP error handling, network-down handling, URL building (no double `/v1`) | This one adapter serves 9 of the 11 built-in providers plus any `customProviders` entry — a bug here breaks most of the extension |
| 2. Anthropic adapter | `x-api-key`/`anthropic-version` headers, system prompt as top-level field (not a message), stray system-role messages filtered, default model fallback | Anthropic's wire format is genuinely different from OpenAI's — this is the highest-risk adapter for subtle bugs |
| 3. Gemini adapter | API key as query param, model in URL path, `role: assistant → model` remapping, `contents`/`parts` body shape | Most different wire format of the three; a missed remap silently produces malformed requests |
| 4. Call graph extraction | Direct call detection, extern/vendor leaf marking, control-flow keyword exclusion, comment stripping | This is what builds the `.dot` call graphs and feeds the diagram prompts — wrong here means wrong diagrams everywhere downstream |
| 5. Vendor path matching | STM32 exclusion patterns, non-exclusion of user code, Windows backslash paths | A false positive here silently drops your code from indexing; a false negative leaks vendor SDK into the knowledge base |
| 6. `.codex` DB round-trip | Write/read fidelity, staleness hash detection, context-string assembly, stats counting | This is the persistent knowledge base — corruption here is invisible until a diagram or chat answer looks wrong |

### 1.3 How the mock model servers work

`test/mockModelServers.cjs` starts real local HTTP servers on `127.0.0.1`
(random free port) shaped like each provider's actual API:

- **OpenAI-shaped**: accepts `POST /v1/chat/completions`, returns
  `{ choices: [{ message: { content } }] }`
- **Anthropic-shaped**: accepts `POST /v1/messages`, returns
  `{ content: [{ type: 'text', text }] }`
- **Gemini-shaped**: accepts `POST /v1beta/models/{model}:generateContent`,
  returns `{ candidates: [{ content: { parts: [{ text }] } }] }`

Each server records every inbound request (method, URL, headers, parsed
body) so the test can assert on exactly what the adapter sent — this is
testing the *real* request-construction and response-parsing code, not a
simulation of it. The only thing being stood in for is the model's
intelligence; the wire protocol is exercised for real.

**Why not test against a real external API?** This sandboxed environment's
network egress is restricted to package registries (npm, PyPI, GitHub) —
it cannot reach `api.openai.com`, `api.anthropic.com`, `openrouter.ai`, or
a developer's local LM Studio instance. Part 2 below covers true
end-to-end testing against a real model on a real machine.

### 1.4 Adding a test for a new provider

If you add a new entry to `PROVIDER_PRESETS` in `src/agent/providers/registry.ts`:

- If it uses the `'openai'` adapter (true for almost everything — see
  registry.ts doc comment), **no new test is needed**; section 1 already
  covers that adapter generically. Just confirm `npm test` still passes.
- If it needs a genuinely new wire format (not OpenAI/Anthropic/Gemini
  shaped), write a new adapter file, a matching mock server function in
  `mockModelServers.cjs`, and a new test section following the pattern of
  sections 1–3.

---

## Part 2 — Manual End-to-End Testing (LM Studio + Qwen)

This validates the full pipeline inside real VS Code against a real
running model. Allow 20–30 minutes for the first full pass.

### 2.1 Prerequisites

- [ ] VS Code with the Codex Intelligence `.vsix` installed
- [ ] `jebbs.plantuml`, `joaompinto.vscode-graphviz` extensions installed
- [ ] LM Studio installed, a Qwen model downloaded (e.g.
      `qwen2.5-coder-7b-instruct`)
- [ ] A small embedded C test project (see 2.2)
- [ ] Universal Ctags installed (optional — the built-in fallback works
      without it, but install it to test the primary path)

### 2.2 Test fixture project

Create a throwaway project so results are predictable:

```
test-project/
├── Core/
│   └── Src/
│       ├── main.c
│       └── uart_driver.c
└── Drivers/
    └── STM32F4xx_HAL_Driver/
        └── Src/
            └── stm32f4xx_hal_uart.c   (stub vendor file)
```

`Core/Src/uart_driver.c`:
```c
#include "stm32f4xx_hal.h"

typedef enum { UART_IDLE, UART_TX, UART_RX, UART_ERROR } uart_state_t;
static uart_state_t state = UART_IDLE;

HAL_StatusTypeDef UART_Transmit(UART_HandleTypeDef *huart, uint8_t *pData, uint16_t size, uint32_t timeout) {
    state = UART_TX;
    HAL_StatusTypeDef status = HAL_UART_Transmit(huart, pData, size, timeout);
    state = (status == HAL_OK) ? UART_IDLE : UART_ERROR;
    return status;
}

void UART_HandleError(void) {
    state = UART_ERROR;
}
```

`Core/Src/main.c`:
```c
#include "uart_driver.h"

int main(void) {
    uint8_t msg[] = "hello\r\n";
    UART_Transmit(&huart2, msg, sizeof(msg), 100);
    while (1) {}
}
```

`Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_uart.c` (stub — content
doesn't matter, only its path matters for the vendor-exclusion test):
```c
HAL_StatusTypeDef HAL_UART_Transmit(UART_HandleTypeDef *h, uint8_t *d, uint16_t s, uint32_t t) { return HAL_OK; }
```

### 2.3 Test cases

#### TC-1 — LM Studio connectivity
1. Open LM Studio, load the Qwen model, start the local server (Developer tab)
2. In VS Code settings: `codex.llmProvider` = `lmstudio`, `codex.llmModel` left blank
3. Run `Codex: Switch LLM provider` → confirm "LM Studio (local)" is selectable and shows in the picker
4. Open the Codex sidebar → DB Status panel
5. **Expect:** "LLM" row shows `LM Studio (local) · (loaded model)` with an `openai` badge

#### TC-2 — Provider quick-switch
1. Run `Codex: Switch LLM provider`
2. **Expect:** picker shows all built-in providers (LM Studio, Ollama, vLLM, OpenRouter, OpenAI, Groq, Together, Mistral, DeepSeek, Anthropic, Gemini, Azure OpenAI, Custom) each with a description/detail line
3. Select a different provider, e.g. "Custom"
4. **Expect:** status sidebar updates immediately (no reload needed) to show the new provider label

#### TC-3 — Vendor exclusion
1. Open the test fixture project (2.2)
2. Confirm `codex.vendorProfile` = `stm32`
3. Run `Codex: Index current file` on `Core/Src/uart_driver.c`
4. **Expect:** `.codex/functions/UART_Transmit.md` and `.codex/functions/UART_HandleError.md` are created
5. **Expect:** no `.codex/functions/HAL_UART_Transmit.md` is ever created (the function is defined inside the excluded `Drivers/STM32F4xx_HAL_Driver/**` path)
6. Open `.codex/functions/UART_Transmit.md` → **expect** `HAL_UART_Transmit` appears in the "Callees" list (the call is recorded) but with no corresponding function page of its own

#### TC-4 — Full rebuild + diagram generation
1. Run `Codex: Rebuild entire knowledge DB`
2. **Expect:** progress notification appears and completes without error
3. **Expect:** `.codex/flows/`, `.codex/states/`, `.codex/sequences/`, `.codex/behaviour/` each contain at least one `.puml` file
4. **Expect:** `.codex/callgraph/uart_driver.dot` exists
5. Open `uart_driver.c`, run `Codex: Show diagram for current file`
6. **Expect:** a PlantUML preview panel opens showing a flow diagram
7. Open `.codex/states/uart_driver.puml` manually
8. **Expect:** the state diagram includes `UART_IDLE`, `UART_TX`, `UART_ERROR` (matching the `uart_state_t` enum) — confirms Qwen correctly detected the explicit FSM rather than falling back to the generic lifecycle template

#### TC-5 — Staleness detection
1. After TC-4, edit `UART_Transmit` in `uart_driver.c` (e.g. add a comment)
2. Save the file
3. Wait ~1 second (debounce) then check the Codex sidebar
4. **Expect:** "DB Status" briefly shows a stale count, then returns to "DB up to date" once the file watcher's auto-index completes
5. **Expect:** `.codex/functions/UART_Transmit.md` frontmatter `sourceHash` has changed and `updated` timestamp is newer

#### TC-6 — Chat sidebar
1. Open the Codex Chat sidebar tab
2. Ask: "What does UART_Transmit do?"
3. **Expect:** a response referencing the function's purpose, mentioning it calls `HAL_UART_Transmit` as an external/vendor call
4. Ask a question with no relevant context, e.g. "What's the capital of France?"
5. **Expect:** the model still responds (the `.codex` context is additive, not restrictive — it doesn't break general queries)

#### TC-7 — Autocomplete
1. In `main.c`, start typing a new line: `UART_`
2. **Expect:** after the 3rd character, IntelliSense shows Codex suggestions tagged with a "Codex" detail label, sorted after clangd's native suggestions
3. **Expect:** suggestions return within ~3 seconds or the dropdown simply doesn't show a Codex entry (graceful timeout, not a hang)

#### TC-8 — Hover
1. Hover over `UART_Transmit` anywhere it's called (e.g. in `main.c`)
2. **Expect:** a hover tooltip shows the signature, purpose, file/line, and side effects — with **no network call** (this reads directly from the `.codex` DB)

#### TC-9 — No API key / no server error handling
1. Switch provider to `openrouter` via `Codex: Switch LLM provider`
2. Leave `codex.llmApiKey` blank and ensure `OPENROUTER_API_KEY` is not set
3. Run `Codex: Index current file`
4. **Expect:** a clear error notification: *"Codex: No API key for OpenRouter..."* — not a silent failure or a generic stack trace
5. Switch back to `lmstudio`, stop the LM Studio server
6. Run `Codex: Index current file`
7. **Expect:** error message explaining LM Studio is unreachable, with the checklist (server running? model loaded? port correct?)

#### TC-10 — Custom provider via settings
1. Add to `settings.json`:
   ```json
   "codex.customProviders": [
     { "id": "my-vllm", "displayName": "My vLLM Box", "baseUrl": "http://192.168.1.50:8000", "model": "qwen2.5-coder-32b" }
   ]
   ```
2. Run `Codex: Switch LLM provider`
3. **Expect:** "My vLLM Box" appears in the picker alongside the built-ins
4. Select it, run `Codex: Index current file`
5. **Expect:** requests go to `http://192.168.1.50:8000/v1/chat/completions` (verify via your vLLM server's request log, or temporarily point `baseUrl` at `http://localhost:<mock-port>` running `test/mockModelServers.cjs` manually for a quick check without a real vLLM box)

#### TC-11 — Vendor profile switch (PIC / NXP)
1. Run `Codex: Switch vendor profile` → select `pic`
2. **Expect:** status sidebar "Vendor" row updates to `pic`
3. Create a dummy file under `mcc_generated_files/foo.c` with a function inside
4. Run `Codex: Rebuild entire knowledge DB`
5. **Expect:** no `.codex/functions/` page is created for that function (PIC profile excludes `mcc_generated_files/**`)

### 2.4 Performance / regression checks

- [ ] Index a file with 30+ functions — confirm it completes without timing out and without the chat/autocomplete becoming unresponsive during indexing (they should queue, not block on the same thread in a way that freezes the UI)
- [ ] Set `codex.maxFilesPerRun` to 2, run a full rebuild on a project with 5+ files — confirm exactly 2 files are processed and the rest are skipped (no error, no partial corruption)
- [ ] Delete `.codex/` entirely, reopen the project, confirm `Codex: Rebuild entire knowledge DB` recreates the full directory structure from scratch

### 2.5 Regression checklist after any provider/settings change

Run this short list any time `registry.ts`, `llmClient.ts`, or the
`package.json` settings schema changes:

- [ ] `npm test` passes (Part 1)
- [ ] TC-1 (LM Studio) still works
- [ ] TC-2 (provider picker) lists all expected providers with no duplicates
- [ ] TC-9 (error handling) still produces clear messages, not raw stack traces
- [ ] Old setting names are gone from `package.json` — no orphaned settings left over from a previous provider scheme

---

## Appendix — Provider coverage matrix

| Provider | Adapter | Auth style | Tested in Part 1 §1–3 | Tested in Part 2 |
|---|---|---|---|---|
| LM Studio | openai | none | ✓ (TC-1 equivalent assertions) | TC-1 |
| Ollama | openai | none | ✓ (shares openai adapter tests) | manual only |
| vLLM / custom | openai | optional bearer | ✓ | TC-10 |
| OpenRouter | openai | bearer + attribution headers | ✓ | manual only |
| OpenAI | openai | bearer | ✓ (shares openai adapter tests) | manual only |
| Groq | openai | bearer | ✓ (shares openai adapter tests) | manual only |
| Together AI | openai | bearer | ✓ (shares openai adapter tests) | manual only |
| Mistral | openai | bearer | ✓ (shares openai adapter tests) | manual only |
| DeepSeek | openai | bearer | ✓ (shares openai adapter tests) | manual only |
| Azure OpenAI | openai (azure branch) | api-key header | ✓ | manual only |
| Anthropic | anthropic | x-api-key + version header | ✓ | manual only |
| Google Gemini | gemini | query-param key | ✓ | manual only |

"Shares openai adapter tests" means the request-building code path is
identical to what section 1 already tests — only the base URL, default
model, and env var name differ, all of which are plain data in
`registry.ts` with no branching logic to test separately.
