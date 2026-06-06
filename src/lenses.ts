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

export const LENS_PARAM_DESCRIPTION =
  "Analytical frame applied via the system prompt. OMIT to use the 'default' " +
  "second-opinion frame (auto-applied when you pass no system text); pass a lens " +
  "name for a specific frame (read the `lenses://frames` resource for the menu, " +
  "e.g. 'pre-mortem', 'steelman-then-break'); pass 'none' to disable framing. " +
  "Composes with `system`: lens first, then your system text.";
