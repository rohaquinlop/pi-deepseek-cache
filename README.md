# pi-deepseek-cache

**Reduce DeepSeek API costs by 95%+** through multi-layered prefix cache optimization. Zero configuration — auto-detects DeepSeek models and applies best practices transparently.

## Contents

- [The Problem](#the-problem)
- [What This Extension Does](#what-this-extension-does)
- [Cost Impact](#cost-impact)
- [Installation](#installation)
- [Provider Support](#provider-support)
- [Subagent Compatibility](#subagent-compatibility)
- [Commands](#commands)
- [How It Works](#how-it-works)
- [License](#license)

## The Problem

DeepSeek's API uses [prefix caching](https://api-docs.deepseek.com/guides/kv_cache/) — identical prompt prefixes served from disk cache at **50–120× lower cost** than fresh computation. But the cache only works when every byte from position 0 is identical across requests.

Pi's default system prompt embeds `Current date: YYYY-MM-DD` and `Current working directory: <cwd>` — dynamic values that change daily and per session, silently busting the entire prefix cache.

## What This Extension Does

| Layer | Feature | Impact |
|-------|---------|--------|
| **P0** | Date & CWD freeze | Root-cause fix — locks session date and directory, preventing daily/per-session cache bust |
| **P1** | Hit-rate telemetry | Per-session hit rate shown as dimmed footer status line; /cache-stats & /cache-graph for detail |
| **P2** | Prefix guard | SHA-256 hash diagnostics — tracks prefix breaks (viewable in /cache-stats) |
| **P3** | Cache-friendly compaction | Deterministic summarization via deepseek-v4-flash at temperature 0, SHA-256 cached for stable replays |
| **P4** | TUI overlays | `/cache-stats` popup with hit rate, tokens, cost savings. `/cache-graph` ASCII trend chart |
| **P5** | OpenRouter auto-pin | Pins every request to one cache-capable upstream so OpenRouter's load balancer can't bust the cache |

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

The extension activates automatically. No configuration needed. The per-session
cache hit rate appears as a dimmed status line (`Cache 96.2%`) in Pi's footer.
Pi's native `CH:XX.X%` shows the per-turn rate in the stats line. Detailed
stats are available via /cache-stats and /cache-graph commands.

## Provider Support

Works with any provider serving DeepSeek models:
- **Any provider** with `deepseek-*` model IDs (NaN Builders, custom proxies, etc.)
- **DeepSeek API** (`deepseek` provider) — direct API users
- **OpenRouter** — see caveat below

Non-DeepSeek models pass through unchanged.

### OpenRouter caveat

OpenRouter load-balances requests across upstream providers, and each upstream
holds its **own** KV cache. Requests landing on different upstreams get almost
no prefix-cache hits — caching only works when every request reaches the same
upstream. This extension handles it automatically: it queries OpenRouter for
the cheapest cache-capable upstream serving your model and pins every request
to it (`provider.order` + `allow_fallbacks: false`). The pin is re-checked
every 6 hours; if you set your own OpenRouter routing preferences, the
extension leaves them untouched.

## Subagent Compatibility

This extension automatically applies to subagent processes that use DeepSeek
models. It declares `appliesToModels: ["deepseek-*", "deepseek"]` in its
`package.json`, which the [pi-subagents](https://github.com/rohaquinlop/pi-subagents)
extension detects and loads into child processes — no configuration needed.

For the best cache performance, ensure both extensions are installed:

```bash
pi install npm:@rohaquinlop/pi-subagents
pi install npm:@rohaquinlop/pi-deepseek-cache
```

## Commands

### `/cache-stats`
Overlay popup showing two sections: **this session's** stats and an **aggregate across all sessions** (N sessions). Each section shows hit rate, cache read/write/input tokens, turns, and estimated cost savings.

### `/cache-graph`
ASCII trend chart of hit rate over turns — helps spot regressions.

### `/cache-reset`
Clears all cached statistics, history, and summary cache — deletes all per-session `stats-*.json` and `history-*.json` files plus the summary cache. Useful after major prompt changes.

## How It Works

**P0 (Date/CWD freeze):** On `before_agent_start`, replaces the dynamic `Current date` and `Current working directory` lines with values frozen at session start. The system prompt prefix stays byte-identical across the entire session.

**P1 (Telemetry):** Accumulates `cacheRead`, `input`, `cacheWrite`, and `turns` from every assistant message's usage data. Each session stores its stats in `stats-{sessionId}.json` and its trend in `history-{sessionId}.json` — concurrent sessions never race because no file is shared. Files older than 30 days are cleaned up automatically. `/cache-stats` shows both this session's stats and an aggregate across all sessions.

**P2 (Prefix guard):** On `before_provider_request`, SHA-256 hashes all messages except the last to fingerprint the prefix. Tracks when the hash changes — the break count is visible in `/cache-stats`.

**P3 (Compaction):** On `session_before_compact`, summarizes conversation history with deepseek-v4-flash at temperature 0. Summaries are SHA-256 hashed and cached — identical histories produce byte-identical summaries, keeping compaction cache-stable.

**P4 (Overlays):** `/cache-stats` and `/cache-graph` render as TUI overlay popups (Esc to dismiss) with formatted hit-rate data and ASCII trend charts.

**P5 (OpenRouter auto-pin):** On the first request to an OpenRouter DeepSeek model, fetches the model's endpoint list from OpenRouter and picks the cheapest upstream that supports prefix caching (`input_cache_read` pricing). Every subsequent request carries `provider.order = [<upstream>]` and `allow_fallbacks: false`, so OpenRouter cannot silently reroute to a different KV cache. Results are cached ~6h; user-supplied `provider` preferences disable auto-pin entirely. Pin status is visible in `/cache-stats`.

## License

[MIT](LICENSE) © Robin Quintero
