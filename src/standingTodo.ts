/**
 * standing_todo_add — add-only park of open work for Grok chat.
 * Wraps standing-todos.sh. No list, done, note, or delete.
 *
 * grok-mcp.service has ProtectHome=read-only, so the unit sets
 * STANDING_TODOS_INPLACE=1 and whitelists only the standing-todos directory
 * (a file whitelist is dropped if the file is missing at process start).
 * The script overwrites the board instead of creating a sibling temp.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execFileAsync = promisify(execFile);

export const OPEN_ITEM_CAP = 12;

const DEFAULT_SCRIPT = "/root/astra-config/scripts/standing-todos.sh";

export function defaultTodosPath(): string {
  return process.env.TODOS_PATH ?? join(homedir(), ".local/state/astra/standing-todos.json");
}

export function normTitle(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

interface TodoItem {
  id?: string;
  title?: string;
  status?: string;
  author?: string;
}

export function readOpenItems(todosPath: string): TodoItem[] {
  let raw: string;
  try {
    raw = readFileSync(todosPath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return [];
    throw e;
  }
  const doc = JSON.parse(raw) as { items?: TodoItem[] };
  const items = Array.isArray(doc.items) ? doc.items : [];
  return items.filter((i) => i.status === "open");
}

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine((s) => !/[\r\n]/.test(s), "title must be one line");

const nextSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((s) => !/[\r\n]/.test(s), "next must be one line");

const authorSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((s) => !/[\r\n]/.test(s), "author must be one line");

export type AddResult =
  | { ok: true; id: string; duplicate: false; open: number; owner: "agent"; priority: 3; author: string }
  | { ok: true; id: string; duplicate: true; open: number; owner: "agent"; priority: 3; author: string | null }
  | { ok: false; error: "open_cap"; open: number; cap: number };

export async function addStandingTodo(input: {
  title: string;
  next?: string;
  todosPath?: string;
  scriptPath?: string;
  cap?: number;
}): Promise<AddResult> {
  // Keep the deployed tool surface stable: creators sign the existing title
  // argument as "[Name / agent] Work title". Store the signature separately so
  // deduplication and the board title stay independent of the caller.
  const signedTitle = titleSchema.parse(input.title);
  const signature = /^\[([^\]\r\n]+)\]\s+(.+)$/.exec(signedTitle);
  if (!signature) {
    throw new Error('Sign the todo title as "[Your name / agent] Work title". The author is stored separately.');
  }
  const author = authorSchema.parse(signature[1]);
  const title = titleSchema.parse(signature[2]);
  const next = input.next === undefined ? undefined : nextSchema.parse(input.next);
  const todosPath = input.todosPath ?? defaultTodosPath();
  const scriptPath = input.scriptPath ?? process.env.STANDING_TODOS_SH ?? DEFAULT_SCRIPT;
  const cap = input.cap ?? OPEN_ITEM_CAP;

  const openItems = readOpenItems(todosPath);
  const want = normTitle(title);
  const existing = openItems.find((i) => i.title && normTitle(i.title) === want && i.id);
  if (existing?.id) {
    return {
      ok: true,
      id: existing.id,
      duplicate: true,
      open: openItems.length,
      owner: "agent",
      priority: 3,
      author: existing.author ?? null,
    };
  }
  if (openItems.length >= cap) {
    return { ok: false, error: "open_cap", open: openItems.length, cap };
  }

  const args = ["add", title, "--author", author, "--owner", "agent", "--priority", "3"];
  if (next) args.push("--next", next);

  let stdout: string;
  try {
    const result = await execFileAsync(scriptPath, args, {
      timeout: 5000,
      env: { ...process.env, TODOS_PATH: todosPath },
    });
    stdout = result.stdout;
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message?: string };
    const stderr = typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8");
    throw new Error((stderr || err.message || "standing-todos.sh failed").trim());
  }

  const id = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
  if (!id) throw new Error("standing-todos.sh returned no id");

  const open = readOpenItems(todosPath).length;
  return { ok: true, id, duplicate: false, open, owner: "agent", priority: 3, author };
}

export function registerStandingTodoAdd(server: any) {
  server.registerTool(
    "standing_todo_add",
    {
      title: "Add Standing Todo",
      description:
        "Add one piece of open work to the board Grok Build ships from. Sign title as \"[Your name / agent] Work " +
          "title\"; the signature is stored separately as author. Use this for todos, reminders and parking slips; never " +
          "use memory_* or the KB. Owner is always agent and priority 3. Returns an existing open same-title item as a " +
          "duplicate; refuses new items at " + OPEN_ITEM_CAP +
          " open. Add-only: cannot list, complete, note or delete.",
      inputSchema: {
        title: titleSchema.describe("Signed one-line title: \"[Your name / agent] Work title\". Signature is stored as author, separate from owner."),
        next: nextSchema
          .optional()
          .describe("Optional one-line next step. Omit when the title is enough."),
      },
    },
    async (args: { title: string; next?: string }) => {
      try {
        const result = await addStandingTodo(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: !result.ok,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `standing_todo_add failed: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
