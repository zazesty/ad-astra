import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getOdds } from "./oddsTool.js";
import { registerGrokXSearch } from "./grokXSearch.js";
import { registerAskGemini } from "./askGemini.js";

const XAI_API_KEY = process.env.XAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4.3";
const DEFAULT_REASONING_EFFORT = "medium";
const PORT = Number(process.env.PORT ?? 3000);

function buildServer() {
  const server = new McpServer({ name: "grok-mcp-remote", version: "1.0.0" });

  server.registerTool(
    "ask_grok",
    {
      title: "Ask Grok",
      description:
        "Send a prompt to xAI's Grok and return its response. Use for a second opinion, a contrarian take, or Grok's specific perspective.",
      inputSchema: {
        prompt: z
          .string()
          .refine((s) => s.trim().length > 0, {
            message: "prompt must not be empty or whitespace-only",
          })
          .describe("The question or prompt to send to Grok."),
        system: z.string().optional().describe("Optional system instruction."),
        model: z.string().optional().describe(`Optional model slug. Default ${DEFAULT_MODEL}.`),
        reasoning_effort: z
          .enum(["low", "medium", "high"])
          .optional()
          .describe(`How hard Grok thinks before answering. Default ${DEFAULT_REASONING_EFFORT}. Bump to high for hard reasoning/math/debugging; drop to low for quick, cheap lookups.`),
      },
    },
    async ({ prompt, system, model, reasoning_effort }) => {
      if (!XAI_API_KEY) {
        return { content: [{ type: "text", text: "Error: XAI_API_KEY not set." }], isError: true };
      }
      const messages: { role: string; content: string }[] = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt });
      try {
        const res = await fetch(`${XAI_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${XAI_API_KEY}` },
          body: JSON.stringify({
            model: model ?? DEFAULT_MODEL,
            reasoning_effort: reasoning_effort ?? DEFAULT_REASONING_EFFORT,
            messages,
          }),
        });
        if (!res.ok) {
          return { content: [{ type: "text", text: `xAI API error ${res.status}: ${await res.text()}` }], isError: true };
        }
        const data = await res.json();
        // Observability: ground-truth which model actually served the response
        // (xAI silently routes legacy aliases). Goes to journald, not the reply.
        console.error(`[ask_grok] model: requested=${model ?? DEFAULT_MODEL} resolved=${data?.model ?? "?"}`);
        const reply = data?.choices?.[0]?.message?.content ?? "(no content returned)";
        return { content: [{ type: "text", text: reply }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Request failed: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  server.registerTool(
    "get_odds",
    {
      title: "Get Odds",
      description:
        "Current prediction-market odds for a topic. Full-text searches liquid markets and returns, per market: implied probability, outcome label, USD-normalized volume, liquidity, a resolution URL, and close_date. NOTE: close_date is the event/expiry date associated with the market, NOT the live trading cutoff — markets typically remain tradeable until resolution, so do not infer \"trading closed\" from a past close_date. Results sorted by salience. sources defaults to ['polymarket','kalshi'].",
      inputSchema: {
        query: z
          .string()
          .refine((s) => s.trim().length > 0, {
            message: "query must not be empty or whitespace-only",
          })
          .describe("Topic to search, e.g. 'fed rate cut', 'california governor primary'. Broader terms return more markets."),
        limit: z.number().optional().describe("Max markets to return (default 5)."),
        sources: z.array(z.string()).optional().describe("Venues to query; default ['polymarket','kalshi']."),
      },
    },
    async ({ query, limit, sources }) => {
      try {
        const result = await getOdds(query, limit ?? 5, sources ?? ["polymarket", "kalshi"]);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `get_odds failed: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  registerGrokXSearch(server, { apiKey: XAI_API_KEY, baseUrl: XAI_BASE_URL, model: DEFAULT_MODEL });
  registerAskGemini(server, { apiKey: GEMINI_API_KEY });

  return server;
}

const app = express();
app.use(express.json());

// Mount path comes from the MCP_PATH env var (set in the off-repo env file),
// comma-separated for multiple mounts. Never hardcode it here.
const MCP_PATHS = (process.env.MCP_PATH ?? "/mcp")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

// Stateless: a fresh server + transport per request. Simple and fine for a single-tool personal server.
app.post(MCP_PATHS, async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// Stateless mode does not use long-lived GET/DELETE sessions.
app.get(MCP_PATHS, (_req, res) => res.status(405).send("Method Not Allowed"));
app.delete(MCP_PATHS, (_req, res) => res.status(405).send("Method Not Allowed"));

app.listen(PORT, "127.0.0.1", () => console.log(`grok-mcp listening on 127.0.0.1:${PORT} (${MCP_PATHS.length} mount(s))`));
