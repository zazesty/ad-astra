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
  "memory_search",
  "memory_retrieve",
  "memory_upsert",
  "memory_list",
  "get_metrics",
  "research_fanout",
  "standing_todo_add",
] as const;

export type McpToolName = (typeof MCP_TOOLS)[number];

export const MCP_TOOL_COUNT: number = MCP_TOOLS.length;

export type ExpectedToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
};

/**
 * Expected MCP tool annotations for every tool on the surface.
 * Note: MCP annotations are static per tool; get_news_digest defaults to
 * email=true and updates state, so it stays readOnlyHint: false.
 */
export const TOOL_ANNOTATIONS: Record<McpToolName, ExpectedToolAnnotations> = {
  get_odds: { readOnlyHint: true, destructiveHint: false },
  ask_panel: { readOnlyHint: true, destructiveHint: false },
  get_news_digest: { readOnlyHint: false, destructiveHint: false },
  memory_search: { readOnlyHint: true, destructiveHint: false },
  memory_retrieve: { readOnlyHint: true, destructiveHint: false },
  memory_upsert: { readOnlyHint: false, destructiveHint: true },
  memory_list: { readOnlyHint: true, destructiveHint: false },
  get_metrics: { readOnlyHint: true, destructiveHint: false },
  research_fanout: { readOnlyHint: true, destructiveHint: false },
  standing_todo_add: { readOnlyHint: false, destructiveHint: false },
};
