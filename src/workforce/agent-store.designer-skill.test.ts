import { describe, it, expect } from "vitest";
import { loadAgentTemplates } from "./agent-store.js";

describe("designer agent template", () => {
  it("declares impeccable as a builtin skill", () => {
    const templates = loadAgentTemplates();
    const designer = templates.find((a) => a.name === "designer");
    expect(designer).toBeTruthy();
    expect(designer?.skills).toContain("impeccable");
  });
});
