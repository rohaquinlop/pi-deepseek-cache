import { describe, it, expect } from "vitest";
import {
  isDeepSeekModel,
  formatTokens,
  todayISO,
  calcHitRate,
  formatHitRate,
  estimateSavings,
} from "../lib/helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// isDeepSeekModel
// ═══════════════════════════════════════════════════════════════════════════

describe("isDeepSeekModel", () => {
  it("returns false for undefined", () => {
    expect(isDeepSeekModel(undefined)).toBe(false);
  });

  it("matches 'nan' provider only for deepseek-* models", () => {
    // NaN Builders serves both DeepSeek and non-DeepSeek models
    expect(isDeepSeekModel({ id: "deepseek-v4-pro", provider: "nan" })).toBe(true);
    expect(isDeepSeekModel({ id: "deepseek-v4-flash", provider: "nan" })).toBe(true);
    // Non-DeepSeek models on NaN Builders should NOT match
    expect(isDeepSeekModel({ id: "mimo-v2.5", provider: "nan" })).toBe(false);
    expect(isDeepSeekModel({ id: "qwen3.6", provider: "nan" })).toBe(false);
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
    expect(isDeepSeekModel({ id: "qwen3.6", provider: "nan" })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// formatTokens
// ═══════════════════════════════════════════════════════════════════════════

describe("formatTokens", () => {
  it("formats small numbers as-is", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with K suffix", () => {
    expect(formatTokens(1_000)).toBe("1.0K");
    expect(formatTokens(1_500)).toBe("1.5K");
    expect(formatTokens(45_200)).toBe("45.2K");
    expect(formatTokens(999_999)).toBe("1000.0K");
  });

  it("formats millions with M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
    expect(formatTokens(150_000_000)).toBe("150.0M");
  });

  it("handles edge cases", () => {
    expect(formatTokens(1_000)).toBe("1.0K");
    expect(formatTokens(1_049)).toBe("1.0K"); // rounds down
    expect(formatTokens(1_050)).toBe("1.1K"); // rounds up
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
  });

  it("returns 100 when all cache reads", () => {
    expect(calcHitRate(1000, 0)).toBe(100);
  });

  it("returns 0 when all input (no cache reads)", () => {
    expect(calcHitRate(0, 1000)).toBe(0);
  });

  it("calculates mixed scenarios", () => {
    expect(calcHitRate(500, 500)).toBe(50);
    expect(calcHitRate(750, 250)).toBe(75);
    expect(calcHitRate(900, 100)).toBe(90);
  });

  it("handles large numbers", () => {
    expect(calcHitRate(1_000_000, 50_000)).toBeCloseTo(95.24, 1);
  });

  it("handles cache reads > input gracefully", () => {
    // This can happen when a provider reports cache_read > prompt_tokens
    // (e.g. some OpenRouter responses). Should not break.
    expect(calcHitRate(2000, 1000)).toBeGreaterThan(50);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// formatHitRate
// ═══════════════════════════════════════════════════════════════════════════

describe("formatHitRate", () => {
  it("formats high rates with one decimal", () => {
    expect(formatHitRate(95)).toBe("95.0%");
    expect(formatHitRate(99.9)).toBe("99.9%");
    expect(formatHitRate(100)).toBe("100.0%");
  });

  it("formats medium rates without decimals", () => {
    expect(formatHitRate(50)).toBe("50%");
    expect(formatHitRate(87.3)).toBe("87%");
    expect(formatHitRate(94.9)).toBe("95%");
  });

  it("formats low rates without decimals", () => {
    expect(formatHitRate(0)).toBe("0%");
    expect(formatHitRate(12.7)).toBe("13%");
    expect(formatHitRate(49.9)).toBe("50%");
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
