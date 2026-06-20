# grok-mcp

A small personal MCP server (Node/TypeScript, Express + `@modelcontextprotocol/sdk`)
running on `zaz-astra`, exposed over Tailscale Funnel. Stateless: a fresh server +
transport per request.

## Tools

- **`ask_panel`** — ask one or more models concurrently and get raw, labeled
  answers back to synthesize yourself. Per-spec backend (`grok` | `gemini`),
  grounding, lens, reasoning effort, temperature. One spec failing doesn't fail
  the others.
- **`grok_x_search`** — citations-first live X search (xAI `/responses` + `x_search`),
  with a no-results-is-an-error contract.
- **`get_odds`** — live Polymarket + Kalshi prediction-market odds.
- **`get_news_digest`** — on-demand, *compressed* read of a curated RSS feed list
  (AI/frontier, macro/heterodox, light industry). Fetches the last N days, dedupes,
  has the LLM **compress** (not amplify) into a short digest, emails it once (Resend)
  and returns it inline. **Never web-searches** — the curated `feeds.json` is the
  whole source list, by design. Quiet-when-quiet; on-demand only (no schedule). See
  [News digest](#news-digest-get_news_digest) below.

Plus the `lenses://frames` resource (analytical frames, live-read from `lenses.md`).

## Configuration

All config is via environment variables in `/etc/grok-mcp.env` (template:
`astra-config/.env.example`). Secrets and the `MCP_PATH` mount are never committed.

| Var | Purpose |
| --- | --- |
| `XAI_API_KEY` | Grok / `grok_x_search`. **Unchanged — Grok always uses the direct xAI API.** |
| `GEMINI_API_KEY` | Gemini on the **direct** transport (`@google/genai` SDK). |
| `GEMINI_TRANSPORT` | `direct` (default) or `openrouter` — see below. |
| `OPENROUTER_API_KEY` | Only needed when `GEMINI_TRANSPORT=openrouter`. |
| `MCP_PATH` | Mount path(s). Treat as a credential. |
| `RESEND_API_KEY`, `NOTIFY_EMAIL_TO` | Alert email (scripts) **and** `get_news_digest` delivery. `NOTIFY_EMAIL_FROM` optional. |

## Gemini transport: direct vs OpenRouter (BYOK)

`ask_panel`'s **gemini** specs can reach Google two ways, chosen by
`GEMINI_TRANSPORT`. **External behavior of `ask_panel` is identical either way** —
same signature, same per-spec controls, same output shape. Only the transport
for Gemini changes. **Grok is never affected.**

- **`direct`** (default) — first-party `@google/genai` SDK, AI Studio key auth.
  Thinking via `thinkingConfig`, grounding via the native `googleSearch` tool.
- **`openrouter`** — OpenRouter's OpenAI-compatible `/chat/completions`, **BYOK**:
  add the same Google AI Studio key as a provider key in the OpenRouter dashboard
  (Settings → Integrations) so `google/*` calls route through it and bill your AI
  Studio credits (a small BYOK surcharge may apply). When credits eventually run
  out, switching to OpenRouter's own billing is a dashboard change, no code edit.
  - Model slug: `google/gemini-pro-latest` (OpenRouter's floating alias, mirrors
    the direct path's `gemini-pro-latest`). The resolved model is logged to
    journald on both paths so the `gemini-model-check` guard stays meaningful.
  - Reasoning: mapped to OpenRouter's unified `reasoning: { effort }`
    (`low|medium|high`, default `high`, attached only for `-pro` models).
  - **Grounding pins `engine:"native"`** — i.e. Gemini's own Google Search
    grounding passed through the gateway (same index/sources as direct), returned
    as `url_citation` annotations. It deliberately **never** uses OpenRouter's Exa
    web search and never sends domain filters (which silently force the Exa
    fallback). Exa is a different index and would change behavior.

### Why the direct path is retained

The direct path stays behind the flag for **instant rollback** (one env edit +
restart) — OpenRouter becomes a single point of failure for all Gemini traffic
once it's the default, and this guards against gateway outages, BYOK hiccups, or
OpenRouter changing its native-search routing. Full consolidation (delete the
direct path + drop the `@google/genai` dependency) is a deliberate later cleanup.

**Graduation criteria (to fully consolidate):** after a sustained period of
`GEMINI_TRANSPORT=openrouter` as default with zero forced fallbacks and no
grounding/cost regressions, remove the direct path and the SDK dependency in a
dedicated follow-up.

### Verification gates

Two unknowns were gated before flipping the default to `openrouter`:

- **Gate 1 — reasoning passthrough.** Same high-effort lensed prompt, direct vs
  OpenRouter; OpenRouter must show comparable reasoning depth (not a flattened
  quick answer).
- **Gate 2 — native grounding under BYOK.** A grounded prompt via OpenRouter must
  return real Google `url_citation` results (not absent, not Exa-flavored), at
  comparable cost.

**Status: both gates PASSED (2026-06-15) — default flipped to `openrouter`.**

- **Gate 1 ✅** Reasoning effort passes through and scales: OpenRouter `low`→286
  reasoning tokens, `high`→597, vs direct `high`→907 (same order of magnitude,
  not flattened). Effort is honored via `reasoning: { effort }`.
- **Gate 2 ✅** Native grounding survives the route under BYOK. Grounded calls
  return `vertexaisearch.cloud.google.com/grounding-api-redirect/...` citations
  (Google's own grounding, **not** Exa), and usage reports `"is_byok": true` with
  the inference cost billed upstream to the AI Studio key (OpenRouter `cost: 0`).
  So grounded Gemini also routes through OpenRouter; no direct-path fallback was
  needed.

Note: OpenRouter's floating-alias API slug carries a literal `~` prefix
(`~google/gemini-pro-latest`); the un-prefixed form returns HTTP 400.

## News digest (`get_news_digest`)

An on-demand primitive, not a cathedral: one tool, one pipeline, one config file.

```
you call tool -> fetch curated feeds (last N days) -> dedupe -> LLM COMPRESS -> email once + return inline
```

- **Config: `feeds.json`** (repo root) — sections (`ai`, `macro`, `industry`) and
  their sources. **Live-read on every call** like `lenses.md`: edit + commit, no
  rebuild/restart. Adding a source = drop a `{source, url}` into a section. The
  curated list **is** the quality control — the summarizer has no web access, so a
  source not in `feeds.json` cannot enter the digest.
- **Params:** `days` (default 4), `sections` (default all), `email` (default true),
  `max_items` (default 18). `industry` is hard-capped (ambient awareness, not a
  dashboard); other sections share the remaining budget by recency.
- **Compress, don't amplify.** The system prompt forces ruthless dedup, 1–2 lines
  per item, no hype, and *quiet-when-quiet* (a slow week says so, never pads).
- **Prior-challenging voices** (Wang, Pettis, Tooze) are flagged `challenger` in
  `feeds.json` and the prompt forbids dropping them — a digest that only confirms
  priors is the amplifying mirror in a nicer wrapper.
- **Summarization reuses the existing cores:** Gemini (`callGemini`, same transport
  as `ask_panel`) with a Grok fallback — **ungrounded** (`grounded:false`) always.
- **Email** goes through Resend (same API as `scripts/notify-email.sh`) but
  **fail-loud**: if the send fails the tool says so in the confirmation rather than
  pretending it was delivered. Subject: `Digest — {date} ({n} items)`.
- **Failed feeds are reported** in a digest footer (not silently swallowed) so a
  dead required-voice URL gets noticed and can be swapped live in `feeds.json`.
- **Upgrade path (deliberately absent in v1):** Hermes would own scheduling if you
  ever flip to a push; a Kimi/DeepSeek swarm enters only if the job grows from
  *summarizing a dozen items* into *wide gathering*. Until then: one call, on demand.

## Build / deploy

```sh
npm run build          # tsc -> build/
npm test               # pure unit tests (no billed calls)
sudo systemctl restart grok-mcp
```

Conventions: **manual commit** (commit by hand to avoid broken mid-edit states in
history); **no auto-push** (ad-astra backup is manual — push after confirmed
functional). `oddsTool` reads `kalshi-series.json` from `build/` — re-copy it
after a clean `tsc` if you wipe `build/`.
