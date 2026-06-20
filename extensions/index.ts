/**
 * DeepSeek Cache Optimization Extension
 *
 * Multi-layered prefix cache optimization for DeepSeek models in pi:
 *
 *   P0 — Date/CWD freeze: replaces dynamic system prompt elements with
 *        frozen values captured at session start. This is the root-cause fix
 *        that prevents daily and per-directory cache busting.
 *
 *   P1 — Hit-rate telemetry: accumulates cacheRead/input/cacheWrite/turns
 *        from every assistant message. Persists to disk so stats survive
 *        /reload and restart.
 *
 *   P2 — Cache shape guard: SHA-256 hashes the prompt prefix each turn and
 *        warns when it changes — diagnosing what busted the cache.
 *
 *   P3 — Cache-friendly compaction: intercepts session_before_compact,
 *        summarizes with deepseek-v4-flash at temperature 0, and caches
 *        summaries by SHA-256 hash for deterministic, cache-stable replays.
 *
 *   P4 — TUI overlays: /cache-stats and /cache-graph display live hit-rate
 *        data and ASCII trend charts as overlay popups.
 *
 * Works with any provider serving DeepSeek models (nan, deepseek, or any
 * provider with a deepseek-* model id). Non-DeepSeek models pass through
 * unchanged.
 *
 * Install: pi install npm:@rohaquinlop/pi-deepseek-cache
 */

import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Focusable } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isDeepSeekModel,
  formatTokens,
  todayISO,
  DATE_LINE_RE,
  CWD_LINE_RE,
} from "../lib/helpers.js";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const STATS_DIR = join(homedir(), ".pi", "agent", "extensions", "deepseek-cache");
const STATS_FILE = join(STATS_DIR, "stats.json");
const HISTORY_FILE = join(STATS_DIR, "history.json");
const SUMMARY_CACHE_FILE = join(STATS_DIR, "summary-cache.json");

const SUMMARY_MAX_TOKENS = 8192;
const MAX_HISTORY_POINTS = 100;
const WRITE_DEBOUNCE_MS = 1000;

// DeepSeek pricing per million tokens (USD)
const COST_PER_M_CACHE_READ = 0.027;
const COST_PER_M_INPUT = 0.27;

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface PersistedStats {
  cacheRead: number;
  input: number;
  cacheWrite: number;
  turns: number;
}

interface HistoryPoint {
  turn: number;
  hitRate: number;
  timestamp: number;
}

interface CachedMessage {
  role: string;
  content?: string;
  customType?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Persistence (P1)
// ═══════════════════════════════════════════════════════════════════════════

let extensionCtx: ExtensionContext | undefined;
let pendingStats: PersistedStats | null = null;
let statsTimer: ReturnType<typeof setTimeout> | null = null;
let pendingHistory: HistoryPoint[] | null = null;
let historyTimer: ReturnType<typeof setTimeout> | null = null;

function loadStats(): PersistedStats {
  try {
    if (existsSync(STATS_FILE)) return JSON.parse(readFileSync(STATS_FILE, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    extensionCtx?.ui.notify(`[deepseek-cache] stats load failed (${msg}), reset`, "warning");
  }
  return { cacheRead: 0, input: 0, cacheWrite: 0, turns: 0 };
}

function loadHistory(): HistoryPoint[] {
  try {
    if (existsSync(HISTORY_FILE)) return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    extensionCtx?.ui.notify(`[deepseek-cache] history load failed (${msg}), reset`, "warning");
  }
  return [];
}

function loadSummaryCache(): Map<string, string> {
  try {
    if (existsSync(SUMMARY_CACHE_FILE)) {
      return new Map(Object.entries(JSON.parse(readFileSync(SUMMARY_CACHE_FILE, "utf-8"))));
    }
  } catch {
    // silent — summary cache is best-effort
  }
  return new Map();
}

function scheduleSaveStats(s: PersistedStats) {
  pendingStats = s;
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    const data = pendingStats;
    pendingStats = null;
    if (!data) return;
    (async () => {
      try {
        if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
        await writeFile(STATS_FILE, JSON.stringify(data, null, 2));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        extensionCtx?.ui.notify(`[deepseek-cache] stats save failed: ${msg}`, "error");
      }
    })();
  }, WRITE_DEBOUNCE_MS);
}

function scheduleSaveHistory(h: HistoryPoint[]) {
  pendingHistory = h;
  if (historyTimer) return;
  historyTimer = setTimeout(() => {
    historyTimer = null;
    const data = pendingHistory;
    pendingHistory = null;
    if (!data) return;
    (async () => {
      try {
        if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
        await writeFile(HISTORY_FILE, JSON.stringify(data.slice(-MAX_HISTORY_POINTS), null, 2));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        extensionCtx?.ui.notify(`[deepseek-cache] history save failed: ${msg}`, "error");
      }
    })();
  }, WRITE_DEBOUNCE_MS);
}

function saveSummaryCacheSync(cache: Map<string, string>) {
  try {
    if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
    const obj: Record<string, string> = {};
    for (const [k, v] of cache) obj[k] = v;
    writeFileSync(SUMMARY_CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch {
    // best-effort
  }
}

function flushPendingWrites() {
  if (statsTimer) { clearTimeout(statsTimer); statsTimer = null; }
  if (pendingStats) {
    try {
      if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
      writeFileSync(STATS_FILE, JSON.stringify(pendingStats, null, 2));
    } catch { /* best-effort */ }
    pendingStats = null;
  }
  if (historyTimer) { clearTimeout(historyTimer); historyTimer = null; }
  if (pendingHistory) {
    try {
      if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
      writeFileSync(HISTORY_FILE, JSON.stringify(pendingHistory.slice(-MAX_HISTORY_POINTS), null, 2));
    } catch { /* best-effort */ }
    pendingHistory = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TUI Overlay Components (P4)
// ═══════════════════════════════════════════════════════════════════════════

class CacheStatsOverlay implements Focusable {
  readonly width = 54;
  focused = false;
  private stats: PersistedStats;
  private theme: any;
  private done: () => void;

  constructor(theme: any, stats: PersistedStats, done: () => void) {
    this.theme = theme;
    this.stats = stats;
    this.done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) this.done();
  }

  render(_width: number): string[] {
    const { cacheRead, input, cacheWrite, turns } = this.stats;
    const denom = cacheRead + input;
    const hitRate = denom ? ((cacheRead / denom) * 100).toFixed(1) : "0.0";
    const saved = (cacheRead / 1_000_000) * (COST_PER_M_INPUT - COST_PER_M_CACHE_READ);
    const savedStr = saved >= 0.01 ? `$${saved.toFixed(2)}` : "< $0.01";
    const th = this.theme;
    const w = this.width;
    const inner = w - 2;

    const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
    const row = (s: string) => th.fg("border", "│") + pad(s) + th.fg("border", "│");
    const label = (k: string, v: string) =>
      `  ${th.fg("dim", k.padEnd(18))}${th.fg("accent", v)}`;

    return [
      th.fg("border", `╭${"─".repeat(inner)}╮`),
      row(` ${th.fg("accent", "⚡ DeepSeek Cache Stats")}`),
      row(""),
      row(label("Hit rate", `${hitRate}%`)),
      row(label("Cache read (hit)", `${cacheRead.toLocaleString()} tokens`)),
      row(label("Cache write (miss)", `${cacheWrite.toLocaleString()} tokens`)),
      row(label("Input (non-cache)", `${input.toLocaleString()} tokens`)),
      row(label("Turns", `${turns}`)),
      row(label("Est. savings", `${th.fg("accent", savedStr)}`)),
      row(""),
      row(` ${th.fg("dim", "Esc / Enter to close")}`),
      th.fg("border", `╰${"─".repeat(inner)}╯`),
    ];
  }

  invalidate(): void {}
  dispose(): void {}
}

class CacheGraphOverlay implements Focusable {
  readonly width = 60;
  focused = false;
  private history: HistoryPoint[];
  private theme: any;
  private done: () => void;

  constructor(theme: any, history: HistoryPoint[], done: () => void) {
    this.theme = theme;
    this.history = history;
    this.done = done;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) this.done();
  }

  render(_width: number): string[] {
    const th = this.theme;
    const inner = this.width - 2;
    const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
    const row = (s: string) => th.fg("border", "│") + pad(s) + th.fg("border", "│");

    if (this.history.length < 2) {
      return [
        th.fg("border", `╭${"─".repeat(inner)}╮`),
        row(` ${th.fg("accent", "⚡ Cache Hit Rate Trend")}`),
        row(""),
        row(`  ${th.fg("dim", "Need 2+ turns with cache data for a trend")}`),
        row(`  ${th.fg("dim", "Keep chatting and try again")}`),
        row(""),
        row(` ${th.fg("dim", "Esc to close")}`),
        th.fg("border", `╰${"─".repeat(inner)}╯`),
      ];
    }

    const rates = this.history.map((h) => h.hitRate);
    const maxRate = Math.max(...rates, 1);
    const minRate = Math.min(...rates, 0);
    const range = maxRate - minRate || 1;
    const chartH = 8;
    const maxW = 44;
    const step = Math.max(1, Math.floor(this.history.length / maxW));
    const data = this.history.filter((_, i) => i % step === 0).slice(-maxW);
    const chartW = data.length;

    // Build chart rows
    const chart: string[] = [];
    for (let r = chartH; r >= 0; r--) {
      const threshold = minRate + range * (r / chartH);
      let line = r === chartH ? `${maxRate.toFixed(0)}%`.padStart(4) :
                 r === 0 ? `${minRate.toFixed(0)}%`.padStart(4) : "    ";
      for (const p of data) {
        line += p.hitRate >= threshold ? "█" : " ";
      }
      chart.push(line);
    }

    // X axis
    chart.push("    " + "─".repeat(chartW));

    // X labels — first / mid / last
    const first = String(data[0].turn);
    const last = String(data[data.length - 1].turn);
    const midIdx = Math.floor(data.length / 2);
    const mid = data.length > 2 ? String(data[midIdx].turn) : "";
    const xChars = new Array(chartW).fill(" ");

    for (let i = 0; i < first.length && i < chartW; i++) xChars[i] = first[i];
    if (mid) {
      const start = Math.floor((chartW - mid.length) / 2);
      for (let i = 0; i < mid.length; i++) {
        const pos = start + i;
        if (pos >= 0 && pos < chartW) xChars[pos] = mid[i];
      }
    }
    for (let i = 0; i < last.length; i++) {
      const pos = chartW - last.length + i;
      if (pos >= 0 && pos < chartW) xChars[pos] = last[i];
    }
    chart.push("    " + xChars.join(""));

    const lines = [
      th.fg("border", `╭${"─".repeat(inner)}╮`),
      row(` ${th.fg("accent", `⚡ Cache Hit Rate Trend (${this.history.length} points)`)}`),
      row(""),
    ];
    for (const c of chart) lines.push(row(`  ${c}`));
    lines.push(row(""));
    lines.push(row(` ${th.fg("dim", "Esc to close")}`));
    lines.push(th.fg("border", `╰${"─".repeat(inner)}╯`));

    return lines;
  }

  invalidate(): void {}
  dispose(): void {}
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  // ────── P1: Restore persisted state ──────
  const persisted = loadStats();
  let cacheRead = persisted.cacheRead;
  let input = persisted.input;
  let cacheWrite = persisted.cacheWrite;
  let turns = persisted.turns;

  const hitRateHistory = loadHistory();
  let lastHitRate = hitRateHistory.length > 0
    ? hitRateHistory[hitRateHistory.length - 1].hitRate
    : 0;

  // ────── P0: Session fingerprint ──────
  let sessionDate = todayISO();
  let sessionCwd = "";

  // ────── P2: Prefix guard state ──────
  let lastPrefixHash: string | undefined;
  let prefixBreaks = 0;
  let hashChangeWarned = false;

  // ────── P3: Summary cache ──────
  const summaryCache = loadSummaryCache();

  // ────── Helper: set ctx for persistence error reporting ──────
  const setCtx = (ctx: ExtensionContext) => { extensionCtx = ctx; };

  // ═══════════════════════════════════════════════════════════════════════
  // session_start
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("session_start", async (_event, ctx) => {
    setCtx(ctx);
    sessionDate = todayISO();
    sessionCwd = ctx.cwd;
    lastPrefixHash = undefined;
    prefixBreaks = 0;
    hashChangeWarned = false;

    if (ctx.hasUI) {
      ctx.ui.setStatus("cache", "Cache: warming up…");
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // session_shutdown — flush writes, clear status
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("session_shutdown", async (_event, ctx) => {
    flushPendingWrites();
    if (ctx.hasUI) ctx.ui.setStatus("cache", undefined);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P0: before_agent_start — freeze date and CWD
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("before_agent_start", async (event, ctx) => {
    setCtx(ctx);
    if (!isDeepSeekModel(ctx.model)) return;

    let prompt = event.systemPrompt;
    let changed = false;

    const dateMatch = prompt.match(DATE_LINE_RE);
    if (dateMatch) {
      const frozenDate = `${sessionDate} (frozen)`;
      if (dateMatch[1] !== sessionDate || !dateMatch[0].includes("(frozen)")) {
        prompt = prompt.replace(DATE_LINE_RE, `Current date: ${frozenDate}`);
        changed = true;
      }
    }

    const cwdMatch = prompt.match(CWD_LINE_RE);
    if (cwdMatch && cwdMatch[1] !== sessionCwd) {
      prompt = prompt.replace(CWD_LINE_RE, `Current working directory: ${sessionCwd}`);
      changed = true;
    }

    if (changed) return { systemPrompt: prompt };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P1: message_end — accumulate cache stats
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("message_end", async (event, ctx) => {
    setCtx(ctx);
    if (event.message.role !== "assistant") return;
    const u = (event.message as any).usage;
    if (!u) return;

    cacheRead += u.cacheRead ?? 0;
    input += u.input ?? 0;
    cacheWrite += u.cacheWrite ?? 0;
    turns += 1;

    const stats: PersistedStats = { cacheRead, input, cacheWrite, turns };
    scheduleSaveStats(stats);

    const denom = cacheRead + input;
    const rate = denom ? (cacheRead / denom) * 100 : 0;

    if (ctx.hasUI) {
      ctx.ui.setStatus("cache", `Cache: ${rate.toFixed(1)}% · ${turns}t · ${formatTokens(cacheRead)}R`);
    }

    // Track history on rate change
    const rateKey = rate.toFixed(1);
    const lastKey = lastHitRate.toFixed(1);
    if (rateKey !== lastKey) {
      hitRateHistory.push({ turn: turns, hitRate: rate, timestamp: Date.now() });
      if (hitRateHistory.length > MAX_HISTORY_POINTS) {
        hitRateHistory.splice(0, hitRateHistory.length - MAX_HISTORY_POINTS);
      }
      lastHitRate = rate;
      scheduleSaveHistory(hitRateHistory);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P2: before_provider_request — prefix hash diagnostics
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("before_provider_request", (event, ctx) => {
    setCtx(ctx);
    if (!isDeepSeekModel(ctx.model)) return;

    const payload = event.payload as { messages?: CachedMessage[] };
    const msgs = payload.messages ?? [];
    if (msgs.length === 0) return;

    // Hash all messages except the last (which is the current user message)
    const currentHash = createHash("sha256")
      .update(JSON.stringify(msgs.slice(0, -1)))
      .digest("hex");

    if (lastPrefixHash !== undefined && currentHash !== lastPrefixHash && !hashChangeWarned) {
      prefixBreaks++;
      hashChangeWarned = true;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `⚠️ Cache prefix changed (break #${prefixBreaks}) — hit rate may drop this turn`,
          "warning",
        );
      }
    }
    lastPrefixHash = currentHash;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P3: session_before_compact — cache-friendly deterministic compaction
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("session_before_compact", async (event, ctx) => {
    setCtx(ctx);
    flushPendingWrites();

    const { preparation, signal } = event;
    const { messagesToSummarize, firstKeptEntryId, tokensBefore, previousSummary } = preparation;

    // Only intercept if we're on a DeepSeek model
    if (!isDeepSeekModel(ctx.model)) return;

    const history = serializeConversation(convertToLlm(messagesToSummarize));
    const text = previousSummary
      ? `[Previous summary]\n${previousSummary}\n\n[New history]\n${history}`
      : history;

    const key = createHash("sha256").update(text).digest("hex");
    let summary = summaryCache.get(key);

    if (!summary) {
      summary = await summarizeWithFlash(text, ctx, signal);
      if (!summary) return; // fall back to default compaction
      summaryCache.set(key, summary);
      saveSummaryCacheSync(summaryCache);
    }

    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        details: { summarizer: "deepseek-v4-flash" },
      },
    };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P4: Commands — /cache-stats, /cache-graph, /cache-reset
  // ═══════════════════════════════════════════════════════════════════════

  pi.registerCommand("cache-stats", {
    description: "DeepSeek cache hit rate statistics",
    handler: async (_args, ctx) => {
      setCtx(ctx);
      await ctx.ui.custom(
        (_tui, theme, _kb, done) =>
          new CacheStatsOverlay(theme, { cacheRead, input, cacheWrite, turns }, done),
        { overlay: true },
      );
    },
  });

  pi.registerCommand("cache-graph", {
    description: "DeepSeek cache hit rate trend chart",
    handler: async (_args, ctx) => {
      setCtx(ctx);
      await ctx.ui.custom(
        (_tui, theme, _kb, done) =>
          new CacheGraphOverlay(theme, hitRateHistory, done),
        { overlay: true },
      );
    },
  });

  pi.registerCommand("cache-reset", {
    description: "Reset DeepSeek cache statistics",
    handler: async (_args, ctx) => {
      setCtx(ctx);
      cacheRead = 0;
      input = 0;
      cacheWrite = 0;
      turns = 0;
      hitRateHistory.length = 0;
      lastHitRate = 0;
      lastPrefixHash = undefined;
      prefixBreaks = 0;
      hashChangeWarned = false;
      summaryCache.clear();
      flushPendingWrites();
      try {
        if (existsSync(STATS_FILE)) unlinkSync(STATS_FILE);
        if (existsSync(HISTORY_FILE)) unlinkSync(HISTORY_FILE);
        if (existsSync(SUMMARY_CACHE_FILE)) unlinkSync(SUMMARY_CACHE_FILE);
      } catch { /* best-effort */ }
      ctx.ui.notify("Cache stats reset", "info");
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// P3 helper: summarize with deepseek-v4-flash at temperature 0
// ═══════════════════════════════════════════════════════════════════════════

async function summarizeWithFlash(
  text: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  // Try the current model's provider first, then fall back to known providers
  let model = ctx.modelRegistry.find("nan", "deepseek-v4-flash")
    ?? ctx.modelRegistry.find("deepseek", "deepseek-v4-flash");

  // Last resort: search any provider
  if (!model) {
    for (const prov of ctx.modelRegistry.listProviders()) {
      model = ctx.modelRegistry.find(prov, "deepseek-v4-flash");
      if (model) break;
    }
  }

  if (!model) {
    ctx.ui.notify("deepseek-cache: flash model not found, skipping cache-friendly compaction", "warning");
    return;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    ctx.ui.notify("deepseek-cache: flash auth failed, falling back to default compaction", "warning");
    return;
  }

  try {
    const response = await complete(
      model,
      {
        messages: [{
          role: "user" as const,
          content: [{
            type: "text" as const,
            text:
              "Summarize this conversation history into structured markdown. " +
              "Cover: ① goal ② key decisions & rationale ③ code/file changes " +
              "④ current progress ⑤ blockers & open questions ⑥ next steps. " +
              "Be thorough — this summary replaces the original history.\n\n" + text,
          }],
          timestamp: Date.now(),
        }],
        temperature: 0,
      },
      { apiKey: auth.apiKey, headers: auth.headers, maxTokens: SUMMARY_MAX_TOKENS, signal },
    );

    const summary = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return summary.trim() || undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`deepseek-cache: flash summarization failed (${msg}), falling back to default compaction`, "error");
    return;
  }
}
