import { describe, it, expect } from "vitest";

describe("historical general template provenance", () => {
  it("retains builtin tags and literal historical body without a bundled live template", async () => {
    const { parseAgentDefinitionMarkdown } = await import("../src/app/upgrade/records.js");
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const body = "Historical general persona.\n  Keep literal bytes.\n";
    const parsed = parseAgentDefinitionMarkdown("general", `---\nname: general\ntags: [builtin]\n---\n${body}`);
    expect(parsed.metadata).toMatchObject({ slug: "general", name: "general", tags: ["builtin"] });
    expect(parsed.body).toBe(body);
    expect(existsSync(join(import.meta.dirname, "../templates/agents/general.md"))).toBe(false);
  });
});
