# pi-deepseek-cache

**Reduce DeepSeek API costs by 95%+** through multi-layered prefix cache optimization. Zero configuration — auto-detects DeepSeek models and applies best practices transparently.

## The Problem

DeepSeek's API uses [prefix caching](https://api-docs.deepseek.com/guides/kv_cache/) — identical prompt prefixes served from disk cache at **50–120× lower cost** than fresh computation. But the cache only works when every byte from position 0 is identical across requests.

Pi's default system prompt embeds `Current date: YYYY-MM-DD` and `Current working directory: <cwd>` — dynamic values that change daily and per session, silently busting the entire prefix cache.

## What This Extension Does

| Layer | Feature | Impact |
|-------|---------|--------|
| **P0** | Date & CWD freeze | Root-cause fix — locks session date and directory, preventing daily/per-session cache bust |
| **P1** | Hit-rate telemetry | Persistent stats with real-time status bar: `Cache: 93.5% · 12t · 45KR` |
| **P2** | Prefix guard | SHA-256 hash diagnostics — warns when prompt prefix changes between turns |
| **P3** | Cache-friendly compaction | Deterministic summarization via deepseek-v4-flash at temperature 0, SHA-256 cached for stable replays |
| **P4** | TUI overlays | `/cache-stats` popup with hit rate, tokens, cost savings. `/cache-graph` ASCII trend chart |

## Cost Impact

| | Without Extension | With Extension |
|---|---|---|
| **deepseek-v4-flash** input | $0.14/M tokens | $0.003/M tokens (98% less) |
| **deepseek-v4-pro** input | $3.00/M tokens | $0.025/M tokens (99% less) |

## Installation

```bash
pi install npm:@rohaquinlop/pi-deepseek-cache
```

Or via git:

```bash
pi install git:github.com/rohaquinlop/pi-deepseek-cache
```

The extension activates automatically. No configuration needed.

## Provider Support

Works with any provider serving DeepSeek models:
- **Any provider** with `deepseek-*` model IDs (NaN Builders, OpenRouter, custom proxies, etc.)
- **DeepSeek API** (`deepseek` provider) — direct API users

Non-DeepSeek models pass through unchanged.

## Commands

### `/cache-stats`
Overlay popup showing cumulative session stats: hit rate, cache read/write/input tokens, turns, and estimated cost savings.

### `/cache-graph`
ASCII trend chart of hit rate over turns — helps spot regressions.

### `/cache-reset`
Clears all cached statistics, history, and summary cache. Useful after major prompt changes.

## How It Works

**P0 (Date/CWD freeze):** On `before_agent_start`, replaces the dynamic `Current date` and `Current working directory` lines with values frozen at session start. The system prompt prefix stays byte-identical across the entire session.

**P1 (Telemetry):** Accumulates `cacheRead`, `input`, `cacheWrite`, and `turns` from every assistant message's usage data. Persists to `~/.pi/agent/extensions/deepseek-cache/stats.json` so stats survive `/reload` and restart.

**P2 (Prefix guard):** On `before_provider_request`, SHA-256 hashes all messages except the last to fingerprint the prefix. Warns when the hash changes — diagnosing what busted the cache.

**P3 (Compaction):** On `session_before_compact`, summarizes conversation history with deepseek-v4-flash at temperature 0. Summaries are SHA-256 hashed and cached — identical histories produce byte-identical summaries, keeping compaction cache-stable.

**P4 (Overlays):** `/cache-stats` and `/cache-graph` render as TUI overlay popups (Esc to dismiss) with formatted hit-rate data and ASCII trend charts.

## License

MIT
