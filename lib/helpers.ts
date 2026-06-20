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

/**
 * Estimate cost savings from cache hits vs cache misses.
 * Returns USD saved.
 */
export function estimateSavings(cacheReadTokens: number): number {
  const COST_PER_M_CACHE_READ = 0.027;
  const COST_PER_M_INPUT = 0.27;
  return (cacheReadTokens / 1_000_000) * (COST_PER_M_INPUT - COST_PER_M_CACHE_READ);
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
