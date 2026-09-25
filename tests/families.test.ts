import { describe, it, expect } from "vitest";
import {
  CACHE_FAMILIES,
  aggregateSavings,
  estimateCreditSavings,
  findFamily,
  formatCredits,
  isCacheOptimizedModel,
  longestPrefixMatch,
  pickSummarizerModel,
  resolveCreditTier,
  resolveDisplayUnit,
  resolveOpenRouterVendor,
  resolvePricingTier,
  resolveSummarizerCandidates,
} from "../lib/families.js";

// ═══════════════════════════════════════════════════════════════════════════
// Detection
// ═══════════════════════════════════════════════════════════════════════════

describe("isCacheOptimizedModel", () => {
  it("returns false for undefined", () => {
    expect(isCacheOptimizedModel(undefined)).toBe(false);
  });

  it("matches MiMo model IDs on any provider", () => {
    expect(isCacheOptimizedModel({ id: "mimo-v2.5", provider: "nan" })).toBe(true);
    expect(isCacheOptimizedModel({ id: "mimo-v2.6-pro", provider: "xiaomi" })).toBe(true);
    expect(isCacheOptimizedModel({ id: "mimo-v2.6-flash", provider: "custom-proxy" })).toBe(true);
  });

  it("matches vendor-prefixed OpenRouter IDs", () => {
    expect(isCacheOptimizedModel({ id: "xiaomi/mimo-v2.6-flash", provider: "openrouter" })).toBe(true);
    expect(isCacheOptimizedModel({ id: "deepseek/deepseek-v4-flash", provider: "openrouter" })).toBe(true);
  });

  it("matches xiaomi providers", () => {
    expect(isCacheOptimizedModel({ id: "mimo-v2.5", provider: "xiaomi" })).toBe(true);
    expect(isCacheOptimizedModel({ id: "mimo-v2.5", provider: "xiaomi-token-plan-ams" })).toBe(true);
    expect(isCacheOptimizedModel({ id: "mimo-v2.5", provider: "xiaomi-token-plan-cn" })).toBe(true);
    expect(isCacheOptimizedModel({ id: "mimo-v2.5", provider: "xiaomi-token-plan-sgp" })).toBe(true);
  });

  it("keeps matching DeepSeek", () => {
    expect(isCacheOptimizedModel({ id: "deepseek-v4-pro", provider: "nan" })).toBe(true);
    expect(isCacheOptimizedModel({ id: "deepseek-chat", provider: "deepseek" })).toBe(true);
    expect(isCacheOptimizedModel({ id: "DEEPSEEK-CHAT", provider: "custom" })).toBe(true);
  });

  it("rejects unrelated models", () => {
    expect(isCacheOptimizedModel({ id: "qwen3.6", provider: "nan" })).toBe(false);
    expect(isCacheOptimizedModel({ id: "claude-sonnet-4-5", provider: "anthropic" })).toBe(false);
    expect(isCacheOptimizedModel({ id: "gpt-4o", provider: "openai" })).toBe(false);
  });

  it("findFamily returns the matched family", () => {
    expect(findFamily({ id: "mimo-v2.5", provider: "xiaomi" })?.id).toBe("mimo");
    expect(findFamily({ id: "deepseek-v4-pro", provider: "nan" })?.id).toBe("deepseek");
    expect(findFamily(undefined)).toBeUndefined();
    expect(findFamily({ id: "gpt-4o", provider: "openai" })).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Longest-prefix matching
// ═══════════════════════════════════════════════════════════════════════════

describe("longestPrefixMatch", () => {
  const table = { "mimo-v2.6-pro": "pro", "mimo-v2.6-pro-ultraspeed": "ultra" };

  it("prefers the longest matching key", () => {
    expect(longestPrefixMatch("mimo-v2.6-pro-ultraspeed", table)).toBe("ultra");
    expect(longestPrefixMatch("mimo-v2.6-pro-lite", table)).toBe("pro");
  });

  it("returns undefined when nothing matches", () => {
    expect(longestPrefixMatch("gpt-4o", table)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// USD price resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("resolvePricingTier", () => {
  it("returns flash pricing for mimo-v2.6-flash", () => {
    const tier = resolvePricingTier({ id: "mimo-v2.6-flash", provider: "xiaomi" });
    expect(tier.cacheHitPerM).toBe(0.0028);
    expect(tier.cacheMissPerM).toBe(0.14);
    expect(tier.outputPerM).toBe(0.28);
  });

  it("returns pro pricing for mimo-v2.6-pro", () => {
    const tier = resolvePricingTier({ id: "mimo-v2.6-pro", provider: "xiaomi" });
    expect(tier.cacheHitPerM).toBe(0.0036);
    expect(tier.cacheMissPerM).toBe(0.435);
  });

  it("gives mimo-v2.6-pro-ultraspeed its own tier", () => {
    const tier = resolvePricingTier({ id: "mimo-v2.6-pro-ultraspeed", provider: "xiaomi" });
    expect(tier.cacheHitPerM).toBe(0.036);
    expect(tier.cacheMissPerM).toBe(4.35);
    expect(tier.outputPerM).toBe(8.7);
  });

  it("gives mimo-v2.5-pro-ultraspeed its own tier", () => {
    const tier = resolvePricingTier({ id: "mimo-v2.5-pro-ultraspeed", provider: "xiaomi" });
    expect(tier.cacheHitPerM).toBe(0.0108);
    expect(tier.cacheMissPerM).toBe(1.305);
    expect(tier.outputPerM).toBe(2.61);
  });

  it("resolves vendor-prefixed IDs", () => {
    const tier = resolvePricingTier({ id: "xiaomi/mimo-v2.6-flash", provider: "openrouter" });
    expect(tier.cacheHitPerM).toBe(0.0028);
  });

  it("keeps DeepSeek prices", () => {
    expect(resolvePricingTier({ id: "deepseek-v4-flash", provider: "nan" }).cacheHitPerM).toBe(0.0028);
    expect(resolvePricingTier({ id: "deepseek-v4-pro", provider: "nan" }).cacheHitPerM).toBe(0.003625);
  });

  it("falls back to pi metadata for unlisted models", () => {
    const tier = resolvePricingTier({
      id: "mimo-v2.7-flash",
      provider: "xiaomi",
      cost: { input: 0.2, cacheRead: 0.004, output: 0.4 },
    });
    expect(tier.cacheHitPerM).toBe(0.004);
    expect(tier.cacheMissPerM).toBe(0.2);
    expect(tier.outputPerM).toBe(0.4);
  });

  it("ignores zero metadata costs and uses the fallback", () => {
    const tier = resolvePricingTier({
      id: "mimo-v2.7-flash",
      provider: "xiaomi-token-plan-sgp",
      cost: { input: 0, cacheRead: 0, output: 0 },
    });
    expect(tier.cacheHitPerM).toBe(0.0028);
  });

  it("returns the fallback for undefined", () => {
    expect(resolvePricingTier(undefined).cacheHitPerM).toBe(0.0028);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Plan credits
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveCreditTier", () => {
  it("resolves v2.5 and v2.6 pro tiers", () => {
    for (const id of ["mimo-v2.5-pro", "mimo-v2.6-pro"]) {
      const tier = resolveCreditTier(id);
      expect(tier).toEqual({ cacheHitPerToken: 2.5, cacheMissPerToken: 300, outputPerToken: 600 });
    }
  });

  it("resolves v2.5 and v2.6 flash tiers", () => {
    for (const id of ["mimo-v2.5", "mimo-v2.6-flash"]) {
      const tier = resolveCreditTier(id);
      expect(tier).toEqual({ cacheHitPerToken: 2, cacheMissPerToken: 100, outputPerToken: 200 });
    }
  });

  it("returns undefined for ultraspeed and unknown models", () => {
    expect(resolveCreditTier("mimo-v2.6-pro-ultraspeed")).toBeUndefined();
    expect(resolveCreditTier("mimo-v2.5-pro-ultraspeed")).toBeUndefined();
    expect(resolveCreditTier("deepseek-v4-flash")).toBeUndefined();
    expect(resolveCreditTier(undefined)).toBeUndefined();
  });
});

describe("estimateCreditSavings", () => {
  it("computes pro savings at 297.5 credits per cached token", () => {
    const tier = resolveCreditTier("mimo-v2.6-pro")!;
    expect(estimateCreditSavings(1_000_000, tier)).toBe(297_500_000);
  });

  it("computes flash savings at 98 credits per cached token", () => {
    const tier = resolveCreditTier("mimo-v2.6-flash")!;
    expect(estimateCreditSavings(1_000_000, tier)).toBe(98_000_000);
  });

  it("returns 0 for no cache reads", () => {
    const tier = resolveCreditTier("mimo-v2.6-pro")!;
    expect(estimateCreditSavings(0, tier)).toBe(0);
  });
});

describe("formatCredits", () => {
  it("formats billions compactly", () => {
    expect(formatCredits(2_980_000_000)).toBe("2.98B credits");
    expect(formatCredits(82_000_000_000)).toBe("82B credits");
  });

  it("formats smaller units", () => {
    expect(formatCredits(1_500_000)).toBe("1.50M credits");
    expect(formatCredits(950)).toBe("950 credits");
  });

  it("formats zero and invalid values", () => {
    expect(formatCredits(0)).toBe("0 credits");
    expect(formatCredits(-5)).toBe("0 credits");
    expect(formatCredits(Number.NaN)).toBe("0 credits");
  });
});

describe("resolveDisplayUnit", () => {
  it("uses credits for token-plan providers", () => {
    expect(resolveDisplayUnit("xiaomi-token-plan-ams")).toBe("credits");
    expect(resolveDisplayUnit("xiaomi-token-plan-cn")).toBe("credits");
    expect(resolveDisplayUnit("xiaomi-token-plan-sgp")).toBe("credits");
  });

  it("uses USD for everything else", () => {
    expect(resolveDisplayUnit("xiaomi")).toBe("usd");
    expect(resolveDisplayUnit("openrouter")).toBe("usd");
    expect(resolveDisplayUnit("deepseek")).toBe("usd");
    expect(resolveDisplayUnit(undefined)).toBe("usd");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Summarizer and vendor resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveSummarizerCandidates", () => {
  it("returns the MiMo preference list", () => {
    expect(resolveSummarizerCandidates({ id: "mimo-v2.6-pro", provider: "xiaomi" })).toEqual([
      "mimo-v2.6-flash",
      "mimo-v2.5",
    ]);
  });

  it("returns the DeepSeek preference list", () => {
    expect(resolveSummarizerCandidates({ id: "deepseek-v4-pro", provider: "nan" })).toEqual([
      "deepseek-v4-flash",
    ]);
  });

  it("returns an empty list for unknown models", () => {
    expect(resolveSummarizerCandidates({ id: "gpt-4o", provider: "openai" })).toEqual([]);
    expect(resolveSummarizerCandidates(undefined)).toEqual([]);
  });
});

describe("pickSummarizerModel", () => {
  const model = (id: string, provider: string) => ({ id, provider });

  it("prefers a candidate on the active provider", () => {
    const picked = pickSummarizerModel(["deepseek-v4-flash"], "deepseek", {
      find: (provider, id) =>
        provider === "deepseek" && id === "deepseek-v4-flash"
          ? model(id, provider)
          : undefined,
      getAvailable: () => [model("deepseek-v4-flash", "opencode")],
    });

    expect(picked).toEqual(model("deepseek-v4-flash", "deepseek"));
  });

  it("falls back to a candidate on another provider with configured auth", () => {
    const picked = pickSummarizerModel(["deepseek-v4-flash"], "deepseek", {
      find: () => undefined,
      getAvailable: () => [model("deepseek-v4-flash", "openrouter")],
    });

    expect(picked).toEqual(model("deepseek-v4-flash", "openrouter"));
  });

  it("ignores providers without configured auth instead of throwing", () => {
    // Regression: the old implementation iterated modelRegistry.listProviders(),
    // which pi's ModelRegistry facade has never exposed, so this path threw a
    // TypeError inside session_before_compact instead of returning undefined.
    const picked = pickSummarizerModel(["deepseek-v4-flash"], "deepseek", {
      find: () => undefined,
      getAvailable: () => [],
    });

    expect(picked).toBeUndefined();
  });

  it("returns undefined when the family has no candidates", () => {
    const picked = pickSummarizerModel([], "deepseek", {
      find: () => model("deepseek-flash", "deepseek"),
      getAvailable: () => [model("deepseek-flash", "deepseek")],
    });

    expect(picked).toBeUndefined();
  });
});

describe("resolveOpenRouterVendor", () => {
  it("resolves the family vendor", () => {
    expect(resolveOpenRouterVendor({ id: "mimo-v2.6-flash", provider: "openrouter" })).toBe("xiaomi");
    expect(resolveOpenRouterVendor({ id: "deepseek-v4-flash", provider: "openrouter" })).toBe("deepseek");
  });

  it("returns undefined for unknown models", () => {
    expect(resolveOpenRouterVendor({ id: "gpt-4o", provider: "openrouter" })).toBeUndefined();
    expect(resolveOpenRouterVendor(undefined)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Aggregate savings
// ═══════════════════════════════════════════════════════════════════════════

describe("aggregateSavings", () => {
  it("sums USD sessions with their own tiers", () => {
    const result = aggregateSavings([
      { cacheRead: 1_000_000, input: 0, modelId: "deepseek-v4-flash", provider: "nan" },
      { cacheRead: 1_000_000, input: 0, modelId: "deepseek-v4-flash", provider: "nan" },
    ]);
    expect(result.savedUsd).toBeCloseTo(0.2744, 4);
    expect(result.savedCredits).toBe(0);
  });

  it("sums credit sessions", () => {
    const result = aggregateSavings([
      {
        cacheRead: 1_000_000,
        input: 0,
        modelId: "mimo-v2.6-pro",
        provider: "xiaomi-token-plan-sgp",
      },
    ]);
    expect(result.savedCredits).toBe(297_500_000);
    expect(result.savedUsd).toBe(0);
  });

  it("keeps both units when sessions mix", () => {
    const result = aggregateSavings([
      { cacheRead: 1_000_000, input: 0, modelId: "deepseek-v4-flash", provider: "nan" },
      {
        cacheRead: 1_000_000,
        input: 0,
        modelId: "mimo-v2.6-flash",
        provider: "xiaomi-token-plan-cn",
      },
    ]);
    expect(result.savedUsd).toBeCloseTo(0.1372, 4);
    expect(result.savedCredits).toBe(98_000_000);
  });

  it("treats legacy sessions without model or provider as USD", () => {
    const result = aggregateSavings([{ cacheRead: 1_000_000, input: 0 }]);
    expect(result.savedUsd).toBeCloseTo(0.1372, 4);
    expect(result.savedCredits).toBe(0);
  });

  it("adds no savings for a token-plan session without a model ID", () => {
    const result = aggregateSavings([
      { cacheRead: 1_000_000, input: 0, provider: "xiaomi-token-plan-ams" },
    ]);
    expect(result.savedUsd).toBe(0);
    expect(result.savedCredits).toBe(0);
  });

  it("returns zeros for an empty list", () => {
    expect(aggregateSavings([])).toEqual({ savedUsd: 0, savedCredits: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Registry sanity
// ═══════════════════════════════════════════════════════════════════════════

describe("CACHE_FAMILIES", () => {
  it("registers deepseek and mimo exactly once", () => {
    const ids = CACHE_FAMILIES.map((f) => f.id);
    expect(ids).toEqual(["deepseek", "mimo"]);
  });

  it("every family has at least one summarizer candidate and a vendor", () => {
    for (const family of CACHE_FAMILIES) {
      expect(family.summarizerModels.length).toBeGreaterThan(0);
      expect(family.openRouterVendor.length).toBeGreaterThan(0);
    }
  });
});
