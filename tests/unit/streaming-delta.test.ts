import { describe, expect, it } from "vitest";
import { appendStreamDelta, finalStreamContent } from "../../web/src/components/streaming-delta";

describe("streaming delta helpers", () => {
  it("appends live text and thinking deltas instead of replacing prior content", () => {
    let live: string | null = null;
    live = appendStreamDelta(live, "first ");
    live = appendStreamDelta(live, "second");

    expect(live).toBe("first second");
  });

  it("uses authoritative final content when present", () => {
    expect(finalStreamContent("complete persisted thinking", "partial live")).toBe("complete persisted thinking");
  });

  it("falls back to accumulated live content when final content is absent", () => {
    expect(finalStreamContent(undefined, "partial live")).toBe("partial live");
    expect(finalStreamContent("", "partial live")).toBe("partial live");
  });
});
