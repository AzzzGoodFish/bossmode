import { describe, expect, it } from "vitest";
import { budgetTone, formatRelativeTime, formatSinceDate } from "../../web/src/utils/member-panel-view.js";

describe("member panel view helpers", () => {
  it("formats relative times for revision lines", () => {
    const now = Date.parse("2026-07-17T12:00:00Z");
    expect(formatRelativeTime(undefined, now)).toBe("never");
    expect(formatRelativeTime(now - 5_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatRelativeTime(now - 45 * 86_400_000, now)).toMatch(/^\w{3} \d{1,2}, \d{4}$/);
  });

  it("formats the member-since date", () => {
    expect(formatSinceDate(Date.parse("2026-07-08T08:00:00Z"))).toBe("Jul 8");
  });

  it("tones budget meters: ok < 70%, warn ≥ 70%, over ≥ 90% or overLimit", () => {
    expect(budgetTone({ pct: 42 })).toBe("ok");
    expect(budgetTone({ pct: 70 })).toBe("warn");
    expect(budgetTone({ pct: 90 })).toBe("over");
    expect(budgetTone({ pct: 125, overLimit: true })).toBe("over");
  });

});
