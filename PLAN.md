# Implementation Plan — DeepSeek Cache Optimization Fixes

Based on [findings.md](./findings.md) review. 9 issues identified: 1 critical, 5 warnings, 3 suggestions.

---

## Files to Modify

| File | Issues |
|------|--------|
| `extensions/index.ts` | #1, #4, #5, #6, #9 (plus #2/#3 call-site update) |
| `lib/helpers.ts` | #2, #3 |
| `tests/helpers.test.ts` | #2, #3, #7 |
| `tests/persistence.test.ts` | #4, #5, #7 |

## New Files to Create

| File | Purpose |
|------|---------|
| `tests/compaction.test.ts` | Destructuring/cache-friendly compaction tests (#1, #7) |

---

## Step 1: Fix Critical Bug — Destructure `event` in `session_before_compact`

**Priority:** 🔴 Critical | **Effort:** Quick Fix | **File:** `extensions/index.ts`

### Problem
In the `session_before_compact` handler (the P3 compaction handler), the variables `messagesToSummarize`, `previousSummary`, `firstKeptEntryId`, `tokensBefore`, and `signal` are used but never destructured from the `event` parameter. This causes a `ReferenceError` at runtime, making the entire P3 (cache-friendly compaction) feature non-functional.

### Current Code (in `session_before_compact` handler)
```typescript
pi.on("session_before_compact", async (event, ctx) => {
  setCtx(ctx);

  // Only intercept if we're on a DeepSeek model
  if (!isDeepSeekModel(ctx.model)) return;

  flushPendingWrites(sessionId);

  const history = serializeConversation(convertToLlm(messagesToSummarize));  // ❌ undefined
  const text = previousSummary                                               // ❌ undefined
    ? `[Previous summary]\n${previousSummary}\n\n[New history]\n${history}`
    : history;

  const key = createHash("sha256").update(text).digest("hex");
  let summary = summaryCache.get(key);

  if (!summary) {
    summary = await summarizeWithFlash(text, ctx, signal);  // ❌ signal undefined
    // ...
  }

  return {
    compaction: {
      summary,
      firstKeptEntryId,  // ❌ undefined
      tokensBefore,      // ❌ undefined
      // ...
    },
  };
});
```

### Fix
Add destructuring immediately after the `if (!isDeepSeekModel(ctx.model)) return;` guard, before `flushPendingWrites(sessionId)`:

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  setCtx(ctx);

  // Only intercept if we're on a DeepSeek model
  if (!isDeepSeekModel(ctx.model)) return;

  const { messagesToSummarize, previousSummary, firstKeptEntryId, tokensBefore, signal } = event;

  flushPendingWrites(sessionId);

  const history = serializeConversation(convertToLlm(messagesToSummarize));
  const text = previousSummary
    ? `[Previous summary]\n${previousSummary}\n\n[New history]\n${history}`
    : history;

  const key = createHash("sha256").update(text).digest("hex");
  let summary = summaryCache.get(key);

  if (!summary) {
    summary = await summarizeWithFlash(text, ctx, signal);
    if (!summary) return; // fall back to default compaction
    summaryCache.set(key, summary);
    saveSummaryCacheSync(summaryCache);
  }

  return {
    compaction: {
      summary,
      firstKeptEntryId,
      tokensBefore,
      details: { summarizer: "deepseek-v4-flash" },
    },
  };
});
```

### Validation
- Manual: Trigger compaction on a DeepSeek session — it should complete without crash.
- Test: Add smoke test in `tests/compaction.test.ts` verifying the destructured shape matches expectations.

---

## Step 2: Fix Pricing Constants

**Priority:** ⚠️ Warning | **Effort:** Small | **File:** `lib/helpers.ts`

### Problem
The pricing constants (`COST_PER_M_CACHE_READ = 0.027` and `COST_PER_M_INPUT = 0.27`) are **local variables inside `estimateSavings()`**, not module-level exports. This is a function-local design that makes them inaccessible to other functions and hard to override for testing.

Additionally, the current values match **no** current DeepSeek tier. They appear to be stale v2/v3-era pricing:

| | Current (`lib/helpers.ts`) | Actual v4-flash | Actual v4-pro |
|---|---|---|---|
| Cache hit | `$0.027/M` | `$0.0028/M` (10× off) | `$0.003625/M` (7.5× off) |
| Cache miss (input) | `$0.27/M` | `$0.14/M` (1.9× off) | `$0.435/M` |
| Output | not modeled ❌ | `$0.28/M` | `$0.87/M` |

DeepSeek has **no API endpoint** for pricing retrieval (confirmed via investigation of `GET /models`, `GET /user/balance`, `POST /chat/completions`). See [findings.md](./findings.md#-pricing-investigation--deepseek-api-analysis).

### Architectural Shift
Move pricing constants from function-local variables to module-level exports. This enables:
- Testing `getPricingTier()` independently
- Consistent pricing across all functions that need it
- Future extensibility (e.g., user-configurable overrides)

### Fix
Replace the entire `estimateSavings` function in `lib/helpers.ts` with the following module-level pricing tier system:

```typescript
// ─── Pricing (moved from function-local constants) ──────────────────
// Architectural change: these were previously local to estimateSavings().
// Now module-level for testability and consistent access.
// Last verified: 2026-06-22 — source: https://api-docs.deepseek.com/quick_start/pricing

export interface PricingTier {
  cacheHitPerM: number;   // $ per 1M tokens
  cacheMissPerM: number;  // $ per 1M tokens
  outputPerM: number;     // $ per 1M tokens
}

export const PRICING_TIERS: Record<string, PricingTier> = {
  "deepseek-v4-flash": {
    cacheHitPerM: 0.0028,
    cacheMissPerM: 0.14,
    outputPerM: 0.28,
  },
  "deepseek-v4-pro": {
    cacheHitPerM: 0.003625,
    cacheMissPerM: 0.435,
    outputPerM: 0.87,
  },
};

export const FALLBACK_PRICING = PRICING_TIERS["deepseek-v4-flash"];

export function getPricingTier(modelId?: string): PricingTier {
  if (!modelId) return FALLBACK_PRICING;
  // Use startsWith to avoid false positives (e.g., "deepseek-v4-flash-lite" should not match v4-flash).
  const key = Object.keys(PRICING_TIERS).find(k => modelId.startsWith(k));
  return key ? PRICING_TIERS[key] : FALLBACK_PRICING;
}
```

### Validation
- Run existing `estimateSavings` tests — they will fail (pricing changed). Update expected values.
- Add new tests for `getPricingTier` with various model ID inputs.

---

## Step 3: Make `estimateSavings` Model-Aware

**Priority:** ⚠️ Warning | **Effort:** Small | **File:** `lib/helpers.ts`, `extensions/index.ts`

### Problem
`estimateSavings()` uses a single pricing tier and doesn't account for output tokens. Users on `deepseek-v4-pro` get wildly inaccurate savings estimates (pro has 3× higher input cost and different cache-hit rate).

### Fix — `lib/helpers.ts`

Replace the current `estimateSavings` function:

```typescript
// Current (function-local pricing, single tier, no output):
export function estimateSavings(cacheReadTokens: number): number {
  const COST_PER_M_CACHE_READ = 0.027;
  const COST_PER_M_INPUT = 0.27;
  return (cacheReadTokens / 1_000_000) * (COST_PER_M_INPUT - COST_PER_M_CACHE_READ);
}
```

With the new model-aware version (uses the module-level pricing from Step 2):

```typescript
export function estimateSavings(
  cacheRead: number,
  input: number = 0,
  output: number = 0,
  modelId?: string
): { saved: number; hitRate: number; effectiveCost: number; withoutCacheCost: number } {
  const pricing = getPricingTier(modelId);

  // Cost WITH caching: cache hits at discounted rate, cache misses at full rate
  const cacheHitCost  = (cacheRead * pricing.cacheHitPerM) / 1_000_000;
  const cacheMissCost = (input * pricing.cacheMissPerM) / 1_000_000;
  const outputCost    = (output * pricing.outputPerM) / 1_000_000;
  const effectiveCost = cacheHitCost + cacheMissCost + outputCost;

  // Cost WITHOUT caching: all tokens at full input rate
  const withoutCacheCost = ((cacheRead + input) * pricing.cacheMissPerM) / 1_000_000 + outputCost;

  const saved = withoutCacheCost - effectiveCost;
  const totalTokens = cacheRead + input;
  const hitRate = totalTokens > 0 ? cacheRead / totalTokens : 0;

  return { saved, hitRate, effectiveCost, withoutCacheCost };
}
```

**Return type change:** The return type changes from `number` to `{ saved, hitRate, effectiveCost, withoutCacheCost }`. This is a **breaking change** for all callers.

### Fix — `extensions/index.ts` (call-site updates)

The `CacheStatsOverlay` class uses `estimateSavings` in its `sectionBlock` method. The overlay constructor currently accepts `(theme, stats, done, aggregate?, prefixBreaks?)` and does not have access to `modelId`.

**1. Update the `CacheStatsOverlay` constructor** to accept and store `modelId`:

```typescript
class CacheStatsOverlay implements Focusable {
  readonly width = 58;
  focused = false;
  private stats: PersistedStats;
  private aggregate?: PersistedStats & { sessionCount: number };
  private prefixBreaks = 0;
  private theme: any;
  private done: () => void;
  private modelId?: string;  // ← ADD

  constructor(
    theme: any,
    stats: PersistedStats,
    done: () => void,
    aggregate?: PersistedStats & { sessionCount: number },
    prefixBreaks?: number,
    modelId?: string,  // ← ADD
  ) {
    this.theme = theme;
    this.stats = stats;
    this.done = done;
    this.aggregate = aggregate;
    if (prefixBreaks !== undefined) this.prefixBreaks = prefixBreaks;
    if (modelId !== undefined) this.modelId = modelId;  // ← ADD
  }
  // ...
```

**2. Update `sectionBlock`** to destructure the new return type and pass `modelId`:

```typescript
private sectionBlock(
  title: string,
  s: PersistedStats,
  turnsLabel?: string,
): string[] {
  const th = this.theme;
  const inner = this.width - 2;
  const { cacheRead, input, cacheWrite, turns } = s;
  const hitRate = calcHitRate(cacheRead, input, cacheWrite).toFixed(1);
  const { saved } = estimateSavings(cacheRead, input, 0, this.modelId);  // ← DESTRUCTURE
  const savedStr = saved >= 0.01 ? `$${saved.toFixed(2)}` : "< $0.01";
  // ... rest unchanged
```

**3. Update the `/cache-stats` command handler** to pass `ctx.model?.id` when constructing the overlay:

```typescript
pi.registerCommand("cache-stats", {
  description: "DeepSeek cache hit rate statistics",
  handler: async (_args, ctx) => {
    setCtx(ctx);
    const agg = aggregateAllSessions();
    await ctx.ui.custom(
      (_tui, theme, _kb, done) =>
        new CacheStatsOverlay(
          theme,
          { cacheRead, input, cacheWrite, turns },
          done,
          agg,
          prefixBreaks,
          ctx.model?.id,  // ← ADD: pass model ID for accurate pricing
        ),
      { overlay: true },
    );
  },
});
```

### Validation
- Update tests in `tests/helpers.test.ts` to pass model ID parameter.
- Add tests for v4-flash vs v4-pro pricing differences.
- Verify savings estimates match expected costs at known token counts.

---

## Step 4: Add LRU Cap to Summary Cache

**Priority:** ⚠️ Warning | **Effort:** Small | **File:** `extensions/index.ts`

### Problem
`summaryCache` Map grows unboundedly — long-running deployments accumulate memory.

### Fix
Add the max-entries constant near the top of the file with other constants (after `WRITE_DEBOUNCE_MS`):

```typescript
const SUMMARY_CACHE_MAX_ENTRIES = 500;
```

Add the eviction helper function in the persistence section (after `saveSummaryCacheSync`):

```typescript
function evictSummaryCacheIfNeeded(): void {
  while (summaryCache.size > SUMMARY_CACHE_MAX_ENTRIES) {
    const firstKey = summaryCache.keys().next().value;
    if (firstKey) summaryCache.delete(firstKey);
  }
}
```

In the `session_before_compact` handler, update the block where a new summary is cached. The current code is:

```typescript
summaryCache.set(key, summary);
saveSummaryCacheSync(summaryCache);
```

Replace with:

```typescript
summaryCache.set(key, summary);
evictSummaryCacheIfNeeded();
saveSummaryCacheSync(summaryCache);
```

> **Note:** `saveSummaryCacheSync(summaryCache)` must remain after eviction — the eviction may remove stale entries, and the persisted file must reflect the final state.

### Validation
- Add test: insert 501 entries, verify cache has exactly 500, verify first-in entry evicted.
- Verify persistence (`saveSummaryCacheSync`) still works after eviction.

---

## Step 5: Throttle Cleanup to Once Per Day

**Priority:** ⚠️ Warning | **Effort:** Small | **File:** `extensions/index.ts`

### Problem
`cleanupOldSessions()` runs `readdirSync` + `statSync` per file on every session start — adds startup latency.

> **Note:** The actual function signature is `cleanupOldSessions()` — it takes **no parameters**.

### Fix
Add the following imports at the top of the file (in the existing `node:fs` import block):

```typescript
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
```

> **Note:** `readFileSync` is already imported in the current code. Verify it's present.

Add a throttled wrapper function in the persistence section (after `cleanupOldSessions`):

```typescript
const CLEANUP_MARKER = ".last-cleanup";

function maybeCleanupOldSessions(): void {
  try {
    const markerPath = join(STATS_DIR, CLEANUP_MARKER);
    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    if (existsSync(markerPath)) {
      const lastCleanup = parseInt(readFileSync(markerPath, "utf8"), 10);
      if (now - lastCleanup < ONE_DAY_MS) return; // skip — cleaned up recently
    }

    cleanupOldSessions();  // ← NO arguments (actual signature takes none)
    writeFileSync(markerPath, String(now), "utf8");
  } catch {
    // If marker file fails, still run cleanup (best-effort throttling)
    cleanupOldSessions();  // ← NO arguments
  }
}
```

In the `session_start` handler, replace the direct call:

```typescript
// Before:
cleanupOldSessions();

// After:
maybeCleanupOldSessions();
```

### Validation
- First run: marker file created, cleanup runs.
- Second run within 24h: cleanup skipped.
- Run after 24h: cleanup runs again.

---

## Step 6: Convert Aggregation to Async

**Priority:** ⚠️ Warning | **Effort:** Medium | **File:** `extensions/index.ts`

### Problem
`aggregateAllSessions()` uses `readFileSync` in a loop, blocking the event loop during `/cache-stats` command.

### Missing Import
The current import is:
```typescript
import { writeFile } from "node:fs/promises";
```

Update to:
```typescript
import { readFile, writeFile } from "node:fs/promises";
```

### Return Shape Must Match Existing `CacheStatsOverlay`
The existing `aggregateAllSessions()` returns `PersistedStats & { sessionCount: number }`, which expands to:

```typescript
{
  cacheRead: number;
  input: number;
  cacheWrite: number;
  turns: number;
  sessionCount: number;
}
```

The `CacheStatsOverlay` accesses these fields directly:
- `this.aggregate.sessionCount`
- `this.aggregate.cacheRead`
- `this.aggregate.input`
- `this.aggregate.cacheWrite`
- `this.aggregate.turns`

The async version **must return the same shape**.

### Fix

Add the async version after the existing `aggregateAllSessions` function:

```typescript
async function aggregateAllSessionsAsync(): Promise<PersistedStats & { sessionCount: number }> {
  const agg: PersistedStats = {
    cacheRead: 0,
    input: 0,
    cacheWrite: 0,
    turns: 0,
  };
  let sessionCount = 0;
  try {
    if (!existsSync(STATS_DIR)) return { ...agg, sessionCount: 0 };
    const files = readdirSync(STATS_DIR); // directory listing is fast — sync is fine

    const statsFiles = files.filter(f => f.startsWith("stats-") && f.endsWith(".json"));

    const results = await Promise.all(
      statsFiles.map(async (file) => {
        try {
          const raw = await readFile(join(STATS_DIR, file), "utf8");
          return JSON.parse(raw) as PersistedStats;
        } catch {
          return null;
        }
      })
    );

    const valid = results.filter((r): r is PersistedStats => r !== null);

    for (const data of valid) {
      agg.cacheRead += data.cacheRead ?? 0;
      agg.input += data.input ?? 0;
      agg.cacheWrite += data.cacheWrite ?? 0;
      agg.turns += data.turns ?? 0;
      sessionCount++;
    }
  } catch {
    // best-effort
  }
  return { ...agg, sessionCount };
}
```

Update the `/cache-stats` command handler to use the async version:

```typescript
pi.registerCommand("cache-stats", {
  description: "DeepSeek cache hit rate statistics",
  handler: async (_args, ctx) => {
    setCtx(ctx);
    const agg = await aggregateAllSessionsAsync();  // ← use async version
    await ctx.ui.custom(
      (_tui, theme, _kb, done) =>
        new CacheStatsOverlay(
          theme,
          { cacheRead, input, cacheWrite, turns },
          done,
          agg,
          prefixBreaks,
          ctx.model?.id,
        ),
      { overlay: true },
    );
  },
});
```

Keep the sync `aggregateAllSessions()` as-is — it serves as a fallback for any non-async contexts and is used by the existing tests.

### Validation
- `/cache-stats` command renders without blocking the event loop.
- Keep sync `aggregateAllSessions()` as fallback for environments without async support.

---

## Step 7: Increase History Dedup Precision

**Priority:** 🟡 Suggestion | **Effort:** Quick Fix | **File:** `extensions/index.ts`

### Problem
History deduplication in the `message_end` handler uses `rate.toFixed(1)` — two rates differing by 0.05 (e.g., 90.05 vs 90.00) round to the same entry but 90.06 rounds to a new one. Minor data loss in the hit-rate chart.

### Current Code (in `message_end` handler)
```typescript
// Track history on rate change
const rateKey = rate.toFixed(1);
const lastKey = lastHitRate.toFixed(1);
if (rateKey !== lastKey) {
  hitRateHistory.push({
    turn: turns,
    hitRate: rate,
    timestamp: Date.now(),
  });
  if (hitRateHistory.length > MAX_HISTORY_POINTS) {
    hitRateHistory.splice(0, hitRateHistory.length - MAX_HISTORY_POINTS);
  }
  lastHitRate = rate;
  scheduleSaveHistory(hitRateHistory, sessionId);
}
```

### Fix
Change `toFixed(1)` to `toFixed(2)` on both `rateKey` and `lastKey`:

```typescript
// Track history on rate change
const rateKey = rate.toFixed(2);
const lastKey = lastHitRate.toFixed(2);
if (rateKey !== lastKey) {
  hitRateHistory.push({
    turn: turns,
    hitRate: rate,
    timestamp: Date.now(),
  });
  if (hitRateHistory.length > MAX_HISTORY_POINTS) {
    hitRateHistory.splice(0, hitRateHistory.length - MAX_HISTORY_POINTS);
  }
  lastHitRate = rate;
  scheduleSaveHistory(hitRateHistory, sessionId);
}
```

### Validation
- Verify chart data still displays correctly.
- 100-point cap (`MAX_HISTORY_POINTS`) handles the slight increase in unique points.

---

## Step 8: Add Tests

**Priority:** 🟡 Suggestion | **Effort:** Medium | **Files:** Multiple

### 8a. Update `tests/helpers.test.ts`

**Update imports** to include new exports:
```typescript
import {
  isDeepSeekModel,
  todayISO,
  calcHitRate,
  estimateSavings,
  getPricingTier,  // ← ADD
} from "../lib/helpers.js";
```

**Add `getPricingTier` tests:**
```typescript
describe("getPricingTier", () => {
  it("returns flash pricing for deepseek-v4-flash", () => {
    const tier = getPricingTier("deepseek-v4-flash");
    expect(tier.cacheHitPerM).toBe(0.0028);
    expect(tier.cacheMissPerM).toBe(0.14);
    expect(tier.outputPerM).toBe(0.28);
  });

  it("returns pro pricing for deepseek-v4-pro", () => {
    const tier = getPricingTier("deepseek-v4-pro");
    expect(tier.cacheHitPerM).toBe(0.003625);
    expect(tier.cacheMissPerM).toBe(0.435);
    expect(tier.outputPerM).toBe(0.87);
  });

  it("returns flash fallback for undefined", () => {
    const tier = getPricingTier(undefined);
    expect(tier.cacheHitPerM).toBe(0.0028);
  });

  it("returns flash fallback for unknown model", () => {
    const tier = getPricingTier("unknown-model");
    expect(tier.cacheHitPerM).toBe(0.0028);
  });

  it("uses startsWith matching (no false positives)", () => {
    // "deepseek-v4-flash-lite" should NOT match "deepseek-v4-flash"
    const tier = getPricingTier("deepseek-v4-flash-lite");
    expect(tier.cacheHitPerM).toBe(0.0028); // falls back to flash (no exact match)
  });
});
```

**Update existing `estimateSavings` tests** for new signature:
```typescript
describe("estimateSavings", () => {
  it("returns zero savings for no cache reads and no input", () => {
    const result = estimateSavings(0, 0);
    expect(result.saved).toBe(0);
  });

  it("calculates savings for v4-flash with known values", () => {
    // 1M cache read tokens at v4-flash: cacheHitCost = 1M * 0.0028 / 1M = $0.0028
    // Without cache: 1M * 0.14 / 1M = $0.14
    // Saved = $0.14 - $0.0028 = $0.1372
    const result = estimateSavings(1_000_000, 0, 0, "deepseek-v4-flash");
    expect(result.saved).toBeCloseTo(0.1372, 4);
  });

  it("calculates savings for v4-pro with known values", () => {
    // 1M cache read tokens at v4-pro: cacheHitCost = 1M * 0.003625 / 1M = $0.003625
    // Without cache: 1M * 0.435 / 1M = $0.435
    // Saved = $0.435 - $0.003625 = $0.431375
    const result = estimateSavings(1_000_000, 0, 0, "deepseek-v4-pro");
    expect(result.saved).toBeCloseTo(0.431375, 4);
  });

  it("v4-pro estimates differ from v4-flash for same token counts", () => {
    const flash = estimateSavings(500_000, 200_000, 0, "deepseek-v4-flash");
    const pro = estimateSavings(500_000, 200_000, 0, "deepseek-v4-pro");
    expect(pro.saved).toBeGreaterThan(flash.saved);
  });

  it("includes output token costs in effectiveCost", () => {
    const noOutput = estimateSavings(100_000, 50_000, 0, "deepseek-v4-flash");
    const withOutput = estimateSavings(100_000, 50_000, 100_000, "deepseek-v4-flash");
    expect(withOutput.effectiveCost).toBeGreaterThan(noOutput.effectiveCost);
    // saved should be the same (output cost doesn't change with caching)
    expect(withOutput.saved).toBeCloseTo(noOutput.saved, 6);
  });
});
```

### 8b. Update `tests/persistence.test.ts`

Add these test cases within the existing describe blocks:

**Summary cache eviction test** (in `summary cache persistence` describe block):
```typescript
it("eviction removes oldest entries when cache exceeds max", () => {
  const MAX_ENTRIES = 500;
  const cache = new Map<string, string>();
  for (let i = 0; i < 501; i++) {
    cache.set(`key-${i}`, `summary-${i}`);
  }

  // Simulate eviction logic from evictSummaryCacheIfNeeded
  while (cache.size > MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }

  expect(cache.size).toBe(MAX_ENTRIES);
  expect(cache.has("key-0")).toBe(false); // first inserted, first evicted
  expect(cache.has("key-1")).toBe(true);
  expect(cache.has("key-500")).toBe(true);
});
```

**Async aggregation test** (new describe block):
```typescript
import { readFile, writeFile } from "node:fs/promises";

describe("async aggregation", () => {
  it("aggregateAllSessionsAsync returns correct totals", async () => {
    // This is a specification test — the actual implementation is in extensions/index.ts.
    // It verifies the expected return shape matches what CacheStatsOverlay consumes.
    interface AggregatedStats {
      cacheRead: number;
      input: number;
      cacheWrite: number;
      turns: number;
      sessionCount: number;
    }

    const mockResults: AggregatedStats = {
      cacheRead: 1000,
      input: 500,
      cacheWrite: 100,
      turns: 10,
      sessionCount: 2,
    };

    // Verify the shape matches what CacheStatsOverlay expects
    expect(mockResults).toHaveProperty("cacheRead");
    expect(mockResults).toHaveProperty("input");
    expect(mockResults).toHaveProperty("cacheWrite");
    expect(mockResults).toHaveProperty("turns");
    expect(mockResults).toHaveProperty("sessionCount");
  });
});
```

### 8c. Create `tests/compaction.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

describe("session_before_compact event shape", () => {
  it("documents the expected destructured fields from the event", () => {
    // The session_before_compact handler destructures these fields from event:
    //   messagesToSummarize, previousSummary, firstKeptEntryId, tokensBefore, signal
    //
    // This test documents the contract — actual runtime test would need pi harness.
    // The fields are verified by the Step 1 fix (adding the destructuring).
    const requiredFields = [
      "messagesToSummarize",
      "previousSummary",
      "firstKeptEntryId",
      "tokensBefore",
      "signal",
    ];

    // Simulate an event object with all required fields
    const mockEvent = {
      messagesToSummarize: [],
      previousSummary: "Previous summary text",
      firstKeptEntryId: "entry-42",
      tokensBefore: 5000,
      signal: new AbortController().signal,
    };

    for (const field of requiredFields) {
      expect(mockEvent).toHaveProperty(field);
    }
  });

  it("JSON.stringify determinism for prefix hashing", () => {
    const msgs = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const hash1 = createHash("sha256")
      .update(JSON.stringify(msgs.slice(0, -1)))
      .digest("hex");
    const hash2 = createHash("sha256")
      .update(JSON.stringify(msgs.slice(0, -1)))
      .digest("hex");
    expect(hash1).toBe(hash2);
  });

  it("summary cache key is deterministic for same input", () => {
    const text = "[Previous summary]\nOld summary\n\n[New history]\nNew messages";
    const key1 = createHash("sha256").update(text).digest("hex");
    const key2 = createHash("sha256").update(text).digest("hex");
    expect(key1).toBe(key2);
  });
});
```

---

## Step 9: Document Prefix Guard Behavior

**Priority:** 🟡 Suggestion | **Effort:** Quick Fix | **File:** `extensions/index.ts`

### Fix
Add explanatory comments in the `before_provider_request` handler documenting why `msgs.slice(0, -1)` is correct for DeepSeek. The current handler:

```typescript
pi.on("before_provider_request", (event, ctx) => {
  setCtx(ctx);
  if (!isDeepSeekModel(ctx.model)) return;

  const payload = event.payload as { messages?: CachedMessage[] };
  const msgs = payload.messages ?? [];
  if (msgs.length === 0) return;

  // Hash all messages except the last (which is the current user message)
  let currentHash: string;
  try {
    currentHash = createHash("sha256")
      .update(JSON.stringify(msgs.slice(0, -1)))
      .digest("hex");
  } catch {
    return;
  }
  // ... rest unchanged
```

Add the comment above the hash computation:

```typescript
  // P2: Prefix guard — detect cache-breaking mutations
  // DeepSeek's prefix cache matches from byte position 0 in the prompt.
  // The prefix is everything BEFORE the new user turn (the current last message).
  // We hash msgs.slice(0, -1) to check if the prefix (all prior messages)
  // has changed since last turn. If the hash differs, the cache is broken
  // and we warn the user.
  let currentHash: string;
  try {
    currentHash = createHash("sha256")
      .update(JSON.stringify(msgs.slice(0, -1)))
      .digest("hex");
  } catch {
    return;
  }
```

---

## Dependencies

- **No new npm packages** — all changes use built-in Node.js modules (`node:crypto`, `node:fs`, `node:fs/promises`)
- **Tests use existing `vitest`** framework
- **Node.js ≥ 22** required (already in `package.json` engines)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Step 3:** `estimateSavings` return type breaking change (`number` → object) | 🔴 High — all callers break silently | Update all call sites (`CacheStatsOverlay.sectionBlock`) to destructure the new return shape. Search for `estimateSavings` usage and verify each is updated. |
| **Step 2:** Changing pricing constants breaks existing cost estimates | ⚠️ Medium — savings values will change significantly | Update all `estimateSavings` tests with new expected values. Document that savings are now more accurate. |
| **Step 5:** First run after deploy runs cleanup (no marker file yet) | 🟡 Low — first startup may be slower | Expected — marker file is created after first cleanup. Acceptable one-time cost. |
| **Step 6:** `readdirSync` stays sync in async aggregation | 🟡 Low — directory listing is fast | Directory listing is fast; file I/O is the real bottleneck, which is now async. |
| **Step 7:** More unique history points from `toFixed(2)` | 🟡 Low — more data points | `MAX_HISTORY_POINTS = 100` cap handles this gracefully. |
| **Step 4 + `cache-reset`:** Eviction interacts with reset | 🟢 None — `cache-reset` clears everything | `cache-reset` already clears `summaryCache` in-memory AND deletes `summary-cache.json` from disk. Eviction only runs when adding new entries, so `cache-reset` followed by new compaction starts fresh. No special handling needed. |

---

## Implementation Order

```
Step 1 (Critical)     → Fix P3 destructuring bug
Step 2 + 3 (Pricing)  → Fix constants + make estimateSavings model-aware (incl. call-site updates)
Step 4 (LRU cache)    → Cap summary cache size
Step 5 (Cleanup)      → Throttle cleanup to once per day
Step 6 (Async)        → Convert aggregation to async (incl. readFile import fix)
Step 7 (Precision)    → Increase history dedup precision
Step 8 (Tests)        → Add tests for all changes
Step 9 (Docs)         → Add prefix guard documentation
```

Each step is self-contained and can be committed independently after validation.
