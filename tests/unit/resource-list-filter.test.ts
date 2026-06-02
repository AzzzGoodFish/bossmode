import { describe, expect, it } from "vitest";
import { matchesWorkspaceResourceSearch } from "../../web/src/pages/resource-list-filter";

describe("workspace resource list filtering", () => {
  it("does not throw when optional metadata is missing", () => {
    expect(matchesWorkspaceResourceSearch({ name: "architect", description: undefined, tags: undefined }, "arch")).toBe(true);
    expect(matchesWorkspaceResourceSearch({ name: "architect", description: undefined, tags: undefined }, "missing")).toBe(false);
  });

  it("matches description and tags when present", () => {
    expect(matchesWorkspaceResourceSearch({ name: "qa", description: "Quality gate", tags: ["builtin"] }, "quality")).toBe(true);
    expect(matchesWorkspaceResourceSearch({ name: "qa", description: "Quality gate", tags: ["builtin"] }, "built")).toBe(true);
  });
});
