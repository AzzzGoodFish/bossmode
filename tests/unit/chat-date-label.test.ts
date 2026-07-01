import { describe, expect, it } from "vitest";
import { formatMessageDateSeparator, isSameLocalDate } from "../../web/src/utils/message-date";

describe("chat date separator labels", () => {
  it("uses a lightweight label for today's messages", () => {
    const now = new Date(2026, 6, 1, 18, 0).getTime();
    const today = new Date(2026, 6, 1, 9, 30).getTime();

    expect(formatMessageDateSeparator(today, now)).toBe("今天");
  });

  it("shows year/month/day for non-today messages", () => {
    const now = new Date(2026, 6, 3, 18, 0).getTime();
    const earlier = new Date(2026, 6, 1, 9, 30).getTime();

    expect(formatMessageDateSeparator(earlier, now)).toBe("2026年7月1日");
  });

  it("compares natural local days across month and year boundaries", () => {
    expect(isSameLocalDate(new Date(2026, 6, 1, 23, 59), new Date(2026, 6, 1, 0, 1))).toBe(true);
    expect(isSameLocalDate(new Date(2026, 6, 1, 23, 59), new Date(2026, 6, 2, 0, 1))).toBe(false);
    expect(isSameLocalDate(new Date(2026, 11, 31, 23, 59), new Date(2027, 0, 1, 0, 1))).toBe(false);
  });
});
