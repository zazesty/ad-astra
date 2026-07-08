# Composer / Grok Build handoff — grok-mcp (2026-07-08)

Repo: `/root/grok-mcp` (origin: `zazesty/ad-astra`). Build `npm run build` →
`cp src/kalshi-series.json build/` → `npm test` → restart. **Manual push** after
functional confirm. Writable state only under `$STATE_DIRECTORY`.

## Queue

| Item | State |
|------|-------|
| #1 Metrics | ✅ |
| #2 Memory scaling | ✅ |
| #3 Fusion | ✅ |
| Panel grounded 60s | ✅ |
| B1–B3 metrics | ✅ `6059a89` |
| Grok default `grok-4.5` | ✅ |
| Panel outer budget + memory_search A2/A3 | ▶ this pass |
| **#4 `research_fanout`** | ▶ spec: `/root/research_fanout_spec.md` |
| Wire grok-mcp into Grok Build for `memory_*` | ⏸ later |

## Ship notes for #4

- New tool → **MCP_PATH rotation** + re-add consumers; smoke `EXPECTED_TOOLS=11`.
- Policy: check connectors after restart; rotate as needed (always on tool-surface change).
- Keep-separate: fanout ≠ oracle/panel/x_search.

## Residual bug queue (non-blocking)

- **B4** fusion synth DI offline test
- **C1–C3** embedding hash/prune, sidecar mutex, memory test gaps
- **C4 / D\*** fusion nits, expand_related archived filter, direct-gemini abort
