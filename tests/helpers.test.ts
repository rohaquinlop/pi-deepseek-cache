import { describe, it, expect } from "vitest";
import {
  isDeepSeekModel,
  todayISO,
  calcHitRate,
  estimateSavings,
  getPricingTier,
} from "../lib/helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// isDeepSeekModel
// ═══════════════════════════════════════════════════════════════════════════

describe("isDeepSeekModel", () => {
  it("returns false for undefined", () => {
    expect(isDeepSeekModel(undefined)).toBe(false);
  });

  it("matches deepseek-* models on any provider", () => {
    // Works regardless of provider name — NaN Builders, OpenRouter, custom
    expect(isDeepSeekModel({ id: "deepseek-v4-pro", provider: "nan" })).toBe(true);
    expect(isDeepSeekModel({ id: "deepseek-v4-flash", provider: "openrouter" })).toBe(true);
    expect(isDeepSeekModel({ id: "deepseek-v4-pro", provider: "custom-proxy" })).toBe(true);
  });

  it("does not match non-deepseek models on any provider", () => {
    // Provider name alone is never sufficient — must match model ID or provider "deepseek"
    expect(isDeepSeekModel({ id: "mimo-v2.5", provider: "nan" })).toBe(false);
    expect(isDeepSeekModel({ id: "qwen3.6", provider: "nan" })).toBe(false);
    expect(isDeepSeekModel({ id: "claude-sonnet-4-5", provider: "anthropic" })).toBe(false);
  });

  it("matches 'deepseek' provider", () => {
    expect(isDeepSeekModel({ id: "deepseek-chat", provider: "deepseek" })).toBe(true);
    expect(isDeepSeekModel({ id: "deepseek-reasoner", provider: "deepseek" })).toBe(true);
  });

  it("matches deepseek-* model id prefix regardless of provider", () => {
    expect(isDeepSeekModel({ id: "deepseek-v4-pro", provider: "unknown" })).toBe(true);
    expect(isDeepSeekModel({ id: "deepseek-v4-flash", provider: "openrouter" })).toBe(true);
    expect(isDeepSeekModel({ id: "DEEPSEEK-CHAT", provider: "custom" })).toBe(true);
  });

  it("does not match non-DeepSeek models", () => {
    expect(isDeepSeekModel({ id: "claude-sonnet-4-5", provider: "anthropic" })).toBe(false);
    expect(isDeepSeekModel({ id: "gpt-4o", provider: "openai" })).toBe(false);
    expect(isDeepSeekModel({ id: "mimo-v2.5", provider: "xiaomi" })).toBe(false);
    expect(isDeepSeekModel({ id: "mimo-v2.5", provider: "nan" })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// todayISO
// ═══════════════════════════════════════════════════════════════════════════

describe("todayISO", () => {
  it("returns a valid YYYY-MM-DD string", () => {
    const date = todayISO();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns today's date (matches JS Date)", () => {
    const expected = new Date().toISOString().split("T")[0];
    expect(todayISO()).toBe(expected);
  });

  it("produces valid month and day ranges", () => {
    const date = todayISO();
    const [year, month, day] = date.split("-").map(Number);
    expect(year).toBeGreaterThanOrEqual(2026);
    expect(month).toBeGreaterThanOrEqual(1);
    expect(month).toBeLessThanOrEqual(12);
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(31);
  });

  it("returns consistent results in rapid succession", () => {
    const a = todayISO();
    const b = todayISO();
    expect(a).toBe(b);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// calcHitRate
// ═══════════════════════════════════════════════════════════════════════════

describe("calcHitRate", () => {
  it("returns 0 when no tokens", () => {
    expect(calcHitRate(0, 0)).toBe(0);
    expect(calcHitRate(0, 0, 0)).toBe(0);
  });

  it("returns 100 when all cache reads", () => {
    expect(calcHitRate(1000, 0, 0)).toBe(100);
  });

  it("returns 0 when all input (no cache reads)", () => {
    expect(calcHitRate(0, 1000, 0)).toBe(0);
  });

  it("calculates mixed scenarios (no cacheWrite)", () => {
    expect(calcHitRate(500, 500)).toBe(50);
    expect(calcHitRate(750, 250)).toBe(75);
    expect(calcHitRate(900, 100)).toBe(90);
  });

  it("includes cacheWrite in denominator", () => {
    // 700 cache hits, 200 misses, 100 writes = 1000 total
    // Hit rate = 700 / 1000 = 70%
    expect(calcHitRate(700, 200, 100)).toBe(70);
  });

  it("equivalently: cacheRead + input + cacheWrite = promptTokens", () => {
    // Verifies that including cacheWrite gives the same result as
    // cacheRead / promptTokens
    expect(calcHitRate(7000, 3000, 0)).toBe(70);    // DeepSeek: write=0
    expect(calcHitRate(7000, 2000, 1000)).toBe(70); // Anthropic: write>0
  });

  it("handles large numbers", () => {
    expect(calcHitRate(1_000_000, 50_000)).toBeCloseTo(95.24, 1);
  });

  it("cacheWrite defaults to 0 when omitted", () => {
    // Backward compat: 2-arg call still works
    expect(calcHitRate(500, 500)).toBe(50);
  });

  it("handles edge cases gracefully", () => {
    expect(calcHitRate(2000, 1000, 0)).toBeGreaterThan(50);
    expect(calcHitRate(0, 0, 0)).toBe(0);
    expect(calcHitRate(100, 0, 0)).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// estimateSavings
// ═══════════════════════════════════════════════════════════════════════════

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

  it("falls back to flash for unknown variants (startsWith matching)", () => {
    // "deepseek-v4-flash-lite" starts with "deepseek-v4-flash" → flash tier
    const tier = getPricingTier("deepseek-v4-flash-lite");
    expect(tier.cacheHitPerM).toBe(0.0028);
  });
});

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
    // saved should be the same (output cost doesn\'t change with caching)
    expect(withOutput.saved).toBeCloseTo(noOutput.saved, 6);
  });
});
