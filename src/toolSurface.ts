/**
 * Single source of truth for the MCP tool surface.
 * Smoke-test + unit tests derive expected tool count from here so we never
 * hand-bump EXPECTED_TOOLS when adding/removing a tool.
 *
 * Keep this list in lockstep with every `server.registerTool("…")` first arg.
 * `test/toolSurface.test.mjs` greps src/ and fails on drift.
 */
export const MCP_TOOLS = [
  "get_odds",
  "ask_panel",
  "get_news_digest",
  "ask_consortium",
  "memory_search",
  "memory_retrieve",
  "memory_upsert",
  "memory_list",
  "get_metrics",
  "research_fanout",
] as const;

export type McpToolName = (typeof MCP_TOOLS)[number];

export const MCP_TOOL_COUNT: number = MCP_TOOLS.length;
