// Analytical lenses — canonical text lives in ../lenses.md (repo root, NOT
// copied into build/, so no post-tsc copy step). Read live on each call so
// edits to lenses.md take effect with no rebuild and no service restart.
import { readFileSync } from "node:fs";

const LENSES_PATH = new URL("../lenses.md", import.meta.url);

export type Lens = { name: string; blurb: string; body: string };

export function loadLensesRaw(): string {
  try {
    return readFileSync(LENSES_PATH, "utf8");
  } catch {
    return "";
  }
}

// Parse H2 sections: "## name" / blurb line / body. Preamble before the first
// "## " is ignored.
export function loadLenses(): Map<string, Lens> {
  const map = new Map<string, Lens>();
  const sections = loadLensesRaw().split(/^##\s+/m).slice(1);
  for (const sec of sections) {
    const lines = sec.split("\n");
    const name = (lines[0] ?? "").trim();
    if (!name) continue;
    const rest = lines.slice(1);
    let i = 0;
    while (i < rest.length && rest[i].trim() === "") i++;
    const blurb = (rest[i] ?? "").trim();
    const body = rest.slice(i + 1).join("\n").trim();
    map.set(name.toLowerCase(), { name, blurb, body: body || blurb });
  }
  return map;
}

// Compose the effective system prompt: lens body first, caller's system after.
// Returns {error} (with the valid menu) when an unknown lens name is passed.
const DEFAULT_LENS = "default";

export function applyLens(
  lensName: string | undefined,
  system: string | undefined,
): { system?: string; error?: string } {
  const requested = (lensName ?? "").trim().toLowerCase();

  // Explicit opt-out of any framing.
  if (requested === "none" || requested === "off") return { system };

  // No lens specified: auto-apply the default second-opinion frame — but only
  // when the caller didn't supply their own system text (a custom system wins).
  if (!requested) {
    if (system && system.trim()) return { system };
    const def = loadLenses().get(DEFAULT_LENS);
    return { system: def ? def.body : system };
  }

  const lenses = loadLenses();
  const lens = lenses.get(requested);
  if (!lens) {
    const names = [...lenses.values()].map((l) => l.name).join(", ");
    return {
      error: `Unknown lens "${lensName}". Available: ${names || "(none)"}. Read the lenses://frames resource for the menu.`,
    };
  }
  return { system: system ? `${lens.body}\n\n${system}` : lens.body };
}

// Built from lenses.md at tool-registration time so the menu is visible IN THE
// SCHEMA (clients that don't surface the lenses://frames resource — e.g. the
// Grok chatbot — still see the options). Single source of truth = lenses.md;
// adding/renaming a lens updates this on restart.
// Just the frame menu ("'name' — blurb; ..."), live from lenses.md. Shared by
// every tool's lens param so the option list has one source of truth.
export function buildLensMenu(): string {
  return [...loadLenses().values()].map((l) => `'${l.name}' — ${l.blurb}`).join("; ");
}

export function buildLensParamDescription(): string {
  return (
    "Analytical frame applied via the system prompt. OMIT to auto-apply the " +
    "'default' second-opinion frame (skipped if you pass a custom `system`); " +
    "pass 'none' to disable framing; or choose one: " +
    buildLensMenu() +
    ". Composes with `system`: lens first, then your system text."
  );
}
