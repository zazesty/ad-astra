/**
 * standing_todo_add: add-only wrapper around standing-todos.sh.
 *   node test/standingTodo.test.mjs
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, access, mkdir, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addStandingTodo, normTitle, OPEN_ITEM_CAP, registerStandingTodoAdd } from "../build/standingTodo.js";

const execFileAsync = promisify(execFile);
const AUTHOR = "Codex / GPT test author";
const signedTitle = (title, author = AUTHOR) => `[${author}] ${title}`;

const SCRIPT = "/root/astra-config/scripts/standing-todos.sh";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

async function load(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function openItems(doc) {
  return doc.items.filter((i) => i.status === "open");
}

console.log("Unit: standing_todo_add");

check("cap is 12", OPEN_ITEM_CAP === 12);
check("norm collapses case and space", normTitle("  Hello   Board ") === "hello board");

const dir = await mkdtemp(join(tmpdir(), "standing-todo-"));
const board = join(dir, "standing-todos.json");
try {
  const added = await addStandingTodo({
    title: `  ${signedTitle("Ship the widget")}  `,
    next: "Grok Build: look at the widget",
    todosPath: board,
    scriptPath: SCRIPT,
  });
  check("add ok", added.ok === true && added.duplicate === false);
  check("open is 1", added.open === 1);
  const doc = await load(board);
  const item = openItems(doc)[0];
  check("title trimmed", item.title === "Ship the widget");
  check("author forwarded and stored", item.author === AUTHOR);
  check("author returned", added.author === AUTHOR);
  check("owner agent", item.owner === "agent");
  check("priority 3", item.priority === 3);
  check("next stored", item.next_action === "Grok Build: look at the widget");
  check("id returned", added.id === item.id);

  const bare = await addStandingTodo({
    title: signedTitle("No next step"),
    todosPath: board,
    scriptPath: SCRIPT,
  });
  check("next omitted", bare.ok && bare.duplicate === false);
  const bareItem = openItems(await load(board)).find((i) => i.id === bare.id);
  check("next_action null", bareItem.next_action === null);

  const dup = await addStandingTodo({
    title: signedTitle("ship   THE widget", "Another agent"),
    todosPath: board,
    scriptPath: SCRIPT,
  });
  check("duplicate returns same id", dup.ok && dup.duplicate === true && dup.id === added.id);
  check("duplicate does not add", openItems(await load(board)).length === 2);
  check("duplicate preserves original author", dup.author === AUTHOR && openItems(await load(board))[0].author === AUTHOR);


  const beforeInvalid = await readFile(board, "utf8");
  for (const title of ["Unsigned", "[] Unsigned", "[  ] Unsigned", "[Agent\nOther] Unsigned", signedTitle("Unsigned", "A".repeat(101))]) {
    let rejected = false;
    try {
      await addStandingTodo({ title, todosPath: board, scriptPath: SCRIPT });
    } catch {
      rejected = true;
    }
    check(`invalid signature rejected: ${JSON.stringify(title)}`, rejected);
  }
  check("invalid authors do not modify board", await readFile(board, "utf8") === beforeInvalid);

  const cliBoard = join(dir, "cli.json");
  for (const args of [["add", "Unsigned"], ["add", "Blank", "--author", "  "], ["add", "Multiline", "--author", "Agent\nOther"]]) {
    let rejected = false;
    try {
      await execFileAsync(SCRIPT, args, { env: { ...process.env, TODOS_PATH: cliBoard } });
    } catch (err) {
      rejected = err.code === 2 && err.stderr.includes("--author is required");
    }
    check(`CLI rejects invalid author: ${args[1]}`, rejected);
  }
  let unsignedBoardExists = true;
  try { await access(cliBoard); } catch { unsignedBoardExists = false; }
  check("CLI rejection does not create board", !unsignedBoardExists);

  let registration;
  registerStandingTodoAdd({ registerTool(name, config, callback) { registration = { name, config, callback }; } });
  check("MCP schema keeps original arguments", Object.keys(registration.config.inputSchema).join(",") === "title,next");
  const oldTodosPath = process.env.TODOS_PATH;
  const oldScriptPath = process.env.STANDING_TODOS_SH;
  process.env.TODOS_PATH = cliBoard;
  process.env.STANDING_TODOS_SH = SCRIPT;
  try {
    const unsigned = await registration.callback({ title: "Unsigned MCP" });
    check("MCP callback rejects unsigned title with instructions", unsigned.isError === true && unsigned.content[0].text.includes("[Your name / agent] Work title"));
    const signed = await registration.callback({ title: signedTitle("Signed MCP", "MCP agent") });
    check("MCP callback stores signed author", !signed.isError && openItems(await load(cliBoard))[0].author === "MCP agent");
  } finally {
    if (oldTodosPath === undefined) delete process.env.TODOS_PATH; else process.env.TODOS_PATH = oldTodosPath;
    if (oldScriptPath === undefined) delete process.env.STANDING_TODOS_SH; else process.env.STANDING_TODOS_SH = oldScriptPath;
  }

  const legacyBoard = join(dir, "legacy.json");
  const legacy = { id: "legacy", title: "Old item", status: "open", owner: "human" };
  await writeFile(legacyBoard, JSON.stringify({ items: [legacy] }));
  const legacyDuplicate = await addStandingTodo({ title: signedTitle("Old item"), todosPath: legacyBoard, scriptPath: SCRIPT });
  check("legacy duplicate has unknown author", legacyDuplicate.duplicate && legacyDuplicate.author === null);
  check("legacy author never fabricated", !("author" in (await load(legacyBoard)).items[0]));
  const legacyList = await execFileAsync(SCRIPT, ["list"], { env: { ...process.env, TODOS_PATH: legacyBoard } });
  check("legacy list shows unknown author", legacyList.stdout.includes("author=unknown (legacy)"));
  const signedList = await execFileAsync(SCRIPT, ["list"], { env: { ...process.env, TODOS_PATH: board } });
  check("list shows signed author", signedList.stdout.includes(`author=${AUTHOR}`));

  const seeded = {
    schema: "standing-todos/v1",
    updated: null,
    items: Array.from({ length: OPEN_ITEM_CAP }, (_, n) => ({
      id: `seed-${n}`,
      title: `Seed ${n}`,
      status: "open",
      owner: "agent",
      priority: 3,
      blocked_on: null,
      next_action: null,
      created: "2026-10-13T00:00:00Z",
      updated: "2026-10-13T00:00:00Z",
      notes: [],
    })),
  };
  seeded.items.push({
    id: "done-1",
    title: "Already shipped",
    status: "done",
    owner: "agent",
    priority: 3,
    blocked_on: null,
    next_action: null,
    created: "2026-10-13T00:00:00Z",
    updated: "2026-10-13T00:00:00Z",
    notes: [],
  });
  const full = join(dir, "full.json");
  await writeFile(full, JSON.stringify(seeded));
  const capped = await addStandingTodo({
    title: signedTitle("One more"),
    todosPath: full,
    scriptPath: SCRIPT,
  });
  check("cap refuses", capped.ok === false && capped.error === "open_cap" && capped.open === 12);
  check("cap does not write", openItems(await load(full)).length === OPEN_ITEM_CAP);

  const inplaceBoard = join(dir, "inplace.json");
  await writeFile(inplaceBoard, JSON.stringify({ schema: "standing-todos/v1", updated: null, items: [] }));
  process.env.STANDING_TODOS_INPLACE = "1";
  const inplace = await addStandingTodo({
    title: signedTitle("In place"),
    todosPath: inplaceBoard,
    scriptPath: SCRIPT,
  });
  delete process.env.STANDING_TODOS_INPLACE;
  check("inplace add ok", inplace.ok === true && inplace.duplicate === false);
  const inplaceDoc = await load(inplaceBoard);
  check("inplace item present", openItems(inplaceDoc).length === 1);
  let tmpLeft = false;
  try {
    await access(join(dir, "inplace.tmp"));
    tmpLeft = true;
  } catch {
    tmpLeft = false;
  }
  check("inplace leaves no temp", tmpLeft === false);

  const realDir = join(dir, "realboard");
  const linkDir = join(dir, "linkdir");
  await mkdir(realDir);
  await mkdir(linkDir);
  const linkBoard = join(linkDir, "standing-todos.json");
  await symlink(join(realDir, "standing-todos.json"), linkBoard);
  const viaLink = await addStandingTodo({
    title: signedTitle("Through the symlink"),
    todosPath: linkBoard,
    scriptPath: SCRIPT,
  });
  check("symlink add ok", viaLink.ok === true && viaLink.duplicate === false);
  check("symlink survives atomic replace", (await lstat(linkBoard)).isSymbolicLink());
  check("symlink target has the item", openItems(await load(join(realDir, "standing-todos.json"))).length === 1);

  process.env.STANDING_TODOS_INPLACE = "1";
  const viaLinkInplace = await addStandingTodo({
    title: signedTitle("Through the symlink inplace"),
    todosPath: linkBoard,
    scriptPath: SCRIPT,
  });
  delete process.env.STANDING_TODOS_INPLACE;
  check("symlink inplace add ok", viaLinkInplace.ok === true && viaLinkInplace.duplicate === false);
  check("symlink survives inplace write", (await lstat(linkBoard)).isSymbolicLink());
  check(
    "symlink inplace target has both",
    openItems(await load(join(realDir, "standing-todos.json"))).length === 2,
  );
} finally {
  delete process.env.STANDING_TODOS_INPLACE;
  await rm(dir, { recursive: true, force: true });
}

let rejected = false;
try {
  await addStandingTodo({ title: "  ", todosPath: join(dir, "nope.json"), scriptPath: SCRIPT });
} catch {
  rejected = true;
}
check("blank title rejected", rejected);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
