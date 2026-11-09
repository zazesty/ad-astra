/**
 * Per-consumer wall-clock envelopes.
 *
 * Three envelopes:
 * - Grok Build (`grok-cli/*`, 120s envelope, fanout outer 85s).
 * - Claude (`Claude-User`, claude.ai custom connector and Claude Code; both die near 60s broker timeout, fanout outer 55s).
 * - Grok chat & unknown clients (~60s MCP tool window, fanout outer 50s).
 *
 * Unknown UAs get the chat envelope so a hung seat cannot discard siblings.
 * Engine-internal — not a tool-surface change.
 */

import { MIN_NEXT_ATTEMPT_MS } from "./timeouts.js";

export type BudgetProfileName = "cli" | "chat" | "claude";

export interface BudgetProfile {
  name: BudgetProfileName;
  panelOuterMs: number;
  panelOrAttemptMs: number;
  panelGrokSeatMs: number;
  panelGeminiSeatMs: number;
  panelOpenaiSeatMs: number;
  panelClaudeSeatMs: number;
  /** Soft whole-call cap so salvage/classify cannot run past the client window. */
  oracleOuterMs: number;
  oracleSlotMs: number;
  oracleOrAttemptMs: number;
  oracleGrokReasoningMs: number;
  oracleCapabilityMs: number;
  oracleFusionMs: number;
  oracleFusionOrAttemptMs: number;
  fanoutOuterMs: number;
  fanoutLegSeatMs?: number;
}

/** Grok Build loopback — current 2026-08 seat caps. */
export const CLI_BUDGET: BudgetProfile = {
  name: "cli",
  panelOuterMs: 110_000,
  panelOrAttemptMs: 60_000,
  panelGrokSeatMs: 80_000,
  panelGeminiSeatMs: 100_000,
  panelOpenaiSeatMs: 80_000,
  panelClaudeSeatMs: 80_000,
  oracleOuterMs: 180_000,
  oracleSlotMs: 70_000,
  oracleOrAttemptMs: 60_000,
  oracleGrokReasoningMs: 70_000,
  oracleCapabilityMs: 60_000,
  oracleFusionMs: 120_000,
  oracleFusionOrAttemptMs: 110_000,
  fanoutOuterMs: 85_000,
  fanoutLegSeatMs: 45_000,
};

/**
 * Grok chat / unknown HTTP clients. Outer 50s so JSON flushes before a ~60s
 * client hangup. OR abort 40s leaves serialize margin; too little for failover
 * (see MIN_NEXT_ATTEMPT_MS).
 */
export const CHAT_BUDGET: BudgetProfile = {
  name: "chat",
  panelOuterMs: 50_000,
  panelOrAttemptMs: 40_000,
  panelGrokSeatMs: 50_000,
  panelGeminiSeatMs: 50_000,
  panelOpenaiSeatMs: 50_000,
  panelClaudeSeatMs: 50_000,
  oracleOuterMs: 50_000,
  oracleSlotMs: 50_000,
  oracleOrAttemptMs: 40_000,
  oracleGrokReasoningMs: 50_000,
  oracleCapabilityMs: 50_000,
  oracleFusionMs: 50_000,
  oracleFusionOrAttemptMs: 45_000,
  fanoutOuterMs: 50_000,
  fanoutLegSeatMs: 45_000,
};

/**
 * Claude chat (claude.ai custom connector) & Claude Code (`Claude-User` UA).
 * Both die near 60s broker timeout. Fanout outer 55s gives legs/synth maximum room
 * while returning before broker disconnect. Panel/oracle stay on 50s chat envelope.
 */
export const CLAUDE_BUDGET: BudgetProfile = {
  name: "claude",
  panelOuterMs: 50_000,
  panelOrAttemptMs: 40_000,
  panelGrokSeatMs: 50_000,
  panelGeminiSeatMs: 50_000,
  panelOpenaiSeatMs: 50_000,
  panelClaudeSeatMs: 50_000,
  oracleOuterMs: 50_000,
  oracleSlotMs: 50_000,
  oracleOrAttemptMs: 40_000,
  oracleGrokReasoningMs: 50_000,
  oracleCapabilityMs: 50_000,
  oracleFusionMs: 50_000,
  oracleFusionOrAttemptMs: 45_000,
  fanoutOuterMs: 55_000,
  fanoutLegSeatMs: 50_000,
};

export function budgetProfileFromUserAgent(ua: string | undefined | null): BudgetProfile {
  const s = String(ua ?? "").toLowerCase();
  if (s.includes("grok-cli")) return CLI_BUDGET;
  if (s.includes("claude")) return CLAUDE_BUDGET;
  return CHAT_BUDGET;
}

export function shortUserAgent(ua: string | undefined | null): string {
  return String(ua ?? "-").replace(/[\r\n\t]/g, " ").slice(0, 120);
}

export { MIN_NEXT_ATTEMPT_MS };
