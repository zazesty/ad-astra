import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getOdds } from "./oddsTool.js";
import { registerGrokXSearch } from "./grokXSearch.js";
import { registerAskPanel } from "./panel.js";
import { loadLensesRaw } from "./lenses.js";

const XAI_API_KEY = process.env.XAI_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_MODEL = "grok-4.3";
const PORT = Number(process.env.PORT ?? 3000);

function buildServer() {
  const server = new McpServer({ name: "grok-mcp-remote", version: "1.0.0" });

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
  registerAskPanel(server, { xaiApiKey: XAI_API_KEY, geminiApiKey: GEMINI_API_KEY, xaiBaseUrl: XAI_BASE_URL });

  // Lens menu as a readable resource (not a tool param), so any client can
  // discover the frames and edits to lenses.md need no schema change / redeploy.
  server.registerResource(
    "lenses",
    "lenses://frames",
    {
      title: "Analytical lenses",
      description: "Menu of analytical frames. Pass a lens name in the `lens` field of an ask_panel spec to apply it via the system prompt.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: loadLensesRaw() || "(no lenses defined)" }],
    }),
  );

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
