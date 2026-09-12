# Codex Intelligence — Context Engine & Multi-Agent Architecture Plan

**Status:** Approved design, implementation not yet started
**Last updated:** 2026-06-20
**Supersedes:** informal discussion across prior sessions (context minimization, Antigravity comparison, transparency manifest, multi-agent routing)

This document is itself written in the style we're proposing for `.codex/decisions/` — context, options considered, decision, consequences — so it doubles as the first worked example of that pattern.

---

## 1. Vision

Codex Intelligence should let an agent (local or cloud) understand a large C/C++ embedded codebase **without** requiring either (a) a context window large enough to hold the whole repo, or (b) the user trusting a black box. Four requirements have accumulated, in order:

| # | Requirement | One-line rationale |
|---|---|---|
| R1 | Minimize context per request | Local models (Qwen via LM Studio) have an 8K–32K window, not Gemini 3's 1M — retrieval is mandatory, not optional |
| R2 | Stay context-*aware* despite minimization | Compressed `.codex` knowledge (function summaries, call graphs, diagrams) stands in for raw source |
| R3 | Coaching, not just autocomplete | Agent should explain trade-offs and methodology, building the user's skill, not just emit code |
| R4 | Full transparency of what the agent read | Antigravity reviews *output* via Artifacts but never discloses *input* context — we explicitly reject that for a correctness-sensitive embedded domain |
| R5 | Multi-agent: one local (unlimited tokens, small context), one cloud (large context, metered tokens) | Future-proofing; only one cloud agent is configured today |

R1–R4 were addressed by the **Context Engine** design (§4.1–4.3). This document adds **R5 — multi-agent orchestration** (§4.4) and reconciles it with everything prior.

## 2. Non-goals

- No browser-in-the-loop automation (Antigravity's Browser surface) — out of scope for an embedded C workflow with no UI to click through
- No vector database / embedding infrastructure in the first phase — a lexical (BM25-style) index over function summaries is the default; embeddings are a documented future upgrade, not a dependency
- No fully autonomous "agents negotiate among themselves" routing — rejected explicitly in §4.4.1
- No requirement for the local agent to be present — the system must work exactly as it does today (single cloud agent) when no local agent is configured

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  EDITOR ENTRY POINTS                                                 │
│  chat sidebar · autocomplete · hover · indexFile · rebuildAll        │
└───────────────────────────────┬───────────────────────────────────-─┘
                                 │
┌────────────────────────────── ▼ ─────────────────────────────────────┐
│  TASK CLASSIFIER                                                       │
│  categorises the request: autocomplete / summarize / draft-diagram /   │
│  review-diagram / explain / coach / synthesize-behaviour               │
│  → emits a (contextRecipe, routingRule) pair from one shared table     │
└───────┬───────────────────────────────────────────────┬──────────────-┘
        │                                                │
┌───────▼─────────────────────────┐   ┌──────────────────▼─────────────-┐
│  CONTEXT ENGINE (R1/R2)          │   │  AGENT ROUTER (R5)               │
│  • call-graph N-hop neighbourhood│   │  • routing table (task→role)     │
│  • lexical relevance index       │   │  • confidence-gated escalation   │
│  • provider-aware token budget   │   │  • local / cloud / both(review)  │
│  → produces a ContextManifest    │   │  → produces an AgentChain        │
└───────┬───────────────────────────┘   └──────────────────┬─────────────┘
        │                                                   │
        └───────────────────────┬───────────────────────────┘
                                 ▼
                  ┌──────────────────────────────┐
                  │  LLM CLIENT (existing)         │
                  │  openai / anthropic / gemini   │
                  │  adapters — now resolves TWO    │
                  │  configs: agents.local, agents.cloud │
                  └───────────────┬────────────────┘
                                  ▼
                  ┌──────────────────────────────┐
                  │  RESPONSE + MANIFEST (R4)      │
                  │  { reply, contextUsed,         │
                  │    agentChain, tokensUsed }    │
                  │  → chat footer / preview cmd /  │
                  │    .codex/decisions/ (if ADR)   │
                  └──────────────────────────────┘
```

The Task Classifier is the single place that decides **both** "how much context" and "which agent" — the same category drives both decisions from one table, avoiding duplicated logic.

---

## 4. Component Designs

### 4.1 Context Engine (R1, R2)

**Retrieval, replacing today's naive "current file + substring name match":**

1. **Call-graph neighbourhood** — walk N hops of callers/callees from the function in focus, using the `.dot` call graph data already produced by `symbolTools.ts` / `callGraphFallback.ts`. N is configurable per task category (e.g. 1 hop for autocomplete, 3 hops for "explain this module").
2. **Lexical relevance index** — a BM25-style index built over each function's `purpose` + `signature` + `sideEffects` strings (not full source). Zero dependency on an embedding model, works with any configured backend, rebuilt incrementally alongside the existing staleness-hash mechanism in `codexDB.ts`.
3. **Provider-aware token budget** — `contextBudgetTokens` resolved per active agent (small default for `lmstudio`/`ollama`/`vllm`, larger for cloud providers with bigger windows), read from the routing table's agent metadata rather than hardcoded.

```ts
interface ContextManifest {
  functions: string[];       // function names included
  diagrams: string[];        // .puml / .dot paths included
  callGraphHops: number;
  tokensUsed: number;
  tokensBudget: number;
  retrievalMethod: 'graph-neighbourhood' | 'lexical' | 'current-file' | 'whole-db';
}
```

### 4.2 Transparency Layer (R4)

- **Chat sidebar footer** — every reply gets a collapsible "📎 Context used (N items)" section listing functions/diagrams, each clickable to open the real `.codex` file.
- **`Codex: Preview context for current file`** — a new command, zero LLM calls, shows exactly what *would* be retrieved. This is the direct rejection of Antigravity's opacity: audit before any model call happens.
- **Diagram-claim linking** — generated state/flow/sequence diagrams note which raw functions/call edges fed them, so a diagram can be checked against its actual inputs rather than trusted blind.
- **Agent attribution (new, for R5)** — the manifest gains an `agentChain` field (see §4.4.4) so the user also sees *which* agent(s) produced the answer, not just what context they read.

### 4.3 Task Classifier

A lightweight categorisation step — heuristic first (keyword/intent matching on the request type and entry point), with the option to escalate to a one-line LLM classification call only when heuristics are ambiguous (and that call always goes to whichever agent is cheapest/local, never cloud, since misclassifying costs nothing but a wasted local call).

| Category | Typical entry point | Context recipe | Default agent role (§4.4) |
|---|---|---|---|
| `autocomplete` | completion provider | current file, 1-hop, tight budget | local only |
| `summarize` | indexFile (per function) | function body only | local only |
| `draft-flow` / `draft-sequence` | indexFile | call graph for the file | local only |
| `draft-state` | indexFile | call graph + existing FSM hints | local draft → cloud review (escalation-gated) |
| `synthesize-behaviour` | rebuildAll | whole-DB function summaries | cloud only |
| `chat-explain` | chat sidebar | graph neighbourhood, 2–3 hops | local first, escalate on budget overflow |
| `chat-coach` | chat sidebar ("how should I implement...") | graph neighbourhood + relevant diagrams | cloud only |
| `adr-draft` | post-change, see §4.6 | the change's manifest + neighbourhood | cloud only |

### 4.4 Multi-Agent Orchestration (R5) — the new piece

#### 4.4.1 Decision: Parent-Child, not free-form auto-routing

**Context.** Two designs were on the table: (a) auto-routing, where the agents themselves decide who handles a request, and (b) parent-child, where the cloud model plans/reviews and the local model executes.

**Options considered:**

- **Free-form auto-routing.** Pros: adapts per-request, not just per-category; could in principle save more cloud spend than a static table. Cons: the routing decision itself becomes invisible context — precisely the opacity problem R4 exists to reject. It also has no clear authority for resolving disagreement between agents, and produces non-reproducible behaviour (the same query could route differently on different days as heuristics drift), which is a poor fit for a correctness-sensitive embedded-systems tool.
- **Strict parent-child (cloud always plans, local always executes).** Pros: simple, fully predictable, fully attributable. Cons: cloud agent gets invoked even for trivial child-only work, wasting metered tokens unnecessarily.
- **Parent-child with deterministic, confidence-gated escalation (chosen).** The local model attempts first for any task marked "local-first" in the routing table. It escalates to the cloud model only when a **deterministic, loggable trigger** fires: output fails to validate (e.g. malformed PlantUML, JSON parse failure), the model's own response indicates low confidence, the task is tagged high-stakes by category (state diagrams — see the hallucination-risk discussion in R4), or the required context exceeds the local agent's token budget. This captures the adaptive cost-saving benefit auto-routing was reaching for, without the opacity: every escalation has a named, inspectable reason surfaced in the manifest.

**Decision.** Parent-child with confidence-gated escalation. The cloud agent is the planner/reviewer; the local agent is the default executor; escalation rules are a configurable table, not emergent agent behaviour.

**Consequences.** Routing is fully deterministic and auditable (satisfies R4). Cloud token spend is bounded and predictable rather than auto-routing's unbounded-but-maybe-lower spend. The routing table is user-editable (§4.4.3), so this is not a rigid hardcoded hierarchy — it's a transparent default that can be tuned.

#### 4.4.2 Roles

| Role | Maps to | Characteristics | Used for |
|---|---|---|---|
| **local** | `lmstudio` / `ollama` / `vllm` (unlimited tokens, small context) | Cheap, fast, narrow-context, high-frequency calls | autocomplete, per-function summarization, single-file diagram drafts |
| **cloud** | any cloud provider already in the registry (anthropic / openai / openrouter / etc.) | Metered, large context, infrequent calls | planning, cross-file review, behaviour synthesis, coaching, ADR drafting |

#### 4.4.3 Settings schema (additive, backward-compatible)

```jsonc
// New: two independent agent slots, replacing the single codex.llmProvider
// going forward. If codex.agents.cloud is unset, codex.llmProvider /
// codex.llmApiKey / codex.llmBaseUrl / codex.llmModel are used as-is —
// zero breaking change for the current single-agent install.
"codex.agents": {
  "local": {
    "provider": "lmstudio",        // any registry id with requiresKey:false typically
    "baseUrl": "",                  // override; blank = preset default
    "model": "",                    // blank = whatever LM Studio has loaded
    "contextBudgetTokens": 6000
  },
  "cloud": {
    "provider": "anthropic",        // or openrouter / openai / google-gemini / etc.
    "apiKey": "",                   // blank = env var fallback, same as today
    "model": "",                    // blank = provider default
    "contextBudgetTokens": 40000
  }
},

// Editable routing table — overrides the defaults in §4.3 per category.
// Omit a category to keep its default.
"codex.routingTable": {
  "draft-state": { "primary": "local", "escalateTo": "cloud", "escalateWhen": "always-if-cloud-configured" },
  "chat-explain": { "primary": "local", "escalateTo": "cloud", "escalateWhen": "budget-exceeded" }
}
```

**Graceful degradation.** If `codex.agents.local` is unset (today's reality), every routing-table entry that names `local` silently falls back to `cloud` — the system behaves exactly as it does in the currently shipped `.vsix`, with no behaviour change required to adopt this plan immediately.

#### 4.4.4 Manifest extension

```ts
interface AgentChain {
  steps: Array<{
    role: 'local' | 'cloud';
    providerId: string;        // e.g. 'lmstudio', 'anthropic'
    purpose: 'draft' | 'review' | 'plan' | 'execute';
    escalationReason?: string; // present only if this step is an escalation
  }>;
}
```

Surfaced in the chat footer alongside the existing `ContextManifest`, e.g.:
`📎 Context used (3 items) · 🤖 qwen-local (draft) → claude-sonnet-cloud (review: state-diagram high-stakes)`

#### 4.4.5 Orchestration flow (parent-child with escalation)

1. Task Classifier emits `{ category, contextRecipe, routingRule }`.
2. Context Engine assembles a `ContextManifest` sized to the **primary** agent's budget.
3. Primary agent (per routing table — local unless unconfigured) executes.
4. Escalation check runs against the rule for that category:
   - `always-if-cloud-configured` → always escalate when a cloud agent exists
   - `budget-exceeded` → escalate only if the full context recipe didn't fit the local budget
   - `validation-failure` → escalate only if local output fails a syntactic check (PlantUML parse, JSON parse)
   - `never` → local-only categories (autocomplete) never escalate, regardless of cloud availability
5. If escalating, the cloud agent receives the local draft **plus** its own (larger) context allowance, and either approves or revises it.
6. Final response carries the full `AgentChain` and `ContextManifest`.

### 4.5 Coach Mode (R3)

Unchanged from the prior design, now explicitly assigned to the **cloud** role in the routing table (`chat-coach` category) — judgment/methodology discussions are exactly the case for the larger model, consistent with §4.4.1's reasoning.

### 4.6 ADR Log (R4, ties to R3)

`.codex/decisions/*.md`, auto-drafted by the **cloud** agent (`adr-draft` category) after any non-trivial chat-driven change — context, options considered, decision, consequences. This document is the first hand-written instance of that exact format.

---

## 5. Data Model / File Layout Changes

```
.codex/
├── vendor.json                  (existing)
├── functions/*.md                (existing)
├── flows/ states/ sequences/     (existing)
├── behaviour/*.puml              (existing)
├── callgraph/*.dot               (existing)
└── decisions/                    (NEW — §4.6)
    └── 2026-06-20-uart-timeout-strategy.md
```

No new persistent files are needed for the Context Manifest or Agent Chain — both are ephemeral, computed per-request and shown in the chat UI / preview command output. Persisting them would clutter the repo for no durable benefit; the ADR log is the durable artifact that matters.

---

## 6. Implementation Roadmap

| Phase | Scope | Depends on | Breaking? |
|---|---|---|---|
| **Phase 0** (done) | Single-agent provider registry (`openai`/`anthropic`/`gemini` adapters), `.codex` DB, vendor profiles, chat/autocomplete/hover | — | — |
| **Phase 1** | Context Engine: call-graph neighbourhood retrieval, lexical index, `ContextManifest`, chat footer, `Codex: Preview context` command | Phase 0 | No |
| **Phase 2** | Task Classifier + shared routing/context-recipe table (single-agent only — routes everything to the one configured agent, but the table/category plumbing is in place) | Phase 1 | No |
| **Phase 3** | Multi-agent: `codex.agents.local` / `codex.agents.cloud` settings, Agent Router, confidence-gated escalation, `AgentChain` in manifest | Phase 2 | No (degrades to Phase 2 behaviour when local agent unset) |
| **Phase 4** | Coach Mode wired to `chat-coach` category | Phase 3 | No |
| **Phase 5** | ADR Log auto-drafting | Phase 3 | No |

Each phase is independently shippable and backward-compatible — at every step, a user with only `codex.llmProvider` set (today's config) continues to work unchanged.

---

## 7. Open Questions

- Should the lexical index be persisted (`.codex/index.json`) or rebuilt in-memory on activation? Leaning persisted, keyed by the same source-hash staleness mechanism already used for function pages.
- Escalation rule `validation-failure` requires a real PlantUML syntax check, not just "did it start with `@startuml`" — needs either a local parser or a call to the `jebbs.plantuml` extension's validation if exposed.
- Should `chat-explain` escalation be visible *before* it happens (asking the user "this needs the cloud agent, proceed?") or only disclosed *after* in the manifest? Current lean: disclose after, to avoid interrupting flow, but make the routing table's `escalateWhen` rules adjustable per user risk tolerance.

---

## 8. Appendix — File Map for Implementation

| New/changed file | Purpose |
|---|---|
| `src/context/contextEngine.ts` | Call-graph neighbourhood + lexical index + manifest assembly |
| `src/context/lexicalIndex.ts` | BM25-style index over function summaries |
| `src/context/taskClassifier.ts` | Category detection + shared routing/recipe table |
| `src/agent/agentRouter.ts` | Resolves `codex.agents.local`/`cloud`, applies routing table, escalation logic |
| `src/agent/llmClient.ts` | *(existing, extended)* — now resolves two configs instead of one |
| `src/db/codexDB.ts` | *(existing, extended)* — add `decisions/` directory support |
| `src/webview/chatViewProvider.ts` | *(existing, extended)* — render manifest + agent-chain footer |
| `src/extension.ts` | *(existing, extended)* — register `Codex: Preview context for current file` |
| `package.json` | New settings: `codex.agents`, `codex.routingTable` |
