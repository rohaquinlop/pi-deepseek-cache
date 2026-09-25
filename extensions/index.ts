/**
 * Prefix Cache Optimization Extension
 *
 * Multi-layered prefix cache optimization for registered model families in pi:
 *
 *   P0 — Date/CWD freeze: replaces dynamic system prompt elements with
 *        frozen values captured at session start. This is the root-cause fix
 *        that prevents daily and per-directory cache busting.
 *
 *   P1 — Hit-rate telemetry: accumulates cacheRead/input/cacheWrite/turns
 *        from every assistant message. Per-session stats are stored in
 *        stats-{sessionId}.json / history-{sessionId}.json files so concurrent
 *        pi sessions never race on the same file. The status line shows THIS
 *        session's hit rate only. /cache-stats shows both this session and
 *        an aggregate across all sessions.
 *
 *   P2 — Cache shape guard: SHA-256 hashes the prompt prefix each turn and
 *        warns when it changes — diagnosing what busted the cache.
 *
 *   P3 — Cache-friendly compaction: intercepts session_before_compact,
 *        summarizes with deepseek-v4-flash at temperature 0, and caches
 *        summaries by SHA-256 hash for deterministic, cache-stable replays.
 *
 *   P4 — TUI overlays: /cache-stats and /cache-graph display hit-rate
 *        data, cost estimates, and ASCII trend charts as overlay popups.
 *
 *   P5 — OpenRouter auto-pin: on OpenRouter, prefix caching only hits when
 *        every request lands on the same upstream provider. Auto-detects the
 *        cheapest cache-capable upstream and pins it via the `provider`
 *        routing object (order + allow_fallbacks:false).
 *
 * Works with any provider serving a registered cache family — today DeepSeek
 * and Xiaomi MiMo. Detection, pricing, plan credits, and the summarizer model
 * all come from the registry in lib/families.ts. Unregistered models pass
 * through unchanged.
 *
 * Install: pi install npm:@rohaquinlop/pi-deepseek-cache
 */

import { complete } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  convertToLlm,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  visibleWidth,
  type Focusable,
} from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  todayISO,
  calcHitRate,
  estimateSavings,
  isDateFrozen,
  isCwdFrozen,
  applyDateFreeze,
  applyCwdFreeze,
  pickCacheCapableUpstream,
  openRouterEndpointsUrl,
  computeProviderPin,
  pinEntryFresh,
  mergePinLookupResult,
  type OpenRouterEndpoint,
  type PinCacheEntry,
  type PricingTier,
} from "../lib/helpers.js";
import {
  FALLBACK_PRICING,
  aggregateSavings,
  estimateCreditSavings,
  formatCredits,
  isCacheOptimizedModel,
  pickSummarizerModel,
  resolveCreditTier,
  resolveDisplayUnit,
  resolveOpenRouterVendor,
  resolvePricingTier,
  resolveSummarizerCandidates,
  type CreditTier,
} from "../lib/families.js";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const STATS_DIR = join(
  homedir(),
  ".pi",
  "agent",
  "extensions",
  "deepseek-cache",
);
const SUMMARY_CACHE_FILE = join(STATS_DIR, "summary-cache.json");

const SUMMARY_MAX_TOKENS = 8192;
const MAX_HISTORY_POINTS = 100;
const WRITE_DEBOUNCE_MS = 1000;
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SUMMARY_CACHE_MAX_ENTRIES = 500;

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface PersistedStats {
  cacheRead: number;
  input: number;
  cacheWrite: number;
  turns: number;
  /** Model and provider of the session, for correct multi-model aggregates. */
  modelId?: string;
  provider?: string;
  /** P5: set once auto-pin injection has occurred this session. */
  openrouterPinned?: boolean;
}

type AggregateStats = PersistedStats & {
  sessionCount: number;
  savedUsd: number;
  savedCredits: number;
};

interface DisplayContext {
  pricing: PricingTier;
  creditTier?: CreditTier;
  unit: "usd" | "credits";
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
// P5: OpenRouter upstream detection (module-level, shared across sessions)
// ═══════════════════════════════════════════════════════════════════════════

const PIN_LOOKUP_TIMEOUT_MS = 10_000;

const pinCache = new Map<string, PinCacheEntry>();
const inflightLookups = new Map<string, Promise<void>>();

async function fetchPinnedUpstream(
  modelId: string,
  vendor: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(openRouterEndpointsUrl(modelId, vendor), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(PIN_LOOKUP_TIMEOUT_MS),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      data?: { endpoints?: OpenRouterEndpoint[] };
    };
    return pickCacheCapableUpstream(json.data?.endpoints ?? []);
  } catch {
    return undefined;
  }
}

/**
 * Return the detected pin target for an OpenRouter model, kicking off a
 * background endpoints-API lookup when none is cached (or the cache expired).
 * Synchronous by design — requests go out unpinned until a lookup resolves;
 * expired entries keep serving until the refresh lands.
 */
/**
 * Return the detected pin target for an OpenRouter model, kicking off a
 * background endpoints-API lookup when none is cached (or the cache expired).
 * Synchronous by design — requests go out unpinned until a lookup resolves;
 * expired entries keep serving until the refresh lands. A failed refresh
 * keeps any previously detected upstream but degrades to the short retry TTL.
 */
function ensurePinnedUpstream(modelId: string, vendor: string): string | undefined {
  const entry = pinCache.get(modelId);
  if (pinEntryFresh(entry, Date.now())) return entry!.slug;

  if (!inflightLookups.has(modelId)) {
    const lookup = fetchPinnedUpstream(modelId, vendor)
      .then((slug) => {
        pinCache.set(modelId, mergePinLookupResult(entry, slug, Date.now()));
      })
      .finally(() => {
        inflightLookups.delete(modelId);
      });
    inflightLookups.set(modelId, lookup);
  }
  return entry?.slug; // stale value while refreshing, undefined on first call
}

// ═══════════════════════════════════════════════════════════════════════════
// Persistence (P1) — per-session files
// ═══════════════════════════════════════════════════════════════════════════

let extensionCtx: ExtensionContext | undefined;
let pendingStats: PersistedStats | null = null;
let statsTimer: ReturnType<typeof setTimeout> | null = null;
let pendingHistory: HistoryPoint[] | null = null;
let historyTimer: ReturnType<typeof setTimeout> | null = null;

function statsPath(sessionId: string): string {
  return join(STATS_DIR, `stats-${sessionId}.json`);
}

function historyPath(sessionId: string): string {
  return join(STATS_DIR, `history-${sessionId}.json`);
}

function loadSummaryCache(): Map<string, string> {
  try {
    if (existsSync(SUMMARY_CACHE_FILE)) {
      return new Map(
        Object.entries(JSON.parse(readFileSync(SUMMARY_CACHE_FILE, "utf-8"))),
      );
    }
  } catch {
    // silent — summary cache is best-effort
  }
  return new Map();
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

function evictSummaryCacheIfNeeded(cache: Map<string, string>): void {
  while (cache.size > SUMMARY_CACHE_MAX_ENTRIES) {
    const firstKey = cache.keys().next().value;
    if (firstKey) cache.delete(firstKey);
  }
}

/**
 * Delete stats-*.json and history-*.json files older than 30 days.
 */
function cleanupOldSessions() {
  try {
    if (!existsSync(STATS_DIR)) return;
    const cutoff = Date.now() - MAX_SESSION_AGE_MS;
    const files = readdirSync(STATS_DIR);
    for (const file of files) {
      if (
        (file.startsWith("stats-") && file.endsWith(".json")) ||
        (file.startsWith("history-") && file.endsWith(".json"))
      ) {
        try {
          const filePath = join(STATS_DIR, file);
          const st = statSync(filePath);
          if (st.mtimeMs < cutoff) {
            unlinkSync(filePath);
          }
        } catch {
          // best-effort per file
        }
      }
    }
  } catch {
    // best-effort
  }
}

const CLEANUP_MARKER = ".last-cleanup";

function maybeCleanupOldSessions(): void {
  try {
    const markerPath = join(STATS_DIR, CLEANUP_MARKER);
    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    if (existsSync(markerPath)) {
      const lastCleanup = parseInt(readFileSync(markerPath, "utf8"), 10);
      if (now - lastCleanup < ONE_DAY_MS) return; // skip — cleaned up recently
    }

    cleanupOldSessions();
    writeFileSync(markerPath, String(now), "utf8");
  } catch {
    // If marker file fails, still run cleanup (best-effort throttling)
    cleanupOldSessions();
  }
}

async function aggregateAllSessionsAsync(): Promise<AggregateStats> {
  const agg: PersistedStats = {
    cacheRead: 0,
    input: 0,
    cacheWrite: 0,
    turns: 0,
  };
  let sessions: PersistedStats[] = [];
  try {
    if (!existsSync(STATS_DIR)) {
      return { ...agg, sessionCount: 0, savedUsd: 0, savedCredits: 0 };
    }
    const files = readdirSync(STATS_DIR); // directory listing is fast — sync is fine

    const statsFiles = files.filter(f => f.startsWith("stats-") && f.endsWith(".json"));

    const results = await Promise.all(
      statsFiles.map(async (file) => {
        try {
          const raw = await readFile(join(STATS_DIR, file), "utf8");
          return JSON.parse(raw) as PersistedStats;
        } catch {
          return null;
        }
      })
    );

    sessions = results.filter((r): r is PersistedStats => r !== null);

    for (const data of sessions) {
      agg.cacheRead += data.cacheRead ?? 0;
      agg.input += data.input ?? 0;
      agg.cacheWrite += data.cacheWrite ?? 0;
      agg.turns += data.turns ?? 0;
    }
  } catch {
    // best-effort
  }
  const { savedUsd, savedCredits } = aggregateSavings(sessions);
  return {
    ...agg,
    sessionCount: sessions.length,
    savedUsd,
    savedCredits,
  };
}

function scheduleSaveStats(s: PersistedStats, sid: string) {
  if (!sid) return;
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
        await writeFile(statsPath(sid), JSON.stringify(data, null, 2));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        extensionCtx?.ui.notify(
          `[deepseek-cache] stats save failed: ${msg}`,
          "error",
        );
      }
    })();
  }, WRITE_DEBOUNCE_MS);
}

function scheduleSaveHistory(h: HistoryPoint[], sid: string) {
  if (!sid) return;
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
        await writeFile(
          historyPath(sid),
          JSON.stringify(data.slice(-MAX_HISTORY_POINTS), null, 2),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        extensionCtx?.ui.notify(
          `[deepseek-cache] history save failed: ${msg}`,
          "error",
        );
      }
    })();
  }, WRITE_DEBOUNCE_MS);
}

function flushPendingWrites(sid: string) {
  if (statsTimer) {
    clearTimeout(statsTimer);
    statsTimer = null;
  }
  if (pendingStats && sid) {
    try {
      if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
      writeFileSync(statsPath(sid), JSON.stringify(pendingStats, null, 2));
    } catch {
      /* best-effort */
    }
    pendingStats = null;
  }
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
  }
  if (pendingHistory && sid) {
    try {
      if (!existsSync(STATS_DIR)) mkdirSync(STATS_DIR, { recursive: true });
      writeFileSync(
        historyPath(sid),
        JSON.stringify(pendingHistory.slice(-MAX_HISTORY_POINTS), null, 2),
      );
    } catch {
      /* best-effort */
    }
    pendingHistory = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TUI Overlay Components (P4)
// ═══════════════════════════════════════════════════════════════════════════

class CacheStatsOverlay implements Focusable {
  readonly width = 58;
  focused = false;
  private stats: PersistedStats;
  private aggregate?: AggregateStats;
  private prefixBreaks = 0;
  private theme: any;
  private done: () => void;
  private display: DisplayContext;
  private pin?: { upstream?: string; userOverride: boolean };

  constructor(
    theme: any,
    stats: PersistedStats,
    done: () => void,
    aggregate?: AggregateStats,
    prefixBreaks?: number,
    display?: DisplayContext,
    pin?: { upstream?: string; userOverride: boolean },
  ) {
    this.theme = theme;
    this.stats = stats;
    this.done = done;
    this.aggregate = aggregate;
    if (prefixBreaks !== undefined) this.prefixBreaks = prefixBreaks;
    this.display = display ?? { pricing: FALLBACK_PRICING, unit: "usd" };
    if (pin !== undefined) this.pin = pin;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "return")) this.done();
  }

  private formatUsd(saved: number): string {
    if (saved <= 0) return "$0.00";
    return saved >= 0.01 ? `$${saved.toFixed(2)}` : "< $0.01";
  }

  private sessionSavings(s: PersistedStats): string | null {
    const { unit, creditTier, pricing } = this.display;
    if (unit === "credits") {
      if (!creditTier) return null;
      return formatCredits(estimateCreditSavings(s.cacheRead, creditTier));
    }
    const { saved } = estimateSavings(s.cacheRead, s.input, 0, pricing);
    return this.formatUsd(saved);
  }

  private aggregateSavingsText(): string | null {
    const agg = this.aggregate;
    if (!agg) return null;
    const parts: string[] = [];
    if (agg.savedUsd > 0 || agg.savedCredits <= 0) {
      parts.push(this.formatUsd(agg.savedUsd));
    }
    if (agg.savedCredits > 0) parts.push(formatCredits(agg.savedCredits));
    return parts.join(" + ");
  }

  private sectionBlock(
    title: string,
    s: PersistedStats,
    turnsLabel?: string,
    savingsText?: string | null,
  ): string[] {
    const th = this.theme;
    const inner = this.width - 2;
    const { cacheRead, input, cacheWrite, turns } = s;
    const hitRate = calcHitRate(cacheRead, input, cacheWrite).toFixed(1);
    const savings =
      savingsText === undefined ? this.sessionSavings(s) : savingsText;
    const pad = (s: string) =>
      s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
    const row = (s: string) =>
      th.fg("border", "│") + pad(s) + th.fg("border", "│");
    const label = (k: string, v: string) =>
      `  ${th.fg("dim", k.padEnd(18))}${th.fg("accent", v)}`;
    const showCacheWrite = cacheWrite > 0;
    const turnStr = turnsLabel ?? `${turns}`;

    const rows: string[] = [
      row(` ${th.fg("accent", title)}`),
      row(""),
      row(label("Hit rate", `${hitRate}%`)),
      row(label("Cache hits", `${cacheRead.toLocaleString()} tokens`)),
    ];

    if (showCacheWrite) {
      rows.push(
        row(label("Cache writes", `${cacheWrite.toLocaleString()} tokens`)),
      );
    }

    rows.push(
      row(label("Cache misses", `${input.toLocaleString()} tokens`)),
      row(label("Turns", turnStr)),
    );

    if (savings !== null) {
      rows.push(row(label("Est. savings", `${th.fg("accent", savings)}`)));
    }

    return rows;
  }

  render(_width: number): string[] {
    const th = this.theme;
    const inner = this.width - 2;
    const pad = (s: string) =>
      s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
    const row = (s: string) =>
      th.fg("border", "│") + pad(s) + th.fg("border", "│");

    const lines: string[] = [
      th.fg("border", `╭${"─".repeat(inner)}╮`),
      ...this.sectionBlock("⚡ This Session", this.stats),
    ];

    if (this.aggregate && this.aggregate.sessionCount > 1) {
      lines.push(row(""));
      lines.push(
        row(
          ` ${th.fg("dim", `─── All Sessions (${this.aggregate.sessionCount}) ───`)}`,
        ),
      );
      lines.push(
        ...this.sectionBlock(
          "📊 Aggregate",
          {
            cacheRead: this.aggregate.cacheRead,
            input: this.aggregate.input,
            cacheWrite: this.aggregate.cacheWrite,
            turns: this.aggregate.turns,
          },
          `${this.aggregate.turns}`,
          this.aggregateSavingsText(),
        ),
      );
    }

    lines.push(row(""));
    if (this.pin) {
      const value = this.pin.userOverride
        ? "user-managed"
        : this.pin.upstream
          ? this.pin.upstream
          : "detecting…";
      lines.push(
        row(
          `  ${th.fg("dim", "OpenRouter pin".padEnd(18))}${th.fg("accent", value)}`,
        ),
      );
    }
    if (this.prefixBreaks > 0) {
      lines.push(
        row(
          `  ${th.fg("dim", "Prefix breaks".padEnd(18))}${th.fg("accent", String(this.prefixBreaks))}`,
        ),
      );
    }
    lines.push(row(` ${th.fg("dim", "Esc / Enter to close")}`));
    lines.push(th.fg("border", `╰${"─".repeat(inner)}╯`));

    return lines;
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
    const pad = (s: string) =>
      s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
    const row = (s: string) =>
      th.fg("border", "│") + pad(s) + th.fg("border", "│");

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
      let line =
        r === chartH
          ? `${maxRate.toFixed(0)}%`.padStart(4)
          : r === 0
            ? `${minRate.toFixed(0)}%`.padStart(4)
            : "    ";
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
    chart.push("    Turn →");

    const lines = [
      th.fg("border", `╭${"─".repeat(inner)}╮`),
      row(
        ` ${th.fg("accent", `⚡ Cache Hit Rate Trend (${this.history.length} points)`)}`,
      ),
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
  // ────── P1: Per-session runtime state (counters start at 0) ──────
  let sessionId = "";
  let cacheRead = 0;
  let input = 0;
  let cacheWrite = 0;
  let turns = 0;

  const hitRateHistory: HistoryPoint[] = [];
  let lastHitRate = 0;

  // ────── P0: Session fingerprint ──────
  let sessionDate = todayISO();
  let sessionCwd = "";

  // ────── P2: Prefix guard state ──────
  let lastPrefixHash: string | undefined;
  let warnedThisTurn = false;
  let prefixBreaks = 0;

  // ────── P5: OpenRouter auto-pin state ──────
  let openrouterPinnedThisSession = false;
  let openrouterUserOverride = false;

  // ────── P3: Summary cache ──────
  const summaryCache = loadSummaryCache();

  // ────── Helper: set ctx for persistence error reporting ──────
  const setCtx = (ctx: ExtensionContext) => {
    extensionCtx = ctx;
  };

  // ═══════════════════════════════════════════════════════════════════════
  // session_start
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("session_start", async (_event, ctx) => {
    setCtx(ctx);

    // Get per-session ID
    sessionId = ctx.sessionManager?.getSessionId?.() ?? "";

    // Reset all counters for fresh session
    cacheRead = 0;
    input = 0;
    cacheWrite = 0;
    turns = 0;
    hitRateHistory.length = 0;
    lastHitRate = 0;

    // P0
    sessionDate = todayISO();
    sessionCwd = ctx.cwd;
    lastPrefixHash = undefined;
    warnedThisTurn = false;
    prefixBreaks = 0;
    openrouterPinnedThisSession = false;
    openrouterUserOverride = false;

    // Cleanup old session files
    maybeCleanupOldSessions();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // session_shutdown — flush writes, clear status
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("session_shutdown", async (_event, ctx) => {
    flushPendingWrites(sessionId);
    if (ctx.hasUI) ctx.ui.setStatus("cache", undefined);
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P0: before_agent_start — freeze date and CWD
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("before_agent_start", async (event, ctx) => {
    setCtx(ctx);
    if (!isCacheOptimizedModel(ctx.model)) return;

    let prompt = event.systemPrompt;
    let changed = false;

    if (!isDateFrozen(prompt, sessionDate)) {
      prompt = applyDateFreeze(prompt, sessionDate);
      changed = true;
    }
    if (!isCwdFrozen(prompt, sessionCwd)) {
      prompt = applyCwdFreeze(prompt, sessionCwd);
      changed = true;
    }

    if (changed) return { systemPrompt: prompt };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P1: message_end — accumulate cache stats (per-session)
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

    const stats: PersistedStats = {
      cacheRead,
      input,
      cacheWrite,
      turns,
      modelId: ctx.model?.id,
      provider: ctx.model?.provider,
    };
    if (openrouterPinnedThisSession) stats.openrouterPinned = true;
    scheduleSaveStats(stats, sessionId);

    // Use total prompt tokens as denominator for accurate hit rate.
    // For DeepSeek: cacheWrite=0, input=miss_tokens → total=prompt_tokens.
    // For Anthropic: cacheWrite holds actual writes, included in total.
    const rate = calcHitRate(cacheRead, input, cacheWrite);

    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "cache",
        ctx.ui.theme.fg("dim", `Cache ${rate.toFixed(1)}%`),
      );
    }

    // Track history on rate change
    const rateKey = rate.toFixed(2);
    const lastKey = lastHitRate.toFixed(2);
    if (rateKey !== lastKey) {
      hitRateHistory.push({
        turn: turns,
        hitRate: rate,
        timestamp: Date.now(),
      });
      if (hitRateHistory.length > MAX_HISTORY_POINTS) {
        hitRateHistory.splice(0, hitRateHistory.length - MAX_HISTORY_POINTS);
      }
      lastHitRate = rate;
      scheduleSaveHistory(hitRateHistory, sessionId);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════
  // turn_end — reset prefix guard for the next turn
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("turn_end", (_event, _ctx) => {
    warnedThisTurn = false;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P2: before_provider_request — prefix hash diagnostics
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("before_provider_request", (event, ctx) => {
    setCtx(ctx);
    if (!isCacheOptimizedModel(ctx.model)) return;

    const payload = event.payload as {
      messages?: CachedMessage[];
      provider?: unknown;
    };
    const msgs = payload.messages ?? [];
    if (msgs.length === 0) return;

    // P5: OpenRouter auto-pin — prefix caching only hits when every request
    // lands on the same upstream. Pin the detected cache-capable upstream via
    // the `provider` routing object unless the user set their own preferences.
    if (ctx.model?.provider === "openrouter") {
      if (payload.provider !== undefined && payload.provider !== null) {
        openrouterUserOverride = true;
      } else {
        const vendor = resolveOpenRouterVendor(ctx.model);
        const upstream = vendor
          ? ensurePinnedUpstream(ctx.model.id, vendor)
          : undefined;
        const pin = computeProviderPin(payload.provider, upstream);
        if (pin) {
          payload.provider = pin;
          openrouterPinnedThisSession = true;
        }
      }
    }

    // P2: Prefix guard — detect cache-breaking mutations
    // DeepSeek's prefix cache matches from byte position 0 in the prompt.
    // The prefix is everything BEFORE the new user turn (the current last message).
    // We hash msgs.slice(0, -1) to check if the prefix (all prior messages)
    // has changed since last turn. If the hash differs, the cache is broken
    // and we warn the user.
    let currentHash: string;
    try {
      currentHash = createHash("sha256")
        .update(JSON.stringify(msgs.slice(0, -1)))
        .digest("hex");
    } catch {
      return;
    }

    if (
      lastPrefixHash !== undefined &&
      currentHash !== lastPrefixHash &&
      !warnedThisTurn
    ) {
      warnedThisTurn = true;
      prefixBreaks++;
    }
    lastPrefixHash = currentHash;
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P3: session_before_compact — cache-friendly deterministic compaction
  // ═══════════════════════════════════════════════════════════════════════

  pi.on("session_before_compact", async (event, ctx) => {
    setCtx(ctx);

    // Only intercept for models from a registered cache family
    if (!isCacheOptimizedModel(ctx.model)) return;

    const { preparation, signal } = event;
    if (!preparation) return; // fall back to default compaction
    const { messagesToSummarize, previousSummary, firstKeptEntryId, tokensBefore } = preparation;

    flushPendingWrites(sessionId);

    const history = serializeConversation(convertToLlm(messagesToSummarize));
    const text = previousSummary
      ? `[Previous summary]\n${previousSummary}\n\n[New history]\n${history}`
      : history;

    const model = resolveSummarizerModel(ctx);
    if (!model) {
      ctx.ui.notify(
        "deepseek-cache: no summarizer model found, falling back to default compaction",
        "warning",
      );
      return;
    }

    // Key by summarizer model so a MiMo session never replays a DeepSeek summary.
    const key = createHash("sha256")
      .update(`${model.id}\n${text}`)
      .digest("hex");
    let summary = summaryCache.get(key);

    if (!summary) {
      summary = await summarizeWithModel(model, text, ctx, signal);
      if (!summary) return; // fall back to default compaction
      summaryCache.set(key, summary);
      evictSummaryCacheIfNeeded(summaryCache);
      saveSummaryCacheSync(summaryCache);
    }

    return {
      compaction: {
        summary,
        firstKeptEntryId,
        tokensBefore,
        details: { summarizer: model.id },
      },
    };
  });

  // ═══════════════════════════════════════════════════════════════════════
  // P4: Commands — /cache-stats, /cache-graph, /cache-reset
  // ═══════════════════════════════════════════════════════════════════════

  pi.registerCommand("cache-stats", {
    description: "Cache hit rate statistics",
    handler: async (_args, ctx) => {
      setCtx(ctx);
      const agg = await aggregateAllSessionsAsync();
      const model = ctx.model;
      const vendor = resolveOpenRouterVendor(model);
      const display: DisplayContext = {
        pricing: resolvePricingTier(model),
        creditTier: resolveCreditTier(model?.id),
        unit: resolveDisplayUnit(model?.provider),
      };
      await ctx.ui.custom(
        (_tui, theme, _kb, done) =>
          new CacheStatsOverlay(
            theme,
            { cacheRead, input, cacheWrite, turns },
            done,
            agg,
            prefixBreaks,
            display,
            model?.provider === "openrouter"
              ? {
                  upstream:
                    model && vendor
                      ? ensurePinnedUpstream(model.id, vendor)
                      : undefined,
                  userOverride: openrouterUserOverride,
                }
              : undefined,
          ),
        { overlay: true },
      );
    },
  });

  pi.registerCommand("cache-graph", {
    description: "Cache hit rate trend chart",
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
    description: "Reset cache statistics",
    handler: async (_args, ctx) => {
      setCtx(ctx);
      // Reset in-memory counters
      cacheRead = 0;
      input = 0;
      cacheWrite = 0;
      turns = 0;
      hitRateHistory.length = 0;
      lastHitRate = 0;
      lastPrefixHash = undefined;
      warnedThisTurn = false;
      prefixBreaks = 0;
      openrouterPinnedThisSession = false;
      openrouterUserOverride = false;
      summaryCache.clear();

      // Clear pending writes without flushing to disk (files get deleted below)
      if (statsTimer) {
        clearTimeout(statsTimer);
        statsTimer = null;
      }
      pendingStats = null;
      if (historyTimer) {
        clearTimeout(historyTimer);
        historyTimer = null;
      }
      pendingHistory = null;

      // Delete ALL session files
      try {
        if (existsSync(STATS_DIR)) {
          const files = readdirSync(STATS_DIR);
          for (const file of files) {
            if (
              (file.startsWith("stats-") && file.endsWith(".json")) ||
              (file.startsWith("history-") && file.endsWith(".json"))
            ) {
              try {
                unlinkSync(join(STATS_DIR, file));
              } catch {
                /* best-effort */
              }
            }
          }
        }
        if (existsSync(SUMMARY_CACHE_FILE)) unlinkSync(SUMMARY_CACHE_FILE);
      } catch {
        /* best-effort */
      }
      ctx.ui.notify("Cache stats reset", "info");
      if (ctx.hasUI) ctx.ui.setStatus("cache", undefined);
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// P3 helper: family summarizer at temperature 0
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve the summarizer model for the active family. Preference order:
 * each candidate on the active provider, each candidate on any provider with
 * configured auth, then the active model itself.
 */
function resolveSummarizerModel(ctx: ExtensionContext) {
  return (
    pickSummarizerModel(
      resolveSummarizerCandidates(ctx.model),
      ctx.model?.provider,
      ctx.modelRegistry,
    ) ?? ctx.model
  );
}

async function summarizeWithModel(
  model: NonNullable<ExtensionContext["model"]>,
  text: string,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string | undefined> {
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    ctx.ui.notify(
      "deepseek-cache: summarizer auth failed, falling back to default compaction",
      "warning",
    );
    return;
  }

  try {
    const response = await complete(
      model,
      {
        messages: [
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text:
                  "Summarize this conversation history into structured markdown. " +
                  "Cover: ① goal ② key decisions & rationale ③ code/file changes " +
                  "④ current progress ⑤ blockers & open questions ⑥ next steps. " +
                  "Be thorough — this summary replaces the original history.\n\n" +
                  text,
              },
            ],
            timestamp: Date.now(),
          },
        ],
        temperature: 0,
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: SUMMARY_MAX_TOKENS,
        signal,
      },
    );

    const summary = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return summary.trim() || undefined;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(
      `deepseek-cache: summarization failed (${msg}), falling back to default compaction`,
      "error",
    );
    return;
  }
}
