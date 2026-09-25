/**
 * Cache family registry.
 *
 * One entry per model family. Each entry owns everything that varies between
 * families: detection, USD pricing, plan credits, summarizer preference order,
 * and the OpenRouter vendor namespace. The extension gates every cache layer on
 * `isCacheOptimizedModel` and resolves display values through the helpers here.
 *
 * Pure by design — no pi runtime imports, so the registry stays unit-testable.
 */

import { estimateSavings, type PricingTier } from "./helpers.js";

export interface CreditTier {
  cacheHitPerToken: number;
  cacheMissPerToken: number;
  outputPerToken: number;
}

export interface CacheFamily {
  id: string;
  match(model: { id: string; provider: string }): boolean;
  /** Model-ID prefix → USD per 1M tokens. */
  pricing: Record<string, PricingTier>;
  /** Model-ID prefix → plan credits per token. A `null` value marks a SKU
   * that has no published credit rate, so a shorter prefix cannot claim it. */
  credits?: Record<string, CreditTier | null>;
  /** Cheap summarizer models in preference order. */
  summarizerModels: string[];
  /** Vendor namespace used in OpenRouter endpoint URLs. */
  openRouterVendor: string;
}

/** Fallback USD tier when nothing else is known. */
export const FALLBACK_PRICING: PricingTier = {
  cacheHitPerM: 0.0028,
  cacheMissPerM: 0.14,
  outputPerM: 0.28,
};

// ─── DeepSeek pricing ──────────────────────────────────────────
// Source: https://api-docs.deepseek.com/quick_start/pricing (verified 2026-06-22)

const DEEPSEEK_FLASH: PricingTier = FALLBACK_PRICING;
const DEEPSEEK_PRO: PricingTier = {
  cacheHitPerM: 0.003625,
  cacheMissPerM: 0.435,
  outputPerM: 0.87,
};

// ─── MiMo pricing ──────────────────────────────────────────────
// USD per 1M tokens. Sources (verified 2026-09-22):
// - Xiaomi pay-as-you-go table: https://mimo.mi.com/docs/en-US/price/pay-as-you-go
// - models.dev and the installed pi catalog for the deprecated v2.5 ultraspeed SKU.

const MIMO_FLASH: PricingTier = {
  cacheHitPerM: 0.0028,
  cacheMissPerM: 0.14,
  outputPerM: 0.28,
};
const MIMO_PRO: PricingTier = {
  cacheHitPerM: 0.0036,
  cacheMissPerM: 0.435,
  outputPerM: 0.87,
};
const MIMO_V25_ULTRASPEED: PricingTier = {
  cacheHitPerM: 0.0108,
  cacheMissPerM: 1.305,
  outputPerM: 2.61,
};
const MIMO_V26_ULTRASPEED: PricingTier = {
  cacheHitPerM: 0.036,
  cacheMissPerM: 4.35,
  outputPerM: 8.7,
};

// Plan credits per token. Source:
// https://mimo.mi.com/docs/en-US/price/token-plan (verified 2026-09-22)
// Ultraspeed has no published credit rate, so it has no entry.

const MIMO_PRO_CREDITS: CreditTier = {
  cacheHitPerToken: 2.5,
  cacheMissPerToken: 300,
  outputPerToken: 600,
};
const MIMO_FLASH_CREDITS: CreditTier = {
  cacheHitPerToken: 2,
  cacheMissPerToken: 100,
  outputPerToken: 200,
};

// ─── Registry ──────────────────────────────────────────────────

export const CACHE_FAMILIES: CacheFamily[] = [
  {
    id: "deepseek",
    match: (m) =>
      modelTail(m.id).toLowerCase().startsWith("deepseek-") ||
      m.provider === "deepseek",
    pricing: {
      "deepseek-v4-flash": DEEPSEEK_FLASH,
      "deepseek-v4-pro": DEEPSEEK_PRO,
    },
    summarizerModels: ["deepseek-v4-flash"],
    openRouterVendor: "deepseek",
  },
  {
    id: "mimo",
    match: (m) =>
      modelTail(m.id).toLowerCase().startsWith("mimo-") ||
      m.provider === "xiaomi" ||
      m.provider.startsWith("xiaomi-token-plan-"),
    pricing: {
      "mimo-v2.5": MIMO_FLASH,
      "mimo-v2.5-pro": MIMO_PRO,
      "mimo-v2.5-pro-ultraspeed": MIMO_V25_ULTRASPEED,
      "mimo-v2.6-flash": MIMO_FLASH,
      "mimo-v2.6-pro": MIMO_PRO,
      "mimo-v2.6-pro-ultraspeed": MIMO_V26_ULTRASPEED,
    },
    credits: {
      "mimo-v2.5": MIMO_FLASH_CREDITS,
      "mimo-v2.5-pro": MIMO_PRO_CREDITS,
      "mimo-v2.6-flash": MIMO_FLASH_CREDITS,
      "mimo-v2.6-pro": MIMO_PRO_CREDITS,
      // Explicit no-tier markers: ultraspeed has no published credit rate.
      // Longest-prefix matching must not fall back to the pro tier for it.
      "mimo-v2.5-pro-ultraspeed": null,
      "mimo-v2.6-pro-ultraspeed": null,
    },
    summarizerModels: ["mimo-v2.6-flash", "mimo-v2.5"],
    openRouterVendor: "xiaomi",
  },
];

/** Flat model-prefix → USD tier index built from every family. */
const PRICING_INDEX: Record<string, PricingTier> = Object.assign(
  {},
  ...CACHE_FAMILIES.map((f) => f.pricing),
);

// ─── Detection ─────────────────────────────────────────────────

/**
 * The model ID without a vendor prefix. OpenRouter exposes IDs such as
 * `xiaomi/mimo-v2.6-flash`; the registry keys are bare (`mimo-v2.6-flash`).
 */
function modelTail(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(slash + 1);
}

export function isCacheOptimizedModel(
  model: { id: string; provider: string } | undefined,
): boolean {
  if (!model) return false;
  return CACHE_FAMILIES.some((family) => family.match(model));
}

export function findFamily(
  model: { id: string; provider: string } | undefined,
): CacheFamily | undefined {
  if (!model) return undefined;
  return CACHE_FAMILIES.find((family) => family.match(model));
}

// ─── Pricing resolution ────────────────────────────────────────

/**
 * Longest key in `table` that prefixes `modelId`. Longest wins so that
 * `mimo-v2.6-pro-ultraspeed` beats `mimo-v2.6-pro`.
 */
export function longestPrefixMatch<T>(
  modelId: string,
  table: Record<string, T>,
): T | undefined {
  let bestKey: string | undefined;
  for (const key of Object.keys(table)) {
    if (!modelId.startsWith(key)) continue;
    if (bestKey === undefined || key.length > bestKey.length) bestKey = key;
  }
  return bestKey === undefined ? undefined : table[bestKey];
}

/**
 * Resolve the USD tier for a model. Registry prices win. Pi model metadata is
 * the fallback for model IDs the registry does not list. The fallback tier is
 * the last resort.
 */
export function resolvePricingTier(
  model:
    | {
        id: string;
        provider?: string;
        cost?: { input?: number; cacheRead?: number; output?: number } | null;
      }
    | undefined,
): PricingTier {
  if (!model) return FALLBACK_PRICING;

  const registry = longestPrefixMatch(modelTail(model.id), PRICING_INDEX);
  if (registry) return registry;

  const cacheRead = model.cost?.cacheRead ?? 0;
  if (cacheRead > 0) {
    return {
      cacheHitPerM: cacheRead,
      cacheMissPerM: model.cost?.input ?? 0,
      outputPerM: model.cost?.output ?? 0,
    };
  }

  return FALLBACK_PRICING;
}

/** Resolve the Token Plan credit tier, if the model has one. */
export function resolveCreditTier(
  modelId: string | undefined,
): CreditTier | undefined {
  if (!modelId) return undefined;
  const id = modelTail(modelId);
  for (const family of CACHE_FAMILIES) {
    if (!family.credits) continue;
    const match = longestPrefixMatch(id, family.credits);
    if (match !== undefined) return match ?? undefined;
  }
  return undefined;
}

// ─── Display helpers ───────────────────────────────────────────

/** Token Plan providers bill in credits; everything else bills in USD. */
export function resolveDisplayUnit(
  provider: string | undefined,
): "usd" | "credits" {
  return provider?.startsWith("xiaomi-token-plan-") ? "credits" : "usd";
}

/** Credits saved by serving `cacheRead` tokens from cache. */
export function estimateCreditSavings(
  cacheRead: number,
  tier: CreditTier,
): number {
  return cacheRead * (tier.cacheMissPerToken - tier.cacheHitPerToken);
}

/** Compact credit label, for example `2.98B credits`. */
export function formatCredits(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 credits";
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [scale, suffix] of units) {
    if (value < scale) continue;
    const n = value / scale;
    const digits = n >= 10 ? 1 : 2;
    return `${n.toFixed(digits).replace(/\.0+$/, "")}${suffix} credits`;
  }
  return `${Math.round(value)} credits`;
}

// ─── Compaction and pin resolution ─────────────────────────────

/** Summarizer candidates for the active model's family. */
export function resolveSummarizerCandidates(
  model: { id: string; provider: string } | undefined,
): string[] {
  return findFamily(model)?.summarizerModels ?? [];
}

/** Minimal model shape needed to resolve a summarizer. */
export interface SummarizerModelRef {
  id: string;
  provider: string;
}

/** Registry surface used to resolve a summarizer (a subset of pi's ModelRegistry). */
export interface SummarizerRegistry<T extends SummarizerModelRef> {
  find(provider: string, modelId: string): T | undefined;
  /** Models with configured auth — pi's ModelRegistry.getAvailable(). */
  getAvailable(): T[];
}

/**
 * Pick the summarizer for the active model's family.
 *
 * Preference order: each candidate on the active provider, then each candidate
 * on any provider with configured auth. Returns undefined when nothing matches,
 * so the caller can fall back to the active model.
 *
 * pi's extension-facing ModelRegistry has never exposed `listProviders()`;
 * scanning `getAvailable()` avoids that crash and skips providers the user has
 * no credentials for (for example a shared model id served by another gateway).
 */
export function pickSummarizerModel<T extends SummarizerModelRef>(
  candidates: string[],
  activeProvider: string | undefined,
  registry: SummarizerRegistry<T>,
): T | undefined {
  if (activeProvider) {
    for (const candidate of candidates) {
      const found = registry.find(activeProvider, candidate);
      if (found) return found;
    }
  }

  const available = registry.getAvailable();
  for (const candidate of candidates) {
    const found = available.find((model) => model.id === candidate);
    if (found) return found;
  }

  return undefined;
}

/** OpenRouter vendor namespace for the active model's family. */
export function resolveOpenRouterVendor(
  model: { id: string; provider: string } | undefined,
): string | undefined {
  return findFamily(model)?.openRouterVendor;
}

// ─── Aggregate savings ─────────────────────────────────────────

export interface SessionStats {
  cacheRead: number;
  input: number;
  modelId?: string;
  provider?: string;
}

export interface AggregateSavings {
  savedUsd: number;
  savedCredits: number;
}

/**
 * Sum savings across stored sessions, pricing each session with its own model
 * tier and billing unit. Legacy sessions without a provider count as USD.
 * A token-plan session without a model ID adds no savings, because no credit
 * tier exists to price it.
 */
export function aggregateSavings(
  sessions: Iterable<SessionStats>,
): AggregateSavings {
  let savedUsd = 0;
  let savedCredits = 0;

  for (const session of sessions) {
    if (resolveDisplayUnit(session.provider) === "credits") {
      const tier = resolveCreditTier(session.modelId);
      if (tier) savedCredits += estimateCreditSavings(session.cacheRead, tier);
      continue;
    }
    const tier = resolvePricingTier(
      session.modelId
        ? { id: session.modelId, provider: session.provider ?? "" }
        : undefined,
    );
    savedUsd += estimateSavings(session.cacheRead, session.input, 0, tier).saved;
  }

  return { savedUsd, savedCredits };
}
