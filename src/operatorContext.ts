/**
 * operatorContext — live read-only access to operator rails (OPERATOR.md),
 * shared harness files (AGENTS.md, CLAUDE.md), and open standing todos.
 *
 * Reads live from disk on each call (no caching across calls) so edits take
 * effect without a service restart. Exposes both MCP resources and the
 * `get_operator_context` tool so remote CLI/chat agents inherit rules and
 * open work reliably regardless of client resource support.
 */
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { defaultTodosPath } from "./standingTodo.js";

export const CONTEXT_SECTIONS = [
  "all",
  "manifest",
  "operator",
  "agents",
  "claude",
  "todos",
] as const;

export type ContextSection = (typeof CONTEXT_SECTIONS)[number];

export interface MarkdownFileInfo {
  path: string;
  available: boolean;
  bytes: number;
  updated_at: string | null;
  content: string | null;
}

export interface OpenTodoNote {
  ts?: string;
  text?: string;
}

export interface OpenTodoItem {
  id: string | null;
  priority: number;
  owner: string;
  author: string | null;
  title: string;
  blocked_on: string | null;
  plain: string | null;
  next_action: string | null;
  notes: OpenTodoNote[];
  created: string | null;
  updated: string | null;
}

export interface OpenTodosInfo {
  path: string;
  available: boolean;
  updated: string | null;
  open_count: number;
  items: OpenTodoItem[];
}

export function resolveOperatorMdPath(): string {
  return process.env.OPERATOR_MD_PATH ?? "/root/OPERATOR.md";
}

export function resolveAgentsMdPath(): string {
  return process.env.AGENTS_MD_PATH ?? "/root/AGENTS.md";
}

export function resolveClaudeMdPath(): string {
  return process.env.CLAUDE_MD_PATH ?? "/root/CLAUDE.md";
}

export function readMarkdownFile(filePath: string): MarkdownFileInfo {
  try {
    const content = readFileSync(filePath, "utf8");
    const st = statSync(filePath);
    return {
      path: filePath,
      available: true,
      bytes: Buffer.byteLength(content, "utf8"),
      updated_at: st.mtime.toISOString(),
      content,
    };
  } catch {
    return {
      path: filePath,
      available: false,
      bytes: 0,
      updated_at: null,
      content: null,
    };
  }
}

function numericPriority(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return 5;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : 5;
}

export function loadOpenTodos(todosPath: string = defaultTodosPath()): OpenTodosInfo {
  try {
    const raw = readFileSync(todosPath, "utf8");
    const doc = JSON.parse(raw) as {
      updated?: string | null;
      items?: Array<Record<string, unknown>>;
    };
    const rawItems = Array.isArray(doc.items) ? doc.items : [];
    const openItems: OpenTodoItem[] = rawItems
      .filter((item) => item && item.status === "open")
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : null,
        priority: numericPriority(item.priority),
        owner: typeof item.owner === "string" && item.owner ? item.owner : "either",
        author: typeof item.author === "string" && item.author ? item.author : null,
        title: typeof item.title === "string" ? item.title : "",
        blocked_on: typeof item.blocked_on === "string" && item.blocked_on ? item.blocked_on : null,
        plain: typeof item.plain === "string" && item.plain ? item.plain : null,
        next_action: typeof item.next_action === "string" && item.next_action ? item.next_action : null,
        notes: Array.isArray(item.notes) ? (item.notes as OpenTodoNote[]) : [],
        created: typeof item.created === "string" ? item.created : null,
        updated: typeof item.updated === "string" ? item.updated : null,
      }))
      .sort((a, b) => a.priority - b.priority);

    return {
      path: todosPath,
      available: true,
      updated: typeof doc.updated === "string" ? doc.updated : null,
      open_count: openItems.length,
      items: openItems,
    };
  } catch {
    return {
      path: todosPath,
      available: false,
      updated: null,
      open_count: 0,
      items: [],
    };
  }
}

export function formatOpenTodosMarkdown(todosPath: string = defaultTodosPath()): string {
  const todos = loadOpenTodos(todosPath);
  if (!todos.available) {
    return "# Open Standing Todos\n\n(board unavailable)\n";
  }
  const lines: string[] = [
    "# Open Standing Todos",
    "",
    `open=${todos.open_count} updated=${todos.updated ?? "unknown"}`,
    "",
  ];
  if (todos.items.length === 0) {
    lines.push("(no open items)");
    return lines.join("\n") + "\n";
  }
  for (const item of todos.items) {
    const author = item.author ?? "unknown (legacy)";
    lines.push(`- **[P${item.priority}]** \`${item.id ?? "unknown"}\` *(owner: ${item.owner}, author: ${author})* — **${item.title}**`);
    if (item.blocked_on) lines.push(`  - blocked_on: ${item.blocked_on}`);
    if (item.plain) lines.push(`  - plain: ${item.plain}`);
    if (item.next_action) lines.push(`  - next: ${item.next_action}`);
    for (const n of item.notes) {
      if (n && typeof n.text === "string" && n.text.trim()) {
        lines.push(`  - note (${n.ts ?? "?"}): ${n.text}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

function summarizeFile(info: MarkdownFileInfo, resource: string) {
  return {
    path: info.path,
    available: info.available,
    bytes: info.bytes,
    updated_at: info.updated_at,
    resource,
  };
}

export function getOperatorContext(section: ContextSection = "all") {
  if (section === "operator") {
    return { section, ...readMarkdownFile(resolveOperatorMdPath()) };
  }
  if (section === "agents") {
    return { section, ...readMarkdownFile(resolveAgentsMdPath()) };
  }
  if (section === "claude") {
    return { section, ...readMarkdownFile(resolveClaudeMdPath()) };
  }
  if (section === "todos") {
    return { section, ...loadOpenTodos() };
  }

  const operator = readMarkdownFile(resolveOperatorMdPath());
  const agents = readMarkdownFile(resolveAgentsMdPath());
  const claude = readMarkdownFile(resolveClaudeMdPath());
  const todos = loadOpenTodos();

  if (section === "manifest") {
    return {
      section: "manifest" as const,
      files: {
        operator: summarizeFile(operator, "operator://rules"),
        agents: summarizeFile(agents, "operator://agents"),
        claude: summarizeFile(claude, "operator://claude"),
      },
      todos: {
        path: todos.path,
        available: todos.available,
        updated: todos.updated,
        open_count: todos.open_count,
        resource: "todos://open",
      },
    };
  }

  return {
    section: "all" as const,
    operator,
    agents,
    claude,
    todos,
  };
}

export function registerOperatorContext(server: any) {
  server.registerTool(
    "get_operator_context",
    {
      title: "Get Operator Context",
      description:
        "Read live box operator rails (OPERATOR.md), shared harness instructions (AGENTS.md, CLAUDE.md), and open " +
          "standing todos (read-only) so remote CLI or chat agents inherit rules and active work without local file " +
          "syncing. Defaults to section='all'; pass 'manifest' for file sizes/open count without bodies, or a single " +
          "section ('operator', 'agents', 'claude', 'todos'). Open items only (completed todos are omitted). Use " +
          "standing_todo_add to park new open work and memory_* for durable KB facts.",
      inputSchema: {
        section: z
          .enum(CONTEXT_SECTIONS)
          .optional()
          .describe(
            "Slice to return (default 'all'). Use 'manifest' for metadata/counts without full text, or one of 'operator', 'agents', 'claude', 'todos'.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
    },
    async ({ section }: { section?: ContextSection }) => {
      try {
        const result = getOperatorContext(section ?? "all");
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `get_operator_context failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  const mdResource = (name: string, uri: string, title: string, description: string, getPath: () => string) => {
    server.registerResource(
      name,
      uri,
      {
        title,
        description,
        mimeType: "text/markdown",
      },
      async (u: URL) => {
        const info = readMarkdownFile(getPath());
        return {
          contents: [
            {
              uri: u.href,
              mimeType: "text/markdown",
              text: info.available && info.content !== null ? info.content : `(unavailable: ${info.path})`,
            },
          ],
        };
      },
    );
  };

  mdResource(
    "operator-rules",
    "operator://rules",
    "Operator Rails (OPERATOR.md)",
    "Live authority, autonomy, and communication rails from OPERATOR.md.",
    resolveOperatorMdPath,
  );
  mdResource(
    "operator-agents",
    "operator://agents",
    "Shared Agent Preamble (AGENTS.md)",
    "Live box architecture, non-negotiables, and deploy conventions from AGENTS.md.",
    resolveAgentsMdPath,
  );
  mdResource(
    "operator-claude",
    "operator://claude",
    "Claude Harness Rules (CLAUDE.md)",
    "Live agent harness conventions from CLAUDE.md.",
    resolveClaudeMdPath,
  );

  server.registerResource(
    "standing-todos-open",
    "todos://open",
    {
      title: "Open Standing Todos",
      description: "Live read-only list of open standing todos sorted by priority (completed items omitted).",
      mimeType: "text/markdown",
    },
    async (u: URL) => ({
      contents: [
        {
          uri: u.href,
          mimeType: "text/markdown",
          text: formatOpenTodosMarkdown(),
        },
      ],
    }),
  );
}
