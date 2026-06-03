/**
 * grokXSearch.ts — adds a `grok_x_search` tool to your existing Grok MCP server.
 *
 * Grok answers a question using a LIVE search of X (Twitter) via xAI's current
 * Agent Tools API: the /v1/responses endpoint with the server-side `x_search`
 * tool. Returns a synthesized answer PLUS citations to the source posts, so you
 * can spot-check the Grok layer rather than trust it blind.
 *
 * IMPORTANT: the old Live Search `search_parameters` API was RETIRED 2026-01-12
 * (returns 410 Gone). This module uses the current Responses + x_search approach
 * per docs.x.ai/developers/tools/x-search.
 *
 * Integration — in index.ts, AFTER you create `server` and have XAI_API_KEY:
 *     import { registerGrokXSearch } from "./grokXSearch.js";
 *     registerGrokXSearch(server, { apiKey: XAI_API_KEY });
 *   (reuses your existing key/base-url/model constants; pass overrides if named
 *    differently). Leaves your ask_grok tool untouched.
 *
 * Requires Node 18+ (global fetch). ESM/TS to match your server.
 */

import { z } from "zod";

type RegisterOpts = {
  apiKey: string | undefined;
  baseUrl?: string;
  model?: string;
};

export function registerGrokXSearch(
  server: any,
  { apiKey, baseUrl = "https://api.x.ai/v1", model = "grok-4.3" }: RegisterOpts
) {
  server.registerTool(
    "grok_x_search",
    {
      title: "Grok X Search",
      description:
        "Answer a question using a LIVE search of X (Twitter), via Grok. Returns a " +
        "synthesized answer plus citations to the source posts. Use for current " +
        "sentiment, trending discussion, or what specific accounts are saying right " +
        "now. For plain Grok with no live data, use ask_grok instead.",
      inputSchema: {
        query: z
          .string()
          .trim()
          .min(1, "query must not be empty")
          .describe("The question to answer using live X data."),
        allowed_handles: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Only consider posts from these X handles (omit the @). Max 20."),
        excluded_handles: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Exclude posts from these handles. Cannot combine with allowed_handles."),
        from_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "from_date must be ISO YYYY-MM-DD")
          .optional()
          .describe("Earliest post date, ISO YYYY-MM-DD."),
        to_date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "to_date must be ISO YYYY-MM-DD")
          .optional()
          .describe("Latest post date, ISO YYYY-MM-DD."),
        include_web: z
          .boolean()
          .optional()
          .describe("Also search the web for broader context, not just X."),
      },
    },
    async ({
      query,
      allowed_handles,
      excluded_handles,
      from_date,
      to_date,
      include_web,
    }: any) => {
      if (!apiKey) {
        return {
          content: [{ type: "text", text: "XAI_API_KEY is not set on the server." }],
          isError: true,
        };
      }
      if (allowed_handles?.length && excluded_handles?.length) {
        return {
          content: [
            { type: "text", text: "Use allowed_handles OR excluded_handles, not both." },
          ],
          isError: true,
        };
      }

      const xTool: Record<string, unknown> = { type: "x_search" };
      if (allowed_handles?.length) xTool.allowed_x_handles = allowed_handles;
      if (excluded_handles?.length) xTool.excluded_x_handles = excluded_handles;
      if (from_date) xTool.from_date = from_date;
      if (to_date) xTool.to_date = to_date;
      const tools: Record<string, unknown>[] = [xTool];
      if (include_web) tools.push({ type: "web_search" });

      let resp: Response;
      try {
        resp = await fetch(`${baseUrl}/responses`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model, input: [{ role: "user", content: query }], tools }),
          // live search + reasoning can run long; give it headroom
          signal: AbortSignal.timeout(120_000),
        });
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Request to xAI failed: ${e?.name}: ${e?.message}` }],
          isError: true,
        };
      }

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        return {
          content: [
            { type: "text", text: `xAI /responses error ${resp.status}: ${errText.slice(0, 600)}` },
          ],
          isError: true,
        };
      }

      const data: any = await resp.json();
      return buildXSearchResult(data);
    }
  );
}

/**
 * Build the MCP result from xAI's /responses payload. Exported for testing.
 *
 * Live-X-or-nothing contract: if the STRUCTURED citations array is empty, the
 * search found no posts (or returned a parametric fallback), so we hard-error
 * rather than pass a sourceless answer through. We do NOT scrape inline links as
 * a fallback (ungrounded takes belong in ask_grok) — but if the answer carries
 * inline X links while the structured array is empty, that smells like a
 * citation response-shape change, so we log a warning to make it visible.
 */
export function buildXSearchResult(data: any) {
  // --- extract answer text (Responses API), defensively ---
  let answer: string = typeof data.output_text === "string" ? data.output_text : "";
  if (!answer && Array.isArray(data.output)) {
    const parts: string[] = [];
    for (const item of data.output) {
      for (const c of item?.content ?? []) {
        if (typeof c?.text === "string") parts.push(c.text);
      }
    }
    answer = parts.join("\n").trim();
  }

  // --- extract citations, defensively (xAI: data.citations; OpenAI-style: annotations) ---
  const citations: string[] = [];
  if (Array.isArray(data.citations)) {
    for (const c of data.citations) {
      citations.push(typeof c === "string" ? c : c?.url ?? JSON.stringify(c));
    }
  }
  if (!citations.length && Array.isArray(data.output)) {
    for (const item of data.output) {
      for (const c of item?.content ?? []) {
        for (const a of c?.annotations ?? []) {
          const u = a?.url ?? a?.url_citation?.url;
          if (u) citations.push(u);
        }
      }
    }
  }

  // Empty structured citations => no live posts => hard error (full stop).
  if (citations.length === 0) {
    if (answer && /https?:\/\/(www\.)?(x|twitter)\.com\//i.test(answer)) {
      console.warn(
        "[grok_x_search] Structured citations array is empty but the answer contains " +
          "inline X links — likely a citation response-shape change. Returning a hard " +
          "error per spec (not scraping); investigate the citation parser in grokXSearch.ts."
      );
    }
    return {
      content: [{ type: "text", text: "No live X posts found for this query/window." }],
      isError: true,
    };
  }

  // Citations present but text didn't parse — return raw so the shape can be fixed.
  if (!answer) {
    return {
      content: [
        {
          type: "text",
          text:
            "Parsed no answer text — response shape differs from the default. " +
            "Raw response (first 1800 chars); adjust the parser in grokXSearch.ts:\n" +
            JSON.stringify(data).slice(0, 1800),
        },
      ],
    };
  }

  return { content: [{ type: "text", text: JSON.stringify({ answer, citations }, null, 2) }] };
}
