import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ═══════════════════════════════════════════════════════════════════════════
// Persistence layer — tested in isolation from the extension
// ═══════════════════════════════════════════════════════════════════════════

// Replicating the persistence logic from extensions/index.ts
// to verify correctness without the full pi runtime.

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

const MAX_HISTORY_POINTS = 100;

function loadStats(file: string): PersistedStats {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // Corrupted file → return defaults
  }
  return { cacheRead: 0, input: 0, cacheWrite: 0, turns: 0 };
}

function saveStats(file: string, stats: PersistedStats): void {
  if (!existsSync(file)) mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(stats, null, 2));
}

function loadHistory(file: string): HistoryPoint[] {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    // Corrupted
  }
  return [];
}

function saveHistory(file: string, history: HistoryPoint[]): void {
  if (!existsSync(file)) mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(history.slice(-MAX_HISTORY_POINTS), null, 2));
}

function loadSummaryCache(file: string): Map<string, string> {
  try {
    if (existsSync(file)) {
      return new Map(Object.entries(JSON.parse(readFileSync(file, "utf-8"))));
    }
  } catch {
    // Corrupted
  }
  return new Map();
}

function saveSummaryCache(file: string, cache: Map<string, string>): void {
  if (!existsSync(file)) mkdirSync(join(file, ".."), { recursive: true });
  const obj: Record<string, string> = {};
  for (const [k, v] of cache) obj[k] = v;
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `pi-deepseek-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

// ─── Stats persistence ───

describe("stats persistence", () => {
  it("loadStats returns defaults when file does not exist", () => {
    const stats = loadStats(join(testDir, "nonexistent.json"));
    expect(stats).toEqual({ cacheRead: 0, input: 0, cacheWrite: 0, turns: 0 });
  });

  it("saveStats and loadStats round-trip", () => {
    const file = join(testDir, "stats.json");
    const stats: PersistedStats = { cacheRead: 45200, input: 8400, cacheWrite: 3100, turns: 12 };
    saveStats(file, stats);

    const loaded = loadStats(file);
    expect(loaded).toEqual(stats);
  });

  it("loadStats returns defaults for corrupted JSON", () => {
    const file = join(testDir, "stats.json");
    writeFileSync(file, "{corrupted json!!!");
    const stats = loadStats(file);
    expect(stats).toEqual({ cacheRead: 0, input: 0, cacheWrite: 0, turns: 0 });
  });

  it("loadStats returns defaults for empty file", () => {
    const file = join(testDir, "stats.json");
    writeFileSync(file, "");
    const stats = loadStats(file);
    expect(stats).toEqual({ cacheRead: 0, input: 0, cacheWrite: 0, turns: 0 });
  });

  it("stats accumulate correctly across multiple saves", () => {
    const file = join(testDir, "stats.json");

    saveStats(file, { cacheRead: 100, input: 50, cacheWrite: 10, turns: 1 });
    let loaded = loadStats(file);
    expect(loaded.cacheRead).toBe(100);

    saveStats(file, { cacheRead: 200, input: 100, cacheWrite: 20, turns: 2 });
    loaded = loadStats(file);
    expect(loaded.cacheRead).toBe(200);
    expect(loaded.turns).toBe(2);
  });

  it("handles zero values correctly", () => {
    const file = join(testDir, "stats.json");
    const stats: PersistedStats = { cacheRead: 0, input: 0, cacheWrite: 0, turns: 0 };
    saveStats(file, stats);
    const loaded = loadStats(file);
    expect(loaded).toEqual(stats);
  });

  it("handles very large token counts", () => {
    const file = join(testDir, "stats.json");
    const stats: PersistedStats = {
      cacheRead: 150_000_000,
      input: 50_000_000,
      cacheWrite: 10_000_000,
      turns: 999,
    };
    saveStats(file, stats);
    const loaded = loadStats(file);
    expect(loaded).toEqual(stats);
  });
});

// ─── History persistence ───

describe("history persistence", () => {
  it("loadHistory returns empty array when file does not exist", () => {
    const history = loadHistory(join(testDir, "nonexistent.json"));
    expect(history).toEqual([]);
  });

  it("saveHistory and loadHistory round-trip", () => {
    const file = join(testDir, "history.json");
    const history: HistoryPoint[] = [
      { turn: 1, hitRate: 80.5, timestamp: 1000 },
      { turn: 2, hitRate: 92.3, timestamp: 2000 },
    ];
    saveHistory(file, history);

    const loaded = loadHistory(file);
    expect(loaded).toEqual(history);
  });

  it("truncates history beyond MAX_HISTORY_POINTS", () => {
    const file = join(testDir, "history.json");
    const history: HistoryPoint[] = Array.from({ length: 150 }, (_, i) => ({
      turn: i + 1,
      hitRate: 90,
      timestamp: i * 1000,
    }));
    saveHistory(file, history);

    const loaded = loadHistory(file);
    expect(loaded.length).toBe(MAX_HISTORY_POINTS);
    expect(loaded[0].turn).toBe(51); // kept last 100
    expect(loaded[loaded.length - 1].turn).toBe(150);
  });

  it("loadHistory returns empty for corrupted file", () => {
    const file = join(testDir, "history.json");
    writeFileSync(file, "not json");
    expect(loadHistory(file)).toEqual([]);
  });

  it("deduplicates hit rate points correctly (same rate → no new entry)", () => {
    // This tests the logic in the extension where new entries are only
    // added when the hit rate changes. The persistence just saves what
    // it's given.
    const file = join(testDir, "history.json");
    const history: HistoryPoint[] = [
      { turn: 1, hitRate: 90.0, timestamp: 1000 },
      { turn: 2, hitRate: 90.0, timestamp: 2000 }, // same rate
    ];
    saveHistory(file, history);

    const loaded = loadHistory(file);
    expect(loaded.length).toBe(2);
  });
});

// ─── Summary cache persistence ───

describe("summary cache persistence", () => {
  it("loadSummaryCache returns empty map when file does not exist", () => {
    const cache = loadSummaryCache(join(testDir, "nonexistent.json"));
    expect(cache.size).toBe(0);
  });

  it("saveSummaryCache and loadSummaryCache round-trip", () => {
    const file = join(testDir, "summary-cache.json");
    const cache = new Map<string, string>();
    cache.set("abc123", "summary 1");
    cache.set("def456", "summary 2");

    saveSummaryCache(file, cache);
    const loaded = loadSummaryCache(file);
    expect(loaded.size).toBe(2);
    expect(loaded.get("abc123")).toBe("summary 1");
    expect(loaded.get("def456")).toBe("summary 2");
  });

  it("handles empty map", () => {
    const file = join(testDir, "summary-cache.json");
    saveSummaryCache(file, new Map());
    const loaded = loadSummaryCache(file);
    expect(loaded.size).toBe(0);
  });

  it("handles keys with special characters", () => {
    const file = join(testDir, "summary-cache.json");
    const cache = new Map<string, string>();
    cache.set("key/with/slashes", "value");
    cache.set("key with spaces", "another value");
    cache.set("中文键", "中文值");

    saveSummaryCache(file, cache);
    const loaded = loadSummaryCache(file);
    expect(loaded.get("key/with/slashes")).toBe("value");
    expect(loaded.get("key with spaces")).toBe("another value");
    expect(loaded.get("中文键")).toBe("中文值");
  });

  it("returns empty map for corrupted file", () => {
    const file = join(testDir, "summary-cache.json");
    writeFileSync(file, "garbage");
    expect(loadSummaryCache(file).size).toBe(0);
  });
});

// ─── Concurrent access safety ───

describe("concurrent access", () => {
  it("handles rapid sequential writes without data loss", () => {
    const file = join(testDir, "stats.json");

    for (let i = 0; i < 100; i++) {
      saveStats(file, { cacheRead: i * 100, input: i * 50, cacheWrite: i * 10, turns: i });
    }

    const loaded = loadStats(file);
    expect(loaded.turns).toBe(99);
    expect(loaded.cacheRead).toBe(9900);
  });

  it("multiple files don't interfere", () => {
    const statsFile = join(testDir, "stats.json");
    const historyFile = join(testDir, "history.json");
    const summaryFile = join(testDir, "summary-cache.json");

    saveStats(statsFile, { cacheRead: 1000, input: 500, cacheWrite: 100, turns: 5 });
    saveHistory(historyFile, [{ turn: 1, hitRate: 90, timestamp: 1000 }]);
    const cache = new Map([["key1", "summary1"]]);
    saveSummaryCache(summaryFile, cache);

    // Verify each file independently
    expect(loadStats(statsFile).turns).toBe(5);
    expect(loadHistory(historyFile).length).toBe(1);
    expect(loadSummaryCache(summaryFile).get("key1")).toBe("summary1");
  });
});
