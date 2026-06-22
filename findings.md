🔍 DeepSeek Cache Optimization — Review & Validation

### Project Overview

Your project (pi-deepseek-cache) is a pi extension that adds DeepSeek-specific cache optimizations on top of the existing pi agent
framework. It implements four optimization layers:

┌───────┬───────────────────────────────────────────────────┬───────────────────────────┐
│ Layer │ Feature                                           │ Status                    │
├───────┼───────────────────────────────────────────────────┼───────────────────────────┤
│ P0    │ Session fingerprint (date + CWD freeze)           │ ✅ Working correctly      │
├───────┼───────────────────────────────────────────────────┼───────────────────────────┤
│ P1    │ Cache hit rate tracking + TUI overlays            │ ✅ Working correctly      │
├───────┼───────────────────────────────────────────────────┼───────────────────────────┤
│ P2    │ Prefix guard (warn on cache-breaking mutations)   │ ✅ Working correctly      │
├───────┼───────────────────────────────────────────────────┼───────────────────────────┤
│ P3    │ Cache-friendly compaction via flash summarization │ ❌ Broken — runtime crash │
├───────┼───────────────────────────────────────────────────┼───────────────────────────┤
│ P4    │ /cache-stats, /cache-graph, /cache-reset commands │ ✅ Working correctly      │
└───────┴───────────────────────────────────────────────────┴───────────────────────────┘

────────────────────────────────────────────────────────────────────────────────

### 🔴 Critical — Must Fix Before Shipping

extensions/index.ts:728-750 — session_before_compact handler references 5 undefined variables

```typescript
pi.on("session_before_compact", async (event, ctx) => {
   // ...
   const history = serializeConversation(convertToLlm(messagesToSummarize));  // ❌ undefined
   const text = previousSummary                                               // ❌ undefined
     ? `[Previous summary]\n${previousSummary}\n\n[New history]\n${history}`
     : history;
   // ...
   summary = await summarizeWithFlash(text, ctx, signal);  // ❌ signal undefined
   // ...
   return {
     compaction: {
       summary,
       firstKeptEntryId,  // ❌ undefined
       tokensBefore,      // ❌ undefined
     },
   };
});
```

Root cause: The event parameter is never destructured. These variables should come from it.

Fix:

```typescript
pi.on("session_before_compact", async (event, ctx) => {
   const { messagesToSummarize, previousSummary, firstKeptEntryId, tokensBefore, signal } = event;
   // ... rest of handler
});
```

Impact: P3 is the feature that makes compacted summaries cache-stable — the core value proposition. Without this fix, every compaction
will throw ReferenceError and fall back to default (cache-breaking) compaction.

────────────────────────────────────────────────────────────────────────────────

### ⚠️ Warnings — Should Fix

┌────────────────────┬─────────────────────────────┬────────────────────────────────────────────────────────────────────────────────────┐
│ Issue              │ Location                    │ Description                                                                        │
├────────────────────┼─────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ Hardcoded pricing  │ lib/helpers.ts:26-27        │ COST_PER_M_CACHE_READ = 0.027 and COST_PER_M_INPUT = 0.27 are WRONG — these don't  │
│ (WRONG values)     │                             │ match any current DeepSeek tier (see Pricing Investigation below for correct       │
│                    │                             │ values). DeepSeek has no API endpoint for pricing; use cached static fetch.        │
├────────────────────┼─────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ Model-unaware      │ lib/helpers.ts:42-44        │ estimateSavings() uses a single pricing tier. v4-flash and v4-pro have drastically  │
│ savings            │                             │ different prices (see Pricing Investigation). Must accept model name to select      │
│                    │                             │ correct tier, plus output token cost (currently not factored at all).             │
├────────────────────┼─────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ Unbounded summary  │ extensions/index.ts:771-821 │ summaryCache Map grows indefinitely. Add LRU cap (e.g., 500 entries) or clear      │
│ cache              │                             │ stale entries on session start.                                                    │
├────────────────────┼─────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ Startup cleanup    │ extensions/index.ts:80-96   │ cleanupOldSessions() runs readdirSync + statSync per file on every session start.  │
│                    │                             │ Could add noticeable latency with many sessions. Consider lazy/once-per-day        │
│                    │                             │ execution.                                                                         │
├────────────────────┼─────────────────────────────┼────────────────────────────────────────────────────────────────────────────────────┤
│ Synchronous        │ extensions/index.ts:297-325 │ aggregateAllSessions() reads all stats files synchronously during /cache-stats     │
│ aggregation        │                             │ handler. Fine for few sessions, but blocks event loop with hundreds.               │
└────────────────────┴─────────────────────────────┴────────────────────────────────────────────────────────────────────────────────────┘

────────────────────────────────────────────────────────────────────────────────

### 🔬 Pricing Investigation — DeepSeek API Analysis

**Question:** Can we retrieve per-model pricing programmatically from the DeepSeek API?

**Answer: No.** The DeepSeek API has no endpoint that returns per-token pricing.

#### Endpoints Examined

| Endpoint | Returns Pricing? | What It Returns |
|---|---|---|
| `GET /models` | ❌ No | `id`, `object`, `owned_by` — model identifiers only |
| `GET /user/balance` | ❌ No | `is_available`, currency, `total_balance`, `granted_balance`, `topped_up_balance` |
| `POST /chat/completions` | ❌ No | `usage` (tokens consumed per request) but not cost-per-token |

Pricing lives exclusively on the static docs page: https://api-docs.deepseek.com/quick_start/pricing

#### Current Pricing (as of 2026-06-22)

| Model | Cache Hit (/M) | Cache Miss (/M) | Output (/M) |
|---|---|---|---|
| `deepseek-v4-flash` | $0.0028 | $0.14 | $0.28 |
| `deepseek-v4-pro` | $0.003625 | $0.435 | $0.87 |

#### How the Project's Hardcoded Values Compare

| | Project (`lib/helpers.ts`) | Actual (v4-flash) | Actual (v4-pro) |
|---|---|---|---|
| Cache hit | `$0.027/M` | `$0.0028/M` (10x off) | `$0.003625/M` (7.5x off) |
| Cache miss (input) | `$0.27/M` | `$0.14/M` (1.9x off) | `$0.435/M` |
| Output | not modeled ❌ | `$0.28/M` | `$0.87/M` |

**The hardcoded values match neither tier and appear to be stale v2/v3-era pricing.**

#### Recommended Approach

Since no API exists for pricing retrieval:

1. **Fetch + cache the pricing page** (`/quick_start/pricing`) once per 24h; parse HTML for the pricing table. Use stale-while-revalidate.
2. **Hardcoded fallback** in code with a `// Last verified: YYYY-MM-DD` comment — update on each release.
3. **User-configurable override** in extension settings for users who want accurate cost tracking between updates.
4. **Model-aware `estimateSavings()`** — accept `model: string` parameter and select the correct tier, including output token costs.

────────────────────────────────────────────────────────────────────────────────

### ✅ What's Implemented Correctly

1. P0 (Date/CWD Freeze) — Correctly pins session metadata to prevent prefix invalidation from timestamp/CWD changes. Tests confirm
idempotency.

2. P1 (Cache Metrics) — Clean per-session file isolation, debounced disk writes, graceful degradation with try/catch.

3. P2 (Prefix Guard) — Hashes JSON.stringify(msgs.slice(0, -1)) to detect when mutations would break the prefix. Warns user. This aligns
with DeepSeek's prefix-matching behavior (match from position 0).

4. Architecture — Good separation of pure helpers (lib/helpers.ts) from extension runtime. Per-session file isolation avoids race
conditions.

5. Test Coverage — Thorough regex/edge-case tests for date/CWD patterns and freeze logic.

────────────────────────────────────────────────────────────────────────────────

### 📊 Comparison with Reference (DeepSeek-Reasonix)

The reference project (esengine/DeepSeek-Reasonix) is a full AI coding agent built from scratch around DeepSeek cache stability. Your
project is a pi extension — different scope, but here's how the approaches compare:

┌──────────────────────┬─────────────────────────────────────────────────────┬─────────────────────────────────┬────────────────────────┐
│ Concept              │ Reasonix (Reference)                                │ Your Extension                  │ Gap                    │
├──────────────────────┼─────────────────────────────────────────────────────┼─────────────────────────────────┼────────────────────────┤
│ Immutable prefix     │ System prompt + tool specs + few-shots, computed    │ P0 freeze (date/CWD) + P2       │ ✅ Similar approach    │
│                      │ once, hashed & pinned                               │ prefix guard                    │                        │
├──────────────────────┼─────────────────────────────────────────────────────┼─────────────────────────────────┼────────────────────────┤
│ Append-only log      │ Messages serialized in append order, no rewrites    │ Relies on pi's message ordering │ ✅ Delegated to        │
│                      │                                                     │                                 │ framework              │
├──────────────────────┼─────────────────────────────────────────────────────┼─────────────────────────────────┼────────────────────────┤
│ Cache metrics        │ Per-turn + per-session hit rates in TUI top-bar     │ /cache-stats, /cache-graph      │ ✅ Equivalent          │
│                      │                                                     │ overlays                        │                        │
├──────────────────────┼─────────────────────────────────────────────────────┼─────────────────────────────────┼────────────────────────┤
│ Prefix break         │ N/A (hard invariant by design)                      │ P2 warns user when mutations    │ ✅ Good safety net     │
│ detection            │                                                     │ detected                        │                        │
├──────────────────────┼─────────────────────────────────────────────────────┼─────────────────────────────────┼────────────────────────┤
│ Auto-compaction      │ Turn-end compaction of tool results >3000 tokens    │ P3 cache-friendly summarization │ ❌ Currently broken    │
│                      │                                                     │ via flash                       │                        │
├──────────────────────┼─────────────────────────────────────────────────────┼─────────────────────────────────┼────────────────────────┤
│ Cost control         │ Flash-first defaults, model self-report escalation  │ Savings estimation              │ Partial — no           │
│                      │                                                     │                                 │ auto-downgrade         │
├──────────────────────┼─────────────────────────────────────────────────────┼─────────────────────────────────┼────────────────────────┤
│ Tool-call repair     │ Scavenge, flatten, truncation, storm passes         │ Not applicable (pi's            │ N/A                    │
│                      │                                                     │ responsibility)                 │                        │
├──────────────────────┼─────────────────────────────────────────────────────┼─────────────────────────────────┼────────────────────────┤
│ Parallel tool        │ Safety-declared parallel execution                  │ Not applicable                  │ N/A                    │
│ dispatch             │                                                     │                                 │                        │
└──────────────────────┴─────────────────────────────────────────────────────┴─────────────────────────────────┴────────────────────────┘

────────────────────────────────────────────────────────────────────────────────

### 🎯 Recommendations (Priority Order)

1. Fix the critical bug — Destructure event in the session_before_compact handler. This is a 1-line fix that unblocks P3.

2. Make pricing configurable — Accept model tier or pricing parameters in estimateSavings(). At minimum, document the pricing date.

3. Cap the summary cache — Add LRU eviction (500 entries) to prevent memory growth in long-running deployments.

4. Add integration tests — The core extension logic (event handlers, P0/P1/P2/P3/P4) is untested. Consider extracting pure functions from
the extension into lib/ for testability.

5. Consider lazy cleanup — Run cleanupOldSessions() once per day instead of every session start.

────────────────────────────────────────────────────────────────────────────────

### Overall Verdict

CHANGES NEEDED — The project demonstrates solid engineering and good understanding of DeepSeek's prefix cache mechanics. The P0/P1/P2
layers are correct. However, P3 (the cache-friendly compaction) is completely non-functional due to the undefined variable bug. This is
the feature that differentiates the extension from basic cache tracking — it's what makes compacted summaries cache-stable.

Fix the critical bug, then address the pricing/model-awareness gaps, and this will be a solid DeepSeek cache optimization extension.
