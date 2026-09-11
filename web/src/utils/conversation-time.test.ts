import { describe, expect, it } from "vitest";
import { conversationTime } from "./conversation-time";
const now = new Date(2026, 8, 11, 18, 30).getTime();
describe("conversationTime", () => {
  it("uses a 24-hour time only for today", () =>
    expect(conversationTime(new Date(2026, 8, 11, 6, 4).getTime(), now)).toBe(
      "06:04",
    ));
  it("distinguishes yesterday from today's activity", () =>
    expect(conversationTime(new Date(2026, 8, 10, 19).getTime(), now)).toBe(
      "昨天",
    ));
  it("shows month and day for older conversations", () =>
    expect(conversationTime(new Date(2026, 7, 20).getTime(), now)).toBe(
      "8/20",
    ));
  it("retains the year for older history", () =>
    expect(conversationTime(new Date(2025, 8, 11).getTime(), now)).toBe(
      "2025/9/11",
    ));
  it("handles yesterday across a year boundary", () =>
    expect(
      conversationTime(
        new Date(2025, 11, 31).getTime(),
        new Date(2026, 0, 1).getTime(),
      ),
    ).toBe("昨天"));
  it("does not invent a date for invalid input", () =>
    expect(conversationTime(NaN, now)).toBe(""));
});
