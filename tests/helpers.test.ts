import { describe, it, expect } from "vitest";
import {
  isDeepSeekModel,
  todayISO,
  calcHitRate,
  estimateSavings,
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

describe("estimateSavings", () => {
  it("returns 0 for no cache reads", () => {
    expect(estimateSavings(0)).toBe(0);
  });

  it("calculates savings for known values", () => {
    // 1M cache read tokens: 1M * (0.27 - 0.027) / 1M = 0.243
    expect(estimateSavings(1_000_000)).toBeCloseTo(0.243, 3);
  });

  it("scales linearly", () => {
    const perToken = 0.27 - 0.027;
    expect(estimateSavings(100_000)).toBeCloseTo(0.1 * perToken, 4);
    expect(estimateSavings(10_000_000)).toBeCloseTo(10 * perToken, 4);
  });

  it("matches the cost constants in the extension", () => {
    // Cross-check: 1M tokens at hit price = $0.027, at miss price = $0.27
    // So 1M cache read tokens saved = $0.243
    const savings = estimateSavings(1_000_000);
    expect(savings).toBeGreaterThan(0.24);
    expect(savings).toBeLessThan(0.25);
  });
});
