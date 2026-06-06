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
export function applyLens(
  lensName: string | undefined,
  system: string | undefined,
): { system?: string; error?: string } {
  if (!lensName || !lensName.trim()) return { system };
  const lenses = loadLenses();
  const lens = lenses.get(lensName.trim().toLowerCase());
  if (!lens) {
    const names = [...lenses.values()].map((l) => l.name).join(", ");
    return {
      error: `Unknown lens "${lensName}". Available: ${names || "(none)"}. Read the lenses://frames resource for the menu.`,
    };
  }
  return { system: system ? `${lens.body}\n\n${system}` : lens.body };
}

export const LENS_PARAM_DESCRIPTION =
  "Optional analytical lens applied via the system prompt — pass a lens name " +
  "(read the `lenses://frames` resource for the menu, e.g. 'default', " +
  "'pre-mortem'). Composes with `system`: lens first, then your system text.";
