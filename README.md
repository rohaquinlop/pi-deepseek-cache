# pi-deepseek-cache

**Reduce DeepSeek API costs by 95%+** through prefix cache optimization. Zero configuration required — auto-detects DeepSeek models and applies best practices transparently.

## The Problem

DeepSeek's API uses [prefix caching](https://api-docs.deepseek.com/guides/kv_cache/) — identical prompt prefixes served from disk cache at **50–120× lower cost** than fresh computation. But the cache only works when every byte from position 0 is identical across requests.

Pi's default system prompt embeds `Current date: YYYY-MM-DD` and `Current working directory: <cwd>` — dynamic values that change daily and per session, silently busting the entire prefix cache. The result: every turn recomputes the full prompt from scratch, costing 50–120× more than necessary.

## What This Extension Does

| Feature | Impact |
|---------|--------|
| **Freezes system prompt date** | Prevents daily cache busting — date locked at session start |
| **Freezes working directory** | Prevents cache busting when navigating directories |
| **Real-time cache hit rate** | Shows hit percentage in TUI status bar: `Cache: 87% hit · 5 turns` |
| **Cache shape diagnostics** | Warns when the system prompt changes between turns |
| **Hit rate alerts** | Notifies when hit rate drops below 50% after 3+ turns |
| **`/cache-stats` command** | Detailed token breakdown, hit rate, prompt hash |

## Cost Impact

| | Without Extension | With Extension |
|---|---|---|
| **deepseek-v4-flash** input | $0.14/M tokens | $0.003/M tokens (98% less) |
| **deepseek-v4-pro** input | $3.00/M tokens | $0.025/M tokens (99% less) |

A 150M token coding session with deepseek-v4-pro at xhigh thinking costs **~$170 without cache** vs **~$1.43 with optimized cache**.

## Installation

```bash
pi install git:github.com/rohaquinlop/pi-deepseek-cache
```

Or via npm:

```bash
pi install npm:pi-deepseek-cache
```

The extension activates automatically on next pi restart or `/reload`. No additional configuration needed.

## Provider Support

Works with any provider serving DeepSeek models:
- **NaN Builders** (`nan` provider)
- **DeepSeek API** (`deepseek` provider)
- Any provider with `deepseek-*` model IDs

Non-DeepSeek models pass through completely unchanged — zero overhead.

## Commands

### `/cache-stats`

Shows detailed cache statistics for the current session:

```
── DeepSeek Cache Stats ──
  Turns:           12
  Assistant msgs:  15

  Cache read:      45.2K tokens
  Cache write:     3.1K tokens
  Input (non-ctx): 8.4K tokens
  Output:          22.1K tokens

  Hit rate:        93.5% (45200/48300)

  Session date:    2026-06-20 (frozen)
  Session CWD:     /Users/rhafid/project
  Prompt hash:     0x8f3a12b9
```

## How It Works

1. **Session start**: Captures the current date and working directory
2. **Before each prompt**: Replaces the dynamic `Current date` and `Current working directory` lines in the system prompt with frozen values from session start
3. **Each turn**: Accumulates cache read/write tokens from the API response, calculates hit rate, and updates the TUI status bar
4. **Shape monitoring**: Hashes the system prompt each turn — if it changes (e.g., skills loaded, tools toggled), warns about potential cache degradation

The extension only modifies two lines at the very end of the system prompt. All other content (project context, guidelines, tool definitions, skills) passes through unchanged.

## Why This Matters for DeepSeek Specifically

DeepSeek's caching is **automatic and transparent** — there are no API flags to toggle. Cache optimization is entirely about prompt engineering:

1. **Static system prompt** — no timestamps, dates, user IDs, session IDs
2. **Message ordering** — most stable content at position 0
3. **Stable tool serialization** — sorted keys, raw strings
4. **Trim history from tail** — never remove from middle/head

This extension automates principles 1 and 2 for every pi session.

## License

MIT
