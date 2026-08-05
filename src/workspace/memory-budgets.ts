// Memory budget configuration (0.20 experience batch ①, fish 2026-08-05).
// The four memory-asset character budgets were hard-coded constants scattered
// across three stores. This module is the single source of truth: compile,
// write validation, and panel percentage all read through getMemoryBudget.
// Config lives in config.json under `memoryBudgets` (optional — absent =
// product defaults 4000/4000/4000/8000, identical to pre-0.20.0-rc.9).
// Semantics: lowering a budget never truncates existing content; a write is
// rejected until the asset is trimmed (same as the current over-limit rule).
import { readConfig } from "../shared/config.js";

export type MemoryBudgetKind = "persona" | "memberPrinciples" | "mainline" | "roomPrinciples";

/** Product defaults — the pre-configuration behavior. */
export const MEMORY_BUDGET_DEFAULTS: Record<MemoryBudgetKind, number> = {
  persona: 4_000,
  memberPrinciples: 4_000,
  mainline: 4_000,
  roomPrinciples: 8_000,
};

/** Clamp: positive integers only; garbage falls back to the default. */
function sanitize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/** Read one budget from config (config file missing → product default). */
export function getMemoryBudget(kind: MemoryBudgetKind): number {
  let config;
  try {
    config = readConfig();
  } catch {
    return MEMORY_BUDGET_DEFAULTS[kind];
  }
  const budgets = config.memoryBudgets || {};
  return sanitize(budgets[kind], MEMORY_BUDGET_DEFAULTS[kind]);
}

/** Read all four budgets, normalized (for settings API + panel display). */
export function getMemoryBudgets(): Record<MemoryBudgetKind, number> {
  return {
    persona: getMemoryBudget("persona"),
    memberPrinciples: getMemoryBudget("memberPrinciples"),
    mainline: getMemoryBudget("mainline"),
    roomPrinciples: getMemoryBudget("roomPrinciples"),
  };
}

/** Validate a partial update payload; throws on any invalid value. */
export function normalizeMemoryBudgetsInput(input: Record<string, unknown>): Record<MemoryBudgetKind, number> {
  const current = getMemoryBudgets();
  const next = { ...current };
  for (const key of Object.keys(MEMORY_BUDGET_DEFAULTS) as MemoryBudgetKind[]) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`memoryBudgets.${key} must be a positive number`);
    }
    next[key] = Math.floor(value);
  }
  return next;
}
