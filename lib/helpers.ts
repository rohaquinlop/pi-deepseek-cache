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

// ─── P5: OpenRouter auto-pin ────────────────────────────────────

/** One entry of OpenRouter's `/api/v1/models/{slug}/endpoints` response. */
export interface OpenRouterEndpoint {
  provider_name?: string;
  tag?: string;
  status?: number;
  pricing?: { input_cache_read?: string | null } | null;
}

export interface ProviderPin {
  order: string[];
  allow_fallbacks: false;
}

/**
 * Pick the pin target from an endpoints list: the cheapest endpoint whose
 * pricing declares input_cache_read (i.e. the upstream supports prefix
 * caching). Ties broken by provider name for determinism.
 * Returns undefined when no cache-capable endpoint exists.
 */
export function pickCacheCapableUpstream(
  endpoints: OpenRouterEndpoint[],
): string | undefined {
  const cacheable = endpoints.filter((e) => {
    const raw = e.pricing?.input_cache_read;
    if (raw === null || raw === undefined) return false;
    return Number.isFinite(Number(raw));
  });
  if (cacheable.length === 0) return undefined;
  const sorted = [...cacheable].sort((a, b) => {
    const diff =
      Number(a.pricing?.input_cache_read) - Number(b.pricing?.input_cache_read);
    if (diff !== 0) return diff;
    return String(a.tag).localeCompare(String(b.tag));
  });
  // Slug = tag without quantization suffix ("deepinfra/fp8" → "deepinfra").
  return sorted[0].tag!.split("/")[0];
}

/**
 * Build the OpenRouter endpoints API URL for a model id.
 * Accepts both bare ids ("deepseek-v4-flash") and full slugs
 * ("deepseek/deepseek-v4-flash"); bare ids are assumed to live in the
 * deepseek vendor namespace on OpenRouter.
 */
export function openRouterEndpointsUrl(modelId: string): string {
  const slug = modelId.includes("/") ? modelId : `deepseek/${modelId}`;
  return `https://openrouter.ai/api/v1/models/${slug}/endpoints`;
}

/**
 * Decide whether to inject a provider pin into a request payload.
 * Returns undefined — meaning "leave payload alone" — when the payload already
 * carries user-supplied routing preferences or when no upstream is known yet.
 */
export function computeProviderPin(
  existingProvider: unknown,
  pinnedUpstream: string | undefined,
): ProviderPin | undefined {
  if (existingProvider !== undefined && existingProvider !== null) {
    return undefined;
  }
  if (!pinnedUpstream) return undefined;
  return { order: [pinnedUpstream], allow_fallbacks: false };
}

// ─── P5: pin-cache bookkeeping ─────────────────────────────────

/** How long a successfully detected upstream stays trusted. */
export const PIN_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
/** Re-check interval after a failed lookup (or while keeping a stale pin). */
export const PIN_RETRY_TTL_MS = 30 * 60 * 1000; // 30 minutes

export interface PinCacheEntry {
  slug: string | undefined;
  at: number;
  /** True when the last lookup failed; entry expires sooner. */
  degraded?: boolean;
}

/** Is the entry still within its TTL? Degraded entries use the shorter one. */
export function pinEntryFresh(entry: PinCacheEntry | undefined, now: number): boolean {
  if (!entry) return false;
  const ttl = entry.degraded ? PIN_RETRY_TTL_MS : PIN_TTL_MS;
  return now - entry.at < ttl;
}

/**
 * Merge a lookup result into the cache.
 *
 * A successful lookup replaces the entry outright. A failed lookup must not
 * evict a known-good upstream (e.g. transient network blip dropping a working
 * pin): the previous slug keeps serving, marked degraded so it is re-checked
 * on the short TTL. A failure with nothing cached also degrades, so retries
 * happen in minutes instead of locking "no pin" in for the full TTL.
 */
export function mergePinLookupResult(
  prev: PinCacheEntry | undefined,
  fetchedSlug: string | undefined,
  now: number,
): PinCacheEntry {
  if (!fetchedSlug) {
    return prev?.slug
      ? { slug: prev.slug, at: now, degraded: true }
      : { slug: undefined, at: now, degraded: true };
  }
  return { slug: fetchedSlug, at: now, degraded: false };
}
