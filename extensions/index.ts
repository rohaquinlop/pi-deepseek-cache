/**
 * DeepSeek Cache Optimization Extension
 *
 * Optimizes DeepSeek prefix cache hit rates by:
 *   1. Freezing dynamic system prompt elements (date, CWD) that bust the cache
 *   2. Tracking cumulative cache read/write tokens across the session
 *   3. Displaying cache hit rate in the TUI status bar
 *   4. Monitoring cache shape stability (system prompt hash changes)
 *   5. Warning when cache hit rate degrades
 *
 * Works with any provider that serves DeepSeek models (e.g. "nan" / NaN Builders,
 * "deepseek", or any provider with a deepseek-* model id).
 *
 * The extension is idempotent — it only modifies the system prompt for
 * DeepSeek-proximate models; other providers pass through unchanged.
 *
 * Install: pi install git:github.com/rhafid/pi-deepseek-cache
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// =============================================================================
// Types
// =============================================================================

interface CacheStats {
  /** Cumulative cache-read tokens across all assistant messages */
  cacheReadTokens: number;
  /** Cumulative cache-write (miss) tokens across all assistant messages */
  cacheWriteTokens: number;
  /** Cumulative input (non-cache) tokens */
  inputTokens: number;
  /** Cumulative output tokens */
  outputTokens: number;
  /** Number of assistant messages processed */
  assistantMessages: number;
  /** Number of full turns completed */
  turnsCompleted: number;
}

interface SessionFingerprint {
  /** The date string captured at session start (YYYY-MM-DD) */
  sessionDate: string;
  /** The CWD captured at session start */
  sessionCwd: string;
  /** Last known system prompt hash for change detection */
  lastSystemPromptHash: number;
  /** Whether we already warned about prompt hash change this session */
  hashChangeWarned: boolean;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check whether the current model looks like a DeepSeek variant.
 *
 * Heuristics (any match → true):
 *   - Provider is "nan" (NaN Builders serves DeepSeek models)
 *   - Provider is "deepseek" (direct DeepSeek API)
 *   - Model id starts with "deepseek-"
 */
function isDeepSeekModel(model: { id: string; provider: string } | undefined): boolean {
  if (!model) return false;
  if (model.provider === "nan") return true;
  if (model.provider === "deepseek") return true;
  if (model.id.toLowerCase().startsWith("deepseek-")) return true;
  return false;
}

/**
 * Simple FNV-1a 32-bit hash — fast, deterministic, good for change detection.
 */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0; // unsigned
}

/**
 * Format a cache hit rate as a human-readable string.
 */
function formatHitRate(rate: number): string {
  if (rate >= 0.95) return `${(rate * 100).toFixed(1)}%`;
  if (rate >= 0.50) return `${(rate * 100).toFixed(0)}%`;
  return `${(rate * 100).toFixed(0)}%`;
}

/**
 * Format a token count with K/M suffix for large numbers.
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Get today's date as YYYY-MM-DD.
 */
function todayISO(): string {
  return new Date().toISOString().split("T")[0];
}

// =============================================================================
// Date & CWD patterns
// =============================================================================

/**
 * Matches "Current date: YYYY-MM-DD" in the system prompt.
 * Does not use $ anchor because the CWD line follows the date line.
 * The date portion is captured in group 1.
 */
const DATE_LINE_RE = /Current date: (\d{4}-\d{2}-\d{2})(?: \(frozen\))?/;

/**
 * Matches "Current working directory: <path>" at the end of the system prompt.
 * The path portion is captured in group 1. Uses $ since CWD is the last line.
 */
const CWD_LINE_RE = /Current working directory: (.+?)\s*$/;

// =============================================================================
// Extension
// =============================================================================

export default function (pi: ExtensionAPI) {
  // ---------------------------------------------------------------------------
  // Session-scoped state — reset on each session_start
  // ---------------------------------------------------------------------------

  let stats: CacheStats = resetStats();
  let fingerprint: SessionFingerprint = {
    sessionDate: todayISO(),
    sessionCwd: "",
    lastSystemPromptHash: 0,
    hashChangeWarned: false,
  };

  function resetStats(): CacheStats {
    return {
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      assistantMessages: 0,
      turnsCompleted: 0,
    };
  }

  // ---------------------------------------------------------------------------
  // session_start — initialize frozen values
  // ---------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    stats = resetStats();
    fingerprint = {
      sessionDate: todayISO(),
      sessionCwd: ctx.cwd,
      lastSystemPromptHash: 0,
      hashChangeWarned: false,
    };

    // Show initial status if UI is available
    if (ctx.hasUI) {
      ctx.ui.setStatus("cache", "Cache: warming up…");
    }
  });

  // ---------------------------------------------------------------------------
  // session_shutdown — clear status
  // ---------------------------------------------------------------------------

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("cache", undefined);
    }
  });

  // ---------------------------------------------------------------------------
  // before_agent_start — freeze date and CWD in system prompt
  // ---------------------------------------------------------------------------

  pi.on("before_agent_start", async (event, ctx) => {
    // Only modify for DeepSeek models
    if (!isDeepSeekModel(ctx.model)) return;

    let prompt = event.systemPrompt;
    let changed = false;

    // 1. Freeze the date
    //    Pi appends "Current date: YYYY-MM-DD" at the end of the system prompt.
    //    We replace it with a frozen version so the prefix cache stays valid
    //    across days within the same session.
    const dateMatch = prompt.match(DATE_LINE_RE);
    if (dateMatch) {
      const frozenDate = `${fingerprint.sessionDate} (frozen)`;
      if (dateMatch[1] !== fingerprint.sessionDate || !dateMatch[0].includes("(frozen)")) {
        prompt = prompt.replace(DATE_LINE_RE, `Current date: ${frozenDate}`);
        changed = true;
      }
    }

    // 2. Freeze the CWD
    //    Pi appends "Current working directory: <path>" at the end of the prompt.
    //    Freezing it prevents cache busting when the user cd's between prompts.
    const cwdMatch = prompt.match(CWD_LINE_RE);
    if (cwdMatch && cwdMatch[1] !== fingerprint.sessionCwd) {
      prompt = prompt.replace(CWD_LINE_RE, `Current working directory: ${fingerprint.sessionCwd}`);
      changed = true;
    }

    if (changed) {
      return { systemPrompt: prompt };
    }
  });

  // ---------------------------------------------------------------------------
  // message_end — accumulate cache usage stats from assistant messages
  // ---------------------------------------------------------------------------

  pi.on("message_end", async (event, _ctx) => {
    // Only track assistant messages with usage data
    if (event.message.role !== "assistant") return;

    const usage = (event.message as any).usage;
    if (!usage || typeof usage !== "object") return;

    // Accumulate tokens
    stats.cacheReadTokens += usage.cacheRead ?? 0;
    stats.cacheWriteTokens += usage.cacheWrite ?? 0;
    stats.inputTokens += usage.input ?? 0;
    stats.outputTokens += usage.output ?? 0;
    stats.assistantMessages += 1;
  });

  // ---------------------------------------------------------------------------
  // turn_end — update status bar, check cache shape, warn on degradation
  // ---------------------------------------------------------------------------

  pi.on("turn_end", async (_event, ctx) => {
    // Only optimize for DeepSeek models
    if (!isDeepSeekModel(ctx.model)) {
      if (ctx.hasUI) {
        ctx.ui.setStatus("cache", undefined);
      }
      return;
    }

    stats.turnsCompleted += 1;

    // --- Cache shape diagnostics ---
    // Hash the system prompt each turn to detect changes that bust the prefix cache.
    try {
      const currentPrompt = ctx.getSystemPrompt();
      const currentHash = fnv1aHash(currentPrompt);

      if (
        fingerprint.lastSystemPromptHash !== 0 &&
        fingerprint.lastSystemPromptHash !== currentHash &&
        !fingerprint.hashChangeWarned
      ) {
        fingerprint.hashChangeWarned = true;
        if (ctx.hasUI) {
          ctx.ui.notify(
            "⚠️ Cache shape changed — system prompt hash differs from previous turn. " +
              "This may reduce prefix cache hit rate.",
            "warning",
          );
        }
      }

      fingerprint.lastSystemPromptHash = currentHash;
    } catch {
      // getSystemPrompt may not be available in all contexts — ignore gracefully
    }

    // --- Update status bar ---
    if (ctx.hasUI) {
      const totalCacheTokens = stats.cacheReadTokens + stats.cacheWriteTokens;
      const hitRate = totalCacheTokens > 0 ? stats.cacheReadTokens / totalCacheTokens : 0;

      const parts: string[] = [];

      if (stats.turnsCompleted > 1 || stats.cacheReadTokens > 0) {
        parts.push(`${formatHitRate(hitRate)} hit`);
      } else {
        parts.push("warming");
      }

      parts.push(`${stats.turnsCompleted} turns`);

      if (stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0) {
        parts.push(`${formatTokens(stats.cacheReadTokens)}R/${formatTokens(stats.cacheWriteTokens)}W`);
      }

      ctx.ui.setStatus("cache", `Cache: ${parts.join(" · ")}`);
    }

    // --- Cache hit rate warning ---
    // If we have enough data (3+ turns) and the hit rate is below 50%, warn.
    if (stats.turnsCompleted >= 3) {
      const totalCacheTokens = stats.cacheReadTokens + stats.cacheWriteTokens;
      if (totalCacheTokens > 0) {
        const hitRate = stats.cacheReadTokens / totalCacheTokens;
        if (hitRate < 0.50 && ctx.hasUI) {
          ctx.ui.notify(
            `⚠️ Cache hit rate is low (${formatHitRate(hitRate)}). ` +
              "System prompt or tool definitions may be changing between turns.",
            "warning",
          );
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Optional command: /cache-stats — show detailed cache statistics
  // ---------------------------------------------------------------------------

  pi.registerCommand("cache-stats", {
    description: "Show DeepSeek cache optimization statistics",
    handler: async (_args, ctx) => {
      const totalCacheTokens = stats.cacheReadTokens + stats.cacheWriteTokens;
      const hitRate = totalCacheTokens > 0 ? stats.cacheReadTokens / totalCacheTokens : 0;

      const lines = [
        "── DeepSeek Cache Stats ──",
        `  Turns:           ${stats.turnsCompleted}`,
        `  Assistant msgs:  ${stats.assistantMessages}`,
        "",
        `  Cache read:      ${formatTokens(stats.cacheReadTokens)} tokens`,
        `  Cache write:     ${formatTokens(stats.cacheWriteTokens)} tokens`,
        `  Input (non-ctx): ${formatTokens(stats.inputTokens)} tokens`,
        `  Output:          ${formatTokens(stats.outputTokens)} tokens`,
        "",
        `  Hit rate:        ${formatHitRate(hitRate)} (${stats.cacheReadTokens}/${totalCacheTokens})`,
        "",
        `  Session date:    ${fingerprint.sessionDate} (frozen)`,
        `  Session CWD:     ${fingerprint.sessionCwd}`,
        `  Prompt hash:     ${fingerprint.lastSystemPromptHash ? `0x${fingerprint.lastSystemPromptHash.toString(16)}` : "n/a"}`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
