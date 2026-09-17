/** View helpers for the Member panel (pure, unit-tested). */

/** Short relative time for asset revision lines: "just now" / "5m ago" / "3h ago" / "2d ago" / "Jul 8, 2026". */
export function formatRelativeTime(ts?: number, now: number = Date.now()): string {
  if (!ts) return "never";
  const diff = Math.max(0, now - ts);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "Jul 8" style date for the member-since line. */
export function formatSinceDate(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export type BudgetTone = "ok" | "warn" | "over";

/** Budget meter tone: over-limit or ≥90% blocked, ≥70% warn, else accent. */
export function budgetTone(budget: { pct: number; overLimit?: boolean }): BudgetTone {
  if (budget.overLimit || budget.pct >= 90) return "over";
  if (budget.pct >= 70) return "warn";
  return "ok";
}
