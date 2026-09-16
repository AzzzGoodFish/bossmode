// Memory asset character budgets — fixed product constants.
// Until 2026-09-16 these four budgets were user-configurable (config.json
// `memoryBudgets`, settings UI); configuration was retired in the P1
// offline-cleanup and the values are fixed at the previous product defaults.
export type MemoryBudgetKind = "persona" | "memberPrinciples" | "mainline" | "roomPrinciples";

/** Fixed budgets — the previous product defaults (pre-configuration behavior). */
export const MEMORY_BUDGET_DEFAULTS: Record<MemoryBudgetKind, number> = {
  persona: 4_000,
  memberPrinciples: 4_000,
  mainline: 4_000,
  roomPrinciples: 8_000,
};

/** Read one budget (now a constant). */
export function getMemoryBudget(kind: MemoryBudgetKind): number {
  return MEMORY_BUDGET_DEFAULTS[kind];
}

/** Read all four budgets (for panel display). */
export function getMemoryBudgets(): Record<MemoryBudgetKind, number> {
  return { ...MEMORY_BUDGET_DEFAULTS };
}
