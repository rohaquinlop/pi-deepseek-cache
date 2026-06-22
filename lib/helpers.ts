/**
 * Pure helpers for the deepseek-cache extension.
 * Extracted for testability — no pi runtime dependencies.
 *
 * Used by the extension: isDeepSeekModel, todayISO, DATE_LINE_RE, CWD_LINE_RE,
 * calcHitRate, estimateSavings, isDateFrozen, isCwdFrozen, applyDateFreeze, applyCwdFreeze.
 * The remaining exports (frozenDate, frozenCwd) are used internally by the freeze helpers.
 */

/**
 * Check whether the current model looks like a DeepSeek variant.
 */
export function isDeepSeekModel(model: { id: string; provider: string } | undefined): boolean {
  if (!model) return false;
  // Match by model ID prefix — the most reliable, provider-agnostic signal.
  // Works for NaN Builders, OpenRouter, direct DeepSeek API, and custom providers.
  if (model.id.toLowerCase().startsWith("deepseek-")) return true;
  // Match by provider name — direct DeepSeek API, covers edge cases where
  // model IDs don't use the deepseek- prefix.
  if (model.provider === "deepseek") return true;
  return false;
}

/**
 * Get today's date as YYYY-MM-DD.
 */
export function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Calculate cache hit rate as a percentage.
 * Uses (cacheRead + input + cacheWrite) as the denominator, which equals
 * promptTokens total. This is correct for all providers.
 *
 * For DeepSeek: cacheWrite is always 0, input = prompt_cache_miss_tokens.
 * For Anthropic: cacheWrite holds the cache write tokens count.
 */
export function calcHitRate(cacheRead: number, input: number, cacheWrite: number = 0): number {
  const denom = cacheRead + input + cacheWrite;
  return denom > 0 ? (cacheRead / denom) * 100 : 0;
}

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

/**
 * Estimate cost savings from cache hits vs cache misses.
 * Returns an object with saved (USD), hitRate, effectiveCost, and withoutCacheCost.
 */
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

/**
 * Matches "Current date: YYYY-MM-DD" in the system prompt.
 * Does not use $ anchor because the CWD line follows.
 * Group 1 captures the date portion.
 */
export const DATE_LINE_RE = /Current date: (\d{4}-\d{2}-\d{2})(?: \(frozen\))?/;

/**
 * Matches "Current working directory: <path>" at the end of the system prompt.
 * Group 1 captures the path portion.
 */
export const CWD_LINE_RE = /Current working directory: (.+?)\s*$/;

/**
 * Build the frozen date replacement string.
 */
export function frozenDate(date: string): string {
  return `Current date: ${date} (frozen)`;
}

/**
 * Build the frozen CWD replacement string.
 */
export function frozenCwd(cwd: string): string {
  return `Current working directory: ${cwd}`;
}

/**
 * Check if a system prompt's date line is already frozen to a given date.
 */
export function isDateFrozen(prompt: string, expectedDate: string): boolean {
  const match = prompt.match(DATE_LINE_RE);
  if (!match) return false;
  return match[0].includes("(frozen)") && match[1] === expectedDate;
}

/**
 * Check if a system prompt's CWD line is already frozen to a given path.
 */
export function isCwdFrozen(prompt: string, expectedCwd: string): boolean {
  const match = prompt.match(CWD_LINE_RE);
  if (!match) return false;
  return match[1] === expectedCwd;
}

/**
 * Apply date freeze to a system prompt.
 */
export function applyDateFreeze(prompt: string, date: string): string {
  return prompt.replace(DATE_LINE_RE, frozenDate(date));
}

/**
 * Apply CWD freeze to a system prompt.
 */
export function applyCwdFreeze(prompt: string, cwd: string): string {
  return prompt.replace(CWD_LINE_RE, frozenCwd(cwd));
}
