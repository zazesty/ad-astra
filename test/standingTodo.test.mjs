/**
 * standing_todo_add: add-only wrapper around standing-todos.sh.
 *   node test/standingTodo.test.mjs
 */
import { mkdtemp, readFile, rm, writeFile, access, mkdir, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addStandingTodo, normTitle, OPEN_ITEM_CAP } from "../build/standingTodo.js";

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
    title: "  Ship the widget  ",
    next: "Grok Build: look at the widget",
    todosPath: board,
    scriptPath: SCRIPT,
  });
  check("add ok", added.ok === true && added.duplicate === false);
  check("open is 1", added.open === 1);
  const doc = await load(board);
  const item = openItems(doc)[0];
  check("title trimmed", item.title === "Ship the widget");
  check("owner agent", item.owner === "agent");
  check("priority 3", item.priority === 3);
  check("next stored", item.next_action === "Grok Build: look at the widget");
  check("id returned", added.id === item.id);

  const bare = await addStandingTodo({
    title: "No next step",
    todosPath: board,
    scriptPath: SCRIPT,
  });
  check("next omitted", bare.ok && bare.duplicate === false);
  const bareItem = openItems(await load(board)).find((i) => i.id === bare.id);
  check("next_action null", bareItem.next_action === null);

  const dup = await addStandingTodo({
    title: "ship   THE widget",
    todosPath: board,
    scriptPath: SCRIPT,
  });
  check("duplicate returns same id", dup.ok && dup.duplicate === true && dup.id === added.id);
  check("duplicate does not add", openItems(await load(board)).length === 2);

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
    title: "One more",
    todosPath: full,
    scriptPath: SCRIPT,
  });
  check("cap refuses", capped.ok === false && capped.error === "open_cap" && capped.open === 12);
  check("cap does not write", openItems(await load(full)).length === OPEN_ITEM_CAP);

  const inplaceBoard = join(dir, "inplace.json");
  await writeFile(inplaceBoard, JSON.stringify({ schema: "standing-todos/v1", updated: null, items: [] }));
  process.env.STANDING_TODOS_INPLACE = "1";
  const inplace = await addStandingTodo({
    title: "In place",
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
    title: "Through the symlink",
    todosPath: linkBoard,
    scriptPath: SCRIPT,
  });
  check("symlink add ok", viaLink.ok === true && viaLink.duplicate === false);
  check("symlink survives atomic replace", (await lstat(linkBoard)).isSymbolicLink());
  check("symlink target has the item", openItems(await load(join(realDir, "standing-todos.json"))).length === 1);

  process.env.STANDING_TODOS_INPLACE = "1";
  const viaLinkInplace = await addStandingTodo({
    title: "Through the symlink inplace",
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
