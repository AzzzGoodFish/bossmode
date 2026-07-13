import { describe, expect, it } from "vitest";
import { suggestMemberName } from "../../web/src/utils/member-name-suggestion.ts";

describe("room member name suggestions", () => {
  it("uses the Agent name first, then an increasing numeric suffix", () => {
    expect(suggestMemberName("developer", [])).toBe("developer");
    expect(suggestMemberName("developer", ["developer"])).toBe("developer-2");
    expect(suggestMemberName("developer", ["developer", "developer-2"])).toBe("developer-3");
  });

  it("finds the next available suffix and is shared for other Agent names", () => {
    expect(suggestMemberName("qa", ["qa", "qa-2", "qa-4"])).toBe("qa-3");
    expect(suggestMemberName("QA", ["qa"])).toBe("qa-2");
  });
});
