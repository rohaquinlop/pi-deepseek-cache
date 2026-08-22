import { describe, it, expect } from "vitest";
import {
  pickCacheCapableUpstream,
  computeProviderPin,
  openRouterEndpointsUrl,
  pinEntryFresh,
  mergePinLookupResult,
  PIN_TTL_MS,
  PIN_RETRY_TTL_MS,
  type OpenRouterEndpoint,
} from "../lib/helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// pickCacheCapableUpstream
// ═══════════════════════════════════════════════════════════════════════════

const ep = (
  tag: string,
  cacheRead: string | null | undefined,
): OpenRouterEndpoint => ({
  provider_name: tag.split("/")[0],
  tag,
  pricing: { input_cache_read: cacheRead as string | null },
});

describe("pickCacheCapableUpstream", () => {
  it("picks the cheapest endpoint with input_cache_read pricing", () => {
    const endpoints = [
      ep("siliconflow/fp8", null), // no caching — excluded
      ep("novita/fp8", "0.000000135"),
      ep("deepinfra/fp8", "0.0000001"), // cheapest
      ep("venice", undefined), // no caching — excluded
    ];
    expect(pickCacheCapableUpstream(endpoints)).toBe("deepinfra");
  });

  it("strips the quantization suffix from the winning tag", () => {
    expect(pickCacheCapableUpstream([ep("together/fp8", "0.0000002")])).toBe(
      "together",
    );
  });

  it("handles tags without a slash", () => {
    expect(pickCacheCapableUpstream([ep("fireworks", "0.0000001")])).toBe(
      "fireworks",
    );
  });

  it("returns undefined when no endpoint supports caching", () => {
    expect(pickCacheCapableUpstream([ep("a/fp8", null)])).toBeUndefined();
    expect(pickCacheCapableUpstream([])).toBeUndefined();
  });

  it("breaks price ties deterministically by tag", () => {
    const endpoints = [ep("zeta/fp8", "0.0000001"), ep("alpha/fp8", "0.0000001")];
    expect(pickCacheCapableUpstream(endpoints)).toBe("alpha");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// openRouterEndpointsUrl
// ═══════════════════════════════════════════════════════════════════════════

describe("openRouterEndpointsUrl", () => {
  it("prefixes bare model ids with the deepseek vendor namespace", () => {
    expect(openRouterEndpointsUrl("deepseek-v4-flash")).toBe(
      "https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints",
    );
  });

  it("keeps full slugs as-is", () => {
    expect(openRouterEndpointsUrl("deepseek/deepseek-v4-pro")).toBe(
      "https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-pro/endpoints",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// computeProviderPin
// ═══════════════════════════════════════════════════════════════════════════

describe("computeProviderPin", () => {
  it("returns strict pin settings when no user preferences exist", () => {
    expect(computeProviderPin(undefined, "deepinfra")).toEqual({
      order: ["deepinfra"],
      allow_fallbacks: false,
    });
  });

  it("treats null like unset", () => {
    expect(computeProviderPin(null, "deepinfra")).toEqual({
      order: ["deepinfra"],
      allow_fallbacks: false,
    });
  });

  it("never clobbers user-supplied routing preferences", () => {
    const existing = { order: ["novita"], only: ["novita"] };
    expect(computeProviderPin(existing, "deepinfra")).toBeUndefined();
    expect(computeProviderPin({ sort: "price" }, "deepinfra")).toBeUndefined();
  });

  it("returns undefined while no upstream has been detected yet", () => {
    expect(computeProviderPin(undefined, undefined)).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════
// pinEntryFresh / mergePinLookupResult
// ═════════════════════════════════════════════════════════════════════

describe("pinEntryFresh", () => {
  it("is false for missing entries", () => {
    expect(pinEntryFresh(undefined, Date.now())).toBe(false);
  });

  it("fresh entries last the full TTL; degraded ones the short retry TTL", () => {
    const now = 1_000_000;
    const ok = { slug: "deepinfra", at: now, degraded: false };
    const degraded = { slug: "deepinfra", at: now, degraded: true };

    expect(pinEntryFresh(ok, now + PIN_TTL_MS - 1)).toBe(true);
    expect(pinEntryFresh(ok, now + PIN_TTL_MS)).toBe(false);

    expect(pinEntryFresh(degraded, now + PIN_RETRY_TTL_MS - 1)).toBe(true);
    expect(pinEntryFresh(degraded, now + PIN_RETRY_TTL_MS)).toBe(false);
  });
});

describe("mergePinLookupResult", () => {
  const prev = { slug: "deepinfra", at: 0, degraded: false };

  it("successful lookup replaces the entry cleanly", () => {
    const merged = mergePinLookupResult(prev, "novita", 5);
    expect(merged).toEqual({ slug: "novita", at: 5, degraded: false });
  });

  it("failed lookup keeps the previous working upstream (degraded)", () => {
    // Regression: a transient network blip must not evict a known-good pin.
    const merged = mergePinLookupResult(prev, undefined, 5);
    expect(merged.slug).toBe("deepinfra");
    expect(merged.degraded).toBe(true);
  });

  it("failed first lookup stores an empty degraded entry for quick retry", () => {
    const merged = mergePinLookupResult(undefined, undefined, 5);
    expect(merged).toEqual({ slug: undefined, at: 5, degraded: true });
  });
});
